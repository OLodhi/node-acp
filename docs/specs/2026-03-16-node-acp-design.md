# Node ACP — Remote ACP Session Dispatch for OpenClaw Nodes

## Problem

OpenClaw's ACP sessions (Claude Code, Codex, etc.) can only run on the gateway host. Users with paired remote nodes — where their projects, IDEs, and toolchains live — cannot spawn coding sessions on those machines via Telegram or other channels. This forces a choice between using ACP (gateway-only, wrong machine) or direct CLI access (right machine, no Telegram integration).

## Solution

A standalone daemon (`acpx-node-daemon`) that runs on OpenClaw nodes and manages ACP coding sessions locally. The gateway communicates with the daemon via a new `acp.*` command family over the existing node WebSocket protocol. Users spawn and interact with remote coding sessions naturally through Telegram, with output streaming and permission approval.

## Architecture

```
User (Telegram)
    ↓ message
Gateway (Linux)
    ↓ node.invoke acp.prompt
Node Host (Thinkpad, WebSocket)
    ↓ local IPC
acpx-node-daemon
    ↓ ACPX queue owner protocol
Claude Code (child process)
```

### Components

**1. `acpx-node-daemon`** — NEW standalone npm package, runs on the node alongside the node host. Manages ACPX sessions locally, streams output to the node host, proxies permission requests.

**2. Gateway ACPX plugin** — FUTURE PR to OpenClaw. Adds `--node` flag to `/acp spawn`, dispatches `acp.*` commands via `node.invoke`, relays streaming output to Telegram, renders permission approval UI.

**3. Node host** — FUTURE PR to OpenClaw. Registers `acp.*` commands, bridges between gateway WebSocket and local daemon IPC, adds `acp.output` streaming event type.

This spec covers component 1 (the daemon) and documentation only. Components 2 and 3 are future PRs to OpenClaw once the daemon is proven.

## Node Command Protocol

Six new commands for the `acp.*` namespace:

### Gateway → Node commands

**`acp.spawn`** — Start a new ACP session

```json
{
  "sessionId": "uuid",
  "agent": "claude",
  "cwd": "C:\\Users\\Omar.Lodhi\\Projects\\MyProject",
  "permissionMode": "approve-reads",
  "model": "claude-opus-4-6",
  "timeoutMinutes": 120
}
```

- `cwd` is **required** — spawn fails if omitted
- `model` defaults to `claude-opus-4-6`
- `permissionMode` defaults to `approve-reads`
- Returns: `{ sessionId, status: "started", pid }` or error

**`acp.prompt`** — Send a prompt to an active session

```json
{
  "sessionId": "uuid",
  "prompt": "Fix the auth bug in src/auth.ts"
}
```

- Returns: `{ accepted: true }` immediately; output streams via `acp.output` events
- Errors if session is not found or not idle

**`acp.cancel`** — Cancel the current turn

```json
{
  "sessionId": "uuid"
}
```

**`acp.close`** — End session and clean up

```json
{
  "sessionId": "uuid"
}
```

- Sends cancel if a prompt is active, then terminates the agent process
- Cleans up session state

**`acp.status`** — Get session state

```json
{
  "sessionId": "uuid"
}
```

- Returns: `{ sessionId, status, agent, cwd, model, pid, createdAt, lastActivityAt }`

**`acp.permission_response`** — User's answer to a permission request

```json
{
  "sessionId": "uuid",
  "permissionId": "uuid",
  "approved": true
}
```

### Node → Gateway events

**`acp.output`** — Streaming output from the agent (multiple per prompt)

```json
{
  "sessionId": "uuid",
  "type": "assistant_text",
  "chunk": "Reading src/auth.ts...",
  "timestamp": 1773600000000
}
```

Output types:
- `assistant_text` — Claude Code's text response chunks
- `tool_use` — Tool invocation (file read, search, exec, etc.)
- `tool_result` — Tool result summary
- `permission_request` — Claude Code wants to perform a write operation
- `prompt_complete` — Turn finished, session returns to idle
- `error` — Error occurred during the turn
- `session_closed` — Session ended (TTL, crash, or explicit close)

**Permission request event:**

