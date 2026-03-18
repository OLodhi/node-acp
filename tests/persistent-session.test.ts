import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { PersistentSession } from "../src/persistent-session.js";
import { PermissionProxy } from "../src/permission-proxy.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";
import type { SessionConfig } from "../src/session-interface.js";

// Mock child_process.spawn
let mockProc: any;
let stdinWritten: string[];
let stdinEnded: boolean;
let closeCallback: ((code: number) => void) | null;
let errorCallback: ((err: Error) => void) | null;
let stdoutLines: string[];
let stdoutResolve: (() => void) | null;
let stdoutDestroyed: boolean;

function createMockProc() {
  stdinWritten = [];
  stdinEnded = false;
  closeCallback = null;
  errorCallback = null;
  stdoutLines = [];
  stdoutResolve = null;
  stdoutDestroyed = false;

  mockProc = {
    pid: 12345,
    stdin: {
      write: vi.fn((data: string) => { stdinWritten.push(data); }),
      end: vi.fn(() => { stdinEnded = true; }),
    },
    stdout: {
      [Symbol.asyncIterator]: async function* () {
        while (!stdoutDestroyed) {
          if (stdoutLines.length > 0) {
            yield stdoutLines.shift()!;
          } else {
            await new Promise<void>((r) => {
              stdoutResolve = r;
              const check = setInterval(() => {
                if (stdoutDestroyed) { clearInterval(check); r(); }
              }, 1);
            });
          }
        }
      },
      destroy: vi.fn(() => { stdoutDestroyed = true; }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: any) => {
      if (event === "close") closeCallback = cb;
      if (event === "error") errorCallback = cb;
    }),
    kill: vi.fn(() => {
      stdoutDestroyed = true;
      if (stdoutResolve) { const r = stdoutResolve; stdoutResolve = null; r(); }
      // Capture callback at kill time to prevent leaking into next test
      const cb = closeCallback;
      closeCallback = null;
      setTimeout(() => cb?.(1), 1);
    }),
  };
  return mockProc;
}

function pushStdout(line: string) {
  stdoutLines.push(line);
  if (stdoutResolve) {
    const r = stdoutResolve;
    stdoutResolve = null;
    r();
  }
}

function simulateCrash(exitCode = 1) {
  stdoutDestroyed = true;
  if (stdoutResolve) { const r = stdoutResolve; stdoutResolve = null; r(); }
  closeCallback?.(exitCode);
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockProc()),
}));

// Mock readline to use our stdout iterator directly
vi.mock("node:readline", () => ({
  createInterface: ({ input }: any) => input,
}));

/** Small delay to let async tasks and microtasks settle */
function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    sessionId: "sess-1",
    cwd: "/tmp/project",
    model: "claude-opus-4-6",
    permissionMode: "bypassPermissions",
    claudeBin: "claude",
    permissionProxy: new PermissionProxy(30, () => {}),
    emit: vi.fn(),
    writer: vi.fn(),
    ...overrides,
  };
}

describe("PersistentSession", () => {
  let session: PersistentSession;
  let config: SessionConfig;
  let emitted: DaemonEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    emitted = [];
    config = makeConfig({
      emit: (event: DaemonEvent) => emitted.push(event),
    });
    session = new PersistentSession(config, 30);
  });

  afterEach(() => {
    // Clean up any live process
    session.close();
  });

  it("spawns process on first prompt and resolves on result", async () => {
    const promptPromise = session.prompt("Hello");

    // Process was spawned, push init message
    await tick();
    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions",
    }));

    await tick();

    // Push result to complete the prompt
    pushStdout(JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 1000,
    }));

    await promptPromise;

    expect(session.status).toBe("idle");
    expect(session.resumeSessionId).toBe("claude-sess-abc");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reuses process for second prompt", async () => {
    // First prompt
    const p1 = session.prompt("First");
    await tick();
    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
    }));
    await tick();
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p1;

    expect(spawn).toHaveBeenCalledTimes(1);

    // Second prompt — should reuse the same process
    const p2 = session.prompt("Second");
    await tick();
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p2;

    // spawn should still have been called only once
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("idle");
  });

  it("emits error + prompt_complete on crash while busy", async () => {
    const promptPromise = session.prompt("Hello");
    await tick();

    // Push init so spawn completes
    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
    }));
    await tick();

    // Simulate crash while busy (no result message sent)
    simulateCrash(1);

    await expect(promptPromise).rejects.toThrow();

    // Should have emitted error and prompt_complete
    const errors = emitted.filter((e) => e.type === "error");
    const completes = emitted.filter((e) => e.type === "prompt_complete");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(completes.length).toBeGreaterThanOrEqual(1);
  });

  it("respawns with --resume after crash", async () => {
    // Complete first prompt successfully
    const p1 = session.prompt("First");
    await tick();
    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
    }));
    await tick();
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p1;

    expect(session.resumeSessionId).toBe("claude-sess-abc");

    // Simulate crash while idle
    simulateCrash(1);
    await tick();

    // Second prompt should respawn
    const p2 = session.prompt("Second");
    await tick();

    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-def",
      model: "claude-opus-4-6",
    }));
    await tick();
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p2;

    expect(spawn).toHaveBeenCalledTimes(2);

    // Verify the second spawn used --resume with the captured session ID
    const secondCall = vi.mocked(spawn).mock.calls[1];
    const args = secondCall[1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("claude-sess-abc");
  });

  it("kills process on close", async () => {
    const promptPromise = session.prompt("Hello");
    await tick();

    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
    }));
    await tick();

    // Close while process is alive
    session.close();

    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses shell: true with windowsHide: true", async () => {
    const promptPromise = session.prompt("Hello");
    await tick();

    pushStdout(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      model: "claude-opus-4-6",
    }));
    await tick();
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await promptPromise;

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const options = spawnCall[2] as any;
    expect(options.shell).toBe(true);
    expect(options.windowsHide).toBe(true);
  });
});
