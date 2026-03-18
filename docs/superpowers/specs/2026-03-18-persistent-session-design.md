# Persistent Claude Code Session Design

## Problem

The current `Session` class spawns a new `claude -p` process for every prompt. Each spawn incurs ~12 seconds of cold-start overhead (process init, config loading, MCP server startup, conversation history reload via `--resume`). For interactive use via Telegram, this makes follow-up prompts feel sluggish.

## Solution

A new `PersistentSession` class that keeps a single long-lived Claude Code process alive across multiple prompts. The process uses `--input-format stream-json` to accept NDJSON messages on stdin and `--output-format stream-json` to emit responses on stdout. After the initial cold start, follow-up prompts complete in ~2-4 seconds instead of ~12-15.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Process start timing | Lazy (on first prompt) | Avoids wasting resources if user never sends a prompt |
| Crash recovery | Notify + auto-respawn on next prompt | User sees the error, recovery is automatic |
| Idle timeout | Two-tier: 15min kills process, 2hr kills session | Frees RAM when idle, preserves context for return |
| Migration strategy | Keep both modes, configurable | Ephemeral mode is proven fallback during transition |

## User Experience

### First prompt (~12-15s)
The persistent claude process cold-starts. Same latency as today. WebUI shows session init and response streaming.

### Follow-up prompts (~2-4s)
Prompt is written directly to the running process's stdin. No spawn, no config reload. The user feels the difference immediately.

### Idle for 15 minutes
The claude process is silently killed to free RAM (~100-200MB). Session metadata stays alive. WebUI still shows the session as "idle".

### Returning after idle process kill (~12-15s)
Process respawns with `--resume`, reloading conversation history from disk. Same latency as first prompt. Conversation context fully preserved. Subsequent prompts are fast again.

### Full TTL expiry (2 hours idle)
Session closed entirely: process killed, metadata cleared, WebUI cleaned. User must start a new session.

### Claude process crashes mid-turn
User sees an error in Telegram: `[Error: claude process exited unexpectedly]`. Next message automatically respawns with `--resume` and continues the conversation.

### Switching modes
Set `sessionMode: "ephemeral"` in gateway plugin config. Everything works exactly as today (one process per prompt with `--resume`).

## Architecture

### New class: `PersistentSession`

Lives alongside `Session`. Same external interface (`prompt()`, `close()`, `cancel()`, same constructor signature). Different internals:

| | `Session` (ephemeral) | `PersistentSession` |
|---|---|---|
| Process lifetime | One per prompt | One per session |
| CLI flags | `claude -p --output-format stream-json` | `claude --input-format stream-json --output-format stream-json` |
| Stdin behavior | Write prompt text, close stdin | Write NDJSON `user_message`, keep stdin open |
| Turn boundary | Process exits | `{"type":"result"}` message on stdout |
| Resume after crash | `--resume <id>` on next spawn | `--resume <id>` on respawn |
| Shell mode | `shell: true` (needs PATH resolution) | `shell: false, windowsHide: true` (direct exec, avoids orphan risk) |

### State machine

```
[no process] --prompt()--> [spawning] --init received--> [running/busy]
                               |
              prompt() while spawning --> QUEUED (await spawn promise)

[running/busy] --result received--> [running/idle] --prompt()--> [running/busy]
                                        |
                            --idle timeout--> [no process]
                            --crash while busy--> [no process] + error event + prompt_complete
                            --crash while idle--> [no process] (silent)
```

**Spawning guard:** A private `_spawnPromise: Promise | null` field. When `prompt()` needs to spawn a process, it sets `_spawnPromise` and awaits it. If a second `prompt()` arrives during spawn, it awaits the same `_spawnPromise` rather than spawning a duplicate. The promise resolves when the `system/init` message is received on stdout.

### PersistentSession internals

**`prompt(text)` flow:**

