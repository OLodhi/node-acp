# Node ACP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `acpx-node-daemon`, a standalone daemon that manages ACP coding sessions (Claude Code) on OpenClaw nodes, communicating via newline-delimited JSON IPC.

**Architecture:** A Node.js daemon process exposes an IPC server over named pipes (Windows) or Unix sockets. It receives spawn/prompt/cancel/close commands, delegates to ACPX's queue owner for agent lifecycle, and streams output + permission requests back to the caller.

**Tech Stack:** TypeScript, Node.js `net` module (IPC), `acpx` (library), `@agentclientprotocol/sdk`, `vitest` (testing)

---

## Chunk 1: Project Scaffold and IPC Protocol

### Task 1: Initialize TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `CLAUDE.md`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "acpx-node-daemon",
  "version": "0.1.0",
  "description": "Remote ACP session dispatch for OpenClaw nodes",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "acpx-node-daemon": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "MIT",
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create stub entry point**

```typescript
// src/index.ts
#!/usr/bin/env node
console.log("acpx-node-daemon v0.1.0");
```

- [ ] **Step 4: Create CLAUDE.md**

```markdown
# acpx-node-daemon

Remote ACP session dispatch for OpenClaw nodes.

## Build & Test
- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run dev` — watch mode

## Architecture
- IPC protocol: newline-delimited JSON over named pipes (Windows) / Unix sockets
- Sessions wrap ACPX queue owner for Claude Code lifecycle
- See docs/specs/2026-03-16-node-acp-design.md for full spec
```

- [ ] **Step 5: Install dependencies and verify build**

```bash
cd C:/Users/olodh/Projects/node-acp
npm install
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: initialize TypeScript project scaffold"
```

---

### Task 2: Define IPC protocol types

**Files:**
- Create: `src/ipc-protocol.ts`
- Create: `tests/ipc-protocol.test.ts`

- [ ] **Step 1: Write the protocol test**

```typescript
// tests/ipc-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  serializeMessage,
  deserializeMessage,
  type DaemonRequest,
  type DaemonEvent,
} from "../src/ipc-protocol.js";

