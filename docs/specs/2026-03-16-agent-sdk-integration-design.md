# Agent SDK Integration — Real Claude Code Sessions

## Problem

The `acpx-node-daemon` currently uses mock responses for prompts. Task 9 replaces these with real Claude Code sessions using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

## Architecture Change

The original design spec referenced `acpx` (queue owner) and `@agentclientprotocol/sdk` as dependencies. This spec replaces both with `@anthropic-ai/claude-agent-sdk`, which provides a higher-level API that directly manages Claude Code sessions. The original spec's `Session → ACPX QueueOwner → Claude Code` chain becomes `Session → query() → Claude Code`.

## Solution

Use the Claude Agent SDK's `query()` function to spawn Claude Code sessions, stream output, and proxy permission requests. The SDK handles the agent lifecycle, tool execution, and conversation context — our daemon wraps it with session management and IPC transport.

## Architecture

### New Files

- `src/session.ts` — Wraps `query()` per session. Manages lifecycle (idle → busy → idle), captures `session_id` for resume, wires `canUseTool` to `PermissionProxy`.
- `src/output-forwarder.ts` — Maps `SDKMessage` stream to `DaemonEvent` emissions via a callback.

### Modified Files

- `src/daemon.ts` — Replace TODO placeholders with real `Session` integration.
- `package.json` — Add `@anthropic-ai/claude-agent-sdk` dependency. Remove `acpx` and `@agentclientprotocol/sdk` if present.
- `CLAUDE.md` — Update architecture notes to reference Claude Agent SDK instead of ACPX.

### Session Lifecycle

```
spawn → Session created (idle, no query running, pid undefined)
         spawn_result returns { success: true, pid: undefined }
  ↓
prompt → query() called with { prompt, cwd, model, permissionMode, canUseTool }
           session captures session_id from SDKSystemMessage (subtype: "init")
  ↓         ↓ streams SDKMessage
  ↓    OutputForwarder maps → DaemonEvent → IPC broadcast
  ↓
query completes → prompt_complete emitted, session returns to idle
  ↓
prompt (2nd+) → query() called with { prompt, resume: capturedSessionId }
  ↓
close → query.close(), cleanup
```

Between `spawn` and first `prompt`, no Claude Code process runs. This avoids wasting resources on sessions that are spawned but never used. The `pid` field in `spawn_result` will be `undefined` (already optional in `SpawnResultEvent`) until the first prompt starts a process.

### Output Forwarder Mapping

The forwarder emits only `SDKPartialAssistantMessage` for streaming text (not the final `SDKAssistantMessage`) to avoid duplicate content. The SDK message type names are from the SDK's `SDKMessage` union type.

| SDKMessage Type (`message.type`) | DaemonEvent |
|---|---|
| `"assistant"` (partial, `SDKPartialAssistantMessage`) | `output { messageType: "assistant_text", chunk }` |
| `"assistant"` (final, `SDKAssistantMessage`) | Ignored (content already streamed via partials) |
| `"tool_use_summary"` (`SDKToolUseSummaryMessage`) | `output { messageType: "tool_use", chunk: tool name + summary }` |
| `"status"` (`SDKStatusMessage`) | `output { messageType: "tool_result", chunk: status text }` |
| `"result"` success (`SDKResultMessage`) | `prompt_complete { stopReason: "end_turn" }` |
| `"result"` error (`SDKResultMessage`) | `error` + `prompt_complete { stopReason: "error" }` |
| All other types | Ignored (internal to Claude Code) |

Note: SDK message type names will be verified during implementation and adjusted if the actual SDK exports differ.

### Permission Proxy Flow

Permissions are handled via the SDK's `canUseTool` callback, not through the output forwarder.

