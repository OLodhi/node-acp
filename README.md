# Node ACP — Remote Claude Code Sessions via OpenClaw

Control Claude Code on your workstation remotely via Telegram, through an OpenClaw gateway. The system has two parts: a **node daemon** that manages Claude Code sessions on the target machine, and a **gateway plugin** that bridges OpenClaw's tool system to the daemon.

## System Architecture

```
User (Telegram)
    │ message
OpenClaw Gateway Agent (RPi, 192.168.1.24)
    │ calls node_acp_prompt tool
Gateway Plugin (openclaw-acpx-remote)
    │ node.invoke → system.run (WebSocket RPC)
Node Host (Windows Thinkpad, 192.168.1.18)
    │ executes: node dist/index.js prompt <sessionId> --async --text-b64 <encoded>
acpx-node-daemon (IPC over named pipe)
    │ spawns child process
claude -p --output-format stream-json --verbose --permission-mode bypassPermissions
    │ stream-json events on stdout
Daemon reads events → renders to terminal + buffers for drain polling
```

## Quick Start

```bash
# On the node (Thinkpad)
git clone https://github.com/OLodhi/node-acp.git
cd node-acp
npm install && npm run build

# Start the daemon in a visible terminal
npx acpx-node-daemon start
```

The daemon listens on `\\.\pipe\acpx-node-daemon` (Windows) or `/tmp/acpx-node-daemon.sock` (Linux/macOS). You'll see live color-coded output for every Claude Code interaction.

## Prerequisites

- Node.js >= 20
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Valid Anthropic API key (configured via `ANTHROPIC_API_KEY` or Claude Code auth flow)
- OpenClaw gateway with the `acpx-remote` plugin (for remote access via Telegram)

---

## Node Daemon

### How It Works

The daemon is a long-running process that accepts commands over IPC (named pipe), manages Claude Code session lifecycles, and buffers output events for async consumers.

When a prompt arrives, the daemon spawns `claude -p` as a child process with `--output-format stream-json`. It pipes the prompt via stdin (avoids shell quoting issues on Windows), reads structured JSON events from stdout line by line, renders them to the daemon's terminal with ANSI colors, and simultaneously buffers them for the gateway to drain.

Prompts are **async by design**. The gateway sends a prompt, gets back `prompt_accepted` immediately, then polls `drain` every 1.5 seconds to collect buffered events. This decouples the gateway from Claude Code's processing time.

### Live Terminal Output

When you run `npx acpx-node-daemon start` in a terminal, you see everything Claude Code does:

```
━━━ Claude Code Session [a1b2c3d4] ━━━
  cwd: C:/Users/Omar.Lodhi/Projects/node-acp
  prompt: Create a copy of readme.md called readme2.md
  resume: (new session)

  session: e6886dd4  model: claude-opus-4-6  mode: bypassPermissions
  ▶ Read README.md
  ✓ # Node ACP — Remote ACP Session Dispatch...
  ▶ Write readme2.md
  ✓ (file written)
Created readme2.md as a copy of README.md.
  ✓ Complete  3 turns  8.2s  $0.0451

━━━ Session [a1b2c3d4] turn complete (exit=0) ━━━
```

- **Blue**: Session header/footer, init info
- **Yellow `▶`**: Tool calls with input previews (file paths, commands)
- **Green `✓`**: Tool results, completion summary (turns, duration, cost)
- **Red `✗`**: Errors
- **Bold white**: Claude's text responses

### Source Files

```
src/
├── index.ts              CLI entry point — dual mode (server or client)
├── daemon.ts             Request dispatcher + event routing
├── session.ts            Spawns claude CLI, reads stream-json, renders live output
├── session-manager.ts    Tracks sessions, enforces limits (max 4), TTL auto-close
├── ipc-server.ts         Named pipe server with ndjson framing
├── ipc-protocol.ts       All 7 request + 11 event type definitions
├── event-buffer.ts       Per-session ring buffer (500 events) for async drain
├── output-forwarder.ts   Maps stream-json events → IPC events (output, prompt_complete, error)
├── permission-proxy.ts   Promise-based permission request/response with 30-min timeout
└── config.ts             Defaults (model, socket path, concurrency, TTL)
```

