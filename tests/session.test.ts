import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session } from "../src/session.js";
import { PermissionProxy } from "../src/permission-proxy.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

// Mock child_process.spawn
const mockStdout = { on: vi.fn(), [Symbol.asyncIterator]: vi.fn() };
const mockStdin = { write: vi.fn(), end: vi.fn() };
const mockStderr = { on: vi.fn() };
let mockExitCode = 0;
let mockStdoutLines: string[] = [];
let spawnErrorCallback: ((err: Error) => void) | null = null;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = {
      pid: 12345,
      stdin: mockStdin,
      stdout: {
        // readline.createInterface reads from this
        [Symbol.asyncIterator]: async function* () {
          for (const line of mockStdoutLines) {
            yield line;
          }
        },
      },
      stderr: mockStderr,
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") {
          // Defer close event
          setTimeout(() => cb(mockExitCode), 10);
        }
        if (event === "error") {
          spawnErrorCallback = cb;
        }
      }),
      kill: vi.fn(),
    };
    return proc;
  }),
}));

// Mock readline to use our stdout iterator
vi.mock("node:readline", () => ({
  createInterface: ({ input }: any) => input,
}));

describe("Session", () => {
  let session: Session;
  let emitted: DaemonEvent[];
  let emit: (event: DaemonEvent) => void;
  let permissionProxy: PermissionProxy;

  beforeEach(() => {
    emitted = [];
    emit = (event) => emitted.push(event);
    permissionProxy = new PermissionProxy(30, emit);
    mockStdoutLines = [];
    mockExitCode = 0;
    spawnErrorCallback = null;
    vi.clearAllMocks();

    session = new Session(
      "sess-1",
      "/tmp/project",
      "claude-opus-4-6",
      "bypassPermissions",
      "claude",
      permissionProxy,
      emit
    );
  });

  it("starts in idle status", () => {
    expect(session.status).toBe("idle");
    expect(session.pid).toBeUndefined();
    expect(session.resumeSessionId).toBeUndefined();
  });

  it("transitions to busy on prompt, back to idle when done", async () => {
    mockStdoutLines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sdk-sess-123", model: "claude-opus-4-6", permissionMode: "bypassPermissions" }),
      JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: 1, duration_ms: 1000 }),
    ];

    await session.prompt("Hello");
    expect(session.status).toBe("idle");
  });

  it("captures resume session ID from init message", async () => {
    mockStdoutLines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sdk-sess-456", model: "claude-opus-4-6", permissionMode: "bypassPermissions" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];

    await session.prompt("Hello");
    expect(session.resumeSessionId).toBe("sdk-sess-456");
  });

  it("emits output events from assistant messages", async () => {
    mockStdoutLines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x", model: "test", permissionMode: "test" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi there" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];

    await session.prompt("Hello");
    const outputs = emitted.filter((e) => e.type === "output");
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]).toMatchObject({
      messageType: "assistant_text",
      chunk: "Hi there",
    });
  });

  it("emits prompt_complete on success result", async () => {
    mockStdoutLines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x", model: "test", permissionMode: "test" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];

    await session.prompt("Hello");
    const completes = emitted.filter((e) => e.type === "prompt_complete");
    expect(completes.length).toBe(1);
    expect(completes[0]).toMatchObject({ stopReason: "end_turn" });
  });

  it("pipes prompt text to stdin", async () => {
    mockStdoutLines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x", model: "test", permissionMode: "test" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];

    await session.prompt("Fix the bug in auth.ts");
    expect(mockStdin.write).toHaveBeenCalledWith("Fix the bug in auth.ts");
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it("cancel is no-op when idle", async () => {
    await session.cancel();
    expect(session.status).toBe("idle");
  });

  it("close cleans up", () => {
    session.close();
    expect(session.status).toBe("idle");
  });
});
