# Session Lifecycle Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 session management bugs: TTL orphan leak, broken stderr capture, missing plugin-side close on error, WebUI memory leak, orphan detection on restart, and daemon startup polling fragility.

**Architecture:** All fixes are surgical edits to existing files. The TTL fix adds a callback from SessionManager to Daemon for full cleanup. Stderr fix moves the listener before the readline loop. Plugin close-on-error adds a best-effort IPC call. WebUI gets a `removeSession()` method. Daemon startup gets exponential backoff in waitForDaemon.

**Tech Stack:** TypeScript, Node.js, Vitest

---

### Task 1: Fix TTL expiry orphaning Session objects and claude processes

The TTL callback in `SessionManager.resetTtl()` only removes from its own map and emits an event. The `Session` object in `Daemon.sessions` is never cleaned up and `Session.close()` is never called — any running claude process continues forever.

**Files:**
- Modify: `src/session-manager.ts:82-95`
- Modify: `src/daemon.ts:24-29`
- Test: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing test for TTL cleanup callback**

Add to `tests/session-manager.test.ts`:

```typescript
it("calls onSessionExpired callback on TTL expiry", () => {
  vi.useFakeTimers();
  const onExpired = vi.fn();
  const config = loadConfig({ maxConcurrentSessions: 2 });
  const events: any[] = [];
  const mgr = new SessionManager(config, (e) => events.push(e), onExpired);

  mgr.registerSession("s1", {
    agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
    permissionMode: "default", ttlMinutes: 1,
  });

  vi.advanceTimersByTime(60_001);

  expect(onExpired).toHaveBeenCalledWith("s1");
  expect(mgr.getSession("s1")).toBeUndefined();
  expect(events.some((e) => e.type === "session_closed" && e.reason === "ttl_expired")).toBe(true);

  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-manager.test.ts -v`
Expected: FAIL — `SessionManager` constructor does not accept a third argument.

- [ ] **Step 3: Add onSessionExpired callback to SessionManager**

In `src/session-manager.ts`, add an optional third constructor parameter and call it in the TTL callback:

```typescript
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  constructor(
    private config: DaemonConfig,
    private emit: (event: DaemonEvent) => void,
    private onSessionExpired?: (sessionId: string) => void,
  ) {}

  // ... (no changes to other methods) ...

  private resetTtl(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttlTimer) clearTimeout(session.ttlTimer);

    session.ttlTimer = setTimeout(() => {
      this.emit({
        type: "session_closed",
        sessionId,
        reason: "ttl_expired",
      });
      this.sessions.delete(sessionId);
      this.onSessionExpired?.(sessionId);
    }, session.ttlMinutes * 60 * 1000);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-manager.test.ts -v`
Expected: PASS

- [ ] **Step 5: Wire up Daemon to handle expired sessions**

In `src/daemon.ts`, update the `SessionManager` construction (around line 32) to pass a cleanup callback:

