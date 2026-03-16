# Gateway Plugin (openclaw-acpx-remote) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenClaw extension that registers an `acpx-remote` ACP runtime backend, enabling Telegram users to spawn and interact with Claude Code sessions on remote nodes via `system.run` and the fire-and-poll pattern.

**Architecture:** The plugin registers an `AcpRuntime` implementation that translates ACP runtime calls into `system.run` commands executed on a remote node via `node.invoke`. The `runTurn` method uses a poll loop to drain buffered events from the node daemon every 1.5 seconds. A bundled skill teaches the agent how to route `/acp spawn --node` requests to this runtime.

**Tech Stack:** TypeScript, Node.js, OpenClaw Plugin SDK

**Spec:** `docs/specs/2026-03-16-gateway-integration-design.md` (Component 2 & 3)

**Prerequisite:** The daemon changes from `docs/plans/2026-03-16-gateway-integration.md` must be deployed on the node first.

**Important:** This is a separate package from node-acp. It will be created in a sibling directory `~/Projects/openclaw-acpx-remote/` on the gateway machine (192.168.1.24). All file paths are relative to that package root unless specified otherwise.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `openclaw.plugin.json` | Create | Plugin manifest with id, config schema, skills |
| `package.json` | Create | NPM package metadata |
| `tsconfig.json` | Create | TypeScript config (ES2022, Node16 modules) |
| `src/index.ts` | Create | Plugin entry point — default export with `register(api)` |
| `src/service.ts` | Create | Service lifecycle — creates runtime, registers ACP backend |
| `src/runtime.ts` | Create | `AcpxRemoteRuntime` implementing `AcpRuntime` interface |
| `src/node-exec.ts` | Create | Wrapper for `node.invoke system.run` calls via gateway RPC |
| `src/config.ts` | Create | Config types and defaults |
| `src/handle.ts` | Create | Encode/decode `AcpRuntimeHandle` state |
| `skills/acp-node-router/SKILL.md` | Create | Skill teaching agent remote ACP session routing |
| `tests/handle.test.ts` | Create | Handle encode/decode tests |
| `tests/runtime.test.ts` | Create | Runtime unit tests with mocked nodeExec |

---

## Task 1: Package Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `openclaw.plugin.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "openclaw-acpx-remote",
  "version": "0.1.0",
  "description": "OpenClaw plugin for remote ACP sessions on nodes via acpx-node-daemon",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "openclaw": {
    "extensions": ["./src/index.ts"]
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

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
    "sourceMap": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `openclaw.plugin.json`**

```json
{
  "id": "acpx-remote",
  "name": "Remote ACP Sessions",
  "description": "Spawn ACP sessions on remote OpenClaw nodes via the node host",
  "configSchema": {
    "type": "object",
    "properties": {
      "pollIntervalMs": {
        "type": "number",
        "default": 1500,
        "description": "Interval between drain polls in milliseconds"
      },
      "daemonBin": {
        "type": "string",
        "default": "acpx-node-daemon",
        "description": "Name or path to the daemon binary on the node"
      },
      "defaultNode": {
        "type": "string",
        "default": "",
        "description": "Default node name if --node is omitted"
      }
    }
  },
  "skills": ["skills/acp-node-router"]
}
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`

- [ ] **Step 5: Commit**

```bash
git init
git add package.json tsconfig.json openclaw.plugin.json
git commit -m "chore: scaffold openclaw-acpx-remote package"
```

---

## Task 2: Config and Handle Modules

**Files:**
- Create: `src/config.ts`
- Create: `src/handle.ts`
- Create: `tests/handle.test.ts`

- [ ] **Step 1: Write failing handle tests**

Create `tests/handle.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encodeHandle, decodeHandle } from "../src/handle.js";

describe("Handle encode/decode", () => {
  it("round-trips handle state", () => {
    const state = {
      sessionId: "abc-123",
      node: "Thinkpad-Node",
      cwd: "C:\\Users\\Omar\\Projects\\MyProject",
    };
    const handle = encodeHandle("session-key-1", state);
    expect(handle.sessionKey).toBe("session-key-1");
    expect(handle.backend).toBe("acpx-remote");

    const decoded = decodeHandle(handle);
    expect(decoded.sessionId).toBe("abc-123");
    expect(decoded.node).toBe("Thinkpad-Node");
    expect(decoded.cwd).toBe("C:\\Users\\Omar\\Projects\\MyProject");
  });

  it("stores state in runtimeSessionName as base64url", () => {
    const handle = encodeHandle("key", {
      sessionId: "test",
      node: "node1",
      cwd: "/tmp",
    });
    // runtimeSessionName should be base64url-encoded JSON
    const decoded = JSON.parse(
      Buffer.from(handle.runtimeSessionName, "base64url").toString("utf-8")
    );
    expect(decoded.sessionId).toBe("test");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/handle.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Create `src/config.ts`**

```typescript
export interface AcpxRemoteConfig {
  pollIntervalMs: number;
  daemonBin: string;
  defaultNode: string;
}

export const DEFAULT_CONFIG: AcpxRemoteConfig = {
  pollIntervalMs: 1500,
  daemonBin: "acpx-node-daemon",
  defaultNode: "",
};

export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): AcpxRemoteConfig {
  return {
    pollIntervalMs: (pluginConfig?.pollIntervalMs as number) ?? DEFAULT_CONFIG.pollIntervalMs,
    daemonBin: (pluginConfig?.daemonBin as string) ?? DEFAULT_CONFIG.daemonBin,
    defaultNode: (pluginConfig?.defaultNode as string) ?? DEFAULT_CONFIG.defaultNode,
  };
}
```

- [ ] **Step 4: Create `src/handle.ts`**

```typescript
export interface HandleState {
  sessionId: string;
  node: string;
  cwd: string;
}

