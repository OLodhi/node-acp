# Node ACP — Remote ACP Session Dispatch for OpenClaw Nodes

A standalone daemon (`acpx-node-daemon`) that manages AI coding sessions (Claude Code) on OpenClaw nodes. The gateway communicates with the daemon via a newline-delimited JSON IPC protocol over named pipes (Windows) or Unix sockets (Linux/macOS). Users spawn and interact with remote coding sessions through Telegram, with output streaming and permission approval.

## System Architecture

```
User (Telegram)
    | message
Gateway (Linux, 192.168.1.24)
    | node.invoke acp.prompt (WebSocket)
Node Host (Windows Thinkpad, 192.168.1.18)
    | local IPC (ndjson over named pipe)
acpx-node-daemon
    | Claude Agent SDK query()
Claude Code (child process)
```

**This repo covers the daemon only.** The gateway plugin and node host integration are future PRs to OpenClaw.

## Project Status

### Implemented
- IPC server with ndjson over named pipes (Windows) / Unix sockets (Linux/macOS)
- Full IPC protocol: spawn, prompt, cancel, close, status, permission_response
- Session manager with concurrency limits (default 4) and TTL auto-close (default 120 min)
- Permission proxy with 30-minute timeout and abort signal support
- Claude Agent SDK integration — real Claude Code sessions via `query()`
- Output forwarder mapping SDK messages to daemon events
- CLI for standalone testing without OpenClaw

### Not Yet Implemented
- `src/session.ts` and `src/output-forwarder.ts` currently use `any` types for SDK messages — SDK types should be refined as the API stabilizes
- E2E testing with real Claude Code (unit tests use mocked SDK)
- `stop` CLI command (daemon must be killed via Ctrl+C / SIGTERM)

## Prerequisites

