# Gateway Integration — Remote ACP Sessions via OpenClaw

## Problem

The `acpx-node-daemon` runs on a Windows node (Thinkpad) and manages Claude Code sessions locally. It works when tested via its CLI, but there's no way to use it from Telegram through the OpenClaw gateway. Users have to SSH into the node and run CLI commands manually.

## Goal

Enable Telegram users to spawn and interact with Claude Code sessions on remote nodes through the OpenClaw bot, using the existing node host WebSocket connection — no new network ports, no changes to the OpenClaw node host.

## Constraints

- **No OpenClaw source access.** OpenClaw is an installed npm package. We build a standalone plugin/extension.
- **No node host modifications.** The node host's `handleInvoke()` router is compiled. We use existing commands only (`system.run`).
- **`system.run` does not stream.** It buffers all output (up to 200KB) and returns it when the command finishes. Long-running prompts would block and return nothing until complete.
- **Poll interval latency.** Output reaches Telegram with a 1–2 second delay due to polling. Acceptable for chat-based interaction.

## Architecture

```
User (Telegram)
    ↓ message
Gateway (Linux) — acpx-remote plugin
    ↓ node.invoke system.run "acpx-node-daemon <command>"
Node Host (Thinkpad, WebSocket) — existing, unmodified
    ↓ shell exec
acpx-node-daemon CLI
    ↓ local IPC (named pipe)
acpx-node-daemon (background daemon)
    ↓ Agent SDK query()
Claude Code (child process)
```

## Solution: Fire-and-Poll

Instead of one long-running `system.run` call per prompt, we split interaction into short-lived commands and poll for output.

### Flow

1. **Spawn**: Gateway generates a UUID session ID and calls `system.run acpx-node-daemon spawn --session-id <uuid> --cwd <path>` → daemon creates session, returns confirmation.

2. **Prompt**: Gateway calls `system.run acpx-node-daemon prompt --async <sessionId> --text-b64 <base64>` → daemon accepts the prompt and begins processing. CLI exits immediately after receiving `prompt_accepted` (does not wait for output). Prompt text is base64-encoded to avoid shell escaping issues with user-supplied text from Telegram.

3. **Poll**: Gateway calls `system.run acpx-node-daemon drain <sessionId>` every 1–2 seconds → daemon returns all buffered events since last drain as ndjson. Events include `output`, `permission_request`, `prompt_complete`, `error`, `session_closed`.

4. **Permission response**: When the poll returns a `permission_request`, the gateway shows an approve/deny UI in Telegram. When the user responds, gateway calls `system.run acpx-node-daemon permission-response <sessionId> <permissionId> <approved>`.

5. **Close**: Gateway calls `system.run acpx-node-daemon close <sessionId>` → daemon closes session, cleans up.

6. **Status/Cancel**: Gateway calls `system.run acpx-node-daemon status <sessionId>` or `cancel <sessionId>` as needed. Cancel returns a `cancel_accepted` event.

Each `system.run` call connects to the daemon's named pipe, sends a message, gets a response, and disconnects. No call blocks for more than a couple of seconds.

### Shell escaping

Prompt text comes from Telegram users and may contain shell metacharacters (`;`, `&&`, `|`, backticks, `$()`, quotes, etc.). To prevent command injection, the gateway base64-encodes prompt text (standard base64, RFC 4648) before embedding it in the `system.run` command. The daemon CLI decodes it with the `--text-b64` flag using `Buffer.from(encoded, 'base64').toString('utf-8')`. All other arguments (session IDs, permission IDs) are UUIDs and safe for shell embedding.

### Race conditions and event ordering

The daemon begins processing a prompt immediately after sending `prompt_accepted`. Output events may arrive before the gateway starts polling. This is safe because the event buffer captures all events. Even if the prompt completes before the first `drain` call, the `prompt_complete` event is buffered and returned on the next drain. No events are lost between `prompt --async` and the first `drain`.

### Permission flow detail

```
Claude Code wants to write a file
    ↓
Daemon emits permission_request event → buffered
    ↓
Gateway polls drain → receives permission_request
    ↓
Gateway agent shows in Telegram: "Claude Code wants to write src/auth.ts [Approve] [Deny]"
    ↓
User taps Approve
    ↓
Gateway calls system.run permission-response <sessionId> <permId> true
    ↓
Daemon resolves permission promise → Claude Code proceeds
```

## Component 1: Daemon Changes (node-acp)

### Event buffer

New module `src/event-buffer.ts`:

```typescript
// BufferedEventType — only these event types are stored in the buffer
type BufferedEventType = "output" | "permission_request" | "prompt_complete" | "error" | "session_closed";

interface EventBuffer {
  push(sessionId: string, event: DaemonEvent & { type: BufferedEventType }): void;
  drain(sessionId: string, maxBytes?: number): { events: DaemonEvent[]; hasMore: boolean };
  markDraining(sessionId: string): void;
  cleanup(sessionId: string): void;
  hasSession(sessionId: string): boolean;
}
```

- Per-session FIFO buffer, configurable max events (default 500) via `DaemonConfig`.
- `push()` appends an event. If buffer is full, drops oldest events and logs a warning.
- `drain(sessionId, maxBytes?)` returns buffered events and clears them. If serialized output would exceed `maxBytes` (default 150KB, leaving headroom under `system.run`'s 200KB cap), returns a partial drain with `hasMore: true`. Remaining events stay in the buffer for the next drain.
- `markDraining(sessionId)` marks a session as "draining" — the buffer survives session removal so terminal events (`session_closed`) can be picked up.
- `cleanup(sessionId)` removes all state for a session. Triggered automatically: `markDraining()` sets a 60-second `setTimeout` that calls `cleanup()`. Additionally, `drain()` calls `cleanup()` immediately if it returns a `session_closed` event (the terminal event has been delivered, no need to wait).
- `hasSession(sessionId)` returns true if the session has a buffer (active or draining). Draining/tombstoned sessions are still drainable — `drain()` returns their buffered events normally.

**Only broadcast events are buffered:** `output`, `permission_request`, `prompt_complete`, `error`, `session_closed`. Request-response events (`spawn_result`, `status_result`, `prompt_accepted`, `cancel_accepted`, `drain_result`) are direct responses to specific callers and are NOT buffered.

**Tombstone pattern for session lifecycle:** When a session is closed (user close, TTL expiry, or crash), the daemon pushes the `session_closed` event into the buffer and calls `markDraining()`. The buffer stays alive until either: (a) the `session_closed` event is drained, or (b) 60 seconds pass. This prevents the gateway from polling forever after a session dies.

**Integration point:** The `Daemon` class wraps the event emission path. When the daemon emits a broadcast event (via `ipcServer.broadcast()`), it also pushes the event to the event buffer. When a `session_closed` event is emitted (from user close, TTL expiry, or crash), the daemon calls `eventBuffer.markDraining(sessionId)` before removing the session from the SessionManager. This keeps the Daemon as the orchestrator — the SessionManager and EventBuffer don't reference each other directly.

**Daemon shutdown:** When `daemon.stop()` is called, `session_closed` events are broadcast to connected clients but NOT buffered (the daemon process is terminating). The gateway handles daemon unavailability via its retry policy — 3 consecutive failed `system.run` calls yield an error to the user.

The daemon currently broadcasts events to all connected IPC clients via `ipcServer.broadcast()`. With the event buffer:
- Broadcast events are pushed to the buffer AND broadcast to connected clients.
- The `drain` CLI command reads from the buffer. Direct IPC clients (like the existing CLI `prompt` command) still receive events via broadcast as before.

### CLI changes

**`prompt --async` and `--text-b64` flags** (in `src/index.ts`):

Current `prompt` command connects, sends prompt, stays connected until `prompt_complete` or `error`. Changes:
- `--async`: Send the prompt message, wait for `prompt_accepted` response, disconnect immediately
- `--text-b64 <base64>`: Decode base64 to get prompt text (alternative to positional text args). Required when prompt text may contain shell metacharacters.
- The two flags are independent — `--text-b64` works with or without `--async`.

Note: `--async` is a CLI-level behavior change only. The daemon's `handlePrompt` already sends `prompt_accepted` immediately and runs the prompt in the background. The existing synchronous CLI just happened to stay connected to receive streaming events.

**New `drain` command** (in `src/index.ts`):

```
acpx-node-daemon drain <sessionId>
```

- Connects to daemon
- Sends `{ type: "drain", sessionId }` request
- Receives `{ type: "drain_result", sessionId, events: [...], hasMore: boolean }` response
- If session not found: receives `{ type: "error", sessionId, error: "Session not found" }`
- Prints events as ndjson (one JSON object per line), e.g.:
  ```
  {"type":"output","sessionId":"abc","messageType":"assistant_text","chunk":"Looking at the code...","timestamp":1710547200000}
  {"type":"output","sessionId":"abc","messageType":"tool_use","chunk":"Read","timestamp":1710547201000}
  {"type":"prompt_complete","sessionId":"abc","stopReason":"end_turn"}
  ```
- Disconnects

**New `permission-response` command** (in `src/index.ts`):

The existing `permission_response` IPC message type exists but there's no CLI command for it. Add:

```
acpx-node-daemon permission-response <sessionId> <permissionId> <approved>
```

Returns `{ type: "permission_response_result", sessionId, success: true }` or an error.

**New `cancel` response** (in `src/daemon.ts`):

The current `handleCancel` does not send a response via `send()`. Add a `cancel_accepted` response so the CLI doesn't hang. The `handlePermissionResponse` method also needs the `send` callback added to its signature (currently the only handler that doesn't receive it).