```json
{
  "sessionId": "uuid",
  "type": "permission_request",
  "permissionId": "uuid",
  "operation": "writeFile",
  "path": "C:\\Users\\Omar.Lodhi\\Projects\\MyProject\\src\\auth.ts",
  "description": "Write 45 lines to src/auth.ts"
}
```

Permission response timeout: **30 minutes**. If no response received, permission is denied.

## acpx-node-daemon

### Lifecycle

- Starts when the node host starts (companion process)
- Idles at near-zero resource usage when no sessions are active
- Manages multiple concurrent sessions (configurable, default 4)
- Auto-closes sessions after TTL (default 120 minutes of inactivity)
- Stops when the node host stops

### Session management

```typescript
interface NodeAcpSession {
  sessionId: string;
  agent: string;
  cwd: string;
  model: string;
  permissionMode: string;
  pid: number;
  status: "starting" | "idle" | "busy" | "closing";
  createdAt: number;
  lastActivityAt: number;
  ttlMinutes: number;
  pendingPermissions: Map<string, {
    resolve: (approved: boolean) => void;
    timeout: NodeJS.Timeout;
  }>;
}
```

### Internal architecture

```
Node Host Process
    ↕ local IPC (newline-delimited JSON over named pipe)
acpx-node-daemon
    ├── SessionManager (manages multiple sessions)
    │   ├── Session 1 → ACPX QueueOwner → Claude Code (PID)
    │   └── Session 2 → ACPX QueueOwner → Codex (PID)
    ├── IPC Server (accepts commands from node host)
    ├── OutputForwarder (streams ACPX output → IPC → node host)
    └── PermissionProxy (permission requests → IPC → node host → gateway → Telegram)
```

### IPC protocol (daemon ↔ node host)

Uses newline-delimited JSON over a named pipe (Windows) or Unix socket (Linux/macOS). This mirrors ACPX's own internal IPC pattern.

**Inbound (node host → daemon):**

```typescript
type DaemonRequest =
  | { type: "spawn"; sessionId: string; agent: string; cwd: string; model: string; permissionMode: string; timeoutMinutes: number }
  | { type: "prompt"; sessionId: string; prompt: string }
  | { type: "cancel"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "status"; sessionId: string }
  | { type: "permission_response"; sessionId: string; permissionId: string; approved: boolean }
```

**Outbound (daemon → node host):**

```typescript
type DaemonEvent =
  | { type: "spawn_result"; sessionId: string; success: boolean; pid?: number; error?: string }
  | { type: "prompt_accepted"; sessionId: string }
  | { type: "output"; sessionId: string; messageType: string; chunk: string; timestamp: number }
  | { type: "permission_request"; sessionId: string; permissionId: string; operation: string; path: string; description: string }
  | { type: "prompt_complete"; sessionId: string; stopReason: string }
  | { type: "error"; sessionId: string; error: string }
  | { type: "session_closed"; sessionId: string; reason: string }
  | { type: "status_result"; sessionId: string; status: string; agent: string; cwd: string; model: string; pid: number; createdAt: number; lastActivityAt: number }
```

### Permission proxy flow

1. Claude Code requests permission (e.g. write file) via ACP JSON-RPC
2. ACPX's `handlePermissionRequest()` fires in the daemon's session
3. Daemon creates a pending permission with a 30-minute timeout
4. Daemon sends `permission_request` event via IPC → node host → gateway → Telegram
5. User sees approval prompt in Telegram with Approve/Deny buttons
6. User response flows back: Telegram → gateway → node host → IPC → daemon
7. Daemon resolves the permission promise, Claude Code proceeds or handles denial
8. If 30-minute timeout expires, permission is denied automatically

### Configuration

```json
{
  "maxConcurrentSessions": 4,
  "defaultAgent": "claude",
  "defaultModel": "claude-opus-4-6",
  "defaultPermissionMode": "approve-reads",
  "defaultTtlMinutes": 120,
  "permissionTimeoutMinutes": 30,
  "ipcSocketPath": "\\\\.\\pipe\\acpx-node-daemon"
}
```

On Linux/macOS: `ipcSocketPath` defaults to `/tmp/acpx-node-daemon.sock`

### CLI mode (standalone testing)