export interface AcpRuntimeHandle {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
}

const BACKEND_ID = "acpx-remote";

export function encodeHandle(sessionKey: string, state: HandleState): AcpRuntimeHandle {
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64url");
  return {
    sessionKey,
    backend: BACKEND_ID,
    runtimeSessionName: encoded,
    cwd: state.cwd,
  };
}

export function decodeHandle(handle: AcpRuntimeHandle): HandleState {
  return JSON.parse(Buffer.from(handle.runtimeSessionName, "base64url").toString("utf-8"));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/handle.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/handle.ts tests/handle.test.ts
git commit -m "feat: add config and handle encode/decode modules"
```

---

## Task 3: Node Exec Helper

**Files:**
- Create: `src/node-exec.ts`

- [ ] **Step 1: Create `src/node-exec.ts`**

This module wraps gateway RPC calls to execute `system.run` commands on a node. Since we can't import `callGatewayTool` directly (it's not exported from the plugin SDK in a way plugins can use), we use the plugin's `api.runtime` to call gateway methods. The actual implementation depends on how the plugin gets access to gateway methods at runtime.

Looking at the acpx plugin, it shells out to the `acpx` CLI directly (not through `system.run`). For our plugin, we need to call `node.invoke` on the gateway. The plugin API provides `api.runtime` which we can use to call gateway methods.

```typescript
export interface NodeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export type NodeExecFn = (
  nodeName: string,
  command: string,
  timeoutMs?: number,
) => Promise<NodeExecResult>;

/**
 * Creates a nodeExec function bound to a gateway runtime.
 * The gatewayCall function is injected by the service at startup,
 * wrapping the appropriate gateway RPC mechanism.
 */
export function createNodeExec(
  gatewayCall: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>,
): NodeExecFn {
  return async (nodeName: string, command: string, timeoutMs: number = 15000): Promise<NodeExecResult> => {
    const result = await gatewayCall(
      "node.invoke",
      {
        node: nodeName,
        command: "system.run",
        params: { command, cwd: "~" },
      },
      timeoutMs,
    ) as any;

    return {
      exitCode: result?.exitCode ?? 1,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      success: result?.exitCode === 0,
    };
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/node-exec.ts
git commit -m "feat: add nodeExec helper for system.run via node.invoke"
```

---

## Task 4: AcpxRemoteRuntime — Core Methods

**Files:**
- Create: `src/runtime.ts`
- Create: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing tests for ensureSession and close**

Create `tests/runtime.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpxRemoteRuntime } from "../src/runtime.js";
import type { NodeExecFn, NodeExecResult } from "../src/node-exec.js";
import type { AcpxRemoteConfig } from "../src/config.js";

const ok = (stdout: string): NodeExecResult => ({
  exitCode: 0, stdout, stderr: "", success: true,
});

const fail = (stderr: string): NodeExecResult => ({
  exitCode: 1, stdout: "", stderr, success: false,
});

describe("AcpxRemoteRuntime", () => {
  let nodeExec: ReturnType<typeof vi.fn<NodeExecFn>>;
  let runtime: AcpxRemoteRuntime;
  const config: AcpxRemoteConfig = {
    pollIntervalMs: 100, // fast for tests
    daemonBin: "acpx-node-daemon",
    defaultNode: "",
  };

  beforeEach(() => {
    nodeExec = vi.fn<NodeExecFn>();
    runtime = new AcpxRemoteRuntime(config, nodeExec);
  });

  it("ensureSession spawns on node and returns handle", async () => {
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "spawn_result",
      sessionId: "sess-1",
      success: true,
    }) + "\n"));

    const handle = await runtime.ensureSession({
      sessionKey: "key-1",
      agent: "claude",
      mode: "persistent",
      cwd: "/tmp/project",
      node: "Thinkpad-Node",
    });

    expect(handle.sessionKey).toBe("key-1");
    expect(handle.backend).toBe("acpx-remote");
    expect(nodeExec).toHaveBeenCalledOnce();
    const cmd = nodeExec.mock.calls[0][1];
    expect(cmd).toContain("acpx-node-daemon spawn");
    expect(cmd).toContain("--cwd /tmp/project");
    expect(cmd).toContain("--session-id");
  });

  it("ensureSession throws on spawn failure", async () => {
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "spawn_result",
      sessionId: "sess-1",
      success: false,
      error: "max concurrent sessions reached",
    }) + "\n"));

    await expect(runtime.ensureSession({
      sessionKey: "key-1",
      agent: "claude",
      mode: "persistent",
      cwd: "/tmp",
      node: "Thinkpad-Node",
    })).rejects.toThrow(/max concurrent/);
  });

  it("close calls close on node", async () => {
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "spawn_result", sessionId: "sess-1", success: true,
    }) + "\n"));

    const handle = await runtime.ensureSession({
      sessionKey: "key-1", agent: "claude", mode: "persistent",
      cwd: "/tmp", node: "Thinkpad-Node",
    });

    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "session_closed", sessionId: "sess-1", reason: "user_closed",
    }) + "\n"));

    await runtime.close({ handle, reason: "user_closed" });

    expect(nodeExec).toHaveBeenCalledTimes(2);
    const cmd = nodeExec.mock.calls[1][1];
    expect(cmd).toContain("close");
  });

  it("cancel calls cancel on node", async () => {
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "spawn_result", sessionId: "sess-1", success: true,
    }) + "\n"));

    const handle = await runtime.ensureSession({
      sessionKey: "key-1", agent: "claude", mode: "persistent",
      cwd: "/tmp", node: "Thinkpad-Node",
    });

    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "cancel_accepted", sessionId: "sess-1",
    }) + "\n"));

    await runtime.cancel({ handle });

    const cmd = nodeExec.mock.calls[1][1];
    expect(cmd).toContain("cancel");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/runtime.ts` — core methods**

```typescript
import { randomUUID } from "node:crypto";
import type { NodeExecFn } from "./node-exec.js";
import type { AcpxRemoteConfig } from "./config.js";
import { encodeHandle, decodeHandle, type AcpRuntimeHandle } from "./handle.js";

