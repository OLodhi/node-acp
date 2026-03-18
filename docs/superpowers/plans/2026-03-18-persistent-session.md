# Persistent Claude Code Session Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `PersistentSession` class that keeps a single Claude Code process alive across prompts, reducing follow-up latency from ~12s to ~2-4s.

**Architecture:** New `PersistentSession` class implements an `ISession` interface alongside the existing `Session`. Daemon factory-switches based on `sessionMode` config. The persistent process uses `--input-format stream-json` / `--output-format stream-json` with stdin kept open. A two-tier timeout kills the process at 15min idle but keeps session metadata alive for 2hr TTL.

**Tech Stack:** TypeScript, Node.js child_process, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-persistent-session-design.md`

---

### Task 1: Extract ISession interface and update Daemon typing

Extract the public contract shared by `Session` and `PersistentSession` into an interface. Update `Daemon.sessions` to use it.

**Files:**
- Create: `src/session-interface.ts`
- Modify: `src/session.ts:19` — add `implements ISession`
- Modify: `src/daemon.ts:6,20` — import `ISession`, retype sessions map

- [ ] **Step 1: Create `src/session-interface.ts`**

```typescript
import type { ChildPidRegistry } from "./child-pid-registry.js";
import type { PermissionProxy } from "./permission-proxy.js";
import type { DaemonEvent } from "./ipc-protocol.js";

export interface ISession {
  readonly sessionId: string;
  readonly status: "idle" | "busy";
  readonly pid: number | undefined;
  readonly resumeSessionId: string | undefined;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}