```typescript
this.sessionManager = new SessionManager(config, emit, (sessionId) => {
  // Clean up the Session object and kill any running claude process
  const agentSession = this.sessions.get(sessionId);
  if (agentSession) {
    agentSession.close();
    this.sessions.delete(sessionId);
  }
  this.permissionProxy.cleanupSession(sessionId);
  if (this.webUI) {
    this.webUI.removeSession(sessionId);
  }
});
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run -v`
Expected: All 60+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/session-manager.ts src/daemon.ts tests/session-manager.test.ts
git commit -m "fix: clean up Session objects and kill claude process on TTL expiry"
```

---

### Task 2: Fix stderr collected after process exit

In `src/session.ts:156-164`, the stderr `data` listener is attached after `proc.on("close")` fires. By that point stderr has already been flushed and closed — the listener never receives data. The `setTimeout(100)` workaround is unreliable.

**Files:**
- Modify: `src/session.ts:105-165`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing test for stderr capture**

Add to `tests/session.test.ts`. First, add `import { spawn } from "node:child_process";` to the existing imports at the top of the file:

```typescript
it("captures stderr output on non-zero exit", async () => {
  mockExitCode = 1;
  mockStdoutLines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "x", model: "test", permissionMode: "test" }),
  ];

  // Configure mock stderr to emit data before close
  const stderrChunks: Buffer[] = [Buffer.from("something went wrong")];
  vi.mocked(spawn).mockImplementationOnce((() => {
    const proc = {
      pid: 12345,
      stdin: mockStdin,
      stdout: {
        [Symbol.asyncIterator]: async function* () {
          for (const line of mockStdoutLines) yield line;
        },
      },
      stderr: {
        on: vi.fn((event: string, cb: any) => {
          if (event === "data") {
            // Emit stderr data before close fires
            setTimeout(() => {
              for (const chunk of stderrChunks) cb(chunk);
            }, 1);
          }
        }),
      },
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") setTimeout(() => cb(mockExitCode), 20);
        if (event === "error") spawnErrorCallback = cb;
      }),
      kill: vi.fn(),
    };
    return proc;
  }) as any);

  const events: DaemonEvent[] = [];
  const lines: string[] = [];
  const session = new Session("sess-1", "/tmp/project", "test", "bypassPermissions", "claude",
    new PermissionProxy(30, () => {}), (e) => events.push(e), (line) => lines.push(line));

  await session.prompt("Hello");

  const stderrLine = lines.find((l) => l.includes("something went wrong"));
  expect(stderrLine).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts -v`
Expected: FAIL — stderr is never captured with current code.

- [ ] **Step 3: Move stderr buffering before the readline loop**

In `src/session.ts`, replace lines 105-165 with stderr collection moved before the readline loop:

```typescript
      const proc = spawn(this.claudeBin, args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
        env: { ...process.env },
      });

      this.currentProcess = proc;
      this._pid = proc.pid;

      // Pipe prompt text to stdin, then close it so claude reads the prompt
      proc.stdin!.write(text);
      proc.stdin!.end();

      // Handle spawn errors without crashing the daemon
      proc.on("error", (err) => {
        console.error(`${RED}${tag} spawn error: ${err.message}${RESET}`);
        this.emit({ type: "error", sessionId: this.sessionId, error: `Failed to start claude: ${err.message}` });
      });

      // Collect stderr incrementally (must attach BEFORE awaiting stdout/close)
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      const rl = createInterface({ input: proc.stdout! });

      for await (const line of rl) {
        if (!line.trim()) continue;

        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        // Capture session ID from init
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          this._resumeSessionId = msg.session_id;
          this.writer(`${BLUE}  session: ${msg.session_id.slice(0, 8)}  model: ${msg.model ?? "?"}  mode: ${msg.permissionMode ?? "?"}${RESET}`);
        }

        // Render to console
        this.renderMessage(tag, msg);

        // Forward to IPC event system (reuses existing output forwarder)
        forwardOutput(msg, this.sessionId, trackingEmit);
      }

      // Wait for process to exit
      const exitCode = await new Promise<number>((resolve) => {
        proc.on("close", (code) => resolve(code ?? 0));
      });

      if (exitCode !== 0 && stderr) {
        this.writer(`${RED}  stderr: ${stderr.slice(0, 500)}${RESET}`);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "fix: collect stderr before process exit, not after"
```

---

### Task 3: Plugin error path sends close to daemon

When `runTurn()` encounters an error, `activeSessions.delete(nodeName)` is called but no `close` IPC is sent to the daemon. The session remains registered until TTL expiry (2 hours), occupying a `maxConcurrentSessions` slot.

**Files:**
- Modify: `plugin/src/runtime.ts:232-236`

- [ ] **Step 1: Add best-effort close before deleting from activeSessions**

In `plugin/src/runtime.ts`, in the `remote_claude_code` execute handler, replace the error path at lines 232-236:

```typescript
              case "error":
                log.push(`[Error: ${event.message}]`);
                // Session might be dead — close it on daemon and clear locally
                try {
                  const closeHandle = encodeHandle(`node-acp-${session!.sessionId}`, session!);
                  await this.close({ handle: closeHandle, reason: "error_cleanup" });
                } catch {}
                this.activeSessions.delete(nodeName);
                return { content: [{ type: "text", text: log.join("\n") || `Error: ${event.message}` }] };
```

Also update the catch block at lines 240-245:

```typescript
        } catch (err: any) {
          // Clear session on failure — close on daemon first
          const failedNodeName = params.node || this.config.defaultNode;
          if (failedNodeName) {
            const failedSession = this.activeSessions.get(failedNodeName);
            if (failedSession) {
              try {
                const closeHandle = encodeHandle(`node-acp-${failedSession.sessionId}`, failedSession);
                await this.close({ handle: closeHandle, reason: "error_cleanup" });
              } catch {}
            }
            this.activeSessions.delete(failedNodeName);
          }
          return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
        }