- Node.js >= 20
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
- Valid Anthropic API key (configured via `ANTHROPIC_API_KEY` env var or Claude Code's auth flow)

## Setup

```bash
git clone https://github.com/OLodhi/node-acp.git
cd node-acp
npm install
npm run build
```

## Usage

### Run Tests

```bash
npm test              # run all 38 tests
npm run test:watch    # watch mode
```

### Start the Daemon

```bash
node dist/index.js start
```

The daemon listens on `\\.\pipe\acpx-node-daemon` (Windows) or `/tmp/acpx-node-daemon.sock` (Linux/macOS).

### CLI Commands (separate terminal)

```bash
# Spawn a session
node dist/index.js spawn --agent claude --cwd /path/to/project

# Send a prompt (use sessionId from spawn output)
node dist/index.js prompt <sessionId> "Fix the auth bug in src/auth.ts"

# Check session status
node dist/index.js status <sessionId>

# Cancel current turn
node dist/index.js cancel <sessionId>

# Close session
node dist/index.js close <sessionId>
```

All commands print JSON responses. The `prompt` command streams output events until `prompt_complete`.

## Source Files

```
src/
  index.ts              CLI entry point — start daemon or send client commands
  daemon.ts             Orchestrator wiring IPC server, session manager, permission proxy, and sessions
  session.ts            Wraps Claude Agent SDK query() — manages lifecycle, permissions, output streaming
  session-manager.ts    Tracks multiple concurrent sessions with TTL and concurrency limits
  ipc-server.ts         ndjson over named pipes/Unix sockets — accepts connections, routes messages
  ipc-protocol.ts       DaemonRequest/DaemonEvent type definitions and serialization
  permission-proxy.ts   Proxies permission requests with 30-minute timeout and AbortSignal support
  output-forwarder.ts   Pure function mapping SDK messages to DaemonEvent emissions
  config.ts             DaemonConfig with sensible defaults
```

## IPC Protocol

Communication uses newline-delimited JSON. Each message is a single JSON object followed by `\n`.

### Inbound (node host -> daemon)

| Command | Fields | Description |
|---------|--------|-------------|
| `spawn` | `sessionId, agent, cwd, model, permissionMode, timeoutMinutes` | Start a new session |
| `prompt` | `sessionId, prompt` | Send prompt to session |
| `cancel` | `sessionId` | Cancel current turn |
| `close` | `sessionId` | End session and clean up |
| `status` | `sessionId` | Get session state |
| `permission_response` | `sessionId, permissionId, approved` | Respond to permission request |

### Outbound (daemon -> node host)

| Event | Fields | Description |
|-------|--------|-------------|
| `spawn_result` | `sessionId, success, pid?, error?` | Session spawn result |
| `prompt_accepted` | `sessionId` | Prompt received, processing started |
| `output` | `sessionId, messageType, chunk, timestamp` | Streaming output (`assistant_text`, `tool_use`) |
| `permission_request` | `sessionId, permissionId, operation, path, description` | Claude Code wants to perform an operation |
| `prompt_complete` | `sessionId, stopReason` | Turn finished (`end_turn` or `error`) |
| `error` | `sessionId, error` | Error occurred |
| `session_closed` | `sessionId, reason` | Session ended (`user_closed`, `ttl_expired`, `daemon_stopped`, `agent_crashed`) |
| `status_result` | `sessionId, status, agent, cwd, model, pid, createdAt, lastActivityAt` | Session state |

## Session Lifecycle

```
spawn -> Session created (idle, no Claude Code process yet)
  |
prompt -> Claude Agent SDK query() starts, session becomes busy
  |         | streams SDKMessage
  |    OutputForwarder maps to DaemonEvent -> IPC broadcast
  |
query completes -> prompt_complete emitted, session returns to idle
  |
prompt (2nd+) -> query() with resume (maintains conversation context)
  |
close -> query.close(), cleanup
```

Key behaviors:
- No Claude Code process runs until the first `prompt` (lazy start)
- Session ID from the SDK is captured on first prompt and reused for conversation continuity
- Permission requests are proxied via `canUseTool` callback, raced against an AbortSignal for cancellation
- Sessions auto-close after TTL expiry (default 120 minutes of inactivity)
- Maximum 4 concurrent sessions (configurable)

## Configuration

Default values (override via `loadConfig()` in `src/config.ts`):

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

On Linux/macOS, `ipcSocketPath` defaults to `/tmp/acpx-node-daemon.sock`.

## Testing

38 tests across 7 test files:

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `tests/ipc-protocol.test.ts` | 6 | Serialization, deserialization, error cases |
| `tests/ipc-server.test.ts` | 3 | Connection, send/receive, clean shutdown |
| `tests/config.test.ts` | 3 | Defaults, overrides, platform-specific path |
| `tests/permission-proxy.test.ts` | 5 | Approve, deny, timeout, cleanup |
| `tests/session-manager.test.ts` | 6 | Registration, concurrency, TTL, status |
| `tests/output-forwarder.test.ts` | 8 | SDK message mapping, ignored types |
| `tests/session.test.ts` | 7 | Lifecycle, resume capture, error handling (mocked SDK) |

## Design Documents

- `docs/specs/2026-03-16-node-acp-design.md` — Original design spec (full protocol, architecture, gateway integration plans)
- `docs/specs/2026-03-16-agent-sdk-integration-design.md` — Claude Agent SDK integration spec
- `docs/plans/2026-03-16-node-acp-implementation.md` — Original implementation plan (Tasks 1-8)
- `docs/plans/2026-03-16-agent-sdk-integration.md` — SDK integration implementation plan (Tasks 1-6)

## Future Work

### Gateway ACPX Plugin (OpenClaw PR)
Adds `--node` flag to `/acp spawn`, dispatches `acp.*` commands via `node.invoke`, relays streaming output to Telegram, renders permission approval UI with inline keyboard buttons.

### Node Host Integration (OpenClaw PR)
Registers `acp.*` commands in the node host, bridges between gateway WebSocket and local daemon IPC, adds `acp.output` streaming event type.

### In This Repo
- Refine SDK type usage (replace `any` with proper SDK types)
- Add integration tests with real Claude Code
- Implement remote `stop` command via IPC
- Handle node host reconnection (re-bind active sessions)