### `index.ts` — Dual-Mode Entry Point

**Server mode** (`acpx-node-daemon start`): Creates a `Daemon`, listens on the named pipe, handles SIGINT/SIGTERM for graceful shutdown.

**Client mode** (all other commands): Connects to the running daemon, sends a single ndjson request, reads events back, exits on terminal events. Special handling:
- `prompt --async`: Disconnects after `prompt_accepted` (gateway uses this)
- `prompt --text-b64 <b64>`: Base64-decodes prompt text to avoid shell escaping issues
- `drain`: Unwraps the `drain_result` envelope, prints inner events as raw ndjson with a `{"type":"has_more"}` sentinel if the buffer has more

### `daemon.ts` — The Orchestrator

Routes 7 request types. Key behaviors:

- **`handlePrompt`**: Validates session is idle, sends `prompt_accepted` synchronously, then calls `session.prompt()` as a fire-and-forget promise. Output streams via `broadcastAndBuffer`.
- **`handleDrain`**: Pulls buffered events from `EventBuffer`. Returns `{ events, hasMore }`.
- **`broadcastAndBuffer`**: Every event goes through here — broadcasts to connected IPC clients AND pushes to the per-session EventBuffer.

### `session.ts` — Where Claude Code Runs

Each prompt spawns:
```
claude -p --output-format stream-json --verbose
       --permission-mode bypassPermissions --dangerously-skip-permissions
       --model claude-opus-4-6 [--resume <session_id>]
```

Prompt text is piped via stdin. Stdout is read line by line via `readline`. Each JSON event:
1. Captures `session_id` from `system/init` (for `--resume` on subsequent prompts)
2. Renders to the daemon's terminal via `renderMessage()` (ANSI colors)
3. Forwards to IPC via `forwardOutput()` (maps to daemon events for the gateway)

Uses `shell: true` on `spawn()` for Windows PATH resolution. Handles spawn errors gracefully without crashing the daemon.

### `session-manager.ts` — Lifecycle and Limits

Tracks sessions in a Map. Each has a status (`starting` → `idle` → `busy` → `idle`), a TTL timer (resets on every activity, default 120 minutes), and a PID. Enforces max 4 concurrent sessions.

### `event-buffer.ts` — Async Event Store

Per-session ring buffer (max 500 events, FIFO oldest-drop on overflow). Drain returns events up to 150KB per call with `hasMore` flag. When a session closes, `markDraining()` starts a 60-second grace period for final drain, then auto-cleanup.

### `output-forwarder.ts` — Event Translator

Pure function mapping Claude Code's stream-json to daemon IPC events:
- `assistant` → extracts text blocks → `OutputEvent(assistant_text)`, extracts tool_use blocks → `OutputEvent(tool_use)`
- `result/success` → `PromptCompleteEvent(end_turn)`
- `result/error` → `ErrorEvent` + `PromptCompleteEvent(error)`
- Everything else (system, hooks, rate_limit) → ignored

### `permission-proxy.ts` — Permission Bridge

Not used in bypass mode, but fully wired for interactive permission modes. Creates a pending promise with a UUID per permission request, emits a `permission_request` event, resolves when `handleResponse()` is called or 30-minute timeout fires.

### CLI Commands

```bash
npx acpx-node-daemon start                                          # Start daemon
npx acpx-node-daemon spawn --cwd /path/to/project                   # Create session
npx acpx-node-daemon prompt <sessionId> "Fix the bug"               # Send prompt (sync, waits for completion)
npx acpx-node-daemon prompt <sessionId> --async --text-b64 <b64>    # Send prompt (async, returns immediately)
npx acpx-node-daemon drain <sessionId>                               # Pull buffered events
npx acpx-node-daemon status <sessionId>                              # Check session state
npx acpx-node-daemon cancel <sessionId>                              # Cancel current turn (SIGTERM)
npx acpx-node-daemon close <sessionId>                               # End session
npx acpx-node-daemon permission-response <sid> <pid> true|false      # Respond to permission request
```

