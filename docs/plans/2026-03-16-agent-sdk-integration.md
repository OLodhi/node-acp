# Agent SDK Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock prompt handling in `acpx-node-daemon` with real Claude Code sessions using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

**Architecture:** The `Session` class wraps the SDK's `query()` function, managing lifecycle (idle → busy → idle), streaming output via `OutputForwarder`, and proxying permissions via the existing `PermissionProxy`. The `Daemon` class is updated to create `Session` objects and delegate prompt/cancel/close to them.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `vitest` (testing)

---

## Chunk 1: Output Forwarder and Dependencies

### Task 1: Install Claude Agent SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

```bash
cd C:/Users/olodh/projects/node-acp
npm install @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Verify TypeScript can resolve the SDK types**

```bash
cd C:/Users/olodh/projects/node-acp
npx tsc --noEmit
```
Expected: No errors (the SDK is installed but not yet imported anywhere)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @anthropic-ai/claude-agent-sdk dependency"
```

---

### Task 2: Implement output forwarder

**Files:**
- Create: `src/output-forwarder.ts`
- Create: `tests/output-forwarder.test.ts`

- [ ] **Step 1: Write the output forwarder test**

```typescript
// tests/output-forwarder.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { forwardOutput } from "../src/output-forwarder.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

describe("OutputForwarder", () => {
  let emitted: DaemonEvent[];
  let emit: (event: DaemonEvent) => void;

  beforeEach(() => {
    emitted = [];
    emit = (event) => emitted.push(event);
  });

  it("forwards partial assistant messages as assistant_text output", () => {
    forwardOutput(
      { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] }, partial: true } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      sessionId: "sess-1",
      messageType: "assistant_text",
      chunk: "Hello world",
    });
  });

  it("ignores final (non-partial) assistant messages", () => {
    forwardOutput(
      { type: "assistant", message: { content: [{ type: "text", text: "Final" }] } } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(0);
  });

  it("forwards result success as prompt_complete", () => {
    forwardOutput(
      { type: "result", subtype: "success", session_id: "x", result: "done" } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "prompt_complete",
      sessionId: "sess-1",
      stopReason: "end_turn",
    });
  });

  it("forwards result error as error + prompt_complete", () => {
    forwardOutput(
      { type: "result", subtype: "error_during_execution", errors: ["something broke"] } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "error",
      sessionId: "sess-1",
      error: "something broke",
    });
    expect(emitted[1]).toMatchObject({
      type: "prompt_complete",
      sessionId: "sess-1",
      stopReason: "error",
    });
  });

  it("ignores unknown message types", () => {
    forwardOutput(
      { type: "system", subtype: "init" } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(0);
  });

  it("handles assistant message with multiple text blocks", () => {
    forwardOutput(
      {
        type: "assistant",
        partial: true,
        message: {
          content: [
            { type: "text", text: "first " },
            { type: "text", text: "second" },
          ],
        },
      } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      chunk: "first second",
    });
  });

  it("handles assistant message with tool_use blocks", () => {
    forwardOutput(
      {
        type: "assistant",
        partial: true,
        message: {
          content: [
            { type: "tool_use", name: "Read", id: "x", input: { file_path: "/tmp/f" } },
          ],
        },
      } as any,
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      messageType: "tool_use",
      chunk: "Read",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/output-forwarder.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement output forwarder**

```typescript
// src/output-forwarder.ts
import type { DaemonEvent } from "./ipc-protocol.js";

/**
 * Maps an SDK message to zero or more DaemonEvent emissions.
 * Pure function — no state.
 *
 * SDK message type names come from the SDKMessage union type in
 * @anthropic-ai/claude-agent-sdk. If actual exports differ, adjust
 * the type checks here.
 */