For development and testing without the OpenClaw node host:

```bash
acpx-node-daemon start                    # Start daemon
acpx-node-daemon spawn --agent claude --cwd /path/to/project  # Spawn session
acpx-node-daemon prompt <sessionId> "Fix the bug"             # Send prompt
acpx-node-daemon status <sessionId>       # Check status
acpx-node-daemon close <sessionId>        # Close session
acpx-node-daemon stop                     # Stop daemon
```

## Gateway Integration (Future PR)

For reference — how the gateway will integrate with the daemon once the OpenClaw PRs are submitted.

### Telegram UX

**Spawn:**
```
/acp spawn claude --node Thinkpad-Node --cwd C:\Users\Omar.Lodhi\Projects\MyProject
```
Response: `🔧 [Claude Code] Session started on Thinkpad-Node in C:\Users\Omar.Lodhi\Projects\MyProject`

**Conversation binding:**
Once spawned, all messages go directly to Claude Code. No `/acp steer` needed.

**Output rendering:**
- `assistant_text` → accumulated and sent as Telegram messages, prefixed with `🔧 [Claude Code]`
- `tool_use` → brief status: `🔧 [Claude Code] Reading src/auth.ts...`
- `permission_request` → inline keyboard: `🔧 [Claude Code] wants to write src/auth.ts (45 lines) — [Approve] [Deny]`
- `prompt_complete` → no message (session stays bound, waiting for next input)
- `session_closed` → `🔧 [Claude Code] Session ended.` and conversation unbinds

**Exit:**
```
/acp exit
```
Response: Session closed, conversation returns to normal work bot.

### Error handling

| Scenario | Behaviour |
|---|---|
| Node disconnects during session | "⚠️ Thinkpad-Node disconnected — session paused. Will resume when node reconnects." |
| Claude Code crashes | "⚠️ Claude Code exited unexpectedly. Session closed." Conversation unbinds. |
| Gateway restarts | On startup, queries connected nodes for active ACP sessions and re-binds. |
| Permission timeout (30 min) | Permission denied, Claude Code handles the denial gracefully. |
| `/acp exit` while mid-task | Sends cancel, waits for graceful shutdown, then closes and unbinds. |
| `cwd` omitted on spawn | Error: "Please specify a working directory: /acp spawn claude --node Thinkpad-Node --cwd /path/to/project" |

## Package Structure

```
packages/acpx-node-daemon/
├── src/
│   ├── index.ts               # Entry point, CLI parser
│   ├── daemon.ts              # Main daemon process
│   ├── session-manager.ts     # Manages multiple concurrent sessions
│   ├── session.ts             # Single session lifecycle (wraps ACPX queue owner)
│   ├── ipc-server.ts          # Local IPC server (node host ↔ daemon)
│   ├── ipc-protocol.ts        # DaemonRequest / DaemonEvent type definitions
│   ├── permission-proxy.ts    # Proxies permission requests, manages timeouts
│   ├── output-forwarder.ts    # Streams ACPX output events to IPC
│   └── config.ts              # Configuration loading and defaults
├── tests/
│   ├── session-manager.test.ts
│   ├── session.test.ts
│   ├── ipc-protocol.test.ts
│   ├── permission-proxy.test.ts
│   └── integration.test.ts
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

### Dependencies

- `acpx` — used as a library for queue owner management
- `@agentclientprotocol/sdk` — ACP JSON-RPC protocol
- Node.js `net` module — IPC server/client
- Node.js `child_process` — process management

### Testing strategy

- **Unit tests** — session manager, IPC protocol serialization, permission proxy timeout logic
- **Integration tests** — mock node host connecting to daemon, spawn/prompt/close lifecycle
- **E2E test** — real daemon + real Claude Code, run a simple coding task via CLI mode

## Success Criteria

1. `acpx-node-daemon start` runs on Windows and Linux
2. Sessions can be spawned, prompted, and closed via the IPC protocol
3. Claude Code output streams in real-time via IPC events
4. Permission requests are proxied with 30-minute timeout
5. Multiple concurrent sessions work independently
6. Sessions auto-close after TTL expiry
7. CLI mode allows full testing without OpenClaw node host
8. All unit and integration tests pass