### IPC Protocol

Newline-delimited JSON over named pipe. Each message is `JSON.stringify(msg) + "\n"`.

**Inbound (client → daemon)**

| Command | Key Fields | Description |
|---------|-----------|-------------|
| `spawn` | `sessionId, agent, cwd, model, permissionMode, timeoutMinutes` | Create session |
| `prompt` | `sessionId, prompt` | Send prompt |
| `drain` | `sessionId` | Pull buffered events |
| `cancel` | `sessionId` | Interrupt current turn |
| `close` | `sessionId` | End session |
| `status` | `sessionId` | Get session state |
| `permission_response` | `sessionId, permissionId, approved` | Answer permission request |

**Outbound (daemon → client)**

| Event | Key Fields | Description |
|-------|-----------|-------------|
| `spawn_result` | `sessionId, success, error?` | Session created or failed |
| `prompt_accepted` | `sessionId` | Prompt received, processing started |
| `output` | `sessionId, messageType, chunk, timestamp` | Streaming output (`assistant_text` or `tool_use`) |
| `prompt_complete` | `sessionId, stopReason` | Turn finished (`end_turn` or `error`) |
| `error` | `sessionId, error` | Error occurred |
| `drain_result` | `sessionId, events[], hasMore` | Buffered events batch |
| `session_closed` | `sessionId, reason` | Session ended (`user_closed`, `ttl_expired`, `daemon_stopped`) |
| `permission_request` | `sessionId, permissionId, operation, path, description` | Permission needed (interactive modes only) |
| `status_result` | `sessionId, status, agent, cwd, model, pid, createdAt, lastActivityAt` | Session state |

### Session Lifecycle

```
spawn → Session registered (idle, no claude process yet)
  │
prompt → claude -p spawned, session becomes busy
  │        │ stream-json events on stdout
  │   output-forwarder maps → DaemonEvent → broadcastAndBuffer
  │
claude exits → prompt_complete emitted, session returns to idle
  │
prompt (2nd+) → claude -p --resume <session_id> (maintains conversation context)
  │
close → SIGTERM child process, cleanup session + buffer
```

### Configuration

Defaults in `src/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrentSessions` | 4 | Max parallel sessions |
| `defaultModel` | `claude-opus-4-6` | Claude model |
| `defaultPermissionMode` | `bypassPermissions` | Skip all permission checks |
| `defaultTtlMinutes` | 120 | Session auto-close after inactivity |
| `permissionTimeoutMinutes` | 30 | Permission request timeout |
| `maxBufferedEvents` | 500 | Per-session event buffer size |
| `ipcSocketPath` | `\\.\pipe\acpx-node-daemon` | Named pipe path (Windows) |

---

## Gateway Plugin

The OpenClaw plugin that bridges Telegram to the node daemon. Runs on the gateway (RPi) and registers tools that the gateway's LLM agent can call.

### Source Files

```
gateway-plugin/src/
├── index.ts          Plugin registration + 5 tool definitions
├── runtime.ts        Session management + async drain poll loop
├── node-exec.ts      RPC bridge to OpenClaw node.invoke → system.run
├── handle.ts         Session handle encode/decode (base64url JSON blob)
└── config.ts         Plugin config (pollIntervalMs, daemonBin, defaultNode)
```

### `node-exec.ts` — The RPC Bridge

Every daemon interaction from the gateway goes through here. Wraps OpenClaw's `callGateway` function to call `node.invoke` → `system.run` on the Thinkpad. Each call executes:

```
node C:/Users/Omar.Lodhi/Projects/node-acp/dist/index.js <command> <args>
```

On the Thinkpad as a child process. Returns `{ exitCode, stdout, stderr, success }`. Caches node ID lookups so `resolveNode("Thinkpad-Node")` only calls `node.list` once.

### `runtime.ts` — The Poll Loop Engine

**`ensureSession()`**: Calls `nodeExec` to run `acpx-node-daemon spawn`. Returns an encoded handle.