```
{ type: "cancel_accepted", sessionId }
```

**New `--session-id` flag for `spawn`** (in `src/index.ts`):

The gateway needs to control the session ID (for tracking). Add `--session-id <uuid>` flag to spawn. If omitted, the CLI generates a random UUID as before.

**CLI `sendAndListen` terminal events:** The existing `sendAndListen` function disconnects on certain event types (`spawn_result`, `status_result`, `error`, `session_closed`, `prompt_complete`). Add the new types to this list: `cancel_accepted`, `drain_result`, `permission_response_result`.

### IPC protocol additions

New message types:

```typescript
// Inbound
| { type: "drain"; sessionId: string }

// Outbound
| { type: "drain_result"; sessionId: string; events: DaemonEvent[]; hasMore: boolean }
| { type: "cancel_accepted"; sessionId: string }
| { type: "permission_response_result"; sessionId: string; success: boolean }
```

### Files changed

- `src/event-buffer.ts` — new module
- `src/ipc-protocol.ts` — add drain request/response types
- `src/daemon.ts` — wire event buffer, handle drain requests
- `src/index.ts` — add `drain`, `prompt --async`, `permission-response` CLI commands
- `tests/event-buffer.test.ts` — new test file
- `tests/ipc-protocol.test.ts` — add drain type tests

## Component 2: Gateway Plugin (acpx-remote)

A new OpenClaw extension package installed on the gateway.

### Package structure

```
openclaw-acpx-remote/
├── src/
│   ├── index.ts              # Plugin entry, registers service
│   ├── service.ts            # Creates runtime, registers ACP backend
│   ├── runtime.ts            # AcpxRemoteRuntime implementing AcpRuntime
│   ├── node-exec.ts          # Wrapper for node.invoke system.run calls
│   └── config.ts             # Plugin configuration
├── skills/
│   └── acp-node-router/
│       └── SKILL.md          # Skill teaching agent how to use remote ACP
├── package.json
├── tsconfig.json
└── openclaw.plugin.json      # Plugin manifest
```

### Plugin manifest

```json
{
  "id": "acpx-remote",
  "name": "Remote ACP Sessions",
  "description": "Spawn ACP sessions on remote OpenClaw nodes via the node host",
  "version": "0.1.0",
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
        "description": "Path to daemon binary on the node"
      }
    }
  },
  "skills": ["skills/acp-node-router"]
}
```

### Runtime implementation

`AcpxRemoteRuntime` implements the same `AcpRuntime` interface as the existing `acpx` plugin:

**`ensureSession(params)`**:
1. Generates a UUID session ID
2. Calls `nodeExec("acpx-node-daemon spawn --session-id <uuid> --cwd <cwd>")` on the target node via `system.run`
3. Parses the JSON response to confirm success
4. Returns an `AcpRuntimeHandle` with encoded state (sessionId, node, cwd)

**`async *runTurn(handle, prompt, signal)`**:
1. Decodes handle state to get sessionId and target node
2. Base64-encodes the prompt text
3. Calls `nodeExec("acpx-node-daemon prompt --async <sessionId> --text-b64 <encoded>")` — returns immediately after acceptance
4. Enters poll loop:
   - Calls `nodeExec("acpx-node-daemon drain <sessionId>")` every `pollIntervalMs`
   - Parses ndjson response into event array
   - For each event:
     - `output` (assistant_text) → yields as `agent_message_chunk`
     - `output` (tool_use) → yields as `tool_call`
     - `permission_request` → yields as permission request for the agent to handle
     - `prompt_complete` → yields as `done`, exits loop
     - `error` → yields as `error`, exits loop
     - `session_closed` → yields as `done` with close reason, exits loop
   - If `hasMore` is true in the drain response, drain again after a 100ms delay (prevents tight loops while still draining quickly). Max 10 consecutive immediate re-drains before falling back to the poll interval.
   - Checks abort signal between polls; if aborted, calls `cancel()` and exits
5. Generator completes