export interface AcpRuntimeEvent {
  type: "text_delta" | "status" | "tool_call" | "done" | "error";
  text?: string;
  message?: string;
  tag?: string;
  stopReason?: string;
  stream?: string;
  code?: string;
  retryable?: boolean;
}

export interface EnsureInput {
  sessionKey: string;
  agent: string;
  mode: string;
  cwd?: string;
  node?: string;
  resumeSessionId?: string;
}

export class AcpxRemoteRuntime {
  constructor(
    private config: AcpxRemoteConfig,
    private nodeExec: NodeExecFn,
  ) {}

  async ensureSession(input: EnsureInput): Promise<AcpRuntimeHandle> {
    const nodeName = input.node || this.config.defaultNode;
    if (!nodeName) {
      throw new Error("No node specified. Use --node <name> or set defaultNode in plugin config.");
    }

    const sessionId = randomUUID();
    const cwd = input.cwd || "~";

    const result = await this.nodeExec(
      nodeName,
      `${this.config.daemonBin} spawn --session-id ${sessionId} --cwd ${cwd}`,
    );

    if (!result.success) {
      throw new Error(`Failed to spawn session on ${nodeName}: ${result.stderr}`);
    }

    // Parse the spawn_result from stdout (first JSON line)
    const spawnResult = this.parseFirstJsonLine(result.stdout);
    if (spawnResult?.success === false) {
      throw new Error(spawnResult.error || "Spawn failed");
    }

    return encodeHandle(input.sessionKey, { sessionId, node: nodeName, cwd });
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const { sessionId, node } = decodeHandle(input.handle);
    await this.nodeExec(node, `${this.config.daemonBin} cancel ${sessionId}`);
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const { sessionId, node } = decodeHandle(input.handle);
    await this.nodeExec(node, `${this.config.daemonBin} close ${sessionId}`);
  }