1. If `_spawnPromise` is active, await it (handles concurrent prompt during respawn)
2. If no process exists, spawn:
   - First call: `claude --input-format stream-json --output-format stream-json --verbose --permission-mode <mode> [--dangerously-skip-permissions] [--model <model>]`
   - After crash/idle kill: same flags + `--resume <claudeSessionId>`
   - Uses `shell: false` with full path to `claude` binary (avoids orphan risk from `shell: true` on Windows — the process idle timer's `stdin.end()` + `SIGTERM` goes directly to the claude process, not a cmd.exe wrapper)
3. Clear the process idle timer (turn is starting)
4. Write NDJSON to stdin: `{"type":"user_message","content":"<text>"}\n`
5. Read stdout NDJSON, forwarding through `forwardOutput()` and `renderMessage()` (unchanged)
6. When `{"type":"result"}` arrives: turn complete, resolve prompt promise, set status idle, restart idle timer
7. Process and stdin stay open for next prompt

**Stdout reading:**

A persistent background loop (started when process spawns) reads stdout via `readline.createInterface`. Each line is parsed as JSON and forwarded through the same `forwardOutput()` and `renderMessage()` pipeline used by ephemeral sessions. The loop runs until the process exits.

The prompt method registers a one-shot `result` listener (or uses a promise that resolves when the background loop sees `type === "result"`). Between prompts, the background loop stays active (but receives no messages since claude is idle).

**Crash detection and prompt_complete guarantee:**

`proc.on("close")` fires in the background loop. Behavior depends on current state:

- **If busy:** Emit `error` event with the exit code, then emit `prompt_complete` with `stopReason: "process_crashed"` (mirrors the `trackingEmit` fallback in ephemeral `Session`), then reject the pending prompt promise.
- **If idle:** Silently mark process as gone (`_proc = null`). Next `prompt()` detects no process and respawns.
- **If spawning:** Reject the spawn promise. `prompt()` caller sees the error.

The `prompt_complete` emission on crash is critical: without it, the daemon never transitions back to idle and the plugin's poll loop never terminates.

**Process idle timer:**

A `setTimeout` at `processIdleMinutes * 60_000` (default 15 minutes). Timer lifecycle:
- **Cleared** when `prompt()` starts (entering busy state)
- **Not running** while busy (so long-running turns don't trigger it)
- **Restarted** when `result` message arrives (entering idle state)
- When it fires:
  1. `proc.stdin.end()` (graceful shutdown signal — goes directly to claude since `shell: false`)
  2. After 5 seconds, `proc.kill("SIGTERM")` if still alive
  3. Session object stays alive, `_claudeSessionId` preserved for resume
  4. Next prompt triggers respawn

**SessionManager TTL interaction:**

The existing `SessionManager.resetTtl()` is called via `setStatus()` which fires at the start and end of each turn (when `Daemon.handlePrompt` sets "busy", and when the prompt completes and sets "idle"). For very long turns (>2 hours), the TTL could fire mid-turn. To prevent this, `PersistentSession.prompt()` calls a heartbeat: `this.emit({ type: "output", sessionId, messageType: "heartbeat" })` which triggers `broadcastAndBuffer` → `updateWebUISessions`. However, this alone doesn't reset the TTL since `resetTtl` is tied to `setStatus`.

**Mitigation:** The `Daemon.handlePrompt` callback already calls `sessionManager.setStatus("idle")` when the prompt resolves. For turns exceeding 1 hour, the `PersistentSession` should call a provided `onActivity` callback (passed from Daemon) that calls `sessionManager.resetTtl()` directly. This callback fires whenever a `result` or `assistant` message is received on stdout — ensuring the TTL resets on actual API activity, not just prompt boundaries. A turn that runs for 3 hours with continuous tool use will continuously reset the TTL via these output messages.

**Integration points (unchanged):**

- `ChildPidRegistry`: register on spawn, unregister on exit
- `writer` function: same dual terminal + WebUI output
- `emit` callback: same event forwarding to IPC/EventBuffer
- `forwardOutput()`: same output-to-event mapping
- `renderMessage()`: same ANSI terminal rendering

### Daemon changes

`handleSpawn()` in `src/daemon.ts` becomes a factory: if the spawn request includes `sessionMode === "persistent"`, instantiate `PersistentSession`; otherwise instantiate `Session`. Both conform to the same `ISession` interface so all other daemon code (handlePrompt, handleClose, handleCancel, etc.) works unchanged.

The `onActivity` callback for TTL reset is passed from Daemon to PersistentSession:
```typescript
const onActivity = () => this.sessionManager.resetTtl(req.sessionId);
```

### Config changes

**Daemon-side (`src/config.ts`):**
- `sessionMode: "persistent" | "ephemeral"` (default: `"persistent"`)
- `processIdleMinutes: number` (default: `15`)

**Plugin-side (`plugin/src/config.ts`):**
- `sessionMode: "persistent" | "ephemeral"` (default: `"persistent"`)

### IPC protocol changes

**`SpawnRequest` in `src/ipc-protocol.ts`** — add optional field:
```typescript
sessionMode?: "persistent" | "ephemeral";
```

**CLI `spawn` command in `src/index.ts`** — add `--session-mode` flag:
```
acpx-node-daemon spawn --cwd <path> [--session-id <uuid>] [--session-mode persistent|ephemeral]
```

**Plugin `ensureSession` in `plugin/src/runtime.ts`** — pass `--session-mode` in the CLI command:
```typescript
const result = await this.bridge.exec(nodeId, [
  ...this.config.daemonBin, "spawn",
  "--session-id", sessionId,
  "--cwd", cwd,
  "--session-mode", this.config.sessionMode,
]);
```

## Files

| File | Action | Purpose |
|---|---|---|
| `src/persistent-session.ts` | Create | PersistentSession class (~250 lines) |
| `src/session-interface.ts` | Create | `ISession` interface extracted from Session |
| `src/session.ts` | Modify | Implement `ISession` interface |
| `src/daemon.ts` | Modify | Factory switch in handleSpawn, pass onActivity callback, type sessions map as `ISession` |
| `src/config.ts` | Modify | Add `sessionMode`, `processIdleMinutes` |
| `src/ipc-protocol.ts` | Modify | Add `sessionMode` field to `SpawnRequest` |
| `src/index.ts` | Modify | Add `--session-mode` flag to spawn CLI command |
| `plugin/src/config.ts` | Modify | Expose `sessionMode` option |
| `plugin/src/runtime.ts` | Modify | Pass `--session-mode` in spawn CLI call |
| `plugin/openclaw.plugin.json` | Modify | Add `sessionMode` to config schema |
| `tests/persistent-session.test.ts` | Create | Tests for PersistentSession |

**Unchanged:** `session-manager.ts`, `event-buffer.ts`, `ipc-server.ts`, `web-ui.ts`, `poll-loop.ts`, `node-bridge.ts`, `daemon-manager.ts`, `output-forwarder.ts`, `permission-proxy.ts`.

## NDJSON Wire Format

**Input (stdin to claude process):**
```json
{"type":"user_message","content":"What is the capital of Canada?"}
```

> **Note:** The exact field names for `--input-format stream-json` must be verified at implementation time by testing `echo '{"type":"user_message","content":"test"}' | claude --input-format stream-json --output-format stream-json --verbose -p`. If the format differs (e.g. `role`/`content` array structure), the stdin write in `PersistentSession.prompt()` must be adjusted. The output format is already verified by the existing `Session` class.

**Output (stdout from claude process, one per line):**
```json
{"type":"system","subtype":"init","session_id":"abc123","model":"claude-sonnet-4-6","permissionMode":"bypassPermissions"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Ottawa is the capital of Canada."}]}}
{"type":"result","subtype":"success","session_id":"abc123","duration_ms":1200,"num_turns":1,"total_cost_usd":0.003}
```

Turn completion: a message with `type === "result"` signals end of turn.

## Error Handling

| Scenario | Behavior |
|---|---|
| Process crashes while busy | Emit error event + prompt_complete (stopReason: "process_crashed"), reject prompt promise. Next prompt respawns with `--resume`. |
| Process crashes while idle | Mark process as gone silently. Next prompt respawns with `--resume`. |
| Process crashes while spawning | Reject spawn promise. prompt() caller sees error. |
| Stdin write fails (broken pipe) | Treat as crash. Same recovery path. |
| Concurrent prompt during spawn | Awaits the in-flight spawn promise instead of spawning again. |
| Process idle timeout fires | Clear idle timer, stdin.end() + 5s SIGTERM fallback (direct to process, no shell wrapper). Session stays alive. |
| TTL expiry | Full cleanup via existing SessionManager callback (kills process, deletes session, cleans WebUI). |
| TTL during long turn | onActivity callback resets TTL on every stdout message, preventing mid-turn TTL expiry. |
| Spawn fails (ENOENT, etc.) | Emit error event + prompt_complete, reject prompt promise. Session remains in "no process" state. |

## Testing Strategy

- Mock `child_process.spawn` to simulate the persistent process (writable stdin stream, stdout async iterator, close events)
- Test prompt flow: write NDJSON to stdin, verify output forwarding, verify result detection resolves prompt
- Test multi-turn: two consecutive prompts on same session, verify process reused (spawn called once)
- Test crash recovery while busy: simulate process exit mid-turn, verify error + prompt_complete emission, verify respawn with --resume on next prompt
- Test crash recovery while idle: simulate process exit, verify silent handling, verify respawn on next prompt
- Test concurrent prompt during spawn: two prompt() calls before init, verify both resolve correctly
- Test idle timeout: use fake timers, verify process killed after timeout, verify respawn on next prompt preserves claudeSessionId for --resume
- Test graceful close: verify stdin.end + SIGTERM sequence
- Test TTL interaction: verify onActivity callback fires on stdout messages
- Verify `shell: false` is used (not `shell: true`)