**Retry policy for `system.run` calls:**
- **Drain calls (in poll loop):** On transient failure (timeout, WebSocket error), retry up to 3 times with 2-second backoff. After 3 consecutive failures, yield an error event and exit the poll loop. On "Session not found" error, the session was lost (daemon restart or TTL expiry) — yield a descriptive error to the user.
- **All other calls (spawn, prompt, cancel, close, permission-response, status):** No automatic retry. Surface errors immediately so the agent can inform the user. These are one-shot commands where retrying silently could cause confusing duplicate actions.

**Re-entrant prompts:** If the user sends a new message while a prompt is still processing, the daemon rejects it with "Session is busy". The skill should instruct the agent to inform the user that the previous prompt is still running.

**`cancel(handle)`**:
- Calls `nodeExec("acpx-node-daemon cancel <sessionId>")`

**`close(handle)`**:
- Calls `nodeExec("acpx-node-daemon close <sessionId>")`

**`getStatus(handle)`**:
- Calls `nodeExec("acpx-node-daemon status <sessionId>")`
- Parses and returns status

### nodeExec helper

Wraps `callGatewayTool("node.invoke", ...)` with `command: "system.run"`:

```typescript
async function nodeExec(
  nodeName: string,
  command: string,
  timeoutMs: number = 15000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await callGatewayTool("node.invoke", { timeoutMs }, {
    command: "system.run",
    node: nodeName,
    params: { command, cwd: "~" }
  });
  return result;
}
```

### Permission handling

When the poll loop receives a `permission_request` event, it needs to yield it to the agent runtime so it can present the approval UI to the user. When the user responds, the runtime calls:

```typescript
async handlePermissionResponse(
  handle: AcpRuntimeHandle,
  permissionId: string,
  approved: boolean
): Promise<void> {
  const { sessionId, node } = decodeHandle(handle);
  await nodeExec(node, `acpx-node-daemon permission-response ${sessionId} ${permissionId} ${approved}`);
}
```

The daemon's permission proxy resolves the pending promise, and Claude Code proceeds (or handles denial). The next `drain` poll picks up any resulting output.

## Component 3: Skill

`skills/acp-node-router/SKILL.md` teaches the agent:

- When the user says `/acp spawn --node <name> --cwd <path>`, call `sessions_spawn` with `runtime: "acpx-remote"`, passing the node name and cwd
- While a remote session is active, route all user messages as prompts to the session
- Handle permission request events by showing approve/deny buttons
- When the user says `/acp exit`, close the session and unbind
- Error messages for: node offline, daemon not running, session not found

The skill mirrors the existing `acp-router` skill but routes to the `acpx-remote` runtime instead of the local `acpx` runtime.

## Telegram UX

**Start session:**
```
User: /acp spawn --node Thinkpad --cwd C:\Users\Omar.Lodhi\Projects\MyProject
Bot:  🔧 Claude Code session started on Thinkpad in C:\Users\Omar.Lodhi\Projects\MyProject
```

**Prompt (output batched per poll cycle):**
```
User: Fix the auth bug in src/auth.ts
Bot:  🔧 Reading src/auth.ts...
Bot:  🔧 The issue is on line 42 — the token expiry check is inverted. I'll fix it.
Bot:  🔧 [Claude Code wants to write src/auth.ts] [Approve] [Deny]
User: [taps Approve]
Bot:  🔧 Fixed. The token validation now correctly rejects expired tokens.
```

**End session:**
```
User: /acp exit
Bot:  🔧 Claude Code session closed.
```

**Errors:**
- Node offline: "⚠️ Thinkpad is not connected."
- Daemon not running: "⚠️ acpx-node-daemon is not running on Thinkpad."
- Session TTL: "🔧 Session timed out after 2 hours of inactivity."

## What we're NOT building

- No changes to the OpenClaw node host
- No new network ports, firewalls, or connections
- No changes to the Telegram plugin
- No TLS/authentication layer (inherits from node host)
- No automatic node routing (explicit `--node` flag only)

## Implementation order

1. **Daemon changes first** (event buffer, drain command, prompt --async, permission-response CLI) — testable locally on the node
2. **Gateway plugin** (runtime, nodeExec, poll loop, config) — requires daemon changes to be deployed
3. **Skill** (acp-node-router) — requires plugin to be registered
4. **End-to-end testing** via Telegram

## Success criteria

1. User can spawn a Claude Code session on the node via Telegram
2. Prompts execute on the node and output streams back to Telegram (≤2s latency per batch)
3. Permission requests show in Telegram with approve/deny, and responses flow back correctly
4. Session close works via `/acp exit` or TTL expiry
5. Multiple concurrent sessions work independently
6. Graceful handling of node disconnect, daemon not running, and other error states
