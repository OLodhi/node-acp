# Gateway Integration — Daemon Changes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add event buffering, drain command, async prompt, and CLI enhancements to the daemon so the gateway plugin can communicate via fire-and-poll over `system.run`.

**Architecture:** The daemon gains an EventBuffer that captures broadcast events per session. New CLI commands (`drain`, `permission-response`) and flags (`--async`, `--text-b64`, `--session-id`) enable the gateway plugin to interact via short-lived `system.run` shell commands instead of persistent IPC connections.

**Tech Stack:** TypeScript, Node.js, vitest

**Spec:** `docs/specs/2026-03-16-gateway-integration-design.md`

**Note:** The gateway plugin (openclaw-acpx-remote) is a separate package and will have its own implementation plan.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/event-buffer.ts` | Create | Per-session event buffer with drain, tombstone, and byte-cap logic |
| `src/ipc-protocol.ts` | Modify | Add `DrainRequest`, `DrainResultEvent`, `CancelAcceptedEvent`, `PermissionResponseResultEvent` types |
| `src/config.ts` | Modify | Add `maxBufferedEvents` config field |
| `src/daemon.ts` | Modify | Wire event buffer, add `handleDrain`, fix `handleCancel` and `handlePermissionResponse` responses |
| `src/index.ts` | Modify | Add `drain`, `permission-response` CLI commands; add `--async`, `--text-b64`, `--session-id` flags; update terminal events list |
| `tests/event-buffer.test.ts` | Create | Unit tests for EventBuffer |
| `tests/ipc-protocol.test.ts` | Modify | Add tests for new message types |
| `tests/daemon.test.ts` | Create | Unit tests for daemon drain/cancel/permission-response handling |

---

## Task 1: IPC Protocol — New Message Types

**Files:**
- Modify: `src/ipc-protocol.ts`
- Modify: `tests/ipc-protocol.test.ts`

- [ ] **Step 1: Write failing tests for new types**

Add to `tests/ipc-protocol.test.ts`:

```typescript
it("serializes a drain request", () => {
  const req: DaemonRequest = {
    type: "drain",
    sessionId: "test-123",
  };
  const serialized = serializeMessage(req);
  expect(serialized).toBe(JSON.stringify(req) + "\n");
});

it("deserializes a drain_result event", () => {
  const event: DaemonEvent = {
    type: "drain_result",
    sessionId: "test-123",
    events: [
      { type: "output", sessionId: "test-123", messageType: "assistant_text", chunk: "hello", timestamp: 1234 },
    ],
    hasMore: false,
  };
  const result = deserializeMessage(JSON.stringify(event));
  expect(result).toEqual(event);
});

it("deserializes a cancel_accepted event", () => {
  const event: DaemonEvent = {
    type: "cancel_accepted",
    sessionId: "test-123",
  };
  const result = deserializeMessage(JSON.stringify(event));
  expect(result).toEqual(event);
});

