# Design: Migration to OpenClaw AcpRuntime Plugin

**Date:** 2026-03-17
**Status:** Proposed
**Goal:** Convert the standalone node-acp daemon + gateway plugin into a single, installable OpenClaw plugin that implements the `AcpRuntime` interface, publishable to npm and installable via `openclaw plugins install`.

---

## 1. Current State

The system is split across two codebases with hard-coded paths and manual setup:

| Component | Location | Problem |
|-----------|----------|---------|
| Node daemon | `C:/Users/Omar.Lodhi/Projects/node-acp` on Thinkpad | Standalone, manual start, hard-coded in gateway config |
| Gateway plugin | `~/Projects/openclaw-acpx-remote` on RPi | Uses `createRequire` hack to reach OpenClaw internals, hard-coded Windows paths |
| SKILL.md | Inside gateway plugin | Custom tool routing instead of native ACP integration |

Users must: clone the daemon repo, npm install, npm build, manually start the daemon, separately install the gateway plugin, configure hard-coded paths. This is not distributable.

## 2. Target Architecture

### Key Insight: Implement `AcpRuntime` Instead of Custom Tools

The existing local `acpx` plugin registers as an **ACP runtime backend** via `registerAcpRuntimeBackend()`. This gives it native integration with OpenClaw's ACP control plane — session management, the `/acp` slash command, concurrent session limits, and agent routing all come for free.

Our remote plugin should do the same. Instead of registering 5 custom tools (`node_acp_spawn`, `node_acp_prompt`, etc.), we implement the `AcpRuntime` interface and register as a backend. OpenClaw handles the rest.

```
User: "Start a coding session on Thinkpad-Node"
  → OpenClaw ACP control plane
    → acpx-remote backend selected (configured as default or by node name)
      → ensureSession() → deploys daemon if needed, starts it, creates session
      → runTurn() → sends prompt to daemon, polls drain, yields AcpRuntimeEvents
```

### Architecture Diagram

```
OpenClaw Gateway (RPi)
├── ACP Control Plane (built-in)
│   ├── Session Manager
│   ├── Agent Router
│   └── Tool Registration (auto)
├── acpx backend (local sessions)        ← existing, bundled
└── acpx-remote backend (remote sessions) ← our plugin
    ├── AcpxRemoteRuntime implements AcpRuntime
    │   ├── ensureSession() → ensureDaemonDeployed() + ensureDaemonRunning() + spawn
    │   ├── runTurn() → prompt --async + pollLoop(drain)
    │   ├── cancel() → cancel command
    │   ├── close() → close command
    │   ├── getStatus() → status command
    │   └── doctor() → version check on node
    └── NodeBridge (replaces node-exec.ts)
        └── callGateway({ method: "node.invoke", ... })

Node Host (Thinkpad)
└── acpx-node-daemon (npm global package)
    ├── IPC Server (named pipe)
    ├── Session Manager
    ├── Sessions → claude -p --output-format stream-json
    └── Event Buffer (for drain polling)
```

### Single npm Package

The plugin ships as one npm package: `openclaw-acpx-remote`. It contains:

1. **Gateway plugin code** — the AcpRuntime implementation that runs on the gateway
2. **Daemon code** — bundled as a deployable artifact, auto-installed on nodes via `npm install -g`
3. **Skill definition** — for agent routing

```
openclaw-acpx-remote/
├── openclaw.plugin.json         ClawdHub/OpenClaw manifest
├── package.json                 npm package (with openclaw.extensions field)
├── src/
│   ├── index.ts                 Plugin entry: registerService
│   ├── service.ts               Service lifecycle (start/stop)
│   ├── runtime.ts               AcpxRemoteRuntime implements AcpRuntime
│   ├── node-bridge.ts           callGateway wrapper for node.invoke
│   ├── daemon-manager.ts        Auto-deploy + auto-start daemon on nodes
│   ├── poll-loop.ts             Drain polling async generator
│   ├── config.ts                Plugin config with JSON Schema
│   └── handle.ts                Session handle encode/decode
├── daemon/
│   ├── package.json             Separate npm package: acpx-node-daemon
│   ├── src/                     All daemon source (existing code, cleaned up)
│   │   ├── index.ts
│   │   ├── daemon.ts
│   │   ├── session.ts
│   │   ├── ipc-server.ts
│   │   ├── ipc-protocol.ts
│   │   ├── session-manager.ts
│   │   ├── event-buffer.ts
│   │   ├── output-forwarder.ts
│   │   └── config.ts
│   └── dist/                    Pre-built for deployment
├── skills/
│   └── acp-remote-router/
│       └── SKILL.md
└── dist/                        Compiled plugin
```

## 3. Component Design

### 3.1 Plugin Entry (`index.ts` + `service.ts`)

Follows the exact pattern of the local acpx plugin:

```ts
// index.ts
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { createAcpxRemoteService } from "./service.js";

const plugin: OpenClawPluginDefinition = {
  id: "acpx-remote",
  name: "Remote ACP Sessions",
  register(api) {
    api.registerService(createAcpxRemoteService(api));
  },
};
export default plugin;

// service.ts
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";

export function createAcpxRemoteService(api) {
  let runtime: AcpxRemoteRuntime | null = null;
  return {
    id: "acpx-remote",
    async start(ctx) {
      const config = resolveConfig(api.pluginConfig);
      runtime = new AcpxRemoteRuntime(config, api);
      registerAcpRuntimeBackend({
        id: "acpx-remote",
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      // Non-blocking: probe node availability in background
      runtime.probeAvailability().catch(() => {});
    },
    async stop() {
      unregisterAcpRuntimeBackend("acpx-remote");
      runtime = null;
    },
  };
}
```

### 3.2 AcpxRemoteRuntime

Implements the full `AcpRuntime` interface. Each method maps to daemon commands via `NodeBridge`:

| AcpRuntime method | Daemon command(s) | Notes |
|-------------------|-------------------|-------|
| `ensureSession()` | `ensureDaemonReady()` + `spawn` | Auto-deploys and starts daemon if needed |
| `runTurn()` | `prompt --async` + `drain` poll loop | Async generator yielding `AcpRuntimeEvent` |
| `cancel()` | `cancel` | Sends SIGTERM to claude process |
| `close()` | `close` | Kills process, cleans up |
| `getStatus()` | `status` | Returns session state |
| `doctor()` | `system.which node` + version check | Reports daemon health |

### 3.3 NodeBridge (replaces `node-exec.ts`)

Uses the proper SDK import instead of the `createRequire` hack:

```ts
import { callGateway } from "openclaw/plugin-sdk/gateway/call";

export class NodeBridge {
  constructor(private token: string) {}

  async exec(nodeId: string, argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const result = await callGateway({
      token: this.token,
      method: "node.invoke",
      params: {
        nodeId,
        command: "system.run",
        params: {
          command: argv,
          cwd: opts?.cwd ?? "~",
          timeoutMs: opts?.timeoutMs ?? 30_000,
        },
        timeoutMs: (opts?.timeoutMs ?? 30_000) + 5_000,
        idempotencyKey: randomUUID(),
      },
      timeoutMs: (opts?.timeoutMs ?? 30_000) + 10_000,
      clientName: "acpx-remote",
      mode: "backend",
      scopes: ["operator.write"],
    });
    // ... parse result
  }

  async resolveNode(displayName: string): Promise<string> {
    // Call node.list, cache results, return nodeId
  }
}
```

**Important:** If `callGateway` is not importable from the plugin SDK subpath (the minified hash in the filename may change), the fallback is to use `api.runtime.system` or register a gateway method via `api.registerGatewayMethod()` that proxies node.invoke calls. This needs to be tested during implementation.

### 3.4 DaemonManager (auto-deploy + auto-start)

Handles daemon lifecycle on remote nodes automatically:

```ts
export class DaemonManager {
  private nodeStatus = new Map<string, "unknown" | "not_installed" | "installed" | "running">();

  async ensureDaemonReady(nodeId: string, bridge: NodeBridge): Promise<void> {
    // 1. Check if daemon is running (try a status ping)
    const pingResult = await bridge.exec(nodeId, ["acpx-node-daemon", "status", "ping"]);
    if (pingResult.success) {
      this.nodeStatus.set(nodeId, "running");
      return;
    }

    // 2. Check if daemon is installed
    const whichResult = await bridge.exec(nodeId, ["acpx-node-daemon", "--version"]);
    if (!whichResult.success) {
      // 3. Install it
      await bridge.exec(nodeId, ["npm", "install", "-g", "acpx-node-daemon"], { timeoutMs: 120_000 });
      this.nodeStatus.set(nodeId, "installed");
    }

    // 4. Start daemon in background
    await bridge.exec(nodeId, ["acpx-node-daemon", "start", "--daemon"]);
    // 5. Wait for it to be ready (retry ping)
    await this.waitForDaemon(nodeId, bridge);
    this.nodeStatus.set(nodeId, "running");
  }
}
```

### 3.5 Daemon Changes

The daemon (`acpx-node-daemon`) needs these changes for the migration:

| Change | Why |
|--------|-----|
| Publish to npm as `acpx-node-daemon` | Enables `npm install -g` on any node |
| Add `--daemon` flag | Detach from terminal, write PID file, log to file |
| Add `--version` flag | For health checks from the plugin |
| Add `status ping` subcommand | Fast liveness check (just verifies pipe is accessible) |
| Remove hard-coded model default | Let the plugin/user configure model |
| Platform-agnostic paths | Detect home dir, use platform-appropriate defaults |

### 3.6 Config Schema

User-facing config in `openclaw.json`:

```json
{
  "acpx-remote": {
    "enabled": true,
    "config": {
      "defaultNode": "Thinkpad-Node",
      "model": "claude-sonnet-4-6",
      "permissionMode": "bypassPermissions",
      "pollIntervalMs": 2000,
      "autoDeployDaemon": true,
      "sessionTimeoutMinutes": 120,
      "maxConcurrentSessions": 4
    }
  }
}
```