**`runTurn()`**: The main prompt flow:
1. Base64-encode the prompt
2. Call `nodeExec` to run `acpx-node-daemon prompt <sessionId> --async --text-b64 <encoded>`
3. Parse the response — must be `{"type":"prompt_accepted"}`
4. Enter `pollLoop()`

**`pollLoop()`**: Async generator driving the drain cycle:
```
while (true):
  check 300s timeout → yield error, return
  check abort signal → cancel, return
  sleep(1500ms)
  nodeExec("drain", sessionId)
  if daemon not running (ENOENT/EPIPE) → retry 3x, then fail
  parse ndjson events from stdout
  for each event:
    if permission_request + autoApprove → approve immediately, yield log, continue
    map to AcpRuntimeEvent, yield it
    if done/error → return
  if hasMore → rapid-drain at 100ms intervals (up to 10x)
```

**`handleEvent()`**: Sub-generator processing one daemon event. If `permission_request` and auto-approve is on, immediately calls `respondToPermission()` via nodeExec and continues the loop without stopping. For terminal events (`done`, `error`), stops the loop.

**Error resilience**:
- Daemon not running → detects "Cannot connect"/"ENOENT"/"EPIPE", fails after 3 retries
- Session lost → detects `"Session not found"` from drain, yields error immediately
- Network RPC failure → try/catch with retry logic
- Timeout → 300-second max poll duration

### `index.ts` — Tool Registration

Registers 5 tools with OpenClaw:

**`node_acp_spawn`** — Creates a session. Takes `node` + `cwd`, calls `runtime.ensureSession()`, returns the sessionId.

**`node_acp_prompt`** — The main tool. Takes `sessionId`, `node`, `text`. Calls `runtime.runTurn()` with `autoApprove: true` and collects ALL events into a sequential log:
- Raw text from Claude → verbatim
- `[Tool: Write]` for tool calls
- `[Permission auto-approved: Write on readme2.md]` for permissions
- `[Error: ...]` for errors

Returns the full log. Tool description instructs the LLM agent: **"relay the FULL output to the user exactly as-is without summarizing."**

**`node_acp_permission`** — Manual override for permission responses (unused in auto-approve mode).

**`node_acp_continue`** — Resumes drain polling after manual permission response.

**`node_acp_close`** — Ends the session.

### `handle.ts` — State Encoding

Packs `{ sessionId, node, cwd }` into a base64url JSON blob. The gateway agent never sees internals — it passes sessionId and node name, the tool reconstructs the handle.

### Skill Definition

`skills/acp-node-router/SKILL.md` teaches the gateway agent when and how to use the tools. Key instruction: **"You MUST relay the FULL output from node_acp_prompt to the user EXACTLY as returned. Do not summarize."**

### Plugin Configuration

Set in OpenClaw's `openclaw.json` under `plugins.entries.acpx-remote.config`:

```json
{
  "defaultNode": "Thinkpad-Node",
  "pollIntervalMs": 1500,
  "daemonBin": "node C:/Users/Omar.Lodhi/Projects/node-acp/dist/index.js"
}
```

---

## Testing

```bash
npm test              # run all tests
npm run test:watch    # watch mode
```

38 tests across 7 files:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `tests/ipc-protocol.test.ts` | 6 | Serialization, deserialization, error cases |
| `tests/ipc-server.test.ts` | 3 | Connection, send/receive, shutdown |
| `tests/config.test.ts` | 3 | Defaults, overrides, platform paths |
| `tests/permission-proxy.test.ts` | 5 | Approve, deny, timeout, cleanup |
| `tests/session-manager.test.ts` | 6 | Registration, concurrency, TTL, status |
| `tests/output-forwarder.test.ts` | 8 | SDK message mapping, ignored types |
| `tests/session.test.ts` | 7 | Lifecycle, resume, error handling |

## Design Documents

- `docs/specs/2026-03-16-node-acp-design.md` — Original design spec
- `docs/specs/2026-03-16-agent-sdk-integration-design.md` — Agent SDK integration spec
- `docs/plans/2026-03-16-node-acp-implementation.md` — Implementation plan (Tasks 1-8)
- `docs/plans/2026-03-16-agent-sdk-integration.md` — SDK integration plan (Tasks 1-6)