  async *runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    signal?: AbortSignal;
    requestId: string;
  }): AsyncIterable<AcpRuntimeEvent> {
    // Implemented in Task 5
    throw new Error("Not implemented");
  }

  private parseFirstJsonLine(stdout: string): any {
    const firstLine = stdout.split("\n").find((l) => l.trim());
    if (!firstLine) return null;
    try {
      return JSON.parse(firstLine);
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runtime.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: implement AcpxRemoteRuntime core methods (ensureSession, cancel, close)"
```

---

## Task 5: AcpxRemoteRuntime — `runTurn` Poll Loop

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing tests for runTurn**

Add to `tests/runtime.test.ts`:

```typescript
describe("runTurn", () => {
  async function setupSession(): Promise<any> {
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "spawn_result", sessionId: "sess-1", success: true,
    }) + "\n"));
    return runtime.ensureSession({
      sessionKey: "key-1", agent: "claude", mode: "persistent",
      cwd: "/tmp", node: "Thinkpad-Node",
    });
  }

  it("yields text_delta events from drain output", async () => {
    const handle = await setupSession();

    // prompt --async returns prompt_accepted
    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "prompt_accepted", sessionId: "sess-1",
    }) + "\n"));

    // first drain returns output + prompt_complete
    nodeExec.mockResolvedValueOnce(ok(
      JSON.stringify({ type: "output", sessionId: "sess-1", messageType: "assistant_text", chunk: "hello world", timestamp: 123 }) + "\n" +
      JSON.stringify({ type: "prompt_complete", sessionId: "sess-1", stopReason: "end_turn" }) + "\n"
    ));

    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle, text: "say hello", requestId: "r1",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "hello world", tag: "agent_message_chunk" });
    expect(events[1]).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("yields tool_call events for tool_use output", async () => {
    const handle = await setupSession();

    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "prompt_accepted", sessionId: "sess-1",
    }) + "\n"));

    nodeExec.mockResolvedValueOnce(ok(
      JSON.stringify({ type: "output", sessionId: "sess-1", messageType: "tool_use", chunk: "Read", timestamp: 123 }) + "\n" +
      JSON.stringify({ type: "prompt_complete", sessionId: "sess-1", stopReason: "end_turn" }) + "\n"
    ));

    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle, text: "read files", requestId: "r1",
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "tool_call", text: "Read", tag: "tool_call" });
  });

  it("yields error on prompt failure", async () => {
    const handle = await setupSession();

    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "error", sessionId: "sess-1", error: "Session is busy",
    }) + "\n"));

    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle, text: "test", requestId: "r1",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0] as any).message).toContain("Session is busy");
  });

  it("retries on transient drain failure", async () => {
    const handle = await setupSession();

    nodeExec.mockResolvedValueOnce(ok(JSON.stringify({
      type: "prompt_accepted", sessionId: "sess-1",
    }) + "\n"));

    // First drain fails
    nodeExec.mockRejectedValueOnce(new Error("WebSocket timeout"));
    // Retry succeeds
    nodeExec.mockResolvedValueOnce(ok(
      JSON.stringify({ type: "prompt_complete", sessionId: "sess-1", stopReason: "end_turn" }) + "\n"
    ));

    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle, text: "test", requestId: "r1",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("done");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL — `runTurn` throws "Not implemented".

- [ ] **Step 3: Implement `runTurn` in `src/runtime.ts`**

Replace the stub `runTurn` method:

```typescript
async *runTurn(input: {
  handle: AcpRuntimeHandle;
  text: string;
  signal?: AbortSignal;
  requestId: string;
}): AsyncIterable<AcpRuntimeEvent> {
  const { sessionId, node } = decodeHandle(input.handle);
  const encodedText = Buffer.from(input.text).toString("base64");

  // Send prompt asynchronously
  const promptResult = await this.nodeExec(
    node,
    `${this.config.daemonBin} prompt --async ${sessionId} --text-b64 ${encodedText}`,
  );

  // Check for immediate error (session not found, session busy, etc.)
  const promptResponse = this.parseFirstJsonLine(promptResult.stdout);
  if (promptResponse?.type === "error") {
    yield { type: "error", message: promptResponse.error || "Prompt failed" };
    return;
  }

  // Poll loop
  let consecutiveFailures = 0;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  const MAX_IMMEDIATE_REDRAINS = 10;

  while (true) {
    // Check abort signal
    if (input.signal?.aborted) {
      await this.cancel({ handle: input.handle });
      yield { type: "done", stopReason: "cancelled" };
      return;
    }

    // Wait for poll interval
    await this.sleep(this.config.pollIntervalMs);

    // Drain events
    let drainResult: { exitCode: number; stdout: string; stderr: string; success: boolean };
    try {
      drainResult = await this.nodeExec(
        node,
        `${this.config.daemonBin} drain ${sessionId}`,
      );
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_RETRIES) {
        yield {
          type: "error",
          message: `Lost connection to node after ${MAX_RETRIES} failed drain attempts`,
          retryable: false,
        };
        return;
      }
      await this.sleep(RETRY_DELAY_MS);
      continue;
    }

    // Parse ndjson events from stdout
    const events = this.parseNdjson(drainResult.stdout);

    // Check for "Session not found" error
    if (events.length === 1 && events[0].type === "error" && events[0].error?.includes("Session not found")) {
      yield {
        type: "error",
        message: "Session was lost (daemon may have restarted or session expired)",
        retryable: false,
      };
      return;
    }

    // Check for has_more marker
    const hasMore = events.some((e: any) => e.type === "has_more");
    const realEvents = events.filter((e: any) => e.type !== "has_more");

    // Map and yield each daemon event
    for (const event of realEvents) {
      const mapped = this.mapDaemonEvent(event);
      if (mapped) {
        yield mapped;
        if (mapped.type === "done" || mapped.type === "error") {
          return;
        }
      }
    }

    // If hasMore, drain again quickly (up to MAX_IMMEDIATE_REDRAINS times)
    if (hasMore) {
      let redrains = 0;
      while (redrains < MAX_IMMEDIATE_REDRAINS) {
        await this.sleep(100);
        redrains++;
        try {
          const moreResult = await this.nodeExec(
            node,
            `${this.config.daemonBin} drain ${sessionId}`,
          );
          const moreEvents = this.parseNdjson(moreResult.stdout);
          const moreHasMore = moreEvents.some((e: any) => e.type === "has_more");
          const moreReal = moreEvents.filter((e: any) => e.type !== "has_more");

          for (const event of moreReal) {
            const mapped = this.mapDaemonEvent(event);
            if (mapped) {
              yield mapped;
              if (mapped.type === "done" || mapped.type === "error") {
                return;
              }
            }
          }
          if (!moreHasMore) break;
        } catch {
          break; // Fall back to normal poll interval
        }
      }
    }
  }
}

private mapDaemonEvent(event: any): AcpRuntimeEvent | null {
  switch (event.type) {
    case "output":
      if (event.messageType === "assistant_text") {
        return { type: "text_delta", text: event.chunk, tag: "agent_message_chunk" };
      }
      if (event.messageType === "tool_use") {
        return { type: "tool_call", text: event.chunk, tag: "tool_call" };
      }
      return { type: "status", text: event.chunk, tag: event.messageType };
    case "prompt_complete":
      return { type: "done", stopReason: event.stopReason };
    case "error":
      return { type: "error", message: event.error };
    case "session_closed":
      return { type: "done", stopReason: `session_closed: ${event.reason}` };
    case "permission_request":
      // TODO: Permission handling requires integration with the agent's approval UI.
      // For now, yield as a status event that the agent can interpret.
      return {
        type: "status",
        text: `Permission requested: ${event.description} [permissionId: ${event.permissionId}]`,
        tag: "tool_call",
      };
    default:
      return null;
  }
}

private parseNdjson(stdout: string): any[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

private sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runtime.test.ts`
Expected: All 8 tests PASS (4 core + 4 runTurn).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: implement runTurn poll loop with retry and event mapping"
```

---

## Task 6: Plugin Entry and Service

**Files:**
- Create: `src/service.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create `src/service.ts`**

```typescript
import { AcpxRemoteRuntime } from "./runtime.js";
import { resolveConfig } from "./config.js";
import { createNodeExec } from "./node-exec.js";

const BACKEND_ID = "acpx-remote";

export function createAcpxRemoteService(opts: {
  pluginConfig: Record<string, unknown> | undefined;
}) {
  let runtime: AcpxRemoteRuntime | null = null;

  return {
    id: BACKEND_ID,

    start(ctx: any) {
      const config = resolveConfig(opts.pluginConfig);

      // Create nodeExec using the gateway call mechanism.
      // ctx provides access to gateway methods via the service context.
      // The actual gateway call mechanism depends on what's available:
      // - If ctx.callGateway exists, use it directly
      // - Otherwise, use a fallback that imports from the plugin SDK
      const gatewayCall = async (method: string, params: unknown, timeoutMs: number) => {
        // This will be refined during integration testing.
        // The plugin SDK's callGatewayTool or ctx.runtime.callGateway
        // provides the actual implementation.
        if (ctx.callGateway) {
          return ctx.callGateway(method, params, { timeoutMs });
        }
        throw new Error("No gateway call mechanism available");
      };

      const nodeExec = createNodeExec(gatewayCall);
      runtime = new AcpxRemoteRuntime(config, nodeExec);

      // Register as ACP runtime backend
      // This import path depends on the plugin SDK's exports
      try {
        const { registerAcpRuntimeBackend } = require("openclaw/plugin-sdk/acpx");
        registerAcpRuntimeBackend({
          id: BACKEND_ID,
          runtime: runtime as any,
          healthy: () => true,
        });
        ctx.logger.info(`[acpx-remote] registered ACP runtime backend "${BACKEND_ID}"`);
      } catch (err) {
        ctx.logger.error(`[acpx-remote] failed to register ACP runtime backend: ${err}`);
      }
    },

    stop(ctx: any) {
      try {
        const { unregisterAcpRuntimeBackend } = require("openclaw/plugin-sdk/acpx");
        unregisterAcpRuntimeBackend(BACKEND_ID);
      } catch {
        // Ignore errors during cleanup
      }
      runtime = null;
      ctx.logger.info(`[acpx-remote] stopped`);
    },
  };
}
```

- [ ] **Step 2: Create `src/index.ts`**

```typescript
import { createAcpxRemoteService } from "./service.js";

const plugin = {
  id: "acpx-remote",
  name: "Remote ACP Sessions",
  description: "Spawn ACP sessions on remote OpenClaw nodes via the node host.",

  register(api: any) {
    api.registerService(
      createAcpxRemoteService({ pluginConfig: api.pluginConfig }),
    );
  },
};

export default plugin;
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build`
Expected: Compiles successfully. (May have warnings about `require` — acceptable for plugin SDK imports that are resolved at runtime.)

- [ ] **Step 4: Commit**

```bash
git add src/service.ts src/index.ts
git commit -m "feat: add plugin entry point and service lifecycle"
```

---

## Task 7: ACP Node Router Skill

**Files:**
- Create: `skills/acp-node-router/SKILL.md`

- [ ] **Step 1: Create the skill**

Create `skills/acp-node-router/SKILL.md`:

```markdown
---
name: acp-node-router
description: Route coding session requests to remote OpenClaw nodes via acpx-node-daemon. Handles /acp spawn --node, session prompting, permission approval, and /acp exit.
user-invocable: false
---

# Remote ACP Session Routing

## When to activate

Activate when the user mentions any of:
- `/acp spawn --node` or `/acp spawn` with a `--node` flag
- Starting a coding session on a specific node/machine
- References to "Thinkpad", "node", or remote machine names in the context of coding tasks

## Spawning a session

When the user says `/acp spawn --node <NodeName> --cwd <path>`:

1. Call `sessions_spawn` with:
   - `runtime: "acpx-remote"`
   - `agent: "claude"`
   - `node: "<NodeName>"`
   - `cwd: "<path>"`
   - `mode: "persistent"`

2. On success, respond: "Claude Code session started on <NodeName> in <path>"

3. On failure:
   - Node not connected: "NodeName is not connected. Make sure the node host is running."
   - Daemon not running: "acpx-node-daemon is not running on NodeName. Start it with: acpx-node-daemon start"
   - Max sessions: "Maximum concurrent sessions reached on NodeName."

## During an active session

While a remote ACP session is active:

- Route ALL user messages as prompts to the active session
- Do NOT interpret user messages as general bot commands (unless they are `/acp` commands)
- Output from the session arrives in batches (1-2 second delay is normal)
- If the user sends a message while a prompt is still processing, inform them: "The previous prompt is still running. Please wait for it to complete."

## Permission requests

When the session yields a permission request:

- Display it to the user with Approve/Deny options
- Format: "Claude Code wants to [operation] on [path] — [Approve] [Deny]"
- When the user responds, send the permission response back to the session

## Ending a session

When the user says `/acp exit` or `/acp close`:

1. Call `close` on the active session handle with reason "user_closed"
2. Respond: "Claude Code session closed."
3. Return to normal bot operation

## Session timeout

If the session closes due to TTL expiry (120 minutes of inactivity):

- Inform the user: "Claude Code session timed out after 2 hours of inactivity."
- Return to normal bot operation

## Error handling

| Scenario | Response |
|----------|----------|
| Node disconnects mid-session | "Lost connection to NodeName. The session may still be running — try again when the node reconnects." |
| Daemon crashes | "acpx-node-daemon on NodeName is not responding. The session has been lost." |
| Session not found | "The session was not found. It may have expired or the daemon was restarted." |
| Unknown error | "An error occurred: [error message]" |
```

- [ ] **Step 2: Commit**

```bash
git add skills/acp-node-router/SKILL.md
git commit -m "feat: add acp-node-router skill for remote session routing"
```

---

## Task 8: Build, Test, and Install on Gateway

**Files:** None (verification and deployment)

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Install the plugin on the gateway**

The plugin needs to be installed as an OpenClaw extension. Two approaches:

**Option A — path-based install (for development):**

Add to `~/.openclaw/openclaw.json` on the gateway:

```json
{
  "plugins": {
    "entries": {
      "acpx-remote": {
        "enabled": true
      }
    },
    "installs": {
      "acpx-remote": {
        "source": "path",
        "path": "/home/omar/Projects/openclaw-acpx-remote"
      }
    }
  }
}
```

**Option B — npm install:**

```bash
cd ~/.npm-global/lib/node_modules/openclaw/extensions/
cp -r ~/Projects/openclaw-acpx-remote ./acpx-remote
```

- [ ] **Step 4: Restart OpenClaw gateway**

```bash
openclaw gateway restart
```

Verify in logs that the plugin loaded:
```bash
tail -f ~/.openclaw/logs/gateway.log | grep acpx-remote
```
Expected: `[acpx-remote] registered ACP runtime backend "acpx-remote"`

- [ ] **Step 5: End-to-end test via Telegram**

Prerequisites:
- acpx-node-daemon running on the Thinkpad node
- Node host connected to gateway
- Plugin installed and gateway restarted

Test sequence in Telegram:
1. Send: `/acp spawn --node Thinkpad --cwd C:\Users\Omar.Lodhi\Projects\node-acp`
2. Expected: "Claude Code session started on Thinkpad in C:\Users\Omar.Lodhi\Projects\node-acp"
3. Send: "what files are in this directory?"
4. Expected: Output arrives within 2-3 seconds showing file list
5. Send: `/acp exit`
6. Expected: "Claude Code session closed."

- [ ] **Step 6: Final commit with any fixes from testing**

```bash
git add -A
git commit -m "chore: final adjustments after E2E testing"
```