JSON Schema in `openclaw.plugin.json` for UI hints:

```json
{
  "configSchema": {
    "type": "object",
    "properties": {
      "defaultNode": {
        "type": "string",
        "description": "Default OpenClaw node for remote sessions"
      },
      "model": {
        "type": "string",
        "default": "claude-sonnet-4-6",
        "description": "Claude model to use"
      },
      "permissionMode": {
        "type": "string",
        "enum": ["bypassPermissions", "default", "acceptEdits"],
        "default": "bypassPermissions"
      },
      "pollIntervalMs": {
        "type": "number",
        "default": 2000,
        "description": "Drain poll interval in milliseconds"
      },
      "autoDeployDaemon": {
        "type": "boolean",
        "default": true,
        "description": "Auto-install daemon on nodes when missing"
      }
    },
    "required": ["defaultNode"]
  },
  "uiHints": {
    "defaultNode": { "label": "Node Name", "help": "The OpenClaw node to run Claude Code on" },
    "model": { "label": "Model", "help": "Claude model ID", "advanced": true },
    "permissionMode": { "label": "Permission Mode", "advanced": true },
    "pollIntervalMs": { "label": "Poll Interval (ms)", "advanced": true },
    "autoDeployDaemon": { "label": "Auto-deploy daemon", "help": "Automatically install the daemon on nodes" }
  }
}
```

### 3.7 Skill Definition

The skill changes from teaching custom tool names to leveraging the ACP system:

```markdown
---
name: acp-remote-router
description: Route coding session requests to remote OpenClaw nodes via the acpx-remote ACP backend.
user-invocable: false
---

## When to activate

When the user mentions running code on a remote node, starting a session on another machine,
or references specific node names for coding tasks.

## How it works

Use the standard /acp commands. The acpx-remote backend handles sessions on remote nodes.
Output from Claude Code is relayed verbatim — do not summarize.
```

## 4. Migration Path from Custom Tools to AcpRuntime

The current plugin registers 5 custom tools. With the AcpRuntime approach, OpenClaw's ACP control plane provides these automatically. The mapping:

| Current Custom Tool | AcpRuntime Equivalent |
|--------------------|-----------------------|
| `node_acp_spawn` | `ensureSession()` — called by ACP control plane |
| `node_acp_prompt` | `runTurn()` — called by ACP control plane |
| `node_acp_cancel` | `cancel()` — called by ACP control plane |
| `node_acp_close` | `close()` — called by ACP control plane |
| `node_acp_permission` | Not needed — `bypassPermissions` mode |
| `node_acp_continue` | Not needed — handled within `runTurn()` |
| Custom SKILL.md routing | Not needed — ACP agent router handles it |

## 5. `callGateway` Import Strategy

The current hack:
```ts
const oc = req("/home/omar/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-DRjqKE3G.js");
const callGateway = oc.Ks;
```

The proper approach (needs testing during implementation):
```ts
import { callGateway } from "openclaw/plugin-sdk/gateway/call";
```

OpenClaw's plugin loader uses jiti with alias resolution so `openclaw/plugin-sdk/*` resolves to the installed OpenClaw's `dist/plugin-sdk/*`. The SDK exports `callGateway` from `gateway/call.d.ts`. If this import path doesn't work at runtime (the `.js` file may have a hashed filename), fallback options:

1. **Dynamic discovery**: `createRequire(import.meta.url)` to resolve `openclaw/plugin-sdk/gateway/call`
2. **Register a gateway method**: Use `api.registerGatewayMethod("acpx-remote.nodeExec", handler)` and call it locally
3. **Use api.runtime.system**: Check if `api.runtime.system` exposes remote exec

## 6. ACP Backend Selection

OpenClaw's ACP config determines which backend to use:

```json
{
  "acp": {
    "enabled": true,
    "backend": "acpx-remote",
    "defaultAgent": "claude",
    "allowedAgents": ["claude"],
    "maxConcurrentSessions": 4
  }
}
```

Setting `"backend": "acpx-remote"` makes our plugin the default for all ACP sessions. Alternatively, both `acpx` (local) and `acpx-remote` could be registered, with routing based on whether the user mentions a node name.

## 7. Security Considerations

- **Permission bypass**: The daemon runs with `--dangerously-skip-permissions`. This is safe only on trusted machines. Document clearly.
- **exec approvals**: The node host's `exec-approvals.json` gates which commands `system.run` can execute. Users need to approve `acpx-node-daemon` and `npm` commands.
- **Token scope**: The plugin uses `operator.write` scope for node.invoke. This is required for `system.run`.

## 8. What We're NOT Changing

- **IPC protocol** — The ndjson-over-named-pipe protocol stays the same
- **Daemon internals** — Session management, event buffering, output forwarding all stay
- **Drain polling pattern** — `system.run` doesn't stream, so we keep the async prompt + drain poll approach
- **Claude CLI spawn** — The daemon keeps spawning `claude -p` with stream-json output
- **Live terminal rendering** — The daemon still renders to its console when run interactively