export interface SessionConfig {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: string;
  claudeBin: string;
  permissionProxy: PermissionProxy;
  emit: (event: DaemonEvent) => void;
  writer?: (line: string) => void;
  pidRegistry?: ChildPidRegistry;
  onActivity?: () => void;
}
```

- [ ] **Step 2: Add `implements ISession` to Session class**

In `src/session.ts` line 19, change:
```typescript
export class Session {
```
to:
```typescript
import type { ISession } from "./session-interface.js";

export class Session implements ISession {
```

Add the import at the top of the file (after line 6).

- [ ] **Step 3: Update Daemon to use ISession**

In `src/daemon.ts`:
- Add import: `import type { ISession } from "./session-interface.js";`
- Change line 20: `private sessions = new Map<string, Session>();` → `private sessions = new Map<string, ISession>();`

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run -v`
Expected: All 65 tests pass. No behavioral changes.

- [ ] **Step 5: Commit**

```bash
git add src/session-interface.ts src/session.ts src/daemon.ts
git commit -m "refactor: extract ISession interface from Session class"
```

---

### Task 2: Add sessionMode and processIdleMinutes to config chain

Add config fields to daemon config, IPC protocol, CLI spawn command, and plugin config.

**Files:**
- Modify: `src/config.ts:3-16,24-38` — add `sessionMode`, `processIdleMinutes` to DaemonConfig
- Modify: `src/ipc-protocol.ts:3-11` — add `sessionMode` to SpawnRequest
- Modify: `src/index.ts:214-226` — add `--session-mode` flag to spawn CLI
- Modify: `plugin/src/config.ts:1-11,26-37` — add `sessionMode` to AcpxRemoteConfig
- Modify: `plugin/src/runtime.ts:58-62` — pass `--session-mode` in spawn CLI call
- Modify: `plugin/openclaw.plugin.json` — add `sessionMode` to schema
- Modify: `src/session-manager.ts:83` — make `resetTtl` public (needed by PersistentSession's onActivity)

- [ ] **Step 1: Add fields to DaemonConfig**

In `src/config.ts`, add to the `DaemonConfig` interface (after `uiPort`):
```typescript
  sessionMode: "persistent" | "ephemeral";
  processIdleMinutes: number;
```

In `loadConfig`, add (after `uiPort` line):
```typescript
    sessionMode: (process.env.ACPX_SESSION_MODE as any) ?? overrides.sessionMode ?? "persistent",
    processIdleMinutes: overrides.processIdleMinutes ?? 15,
```

- [ ] **Step 2: Add sessionMode to SpawnRequest**

In `src/ipc-protocol.ts`, add to `SpawnRequest` (after `timeoutMinutes`):
```typescript
  sessionMode?: "persistent" | "ephemeral";
```

- [ ] **Step 3: Add --session-mode to spawn CLI command**

In `src/index.ts`, in the `case "spawn"` block (around line 218), add `sessionMode` to the `sendAndListen` call:
```typescript
        sendAndListen({
          type: "spawn",
          sessionId: getFlag(args, "--session-id") ?? randomUUID(),
          agent,
          cwd,
          model: getFlag(args, "--model") ?? config.defaultModel,
          permissionMode: config.defaultPermissionMode,
          timeoutMinutes: config.defaultTtlMinutes,
          sessionMode: (getFlag(args, "--session-mode") as any) ?? config.sessionMode,
        });
```

- [ ] **Step 4: Add sessionMode to plugin config**

In `plugin/src/config.ts`, add to `AcpxRemoteConfig` interface:
```typescript
  sessionMode: "persistent" | "ephemeral";
```

In `resolveConfig`, add to the return object:
```typescript
    sessionMode: (pluginConfig?.sessionMode as string as any) ?? "persistent",
```

- [ ] **Step 5: Pass --session-mode in plugin's ensureSession**

In `plugin/src/runtime.ts`, update the spawn CLI call in `ensureSession()` (around line 58):
```typescript
    const result = await this.bridge.exec(nodeId, [
      ...this.config.daemonBin, "spawn",
      "--session-id", sessionId,
      "--cwd", cwd,
      "--session-mode", this.config.sessionMode,
    ]);
```

- [ ] **Step 6: Make SessionManager.resetTtl public**

In `src/session-manager.ts`, change line 83:
```typescript
  private resetTtl(sessionId: string): void {
```
to:
```typescript
  resetTtl(sessionId: string): void {
```

- [ ] **Step 7: Add sessionMode to openclaw.plugin.json schema**

In `plugin/openclaw.plugin.json`, add to `configSchema.properties`:
```json
      "sessionMode": {
        "type": "string",
        "enum": ["persistent", "ephemeral"],
        "default": "persistent",
        "description": "Session mode: 'persistent' keeps the claude process alive between prompts, 'ephemeral' spawns a new process per prompt"
      }
```

- [ ] **Step 8: Build and run tests**

Run: `npm run build && cd plugin && npx tsc && cd .. && npx vitest run -v`
Expected: All tests pass. Config tests may need updating if they validate field count.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/ipc-protocol.ts src/index.ts src/session-manager.ts plugin/src/config.ts plugin/src/runtime.ts plugin/openclaw.plugin.json
git commit -m "feat: add sessionMode and processIdleMinutes config chain"
```

---

### Task 3: Implement PersistentSession core

The main new file. Implements `ISession` with a long-lived claude process, NDJSON stdin/stdout, spawn guard, idle timer, crash recovery, and prompt_complete guarantee.

**Files:**
- Create: `src/persistent-session.ts`
- Create: `tests/persistent-session.test.ts`

- [ ] **Step 1: Write tests for PersistentSession**

Create `tests/persistent-session.test.ts` with tests covering:
1. Single prompt: spawns process, writes NDJSON to stdin, reads result, resolves
2. Multi-turn: two prompts, process spawned only once
3. Crash while busy: emits error + prompt_complete, rejects promise
4. Crash while idle: silent, next prompt respawns with --resume
5. Idle timeout: process killed after timeout, respawns on next prompt
6. Close: kills process, cleans up

```typescript
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
      // Simulates readline-compatible stream that terminates when destroyed
      [Symbol.asyncIterator]: async function* () {
        while (!stdoutDestroyed) {
          if (stdoutLines.length > 0) {
            yield stdoutLines.shift()!;
          } else {
            await new Promise<void>((r) => {
              stdoutResolve = r;
              // Break out if destroyed while waiting
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
      // Simulate process termination: destroy stdout and fire close
      stdoutDestroyed = true;
      if (stdoutResolve) { const r = stdoutResolve; stdoutResolve = null; r(); }
      setTimeout(() => closeCallback?.(1), 1);
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

/** Simulate process crash/exit — breaks stdout iterator and fires close callback */
function simulateCrash(exitCode = 1) {
  stdoutDestroyed = true;
  if (stdoutResolve) { const r = stdoutResolve; stdoutResolve = null; r(); }
  closeCallback?.(exitCode);
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockProc()),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns process on first prompt and resolves on result", async () => {
    const config = makeConfig();
    const session = new PersistentSession(config, 15);

    const promptPromise = session.prompt("Hello");

    // Process should have been spawned
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("busy");

    // Simulate init + assistant + result
    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }));
    pushStdout(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }));
    pushStdout(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-abc" }));

    await promptPromise;

    expect(session.status).toBe("idle");
    expect(session.resumeSessionId).toBe("claude-abc");
    expect(config.emit).toHaveBeenCalled();
  });

  it("reuses process for second prompt", async () => {
    const config = makeConfig();
    const session = new PersistentSession(config, 15);

    // First prompt
    const p1 = session.prompt("First");
    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }));
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p1;