it("deserializes a permission_response_result event", () => {
  const event: DaemonEvent = {
    type: "permission_response_result",
    sessionId: "test-123",
    success: true,
  };
  const result = deserializeMessage(JSON.stringify(event));
  expect(result).toEqual(event);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ipc-protocol.test.ts`
Expected: FAIL — type errors since new types don't exist yet.

- [ ] **Step 3: Add new types to `src/ipc-protocol.ts`**

Add after `PermissionResponseRequest` (line 39):

```typescript
export interface DrainRequest {
  type: "drain";
  sessionId: string;
}
```

Add `DrainRequest` to the `DaemonRequest` union (line 41-47):

```typescript
export type DaemonRequest =
  | SpawnRequest
  | PromptRequest
  | CancelRequest
  | CloseRequest
  | StatusRequest
  | PermissionResponseRequest
  | DrainRequest;
```

Add after `StatusResultEvent` (line 109):

```typescript
export interface DrainResultEvent {
  type: "drain_result";
  sessionId: string;
  events: DaemonEvent[];
  hasMore: boolean;
}

export interface CancelAcceptedEvent {
  type: "cancel_accepted";
  sessionId: string;
}

export interface PermissionResponseResultEvent {
  type: "permission_response_result";
  sessionId: string;
  success: boolean;
}
```

Add all three to the `DaemonEvent` union (line 111-119):

```typescript
export type DaemonEvent =
  | SpawnResultEvent
  | PromptAcceptedEvent
  | OutputEvent
  | PermissionRequestEvent
  | PromptCompleteEvent
  | ErrorEvent
  | SessionClosedEvent
  | StatusResultEvent
  | DrainResultEvent
  | CancelAcceptedEvent
  | PermissionResponseResultEvent;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ipc-protocol.test.ts`
Expected: All tests PASS (10 total — 6 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/ipc-protocol.ts tests/ipc-protocol.test.ts
git commit -m "feat: add drain, cancel_accepted, permission_response_result IPC types"
```

---

## Task 2: Config — Add `maxBufferedEvents`

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/config.test.ts`, add inside the "returns defaults when no overrides" test (after the existing `expect` calls at line 11):

```typescript
expect(config.maxBufferedEvents).toBe(500);
```

Note: `tests/config.test.ts` already exists with 3 tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `maxBufferedEvents` property doesn't exist.

- [ ] **Step 3: Add `maxBufferedEvents` to config**

In `src/config.ts`, add to `DaemonConfig` interface (after line 7, before `ipcSocketPath`):

```typescript
maxBufferedEvents: number;
```

Add to `loadConfig` return (before line 24, before the `ipcSocketPath` line):

```typescript
maxBufferedEvents: overrides.maxBufferedEvents ?? 500,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add maxBufferedEvents config (default 500)"
```

---

## Task 3: EventBuffer — Core Implementation

**Files:**
- Create: `src/event-buffer.ts`
- Create: `tests/event-buffer.test.ts`

- [ ] **Step 1: Write failing tests for basic push/drain**

Create `tests/event-buffer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBuffer } from "../src/event-buffer.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new EventBuffer(500);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeOutput = (sessionId: string, chunk: string): DaemonEvent & { type: "output" } => ({
    type: "output",
    sessionId,
    messageType: "assistant_text",
    chunk,
    timestamp: Date.now(),
  });

  it("push and drain returns events in order", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.push("s1", makeOutput("s1", "world"));
    const result = buffer.drain("s1");
    expect(result.events).toHaveLength(2);
    expect((result.events[0] as any).chunk).toBe("hello");
    expect((result.events[1] as any).chunk).toBe("world");
    expect(result.hasMore).toBe(false);
  });

  it("drain clears the buffer", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.drain("s1");
    const result = buffer.drain("s1");
    expect(result.events).toHaveLength(0);
  });

  it("drain returns empty for unknown session", () => {
    const result = buffer.drain("nonexistent");
    expect(result.events).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("hasSession returns true after push", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    expect(buffer.hasSession("s1")).toBe(true);
  });

  it("hasSession returns false for unknown session", () => {
    expect(buffer.hasSession("nonexistent")).toBe(false);
  });

  it("isolates events between sessions", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.push("s2", makeOutput("s2", "world"));
    const r1 = buffer.drain("s1");
    const r2 = buffer.drain("s2");
    expect(r1.events).toHaveLength(1);
    expect(r2.events).toHaveLength(1);
    expect((r1.events[0] as any).chunk).toBe("hello");
    expect((r2.events[0] as any).chunk).toBe("world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/event-buffer.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal EventBuffer implementation**

Create `src/event-buffer.ts`:

```typescript
import type { DaemonEvent } from "./ipc-protocol.js";

export type BufferedEventType = "output" | "permission_request" | "prompt_complete" | "error" | "session_closed";

interface SessionBuffer {
  events: DaemonEvent[];
  draining: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export class EventBuffer {
  private buffers = new Map<string, SessionBuffer>();

  constructor(private maxEvents: number = 500) {}

  push(sessionId: string, event: DaemonEvent & { type: BufferedEventType }): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], draining: false };
      this.buffers.set(sessionId, buf);
    }
    if (buf.events.length >= this.maxEvents) {
      buf.events.shift();
      console.warn(`[event-buffer] session ${sessionId}: buffer full, dropping oldest event`);
    }
    buf.events.push(event);
  }

  drain(sessionId: string, maxBytes: number = 150_000): { events: DaemonEvent[]; hasMore: boolean } {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.events.length === 0) {
      return { events: [], hasMore: false };
    }

    const result: DaemonEvent[] = [];
    let totalBytes = 0;
    let hasMore = false;

    while (buf.events.length > 0) {
      const next = buf.events[0];
      const nextBytes = JSON.stringify(next).length;
      if (result.length > 0 && totalBytes + nextBytes > maxBytes) {
        hasMore = true;
        break;
      }
      result.push(buf.events.shift()!);
      totalBytes += nextBytes;
    }

    // Auto-cleanup if we drained a session_closed event
    const hasSessionClosed = result.some((e) => e.type === "session_closed");
    if (hasSessionClosed && buf.draining) {
      this.cleanup(sessionId);
    }

    return { events: result, hasMore };
  }

  markDraining(sessionId: string): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], draining: true };
      this.buffers.set(sessionId, buf);
    }
    buf.draining = true;
    // Grace period: cleanup after 60 seconds if not drained
    buf.cleanupTimer = setTimeout(() => {
      this.cleanup(sessionId);
    }, 60_000);
  }

  cleanup(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (buf?.cleanupTimer) {
      clearTimeout(buf.cleanupTimer);
    }
    this.buffers.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.buffers.has(sessionId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/event-buffer.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/event-buffer.ts tests/event-buffer.test.ts
git commit -m "feat: implement EventBuffer with per-session push/drain"
```

---

## Task 4: EventBuffer — Overflow, Tombstone, and maxBytes

**Files:**
- Modify: `tests/event-buffer.test.ts`
- Modify: `src/event-buffer.ts` (if tests reveal bugs)

- [ ] **Step 1: Write failing tests for advanced behavior**

Add to `tests/event-buffer.test.ts`:

```typescript
it("drops oldest events when buffer is full", () => {
  const small = new EventBuffer(3);
  small.push("s1", makeOutput("s1", "a"));
  small.push("s1", makeOutput("s1", "b"));
  small.push("s1", makeOutput("s1", "c"));
  small.push("s1", makeOutput("s1", "d"));
  const result = small.drain("s1");
  expect(result.events).toHaveLength(3);
  expect((result.events[0] as any).chunk).toBe("b");
  expect((result.events[2] as any).chunk).toBe("d");
});

it("returns hasMore true when events exceed maxBytes", () => {
  const bigChunk = "x".repeat(100_000);
  buffer.push("s1", makeOutput("s1", bigChunk));
  buffer.push("s1", makeOutput("s1", bigChunk));
  const result = buffer.drain("s1", 150_000);
  expect(result.events).toHaveLength(1);
  expect(result.hasMore).toBe(true);
  // Second drain gets the rest
  const result2 = buffer.drain("s1", 150_000);
  expect(result2.events).toHaveLength(1);
  expect(result2.hasMore).toBe(false);
});

it("always returns at least one event even if it exceeds maxBytes", () => {
  const bigChunk = "x".repeat(200_000);
  buffer.push("s1", makeOutput("s1", bigChunk));
  const result = buffer.drain("s1", 150_000);
  expect(result.events).toHaveLength(1);
  expect(result.hasMore).toBe(false);
});

it("markDraining keeps buffer alive after cleanup timer", () => {
  buffer.push("s1", { type: "session_closed", sessionId: "s1", reason: "ttl" } as any);
  buffer.markDraining("s1");
  expect(buffer.hasSession("s1")).toBe(true);
  // Before timer fires, drain should work
  const result = buffer.drain("s1");
  expect(result.events).toHaveLength(1);
  expect(result.events[0].type).toBe("session_closed");
  // After draining session_closed, buffer is cleaned up
  expect(buffer.hasSession("s1")).toBe(false);
});

it("markDraining auto-cleans after 60 seconds if not drained", () => {
  buffer.push("s1", { type: "session_closed", sessionId: "s1", reason: "ttl" } as any);
  buffer.markDraining("s1");
  expect(buffer.hasSession("s1")).toBe(true);
  vi.advanceTimersByTime(60_000);
  expect(buffer.hasSession("s1")).toBe(false);
});

it("cleanup clears timer and removes buffer", () => {
  buffer.push("s1", makeOutput("s1", "hello"));
  buffer.markDraining("s1");
  buffer.cleanup("s1");
  expect(buffer.hasSession("s1")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/event-buffer.test.ts`
Expected: All 12 tests PASS (6 existing + 6 new). If any fail, fix the implementation.

- [ ] **Step 3: Commit**

```bash
git add tests/event-buffer.test.ts src/event-buffer.ts
git commit -m "test: add overflow, tombstone, and maxBytes tests for EventBuffer"
```

---

## Task 5: Daemon — Wire EventBuffer and Add Drain Handler

**Files:**
- Modify: `src/daemon.ts`
- Create: `tests/daemon.test.ts`

- [ ] **Step 1: Write failing tests for daemon drain handling**

Create `tests/daemon.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { createConnection } from "node:net";
import { serializeMessage, deserializeMessage, type DaemonEvent } from "../src/ipc-protocol.js";

// Helper: send a request and collect responses
function sendRequest(socketPath: string, request: any): Promise<DaemonEvent[]> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    const events: DaemonEvent[] = [];
    let buffer = "";

    client.on("connect", () => {
      client.write(serializeMessage(request));
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        events.push(deserializeMessage(line) as DaemonEvent);
      }
    });

    client.on("error", reject);

    // Give it a moment then disconnect
    setTimeout(() => {
      client.destroy();
      resolve(events);
    }, 200);
  });
}

describe("Daemon drain/cancel/permission-response", () => {
  let daemon: Daemon;
  const socketPath = process.platform === "win32"
    ? "\\\\.\\pipe\\acpx-node-daemon-test-" + Date.now()
    : "/tmp/acpx-node-daemon-test-" + Date.now() + ".sock";

  beforeEach(async () => {
    const config = loadConfig({ ipcSocketPath: socketPath });
    daemon = new Daemon(config);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("drain returns empty for unknown session", async () => {
    const events = await sendRequest(socketPath, {
      type: "drain",
      sessionId: "nonexistent",
    });
    // Should get an error since session doesn't exist in session manager
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
  });

  it("cancel returns cancel_accepted", async () => {
    // Spawn first
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    const events = await sendRequest(socketPath, {
      type: "cancel",
      sessionId: "s1",
    });
    const accepted = events.find((e) => e.type === "cancel_accepted");
    expect(accepted).toBeDefined();
  });

  it("permission_response returns permission_response_result", async () => {
    // Spawn first
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    const events = await sendRequest(socketPath, {
      type: "permission_response",
      sessionId: "s1",
      permissionId: "perm-1",
      approved: true,
    });
    const result = events.find((e) => e.type === "permission_response_result");
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/daemon.test.ts`
Expected: FAIL — daemon doesn't handle `drain`, `cancel` doesn't send response, `permission_response` doesn't send response.

- [ ] **Step 3: Modify `src/daemon.ts`**

The key change: extract a `broadcastAndBuffer` method that both buffers events AND broadcasts to IPC clients. Replace ALL direct `this.ipcServer.broadcast()` calls for session events with `this.broadcastAndBuffer()`. This ensures the gateway can drain every event.

Add EventBuffer import (at top of file):

```typescript
import { EventBuffer } from "./event-buffer.js";
```

Add `BUFFERED_TYPES` constant and `eventBuffer` field:

```typescript
const BUFFERED_TYPES = new Set(["output", "permission_request", "prompt_complete", "error", "session_closed"]);

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;
  private sessions = new Map<string, Session>();
  private eventBuffer: EventBuffer;
```

Add the `broadcastAndBuffer` method to the class:

```typescript
private broadcastAndBuffer(event: DaemonEvent): void {
  if (BUFFERED_TYPES.has(event.type) && "sessionId" in event) {
    this.eventBuffer.push((event as any).sessionId, event as any);
  }
  this.ipcServer.broadcast(event);
}
```

Rewrite the constructor to use `broadcastAndBuffer`:

```typescript
constructor(private config: DaemonConfig) {
  this.eventBuffer = new EventBuffer(config.maxBufferedEvents);

  const emit = (event: DaemonEvent) => this.broadcastAndBuffer(event);

  this.sessionManager = new SessionManager(config, emit);
  this.permissionProxy = new PermissionProxy(config.permissionTimeoutMinutes, emit);

  this.ipcServer = new IpcServer(config.ipcSocketPath, (req, send) => {
    this.handleRequest(req, send);
  });
}
```

Note: `emit` captures `this.broadcastAndBuffer` via closure. `this.ipcServer` is assigned after `emit` is created, but `broadcastAndBuffer` reads it at call time (not capture time). This is safe because `emit` is never called during construction — `SessionManager` and `PermissionProxy` constructors don't invoke their emit callbacks.

Add `drain` case to `handleRequest` switch (after the `permission_response` case):

```typescript
case "drain":
  this.handleDrain(req, send);
  break;
```

Add the `handleDrain` method:

```typescript
private handleDrain(req: DaemonRequest & { type: "drain" }, send: (event: DaemonEvent) => void): void {
  if (!this.sessionManager.getSession(req.sessionId) && !this.eventBuffer.hasSession(req.sessionId)) {
    send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
    return;
  }
  const result = this.eventBuffer.drain(req.sessionId);
  send({
    type: "drain_result",
    sessionId: req.sessionId,
    events: result.events,
    hasMore: result.hasMore,
  });
}
```

Fix `handleCancel` to send a response (line 144-154):

```typescript
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
  send({ type: "cancel_accepted", sessionId: req.sessionId });
}
```

Fix `handlePermissionResponse` to accept `send` and return a result (line 196-198):

```typescript
private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }, send: (event: DaemonEvent) => void): void {
  this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
  send({ type: "permission_response_result", sessionId: req.sessionId, success: true });
}
```

Update the `handleRequest` switch for `permission_response` to pass `send`:

```typescript
case "permission_response":
  this.handlePermissionResponse(req, send);
  break;
```

Rewrite `handleSpawn` to use `broadcastAndBuffer` for the per-session emit (replace `const emit = ...` at line 81):

```typescript
const emit = (event: DaemonEvent) => this.broadcastAndBuffer(event);
```

Rewrite `handleClose` to use `broadcastAndBuffer` AND call `markDraining`. Replace lines 156-174:

```typescript
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
  // Use broadcastAndBuffer so the session_closed event is drainable by the gateway
  this.broadcastAndBuffer({
    type: "session_closed",
    sessionId: req.sessionId,
    reason: "user_closed",
  });
  this.eventBuffer.markDraining(req.sessionId);
}
```

Rewrite `handlePrompt` error broadcast to use `broadcastAndBuffer`. Replace the `.catch` block (lines 134-141):

```typescript
}).catch((err) => {
  this.broadcastAndBuffer({
    type: "error",
    sessionId: req.sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
  this.sessionManager.setStatus(req.sessionId, "idle");
});
```

**Important: `daemon.stop()` is intentionally NOT changed.** Per the spec, shutdown broadcasts are not buffered since the daemon process is terminating. The gateway handles daemon unavailability via its retry policy.

**TTL expiry:** The `SessionManager.resetTtl()` callback emits `session_closed` through the constructor's `emit` callback, which now routes through `broadcastAndBuffer`. So the event IS buffered automatically. However, `markDraining` is not called on TTL expiry. To fix this, wrap the SessionManager's emit callback to also call `markDraining` when a `session_closed` event is emitted:

```typescript
const emit = (event: DaemonEvent) => {
  this.broadcastAndBuffer(event);
  // When SessionManager emits session_closed (e.g. TTL expiry), mark buffer as draining
  if (event.type === "session_closed" && "sessionId" in event) {
    this.eventBuffer.markDraining((event as any).sessionId);
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/daemon.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Run ALL tests to verify nothing broke**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat: wire EventBuffer into daemon, add drain/cancel/permission-response handlers"
```

---

## Task 6: CLI — `drain` Command

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `drain` to help text**

In `src/index.ts`, update the help text (lines 12-21) to include:

```
  acpx-node-daemon drain <sessionId>                  Drain buffered events
  acpx-node-daemon permission-response <sid> <pid> <y/n> Respond to permission
```

- [ ] **Step 2: Add `drain` to the CLI switch**

Add after the `close` case (line 122):

```typescript
case "drain": {
  const sessionId = args[1];
  if (!sessionId) {
    console.error("Usage: acpx-node-daemon drain <sessionId>");
    process.exit(1);
  }
  sendAndListen({ type: "drain", sessionId });
  break;
}
```

- [ ] **Step 3: Add `drain_result` to terminal events list**

Update `sendAndListen` (lines 64-72) to include new terminal types:

```typescript
if (
  event.type === "spawn_result" ||
  event.type === "status_result" ||
  event.type === "error" ||
  event.type === "session_closed" ||
  event.type === "prompt_complete" ||
  event.type === "cancel_accepted" ||
  event.type === "drain_result" ||
  event.type === "permission_response_result"
) {
  client.destroy();
}
```

- [ ] **Step 4: For `drain_result`, print events as ndjson instead of the wrapper**

The default `sendAndListen` prints `JSON.stringify(event, null, 2)`. For `drain_result`, we want to print each inner event as one line of ndjson. Rewrite the data handler in `sendAndListen` to handle this:

```typescript
const sendAndListen = (msg: any) => {
  client.write(serializeMessage(msg));

  let buffer = "";
  client.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = deserializeMessage(line) as DaemonEvent;

      // Special handling for drain_result: print inner events as ndjson
      if (event.type === "drain_result" && "events" in event) {
        const drainResult = event as any;
        for (const inner of drainResult.events) {
          console.log(JSON.stringify(inner));
        }
        if (drainResult.hasMore) {
          console.log(JSON.stringify({ type: "has_more" }));
        }
        client.destroy();
        return;
      }

      console.log(JSON.stringify(event, null, 2));

      // Exit after terminal events
      if (
        event.type === "spawn_result" ||
        event.type === "status_result" ||
        event.type === "error" ||
        event.type === "session_closed" ||
        event.type === "prompt_complete" ||
        event.type === "cancel_accepted" ||
        event.type === "permission_response_result"
      ) {
        client.destroy();
      }
    }
  });
};
```

- [ ] **Step 5: Build and manually test**

Run: `npm run build`
Then test with daemon running:
```bash
node dist/index.js spawn --cwd /tmp
# note the sessionId
node dist/index.js drain <sessionId>
# should output empty (no events yet)
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add drain CLI command with ndjson output"
```

---

## Task 7: CLI — `permission-response` Command, `--session-id` Flag

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `permission-response` command**

Add after the `drain` case:

```typescript
case "permission-response": {
  const sessionId = args[1];
  const permissionId = args[2];
  const approved = args[3];
  if (!sessionId || !permissionId || !approved) {
    console.error("Usage: acpx-node-daemon permission-response <sessionId> <permissionId> <true|false>");
    process.exit(1);
  }
  sendAndListen({
    type: "permission_response",
    sessionId,
    permissionId,
    approved: approved === "true",
  });
  break;
}
```

- [ ] **Step 2: Add `--session-id` flag to `spawn`**

Update the spawn case (line 78-94):

```typescript
case "spawn": {
  const agent = getFlag(args, "--agent") ?? config.defaultAgent;
  const cwd = getFlag(args, "--cwd");
  if (!cwd) {
    console.error("Error: --cwd is required");
    process.exit(1);
  }
  sendAndListen({
    type: "spawn",
    sessionId: getFlag(args, "--session-id") ?? randomUUID(),
    agent,
    cwd,
    model: getFlag(args, "--model") ?? config.defaultModel,
    permissionMode: config.defaultPermissionMode,
    timeoutMinutes: config.defaultTtlMinutes,
  });
  break;
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add permission-response CLI command and --session-id spawn flag"
```

---

## Task 8: CLI — `--async` and `--text-b64` Flags for Prompt

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the `prompt` case**

Replace the prompt case (lines 96-104):

```typescript
case "prompt": {
  const sessionId = args[1];
  if (!sessionId) {
    console.error("Usage: acpx-node-daemon prompt <sessionId> [--text-b64 <b64>] [--async] [text...]");
    process.exit(1);
  }

  // Parse prompt text: --text-b64 takes priority, then positional args
  const textB64 = getFlag(args, "--text-b64");
  let prompt: string;
  if (textB64) {
    prompt = Buffer.from(textB64, "base64").toString("utf-8");
  } else {
    // Positional args: everything after sessionId that isn't a flag
    const textArgs = args.slice(2).filter((a) => a !== "--async" && a !== "--text-b64");
    prompt = textArgs.join(" ");
  }

  if (!prompt) {
    console.error("Error: prompt text required (positional args or --text-b64)");
    process.exit(1);
  }

  const isAsync = args.includes("--async");

  if (isAsync) {
    // Send prompt, wait for prompt_accepted, then disconnect
    client.write(serializeMessage({ type: "prompt", sessionId, prompt }));
    let buf = "";
    client.on("data", (data) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = deserializeMessage(line) as DaemonEvent;
        console.log(JSON.stringify(event, null, 2));
        if (event.type === "prompt_accepted" || event.type === "error") {
          client.destroy();
        }
      }
    });
  } else {
    sendAndListen({ type: "prompt", sessionId, prompt });
  }
  break;
}
```

- [ ] **Step 2: Build and manually test**

Run: `npm run build`
Test with daemon running:
```bash
# Test --text-b64
echo -n "what is 2+2" | base64
# outputs: d2hhdCBpcyAyKzI=
node dist/index.js prompt <sessionId> --text-b64 d2hhdCBpcyAyKzI= --async
# should print prompt_accepted and exit immediately

# Then drain to see output
node dist/index.js drain <sessionId>
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add --async and --text-b64 flags to prompt CLI command"
```

---

## Task 9: Build, Full Test Suite, and Manual E2E Test

**Files:** None (verification only)

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Manual E2E test of the fire-and-poll flow**

Start the daemon:
```bash
node dist/index.js start &
```

Run the full fire-and-poll flow:
```bash
# 1. Spawn with explicit session ID
node dist/index.js spawn --session-id test-e2e-1 --cwd .

# 2. Send prompt async
echo -n "what is 2+2, reply with just the number" | base64
# use the output below
node dist/index.js prompt test-e2e-1 --text-b64 <base64> --async

# 3. Wait 2 seconds, then drain
sleep 2
node dist/index.js drain test-e2e-1

# 4. Check status
node dist/index.js status test-e2e-1

# 5. Close
node dist/index.js close test-e2e-1

# 6. Drain after close (should get session_closed, then "Session not found" on next drain)
node dist/index.js drain test-e2e-1
sleep 1
node dist/index.js drain test-e2e-1
```

- [ ] **Step 4: Verify cancel flow**

```bash
node dist/index.js spawn --session-id test-e2e-2 --cwd .
node dist/index.js cancel test-e2e-2
# should print cancel_accepted
node dist/index.js close test-e2e-2
```

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "chore: final adjustments after E2E testing"
```