describe("IPC Protocol", () => {
  it("serializes a spawn request", () => {
    const req: DaemonRequest = {
      type: "spawn",
      sessionId: "test-123",
      agent: "claude",
      cwd: "C:\\Users\\Omar\\Projects\\MyProject",
      model: "claude-opus-4-6",
      permissionMode: "approve-reads",
      timeoutMinutes: 120,
    };
    const serialized = serializeMessage(req);
    expect(serialized).toBe(JSON.stringify(req) + "\n");
  });

  it("deserializes a spawn_result event", () => {
    const event: DaemonEvent = {
      type: "spawn_result",
      sessionId: "test-123",
      success: true,
      pid: 12345,
    };
    const line = JSON.stringify(event);
    const result = deserializeMessage(line);
    expect(result).toEqual(event);
  });

  it("deserializes an output event", () => {
    const event: DaemonEvent = {
      type: "output",
      sessionId: "test-123",
      messageType: "assistant_text",
      chunk: "Reading src/auth.ts...",
      timestamp: 1773600000000,
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("deserializes a permission_request event", () => {
    const event: DaemonEvent = {
      type: "permission_request",
      sessionId: "test-123",
      permissionId: "perm-456",
      operation: "writeFile",
      path: "C:\\Users\\Omar\\Projects\\src\\auth.ts",
      description: "Write 45 lines to src/auth.ts",
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("rejects invalid JSON", () => {
    expect(() => deserializeMessage("not json")).toThrow();
  });

  it("rejects messages missing type field", () => {
    expect(() => deserializeMessage('{"sessionId":"x"}')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/ipc-protocol.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement IPC protocol types**

```typescript
// src/ipc-protocol.ts

// --- Inbound: node host → daemon ---

export interface SpawnRequest {
  type: "spawn";
  sessionId: string;
  agent: string;
  cwd: string;
  model: string;
  permissionMode: string;
  timeoutMinutes: number;
}

export interface PromptRequest {
  type: "prompt";
  sessionId: string;
  prompt: string;
}

export interface CancelRequest {
  type: "cancel";
  sessionId: string;
}

export interface CloseRequest {
  type: "close";
  sessionId: string;
}

export interface StatusRequest {
  type: "status";
  sessionId: string;
}

export interface PermissionResponseRequest {
  type: "permission_response";
  sessionId: string;
  permissionId: string;
  approved: boolean;
}

export type DaemonRequest =
  | SpawnRequest
  | PromptRequest
  | CancelRequest
  | CloseRequest
  | StatusRequest
  | PermissionResponseRequest;

// --- Outbound: daemon → node host ---

export interface SpawnResultEvent {
  type: "spawn_result";
  sessionId: string;
  success: boolean;
  pid?: number;
  error?: string;
}

export interface PromptAcceptedEvent {
  type: "prompt_accepted";
  sessionId: string;
}

export interface OutputEvent {
  type: "output";
  sessionId: string;
  messageType: string;
  chunk: string;
  timestamp: number;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  sessionId: string;
  permissionId: string;
  operation: string;
  path: string;
  description: string;
}

export interface PromptCompleteEvent {
  type: "prompt_complete";
  sessionId: string;
  stopReason: string;
}

export interface ErrorEvent {
  type: "error";
  sessionId: string;
  error: string;
}

export interface SessionClosedEvent {
  type: "session_closed";
  sessionId: string;
  reason: string;
}

export interface StatusResultEvent {
  type: "status_result";
  sessionId: string;
  status: string;
  agent: string;
  cwd: string;
  model: string;
  pid: number;
  createdAt: number;
  lastActivityAt: number;
}

export type DaemonEvent =
  | SpawnResultEvent
  | PromptAcceptedEvent
  | OutputEvent
  | PermissionRequestEvent
  | PromptCompleteEvent
  | ErrorEvent
  | SessionClosedEvent
  | StatusResultEvent;

// --- Serialization ---

export function serializeMessage(msg: DaemonRequest | DaemonEvent): string {
  return JSON.stringify(msg) + "\n";
}

export function deserializeMessage(line: string): DaemonRequest | DaemonEvent {
  const trimmed = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON: ${trimmed.slice(0, 100)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error(`Message missing 'type' field: ${trimmed.slice(0, 100)}`);
  }
  return parsed as DaemonRequest | DaemonEvent;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/ipc-protocol.test.ts
```
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: define IPC protocol types with serialization"
```

---

### Task 3: Build IPC server

**Files:**
- Create: `src/ipc-server.ts`
- Create: `tests/ipc-server.test.ts`

- [ ] **Step 1: Write the IPC server test**

```typescript
// tests/ipc-server.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createConnection } from "node:net";
import { IpcServer } from "../src/ipc-server.js";
import { serializeMessage, type DaemonRequest, type DaemonEvent } from "../src/ipc-protocol.js";

const TEST_PIPE = process.platform === "win32"
  ? "\\\\.\\pipe\\acpx-node-daemon-test-" + process.pid
  : "/tmp/acpx-node-daemon-test-" + process.pid + ".sock";

let server: IpcServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe("IpcServer", () => {
  it("starts and accepts connections", async () => {
    const requests: DaemonRequest[] = [];
    server = new IpcServer(TEST_PIPE, (req, send) => {
      requests.push(req);
    });
    await server.start();

    const client = createConnection(TEST_PIPE);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    const req: DaemonRequest = {
      type: "status",
      sessionId: "test-123",
    };
    client.write(serializeMessage(req));

    await new Promise((r) => setTimeout(r, 50));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(req);

    client.destroy();
  });

  it("sends events back to connected clients", async () => {
    let sendFn: ((event: DaemonEvent) => void) | null = null;
    server = new IpcServer(TEST_PIPE, (_req, send) => {
      sendFn = send;
    });
    await server.start();

    const client = createConnection(TEST_PIPE);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    // Trigger a request so we get the send function
    client.write(serializeMessage({ type: "status", sessionId: "x" }));
    await new Promise((r) => setTimeout(r, 50));

    const received: string[] = [];
    client.on("data", (data) => received.push(data.toString()));

    const event: DaemonEvent = {
      type: "status_result",
      sessionId: "x",
      status: "idle",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      pid: 123,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    sendFn!(event);

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThan(0);
    const parsed = JSON.parse(received[0].trim());
    expect(parsed.type).toBe("status_result");
    expect(parsed.sessionId).toBe("x");

    client.destroy();
  });

  it("stops cleanly", async () => {
    server = new IpcServer(TEST_PIPE, () => {});
    await server.start();
    await server.stop();
    server = null;

    // Verify cannot connect after stop
    const client = createConnection(TEST_PIPE);
    const error = await new Promise<Error>((resolve) => {
      client.on("error", resolve);
    });
    expect(error.message).toMatch(/ENOENT|ECONNREFUSED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/ipc-server.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement IPC server**

```typescript
// src/ipc-server.ts
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import {
  deserializeMessage,
  serializeMessage,
  type DaemonRequest,
  type DaemonEvent,
} from "./ipc-protocol.js";

export type RequestHandler = (
  request: DaemonRequest,
  send: (event: DaemonEvent) => void
) => void;

export class IpcServer {
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();

  constructor(
    private socketPath: string,
    private onRequest: RequestHandler
  ) {}

  async start(): Promise<void> {
    // Clean up stale socket
    try {
      unlinkSync(this.socketPath);
    } catch {}

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        try {
          unlinkSync(this.socketPath);
        } catch {}
        this.server = null;
        resolve();
      });
    });
  }

  broadcast(event: DaemonEvent): void {
    const data = serializeMessage(event);
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data);
      }
    }
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";

    const send = (event: DaemonEvent) => {
      if (!socket.destroyed) {
        socket.write(serializeMessage(event));
      }
    };

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = deserializeMessage(line) as DaemonRequest;
          this.onRequest(request, send);
        } catch (err) {
          send({
            type: "error",
            sessionId: "unknown",
            error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
    });

    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/ipc-server.test.ts
```
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement IPC server with ndjson over named pipes"
```

---

## Chunk 2: Configuration and Session Manager

### Task 4: Configuration module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write config test**

```typescript
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig, type DaemonConfig } from "../src/config.js";

describe("Config", () => {
  it("returns defaults when no overrides", () => {
    const config = loadConfig({});
    expect(config.maxConcurrentSessions).toBe(4);
    expect(config.defaultAgent).toBe("claude");
    expect(config.defaultModel).toBe("claude-opus-4-6");
    expect(config.defaultPermissionMode).toBe("approve-reads");
    expect(config.defaultTtlMinutes).toBe(120);
    expect(config.permissionTimeoutMinutes).toBe(30);
  });

  it("overrides defaults with provided values", () => {
    const config = loadConfig({ maxConcurrentSessions: 8, defaultTtlMinutes: 60 });
    expect(config.maxConcurrentSessions).toBe(8);
    expect(config.defaultTtlMinutes).toBe(60);
    expect(config.defaultAgent).toBe("claude"); // unchanged
  });

  it("resolves platform-specific socket path", () => {
    const config = loadConfig({});
    if (process.platform === "win32") {
      expect(config.ipcSocketPath).toMatch(/\\\\.\\pipe\\/);
    } else {
      expect(config.ipcSocketPath).toMatch(/\.sock$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/config.test.ts
```

- [ ] **Step 3: Implement config module**

```typescript
// src/config.ts

export interface DaemonConfig {
  maxConcurrentSessions: number;
  defaultAgent: string;
  defaultModel: string;
  defaultPermissionMode: string;
  defaultTtlMinutes: number;
  permissionTimeoutMinutes: number;
  ipcSocketPath: string;
}

const DEFAULT_SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\acpx-node-daemon"
    : "/tmp/acpx-node-daemon.sock";

export function loadConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  return {
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
    defaultAgent: overrides.defaultAgent ?? "claude",
    defaultModel: overrides.defaultModel ?? "claude-opus-4-6",
    defaultPermissionMode: overrides.defaultPermissionMode ?? "approve-reads",
    defaultTtlMinutes: overrides.defaultTtlMinutes ?? 120,
    permissionTimeoutMinutes: overrides.permissionTimeoutMinutes ?? 30,
    ipcSocketPath: overrides.ipcSocketPath ?? DEFAULT_SOCKET_PATH,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/config.test.ts
```
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add configuration module with defaults"
```

---

### Task 5: Permission proxy

**Files:**
- Create: `src/permission-proxy.ts`
- Create: `tests/permission-proxy.test.ts`

- [ ] **Step 1: Write permission proxy test**

```typescript
// tests/permission-proxy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionProxy } from "../src/permission-proxy.js";

describe("PermissionProxy", () => {
  let proxy: PermissionProxy;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];
    proxy = new PermissionProxy(0.01, (event) => emittedEvents.push(event)); // 0.01 min = 600ms timeout for tests
  });

  it("creates a pending permission and emits request event", () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path/file.ts", "Write 10 lines");

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].type).toBe("permission_request");
    expect(emittedEvents[0].sessionId).toBe("sess-1");
    expect(emittedEvents[0].operation).toBe("writeFile");
    expect(typeof emittedEvents[0].permissionId).toBe("string");
  });

  it("resolves true when approved", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const permId = emittedEvents[0].permissionId;

    proxy.handleResponse("sess-1", permId, true);
    const result = await promise;
    expect(result).toBe(true);
  });

  it("resolves false when denied", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const permId = emittedEvents[0].permissionId;

    proxy.handleResponse("sess-1", permId, false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("resolves false on timeout", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const result = await promise; // 600ms timeout
    expect(result).toBe(false);
  }, 5000);

  it("cleans up pending permissions for a session", () => {
    proxy.requestPermission("sess-1", "writeFile", "/a", "d");
    proxy.requestPermission("sess-1", "writeFile", "/b", "d");
    proxy.cleanupSession("sess-1");
    // Should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/permission-proxy.test.ts
```

- [ ] **Step 3: Implement permission proxy**

```typescript
// src/permission-proxy.ts
import { randomUUID } from "node:crypto";
import type { DaemonEvent, PermissionRequestEvent } from "./ipc-protocol.js";

interface PendingPermission {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class PermissionProxy {
  private pending = new Map<string, Map<string, PendingPermission>>();

  constructor(
    private timeoutMinutes: number,
    private emit: (event: DaemonEvent) => void
  ) {}

  async requestPermission(
    sessionId: string,
    operation: string,
    path: string,
    description: string
  ): Promise<boolean> {
    const permissionId = randomUUID();

    if (!this.pending.has(sessionId)) {
      this.pending.set(sessionId, new Map());
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.get(sessionId)?.delete(permissionId);
        resolve(false);
      }, this.timeoutMinutes * 60 * 1000);

      this.pending.get(sessionId)!.set(permissionId, { resolve, timeout });

      const event: PermissionRequestEvent = {
        type: "permission_request",
        sessionId,
        permissionId,
        operation,
        path,
        description,
      };
      this.emit(event);
    });
  }

  handleResponse(sessionId: string, permissionId: string, approved: boolean): void {
    const sessionPerms = this.pending.get(sessionId);
    if (!sessionPerms) return;

    const pending = sessionPerms.get(permissionId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    sessionPerms.delete(permissionId);
    pending.resolve(approved);
  }

  cleanupSession(sessionId: string): void {
    const sessionPerms = this.pending.get(sessionId);
    if (!sessionPerms) return;

    for (const [, pending] of sessionPerms) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pending.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/permission-proxy.test.ts
```
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement permission proxy with timeout"
```

---

### Task 6: Session manager

**Files:**
- Create: `src/session-manager.ts`
- Create: `tests/session-manager.test.ts`

- [ ] **Step 1: Write session manager test**

```typescript
// tests/session-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

describe("SessionManager", () => {
  let manager: SessionManager;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];
    const config = loadConfig({ maxConcurrentSessions: 2 });
    manager = new SessionManager(config, (event) => emittedEvents.push(event));
  });

  it("tracks session state", () => {
    manager.registerSession("sess-1", {
      agent: "claude",
      cwd: "/tmp/project",
      model: "claude-opus-4-6",
      permissionMode: "approve-reads",
      ttlMinutes: 120,
    });

    const session = manager.getSession("sess-1");
    expect(session).toBeDefined();
    expect(session!.status).toBe("starting");
    expect(session!.agent).toBe("claude");
  });

  it("rejects when max concurrent sessions reached", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp/a", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.registerSession("sess-2", {
      agent: "claude", cwd: "/tmp/b", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });

    expect(() => manager.registerSession("sess-3", {
      agent: "claude", cwd: "/tmp/c", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    })).toThrow(/max concurrent/i);
  });

  it("removes session on close", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.removeSession("sess-1");
    expect(manager.getSession("sess-1")).toBeUndefined();
  });

  it("updates session status", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.setStatus("sess-1", "idle");
    expect(manager.getSession("sess-1")!.status).toBe("idle");
  });

  it("returns undefined for unknown session", () => {
    expect(manager.getSession("nonexistent")).toBeUndefined();
  });

  it("lists active sessions", () => {
    manager.registerSession("s1", {
      agent: "claude", cwd: "/a", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.registerSession("s2", {
      agent: "claude", cwd: "/b", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    expect(manager.listSessions()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/session-manager.test.ts
```

- [ ] **Step 3: Implement session manager**

```typescript
// src/session-manager.ts
import type { DaemonConfig } from "./config.js";
import type { DaemonEvent } from "./ipc-protocol.js";

export interface SessionInfo {
  agent: string;
  cwd: string;
  model: string;
  permissionMode: string;
  ttlMinutes: number;
}

export interface ManagedSession extends SessionInfo {
  sessionId: string;
  pid: number | null;
  status: "starting" | "idle" | "busy" | "closing";
  createdAt: number;
  lastActivityAt: number;
  ttlTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  constructor(
    private config: DaemonConfig,
    private emit: (event: DaemonEvent) => void
  ) {}

  registerSession(sessionId: string, info: SessionInfo): ManagedSession {
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Max concurrent sessions (${this.config.maxConcurrentSessions}) reached`
      );
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const now = Date.now();
    const session: ManagedSession = {
      ...info,
      sessionId,
      pid: null,
      status: "starting",
      createdAt: now,
      lastActivityAt: now,
      ttlTimer: null,
    };

    this.sessions.set(sessionId, session);
    this.resetTtl(sessionId);
    return session;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  setStatus(sessionId: string, status: ManagedSession["status"]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    session.lastActivityAt = Date.now();
    this.resetTtl(sessionId);
  }

  setPid(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.pid = pid;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.ttlTimer) clearTimeout(session.ttlTimer);
    this.sessions.delete(sessionId);
  }

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
    }, session.ttlMinutes * 60 * 1000);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/session-manager.test.ts
```
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement session manager with TTL and concurrency limits"
```

---

## Chunk 3: Daemon Core and CLI

### Task 7: Daemon orchestrator

**Files:**
- Create: `src/daemon.ts`

- [ ] **Step 1: Implement daemon**

```typescript
// src/daemon.ts
import type { DaemonConfig } from "./config.js";
import { IpcServer, type RequestHandler } from "./ipc-server.js";
import { SessionManager } from "./session-manager.js";
import { PermissionProxy } from "./permission-proxy.js";
import type { DaemonRequest, DaemonEvent } from "./ipc-protocol.js";

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;

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
    // Close all sessions
    for (const session of this.sessionManager.listSessions()) {
      this.permissionProxy.cleanupSession(session.sessionId);
      this.sessionManager.removeSession(session.sessionId);
    }
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
      const session = this.sessionManager.registerSession(req.sessionId, {
        agent: req.agent,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        ttlMinutes: req.timeoutMinutes,
      });

      // TODO: Task 8 — actually spawn Claude Code via ACPX queue owner here
      // For now, mark as idle (ready to accept prompts)
      this.sessionManager.setStatus(req.sessionId, "idle");

      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: true,
        pid: 0, // placeholder until ACPX integration
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
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    if (session.status !== "idle") {
      send({ type: "error", sessionId: req.sessionId, error: `Session is ${session.status}, not idle` });
      return;
    }

    this.sessionManager.setStatus(req.sessionId, "busy");
    send({ type: "prompt_accepted", sessionId: req.sessionId });

    // TODO: Task 8 — forward prompt to ACPX queue owner
    // For now, send a mock response
    this.ipcServer.broadcast({
      type: "output",
      sessionId: req.sessionId,
      messageType: "assistant_text",
      chunk: `[mock] Received prompt: ${req.prompt}`,
      timestamp: Date.now(),
    });
    this.ipcServer.broadcast({
      type: "prompt_complete",
      sessionId: req.sessionId,
      stopReason: "end_turn",
    });
    this.sessionManager.setStatus(req.sessionId, "idle");
  }

  private handleCancel(req: DaemonRequest & { type: "cancel" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    // TODO: Task 8 — cancel via ACPX
    this.sessionManager.setStatus(req.sessionId, "idle");
  }

  private handleClose(req: DaemonRequest & { type: "close" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    this.permissionProxy.cleanupSession(req.sessionId);
    this.sessionManager.removeSession(req.sessionId);
    // TODO: Task 8 — kill ACPX queue owner process
    this.ipcServer.broadcast({
      type: "session_closed",
      sessionId: req.sessionId,
      reason: "user_closed",
    });
  }

  private handleStatus(req: DaemonRequest & { type: "status" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    send({
      type: "status_result",
      sessionId: session.sessionId,
      status: session.status,
      agent: session.agent,
      cwd: session.cwd,
      model: session.model,
      pid: session.pid ?? 0,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    });
  }

  private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }): void {
    this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement daemon orchestrator with request routing"
```

---

### Task 8: CLI entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement CLI**

```typescript
// src/index.ts
#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Daemon } from "./daemon.js";
import { loadConfig } from "./config.js";
import { serializeMessage, deserializeMessage, type DaemonEvent } from "./ipc-protocol.js";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`acpx-node-daemon v0.1.0

Usage:
  acpx-node-daemon start                              Start the daemon
  acpx-node-daemon spawn --agent <agent> --cwd <path> Spawn a session
  acpx-node-daemon prompt <sessionId> <text>           Send a prompt
  acpx-node-daemon status <sessionId>                  Check session status
  acpx-node-daemon cancel <sessionId>                  Cancel current turn
  acpx-node-daemon close <sessionId>                   Close a session
  acpx-node-daemon stop                                Stop the daemon`);
  process.exit(0);
}

const config = loadConfig({});

if (command === "start") {
  const daemon = new Daemon(config);
  await daemon.start();

  const shutdown = async () => {
    console.log("\nShutting down...");
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  // Client commands — connect to running daemon
  const client = createConnection(config.ipcSocketPath);

  client.on("error", (err) => {
    console.error(`Cannot connect to daemon: ${err.message}`);
    console.error("Is the daemon running? Start it with: acpx-node-daemon start");
    process.exit(1);
  });

  await new Promise<void>((resolve) => client.on("connect", resolve));

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
        console.log(JSON.stringify(event, null, 2));

        // Exit after terminal events
        if (
          event.type === "spawn_result" ||
          event.type === "status_result" ||
          event.type === "error" ||
          event.type === "session_closed" ||
          event.type === "prompt_complete"
        ) {
          client.destroy();
        }
      }
    });
  };

  switch (command) {
    case "spawn": {
      const agent = getFlag(args, "--agent") ?? config.defaultAgent;
      const cwd = getFlag(args, "--cwd");
      if (!cwd) {
        console.error("Error: --cwd is required");
        process.exit(1);
      }
      sendAndListen({
        type: "spawn",
        sessionId: randomUUID(),
        agent,
        cwd,
        model: getFlag(args, "--model") ?? config.defaultModel,
        permissionMode: config.defaultPermissionMode,
        timeoutMinutes: config.defaultTtlMinutes,
      });
      break;
    }
    case "prompt": {
      const sessionId = args[1];
      const prompt = args.slice(2).join(" ");
      if (!sessionId || !prompt) {
        console.error("Usage: acpx-node-daemon prompt <sessionId> <text>");
        process.exit(1);
      }
      sendAndListen({ type: "prompt", sessionId, prompt });
      break;
    }
    case "status": {
      const sessionId = args[1];
      if (!sessionId) { console.error("Usage: acpx-node-daemon status <sessionId>"); process.exit(1); }
      sendAndListen({ type: "status", sessionId });
      break;
    }
    case "cancel": {
      const sessionId = args[1];
      if (!sessionId) { console.error("Usage: acpx-node-daemon cancel <sessionId>"); process.exit(1); }
      sendAndListen({ type: "cancel", sessionId });
      break;
    }
    case "close": {
      const sessionId = args[1];
      if (!sessionId) { console.error("Usage: acpx-node-daemon close <sessionId>"); process.exit(1); }
      sendAndListen({ type: "close", sessionId });
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
```

- [ ] **Step 2: Build and test CLI**

```bash
npm run build
node dist/index.js --help
```
Expected: Help text displayed

- [ ] **Step 3: Integration test — start daemon, spawn, prompt, close**

```bash
# Terminal 1: start daemon
node dist/index.js start

# Terminal 2: spawn a session
node dist/index.js spawn --agent claude --cwd /tmp/test-project

# Note the sessionId from output, then:
node dist/index.js prompt <sessionId> "Hello world"
node dist/index.js status <sessionId>
node dist/index.js close <sessionId>
```
Expected: Each command returns appropriate JSON events

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: implement CLI entry point with start/spawn/prompt/status/close commands"
```

---

## Chunk 4: ACPX Integration (Future)

> **Note:** This chunk integrates the real ACPX queue owner to spawn Claude Code. It depends on the `acpx` npm package being available as a library. Implementation details will be refined once Chunks 1-3 are complete and tested with the mock daemon.

### Task 9: Integrate ACPX queue owner for real Claude Code sessions

**Files:**
- Create: `src/session.ts`
- Create: `src/output-forwarder.ts`
- Modify: `src/daemon.ts` (replace TODO placeholders)

This task replaces the mock prompt handler in `daemon.ts` with real ACPX queue owner integration:
- Spawn Claude Code via ACPX's `QueueOwnerProcess`
- Forward ACPX output events through `OutputForwarder` → IPC → node host
- Hook `handlePermissionRequest` to `PermissionProxy`
- Handle agent process exit/crash

- [ ] **Step 1: Install acpx dependency**

```bash
npm install acpx @agentclientprotocol/sdk
```

- [ ] **Step 2: Implement session.ts (ACPX wrapper)**

*Implementation details TBD — depends on ACPX library API surface*

- [ ] **Step 3: Implement output-forwarder.ts**

*Implementation details TBD — maps ACPX output events to DaemonEvent*

- [ ] **Step 4: Replace daemon.ts TODO placeholders**

*Wire Session class into spawn/prompt/cancel/close handlers*

- [ ] **Step 5: E2E test with real Claude Code**

```bash
# Start daemon
node dist/index.js start

# Spawn real Claude Code session
node dist/index.js spawn --agent claude --cwd C:\Users\Omar.Lodhi\Projects\TestProject

# Send a real coding prompt
node dist/index.js prompt <sessionId> "List the files in this directory"

# Verify streaming output appears
# Close session
node dist/index.js close <sessionId>
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: integrate ACPX queue owner for real Claude Code sessions"
```

---

### Task 10: Final documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write comprehensive README**

Include: installation, configuration, CLI usage, architecture overview, protocol reference, contributing guide.

- [ ] **Step 2: Commit and push**

```bash
git add -A
git commit -m "docs: add comprehensive README with setup, usage, and protocol reference"
git push
```