```
Claude Code requests tool use
  ↓
canUseTool(toolName, input, { signal }) called by SDK
  ↓
Session extracts path and description from input:
  - path: input.file_path ?? input.command ?? input.path ?? "(unknown)"
  - description: `${toolName} on ${path}`
  ↓
Session calls PermissionProxy.requestPermission(sessionId, toolName, path, description)
  ↓
PermissionProxy emits permission_request event → IPC → node host → gateway → Telegram
  ↓
User responds (or 30-min timeout)
  ↓
PermissionProxy resolves boolean →
  Session returns { behavior: "allow" } or { behavior: "deny", message: "Permission denied by user" }
```

**AbortSignal handling:** The `canUseTool` callback receives a `signal: AbortSignal`. The Session races the `PermissionProxy.requestPermission()` promise against the signal. If the signal fires first (due to `cancel()` or `interrupt()`), the permission is denied and the pending permission is cleaned up via `PermissionProxy.cleanupSession()`.

### Error Handling

| Scenario | Behavior |
|---|---|
| `query()` throws | Emit `error` + `session_closed { reason: "agent_crashed" }`, clean up session |
| `query()` generator completes normally | Emit `prompt_complete { stopReason: "end_turn" }`, session → idle |
| `prompt()` called while session is busy | Throws error — daemon's `handlePrompt` already guards against this via `session.status !== "idle"` check |
| `cancel()` called | Calls `query.interrupt()`, generator completes with result message, session → idle |
| `cancel()` during permission wait | `signal` fires, permission denied via AbortSignal race, generator completes, session → idle |
| Session not found | Return error event (existing behavior) |
| Claude Code CLI not installed | `query()` will throw on first prompt, caught and reported as error event |

After `cancel()`, the async generator will complete (either with a result message or by throwing). The Session listens for generator completion and transitions back to `idle` in all cases. The generator completing is the authoritative signal for state transition — `cancel()` itself does not change status.

### Session Class Interface

```typescript
class Session {
  readonly sessionId: string;

  constructor(
    sessionId: string,
    cwd: string,
    model: string,
    permissionMode: string,
    permissionProxy: PermissionProxy,
    emit: (event: DaemonEvent) => void
  );

  get status(): "idle" | "busy";
  get pid(): number | undefined;
  get resumeSessionId(): string | undefined;  // Captured from SDK init message

  async prompt(text: string): Promise<void>;   // Throws if busy. Starts query, streams output.
  async cancel(): Promise<void>;                // Calls interrupt(). No-op if idle.
  close(): void;                                // Calls close(), cleanup resources.
}
```

**State management:** `prompt()` sets status to `busy`, starts the async generator loop in the background. When the generator completes (for any reason — success, error, cancel), status returns to `idle`. The `prompt()` method throws if called while `busy`.

**Resume:** The first call to `prompt()` starts `query()` with `{ prompt, cwd, model, permissionMode, canUseTool }`. The Session captures `session_id` from the init system message. Subsequent `prompt()` calls use `{ prompt, resume: this.resumeSessionId }`.

### Output Forwarder Interface

```typescript
function forwardOutput(
  message: SDKMessage,
  sessionId: string,
  emit: (event: DaemonEvent) => void
): void;
```

A pure function — takes an SDKMessage, maps it to zero or more DaemonEvent emissions. No state. Discriminates on `message.type` string.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK (npm package)
- Claude Code CLI must be installed on the node machine (`npm install -g @anthropic-ai/claude-code`)

**Removed from original spec:** `acpx` and `@agentclientprotocol/sdk` are no longer needed.

## Testing Strategy

- **Unit tests for `output-forwarder.ts`** — Feed mock SDKMessages, verify correct DaemonEvents emitted. Verify partial messages emit output but final assistant messages are ignored.
- **Unit tests for `session.ts`** — Mock `query()` to return a fake async generator. Verify lifecycle (idle → busy → idle), verify `canUseTool` integration with PermissionProxy, verify resume session ID capture, verify prompt-while-busy throws.
- **Integration test** — Real daemon + real Claude Code, spawn session, send simple prompt, verify streaming output (requires Claude Code CLI installed)