```

- [ ] **Step 2: Build and run tests**

Run: `npm run build && cd plugin && npx tsc && cd .. && npx vitest run -v`
Expected: All tests pass, no type errors.

- [ ] **Step 3: Commit**

```bash
git add plugin/src/runtime.ts
git commit -m "fix: send close IPC to daemon when plugin encounters errors"
```

---

### Task 4: WebUI lineBuffers cleanup on session close

`WebUI.lineBuffers` accumulates per-session line arrays up to 1000 lines each. There is no cleanup when a session is closed. Old entries persist for the daemon's lifetime.

**Files:**
- Modify: `src/web-ui.ts`
- Modify: `src/daemon.ts` (call removeSession from handleClose and TTL callback)

- [ ] **Step 1: Add removeSession method to WebUI**

In `src/web-ui.ts`, add after the `pushLine` method:

```typescript
  removeSession(sessionId: string): void {
    this.lineBuffers.delete(sessionId);
  }
```

- [ ] **Step 2: Call removeSession from handleClose in Daemon**

In `src/daemon.ts`, in `handleClose()` after `this.eventBuffer.markDraining(req.sessionId)` (line 240), add:

```typescript
    if (this.webUI) {
      this.webUI.removeSession(req.sessionId);
    }
```

Note: The TTL expiry callback (from Task 1) already includes `this.webUI.removeSession(sessionId)`.

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npx vitest run -v`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/web-ui.ts src/daemon.ts
git commit -m "fix: clean up WebUI lineBuffers when sessions close"
```

---

### Task 5: Detect and kill orphaned claude processes on daemon restart

If the daemon crashes while a claude process is running, that process becomes an orphan. On restart, the daemon has no record of it. Add a child PID registry that persists to disk so orphans can be killed on boot.

**Files:**
- Create: `src/child-pid-registry.ts`
- Modify: `src/session.ts` (register/unregister child PIDs)
- Modify: `src/daemon.ts` (kill orphans on start)
- Create: `tests/child-pid-registry.test.ts`

- [ ] **Step 1: Write the test for ChildPidRegistry**

Create `tests/child-pid-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildPidRegistry } from "../src/child-pid-registry.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ChildPidRegistry", () => {
  const filePath = join(tmpdir(), `test-child-pids-${Date.now()}.json`);
  let registry: ChildPidRegistry;

  beforeEach(() => {
    registry = new ChildPidRegistry(filePath);
  });

  afterEach(() => {
    try { unlinkSync(filePath); } catch {}
  });

  it("registers and unregisters PIDs", () => {
    registry.register(1234);
    registry.register(5678);
    expect(registry.list()).toEqual([1234, 5678]);

    registry.unregister(1234);
    expect(registry.list()).toEqual([5678]);
  });

  it("persists to disk and loads on new instance", () => {
    registry.register(1234);
    registry.register(5678);

    const loaded = new ChildPidRegistry(filePath);
    expect(loaded.list()).toEqual([1234, 5678]);
  });

  it("clear removes all PIDs and deletes file", () => {
    registry.register(1234);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/child-pid-registry.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChildPidRegistry**

Create `src/child-pid-registry.ts`:

```typescript
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

export class ChildPidRegistry {
  private pids = new Set<number>();

  constructor(private filePath: string) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(data)) {
        for (const pid of data) this.pids.add(pid);
      }
    } catch {}
  }

  register(pid: number): void {
    this.pids.add(pid);
    this.save();
  }

  unregister(pid: number): void {
    this.pids.delete(pid);
    this.save();
  }

  list(): number[] {
    return Array.from(this.pids);
  }

  clear(): void {
    this.pids.clear();
    try { unlinkSync(this.filePath); } catch {}
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(Array.from(this.pids)));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/child-pid-registry.test.ts -v`
Expected: PASS

- [ ] **Step 5: Wire ChildPidRegistry into Session and Daemon**

In `src/session.ts`, add a constructor parameter for the registry and register/unregister around spawns. In `Session.prompt()`, after `this._pid = proc.pid` (line 114):

```typescript
      this.pidRegistry?.register(proc.pid!);
```

In the `finally` block (line 186-188), before `this.currentProcess = null`:

```typescript
      if (this._pid) this.pidRegistry?.unregister(this._pid);
```

Add `pidRegistry` as a class field and optional constructor parameter in `src/session.ts`. Add the field declaration after `private writer`:

```typescript
  private pidRegistry?: ChildPidRegistry;
```

Add a ninth optional parameter to the constructor (no `private` keyword — it's a plain class, not using parameter properties):

```typescript
    pidRegistry?: ChildPidRegistry,
```

And in the constructor body, after `this.writer = writer ?? (...)`:

```typescript
    this.pidRegistry = pidRegistry;
```

In `src/daemon.ts`:
1. Import `ChildPidRegistry` and `join`/`homedir`.
2. In the constructor, create the registry: `this.pidRegistry = new ChildPidRegistry(join(homedir(), ".acpx-node-daemon-children.json"))`.
3. In `start()`, before the IPC server starts, kill orphans:

```typescript
    // Kill orphaned claude processes from a previous crash
    for (const pid of this.pidRegistry.list()) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    this.pidRegistry.clear();
```

4. Pass `this.pidRegistry` to `new Session(...)` calls.

- [ ] **Step 6: Run full test suite**

Run: `npm run build && npx vitest run -v`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/child-pid-registry.ts tests/child-pid-registry.test.ts src/session.ts src/daemon.ts
git commit -m "feat: track child PIDs and kill orphans on daemon restart"
```

---

### Task 6: Add exponential backoff to waitForDaemon

`waitForDaemon` polls with a fixed 1-second interval, 10 attempts max. On slow nodes this causes spurious failures. Add exponential backoff.

**Files:**
- Modify: `plugin/src/daemon-manager.ts:96-106`

- [ ] **Step 1: Replace fixed-interval polling with exponential backoff**

In `plugin/src/daemon-manager.ts`, replace `waitForDaemon`:

```typescript
  private async waitForDaemon(nodeId: string, bridge: NodeBridge, maxAttempts = 12): Promise<boolean> {
    let delayMs = 500;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const ping = await bridge.exec(nodeId, [...this.daemonBin, "status", "ping"], { timeoutMs: 10_000 });
      if (ping.success && ping.stdout.includes("alive")) {
        this.nodeStatus.set(nodeId, "running");
        return true;
      }
      delayMs = Math.min(delayMs * 1.5, 5000); // Cap at 5s between polls
    }
    return false;
  }
```

This gives a total wait of ~40s instead of 10s, with faster initial checks (500ms, 750ms, 1125ms, ..., capped at 5s).

- [ ] **Step 2: Build plugin**

Run: `npm run build && cd plugin && npx tsc`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add plugin/src/daemon-manager.ts
git commit -m "fix: use exponential backoff in waitForDaemon polling"
```

---

## Execution Order

Tasks are independent and can be parallelized:
- **Tasks 1, 2, 5** touch different daemon-side files and can run in parallel.
- **Task 3** is plugin-only.
- **Task 4** depends on Task 1 (uses the `webUI.removeSession` call wired in the TTL callback).
- **Task 6** is plugin-only and fully independent.

Recommended serial order for review clarity: 1 → 2 → 4 → 3 → 5 → 6.