    // Second prompt — should NOT spawn again
    const p2 = session.prompt("Second");
    expect(spawn).toHaveBeenCalledTimes(1); // Still only 1 spawn

    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p2;
  });

  it("emits error + prompt_complete on crash while busy", async () => {
    const config = makeConfig();
    const session = new PersistentSession(config, 15);

    const p1 = session.prompt("Hello");
    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }));

    // Simulate crash — breaks stdout iterator and fires close
    simulateCrash(1);

    await expect(p1).rejects.toThrow();
    expect(session.status).toBe("idle");

    // Should have emitted error and prompt_complete
    const emitCalls = (config.emit as any).mock.calls.map((c: any) => c[0].type);
    expect(emitCalls).toContain("error");
    expect(emitCalls).toContain("prompt_complete");
  });

  it("respawns with --resume after crash", async () => {
    const config = makeConfig();
    const session = new PersistentSession(config, 15);

    // First prompt — establishes claudeSessionId
    const p1 = session.prompt("First");
    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }));
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p1;

    // Simulate idle crash — breaks stdout iterator and fires close
    simulateCrash(1);

    // Next prompt should respawn with --resume
    const p2 = session.prompt("Second");
    expect(spawn).toHaveBeenCalledTimes(2);

    // Check --resume flag in spawn args
    const lastSpawnArgs = vi.mocked(spawn).mock.calls[1][1] as string[];
    expect(lastSpawnArgs).toContain("--resume");
    expect(lastSpawnArgs).toContain("claude-abc");

    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-abc" }));
    pushStdout(JSON.stringify({ type: "result", subtype: "success" }));
    await p2;
  });

  it("kills process on close", () => {
    const config = makeConfig();
    const session = new PersistentSession(config, 15);

    // Start a process
    session.prompt("Hello");
    pushStdout(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }));

    session.close();
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/persistent-session.test.ts -v`
Expected: FAIL — `PersistentSession` module not found.

- [ ] **Step 3: Implement PersistentSession**

Create `src/persistent-session.ts`. This is the core implementation (~250 lines). The class:
- Implements `ISession`
- Spawns claude with `--input-format stream-json --output-format stream-json` (no `-p`, `shell: false`)
- Keeps stdin open between prompts
- Writes NDJSON `user_message` lines per prompt
- Detects turn completion via `type === "result"` on stdout
- Has `_spawnPromise` guard for concurrent spawn protection
- Has process idle timer (cleared on busy, restarted on result)
- Calls `onActivity` callback on stdout messages for TTL reset
- Emits `error` + `prompt_complete` on crash-while-busy
- Respawns with `--resume` after crash/idle-kill

The implementation should:
- Import `spawn, ChildProcess` from `node:child_process`
- Import `createInterface` from `node:readline`
- Import `ISession, SessionConfig` from `./session-interface.js`
- Import `forwardOutput` from `./output-forwarder.js`
- Reuse `renderMessage` and `formatToolInput` private methods from Session (copy them, or extract to a shared util — copying is simpler for now)

Key constructor: `constructor(config: SessionConfig, processIdleMinutes: number)`

Key fields:
```typescript
  private _proc: ChildProcess | null = null;
  private _rl: ReturnType<typeof createInterface> | null = null;
  private _status: "idle" | "busy" = "idle";
  private _claudeSessionId: string | undefined;
  private _pid: number | undefined;
  private _spawnPromise: Promise<void> | null = null;
  private _promptResolve: (() => void) | null = null;
  private _promptReject: ((err: Error) => void) | null = null;
  private _idleTimer: NodeJS.Timeout | null = null;
  private _killTimer: NodeJS.Timeout | null = null;  // 5-second SIGTERM fallback after stdin.end()
  private _promptCompleteEmitted = false;