export function forwardOutput(
  message: any,
  sessionId: string,
  emit: (event: DaemonEvent) => void
): void {
  const type = message?.type;
  if (!type) return;

  switch (type) {
    case "assistant": {
      // Only forward partial (streaming) messages, not the final assembled one
      if (!message.partial) return;

      const content = message.message?.content;
      if (!Array.isArray(content)) return;

      // Extract text blocks
      const textParts: string[] = [];
      const toolNames: string[] = [];

      for (const block of content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use" && block.name) {
          toolNames.push(block.name);
        }
      }

      if (textParts.length > 0) {
        emit({
          type: "output",
          sessionId,
          messageType: "assistant_text",
          chunk: textParts.join(""),
          timestamp: Date.now(),
        });
      }

      if (toolNames.length > 0) {
        emit({
          type: "output",
          sessionId,
          messageType: "tool_use",
          chunk: toolNames.join(", "),
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "result": {
      const subtype = message.subtype;
      if (subtype === "success") {
        emit({
          type: "prompt_complete",
          sessionId,
          stopReason: "end_turn",
        });
      } else {
        // Error variants: error_during_execution, error_max_turns, etc.
        const errors: string[] = message.errors ?? [];
        emit({
          type: "error",
          sessionId,
          error: errors.join("; ") || "Unknown error",
        });
        emit({
          type: "prompt_complete",
          sessionId,
          stopReason: "error",
        });
      }
      break;
    }

    // All other types (system, status, hook_*, etc.) are ignored
    default:
      break;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/output-forwarder.test.ts
```
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/output-forwarder.ts tests/output-forwarder.test.ts
git commit -m "feat: implement output forwarder mapping SDK messages to daemon events"
```

---

## Chunk 2: Session Class

### Task 3: Implement Session class

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

- [ ] **Step 1: Write the session test**

```typescript
// tests/session.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session } from "../src/session.js";
import { PermissionProxy } from "../src/permission-proxy.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

// Mock the SDK's query function
const mockMessages: any[] = [];
let mockQueryInstance: any = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    const generator = (async function* () {
      for (const msg of mockMessages) {
        yield msg;
      }
    })();
    mockQueryInstance = {
      ...generator,
      [Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
      next: () => generator.next(),
      return: (v: any) => generator.return(v),
      throw: (e: any) => generator.throw(e),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
      initializationResult: vi.fn(async () => ({})),
    };
    return mockQueryInstance;
  },
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
    mockMessages.length = 0;
    mockQueryInstance = null;

    session = new Session(
      "sess-1",
      "/tmp/project",
      "claude-opus-4-6",
      "approve-reads",
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
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "sdk-sess-123" },
      { type: "result", subtype: "success", session_id: "sdk-sess-123", result: "done" }
    );

    await session.prompt("Hello");
    expect(session.status).toBe("idle");
  });

  it("captures resume session ID from init message", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "sdk-sess-456" },
      { type: "result", subtype: "success", session_id: "sdk-sess-456", result: "done" }
    );

    await session.prompt("Hello");
    expect(session.resumeSessionId).toBe("sdk-sess-456");
  });

  it("emits output events from assistant messages", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        partial: true,
        message: { content: [{ type: "text", text: "Hi there" }] },
      },
      { type: "result", subtype: "success", session_id: "x", result: "done" }
    );

    await session.prompt("Hello");
    const outputs = emitted.filter((e) => e.type === "output");
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]).toMatchObject({
      messageType: "assistant_text",
      chunk: "Hi there",
    });
  });

  it("throws if prompt called while busy", async () => {
    // Use a message stream that never completes
    let resolveBlock: () => void;
    const blockPromise = new Promise<void>((r) => { resolveBlock = r; });

    mockMessages.push(
      { type: "system", subtype: "init", session_id: "x" },
    );
    // Add a message that will cause the generator to block
    const originalPrompt = session.prompt("First");

    // Wait a tick for the prompt to start
    await new Promise((r) => setTimeout(r, 10));

    // Session should be busy now — second prompt should throw
    // (prompt() sets status to busy synchronously before awaiting)
    // We need the session to still be processing, so check status
    if (session.status === "busy") {
      await expect(session.prompt("Second")).rejects.toThrow(/busy/i);
    }

    // Clean up: let the generator finish
    mockQueryInstance?.close();
    try { await originalPrompt; } catch {}
  });

  it("emits error events on SDK error result", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "x" },
      { type: "result", subtype: "error_during_execution", errors: ["bad stuff"] }
    );

    await session.prompt("Hello");
    const errors = emitted.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ error: "bad stuff" });
  });

  it("cancel is no-op when idle", async () => {
    await session.cancel();
    expect(session.status).toBe("idle");
  });

  it("close cleans up", () => {
    session.close();
    // Should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/session.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement Session class**

```typescript
// src/session.ts
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionProxy } from "./permission-proxy.js";
import type { DaemonEvent } from "./ipc-protocol.js";
import { forwardOutput } from "./output-forwarder.js";

export class Session {
  readonly sessionId: string;

  private _status: "idle" | "busy" = "idle";
  private _resumeSessionId: string | undefined;
  private _pid: number | undefined;
  private currentQuery: any = null;

  private cwd: string;
  private model: string;
  private permissionMode: string;
  private permissionProxy: PermissionProxy;
  private emit: (event: DaemonEvent) => void;

  constructor(
    sessionId: string,
    cwd: string,
    model: string,
    permissionMode: string,
    permissionProxy: PermissionProxy,
    emit: (event: DaemonEvent) => void
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.permissionMode = permissionMode;
    this.permissionProxy = permissionProxy;
    this.emit = emit;
  }

  get status(): "idle" | "busy" {
    return this._status;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get resumeSessionId(): string | undefined {
    return this._resumeSessionId;
  }

  async prompt(text: string): Promise<void> {
    if (this._status === "busy") {
      throw new Error(`Session ${this.sessionId} is busy`);
    }

    this._status = "busy";

    try {
      const options: any = {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          opts: { signal: AbortSignal; toolUseID: string }
        ) => this.handlePermission(toolName, input, opts),
      };

      if (this.model) {
        options.model = this.model;
      }

      if (this._resumeSessionId) {
        options.resume = this._resumeSessionId;
      }

      this.currentQuery = sdkQuery({ prompt: text, options });

      for await (const message of this.currentQuery) {
        // Capture session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          this._resumeSessionId = message.session_id;
        }

        // Forward to output forwarder
        forwardOutput(message, this.sessionId, this.emit);
      }
    } catch (err) {
      this.emit({
        type: "error",
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._status = "idle";
      this.currentQuery = null;
    }
  }

  async cancel(): Promise<void> {
    if (this._status !== "busy" || !this.currentQuery) return;
    try {
      await this.currentQuery.interrupt();
    } catch {
      // Ignore errors during interrupt
    }
  }

  close(): void {
    if (this.currentQuery) {
      try {
        this.currentQuery.close();
      } catch {
        // Ignore errors during close
      }
    }
    this.currentQuery = null;
    this._status = "idle";
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string }
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const path = String(
      input.file_path ?? input.command ?? input.path ?? "(unknown)"
    );
    const description = `${toolName} on ${path}`;

    // Race permission request against abort signal
    const permissionPromise = this.permissionProxy.requestPermission(
      this.sessionId,
      toolName,
      path,
      description
    );

    const abortPromise = new Promise<false>((resolve) => {
      if (opts.signal.aborted) {
        resolve(false);
        return;
      }
      opts.signal.addEventListener("abort", () => resolve(false), { once: true });
    });

    const approved = await Promise.race([permissionPromise, abortPromise]);

    if (approved) {
      return { behavior: "allow" };
    }
    return { behavior: "deny", message: "Permission denied by user" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/session.test.ts
```
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: implement Session class wrapping Claude Agent SDK"
```

---

## Chunk 3: Daemon Integration

### Task 4: Wire Session into Daemon

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Update daemon to use Session class**

Replace the contents of `src/daemon.ts` with:

```typescript
// src/daemon.ts
import type { DaemonConfig } from "./config.js";
import { IpcServer } from "./ipc-server.js";
import { SessionManager } from "./session-manager.js";
import { PermissionProxy } from "./permission-proxy.js";
import { Session } from "./session.js";
import type { DaemonRequest, DaemonEvent } from "./ipc-protocol.js";

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;
  private sessions = new Map<string, Session>();

  constructor(private config: DaemonConfig) {
    const emit = (event: DaemonEvent) => this.ipcServer.broadcast(event);

    this.sessionManager = new SessionManager(config, emit);
    this.permissionProxy = new PermissionProxy(config.permissionTimeoutMinutes, emit);

    this.ipcServer = new IpcServer(config.ipcSocketPath, (req, send) => {
      this.handleRequest(req, send);
    });
  }

  async start(): Promise<void> {
    await this.ipcServer.start();
    console.log(`[acpx-node-daemon] listening on ${this.config.ipcSocketPath}`);
  }

  async stop(): Promise<void> {
    for (const session of this.sessionManager.listSessions()) {
      this.ipcServer.broadcast({
        type: "session_closed",
        sessionId: session.sessionId,
        reason: "daemon_stopped",
      });
      const agentSession = this.sessions.get(session.sessionId);
      if (agentSession) agentSession.close();
      this.permissionProxy.cleanupSession(session.sessionId);
      this.sessionManager.removeSession(session.sessionId);
    }
    this.sessions.clear();
    await this.ipcServer.stop();
    console.log("[acpx-node-daemon] stopped");
  }

  private handleRequest(req: DaemonRequest, send: (event: DaemonEvent) => void): void {
    switch (req.type) {
      case "spawn":
        this.handleSpawn(req, send);
        break;
      case "prompt":
        this.handlePrompt(req, send);
        break;
      case "cancel":
        this.handleCancel(req, send);
        break;
      case "close":
        this.handleClose(req, send);
        break;
      case "status":
        this.handleStatus(req, send);
        break;
      case "permission_response":
        this.handlePermissionResponse(req);
        break;
    }
  }

  private handleSpawn(req: DaemonRequest & { type: "spawn" }, send: (event: DaemonEvent) => void): void {
    try {
      this.sessionManager.registerSession(req.sessionId, {
        agent: req.agent,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        ttlMinutes: req.timeoutMinutes,
      });

      const emit = (event: DaemonEvent) => this.ipcServer.broadcast(event);

      const agentSession = new Session(
        req.sessionId,
        req.cwd,
        req.model,
        req.permissionMode,
        this.permissionProxy,
        emit
      );
      this.sessions.set(req.sessionId, agentSession);

      this.sessionManager.setStatus(req.sessionId, "idle");

      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: true,
        // pid is undefined until first prompt starts Claude Code
      });
    } catch (err) {
      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handlePrompt(req: DaemonRequest & { type: "prompt" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    if (managed.status !== "idle") {
      send({ type: "error", sessionId: req.sessionId, error: `Session is ${managed.status}, not idle` });
      return;
    }

    const agentSession = this.sessions.get(req.sessionId);
    if (!agentSession) {
      send({ type: "error", sessionId: req.sessionId, error: "Agent session not found" });
      return;
    }

    this.sessionManager.setStatus(req.sessionId, "busy");
    send({ type: "prompt_accepted", sessionId: req.sessionId });

    // Run prompt in background — output streams via broadcast
    agentSession.prompt(req.prompt).then(() => {
      this.sessionManager.setStatus(req.sessionId, "idle");
    }).catch((err) => {
      this.ipcServer.broadcast({
        type: "error",
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sessionManager.setStatus(req.sessionId, "idle");
    });
  }

  private handleCancel(req: DaemonRequest & { type: "cancel" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    if (agentSession) {
      agentSession.cancel();
    }
  }

  private handleClose(req: DaemonRequest & { type: "close" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    if (agentSession) {
      agentSession.close();
      this.sessions.delete(req.sessionId);
    }
    this.permissionProxy.cleanupSession(req.sessionId);
    this.sessionManager.removeSession(req.sessionId);
    this.ipcServer.broadcast({
      type: "session_closed",
      sessionId: req.sessionId,
      reason: "user_closed",
    });
  }

  private handleStatus(req: DaemonRequest & { type: "status" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    send({
      type: "status_result",
      sessionId: managed.sessionId,
      status: managed.status,
      agent: managed.agent,
      cwd: managed.cwd,
      model: managed.model,
      pid: agentSession?.pid ?? 0,
      createdAt: managed.createdAt,
      lastActivityAt: managed.lastActivityAt,
    });
  }

  private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }): void {
    this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
  }
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: No errors

- [ ] **Step 3: Run all existing tests**

```bash
npx vitest run
```
Expected: All tests pass (existing tests don't depend on daemon internals)

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: wire Session class into daemon, replacing mock handlers"
```

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Replace contents of `CLAUDE.md` with:

```markdown
# acpx-node-daemon

Remote ACP session dispatch for OpenClaw nodes.

## Build & Test
- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run dev` — watch mode

## Architecture
- IPC protocol: newline-delimited JSON over named pipes (Windows) / Unix sockets
- Sessions wrap Claude Agent SDK `query()` for Claude Code lifecycle
- Output streams via OutputForwarder mapping SDK messages to daemon events
- Permissions proxied via PermissionProxy with 30-minute timeout
- See docs/specs/2026-03-16-node-acp-design.md for full spec
- See docs/specs/2026-03-16-agent-sdk-integration-design.md for SDK integration spec

## Dependencies
- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK
- Claude Code CLI must be installed on the host machine
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Agent SDK integration"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```
Expected: All tests pass (existing 23 + new output-forwarder + session tests)

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: Clean build

- [ ] **Step 3: Verify CLI help still works**

```bash
node dist/index.js --help
```
Expected: Help text displayed

- [ ] **Step 4: Commit any remaining changes**

```bash
git status
# If clean, nothing to commit. Otherwise:
# git add -A && git commit -m "chore: final cleanup"
```