```

**Background loop and prompt signaling mechanism:**

When a process is spawned, start a background async loop:
```typescript
private async runBackgroundReader(): Promise<void> {
  const rl = createInterface({ input: this._proc!.stdout! });
  this._rl = rl;
  for await (const line of rl) {
    // parse JSON, forward via forwardOutput/renderMessage
    // if type === "system" && subtype === "init": capture _claudeSessionId, resolve _spawnPromise
    // if type === "result": set _promptCompleteEmitted, call _promptResolve?.()
    // if type === "assistant" || type === "result": call onActivity?.()
  }
  // Loop exits when rl is closed (process exit or rl.close())
}
```

On `proc.on("close")`:
- Call `this._rl?.close()` — this breaks the `for await` loop above
- If busy: emit error + prompt_complete, call `_promptReject`
- Set `_proc = null`, `_rl = null`

The `prompt()` method:
1. If `_spawnPromise`: `await _spawnPromise`
2. If no process: call `spawnProcess()` which sets `_spawnPromise` and starts `runBackgroundReader()`. `_spawnPromise` resolves when `system/init` is received.
3. Clear idle timer
4. Set `_status = "busy"`, write NDJSON to stdin
5. `await new Promise((resolve, reject) => { _promptResolve = resolve; _promptReject = reject; })`
6. Set `_status = "idle"`, restart idle timer

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/persistent-session.test.ts -v`
Expected: All tests pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/persistent-session.ts tests/persistent-session.test.ts
git commit -m "feat: implement PersistentSession with NDJSON stdin/stdout"
```

---

### Task 4: Wire PersistentSession into Daemon

Update `handleSpawn` to factory-switch between Session and PersistentSession based on the spawn request's `sessionMode` field. Pass `onActivity` callback.

**Files:**
- Modify: `src/daemon.ts:6,142-195`

- [ ] **Step 1: Import PersistentSession**

In `src/daemon.ts`, add import:
```typescript
import { PersistentSession } from "./persistent-session.js";
```

- [ ] **Step 2: Update handleSpawn to factory-switch**

In `handleSpawn()`, replace the `new Session(...)` block (lines 166-176) with:

```typescript
      const sessionConfig = {
        sessionId: req.sessionId,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        claudeBin: this.config.claudeBin,
        permissionProxy: this.permissionProxy,
        emit,
        writer,
        pidRegistry: this.pidRegistry,
        onActivity: () => this.sessionManager.resetTtl(req.sessionId),
      };

      const mode = req.sessionMode ?? this.config.sessionMode;
      const agentSession = mode === "persistent"
        ? new PersistentSession(sessionConfig, this.config.processIdleMinutes)
        : new Session(
            req.sessionId, req.cwd, req.model, req.permissionMode,
            this.config.claudeBin, this.permissionProxy, emit, writer, this.pidRegistry
          );
      this.sessions.set(req.sessionId, agentSession);
```

- [ ] **Step 3: Build and run full test suite**

Run: `npm run build && npx vitest run -v`
Expected: All tests pass (65+ existing + new persistent session tests).

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: wire PersistentSession into Daemon with factory switch"
```

---

### Task 5: Verify NDJSON input format and integration test

The `--input-format stream-json` NDJSON format must be verified against the actual Claude Code CLI. Run a real integration test.

**Files:**
- No file changes — this is a verification step

- [ ] **Step 1: Test NDJSON input format locally**

Run this command to verify the stdin message format:
```bash
echo '{"type":"user_message","content":"What is 2+2? Reply with just the number."}' | claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions 2>/dev/null | head -20
```

Note: Do NOT use `-p` flag — it conflicts with `--input-format stream-json`. The persistent mode does not use print mode.

If this returns stream-json output with a `result` message, the format is correct. If it errors or hangs, try alternative formats:
```bash
# Alternative 1: role-based
echo '{"role":"user","content":"What is 2+2?"}' | claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions 2>/dev/null | head -20

# Alternative 2: message wrapper
echo '{"type":"user","message":{"role":"user","content":"What is 2+2?"}}' | claude --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions 2>/dev/null | head -20
```

- [ ] **Step 2: Update PersistentSession if format differs**

If the verified format differs from `{"type":"user_message","content":"..."}`, update the `writePrompt` method in `src/persistent-session.ts` to use the correct format.

- [ ] **Step 3: Build, deploy, and end-to-end test**

```bash
npm run build && npm install -g .
acpx-node-daemon stop; acpx-node-daemon start --daemon --ui
```

Then test via the daemon CLI:
```bash
acpx-node-daemon spawn --session-id test-persist --cwd ~ --session-mode persistent
acpx-node-daemon prompt test-persist --text-b64 $(echo -n "What is 2+2?" | base64)
# Wait for completion, then:
acpx-node-daemon drain test-persist
# Second prompt (should be fast):
acpx-node-daemon prompt test-persist --text-b64 $(echo -n "Multiply that by 3" | base64)
acpx-node-daemon drain test-persist
acpx-node-daemon close test-persist
```

- [ ] **Step 4: Deploy plugin and test via Telegram**

```bash
cd plugin && npx tsc
scp plugin/src/*.ts omar@192.168.1.24:/home/omar/Projects/openclaw-acpx-remote/src/
scp plugin/openclaw.plugin.json omar@192.168.1.24:/home/omar/Projects/openclaw-acpx-remote/
ssh omar@192.168.1.24 "export PATH=\$PATH:/home/omar/.npm-global/bin && openclaw gateway restart 2>&1 | tail -3"
```

Test: Send two prompts via Telegram bot. First should take ~12s, second should take ~2-4s.

- [ ] **Step 5: Commit any format fixes**

```bash
git add -A
git commit -m "fix: adjust NDJSON format based on CLI verification"
```

---

## Execution Order

Tasks must be sequential: 1 → 2 → 3 → 4 → 5.

Each builds on the previous:
- Task 1 creates the interface that Task 3 implements
- Task 2 adds config that Task 3 and 4 use
- Task 3 creates the class that Task 4 wires in
- Task 5 is integration verification after everything is assembled
