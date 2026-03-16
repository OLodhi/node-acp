# Agent SDK Integration — Real Claude Code Sessions

## Problem

The `acpx-node-daemon` currently uses mock responses for prompts. Task 9 replaces these with real Claude Code sessions using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

## Solution

Use the Claude Agent SDK's `query()` function to spawn Claude Code sessions, stream output, and proxy permission requests. The SDK handles the agent lifecycle, tool execution, and conversation context — our daemon wraps it with session management and IPC transport.

## Architecture

### New Files

- `src/session.ts` — Wraps `query()` per session. Manages lifecycle (idle → busy → idle), captures `session_id` for resume, wires `canUseTool` to `PermissionProxy`.
- `src/output-forwarder.ts` — Maps `SDKMessage` stream to `DaemonEvent` emissions via a callback.

### Modified Files

- `src/daemon.ts` — Replace TODO placeholders with real `Session` integration.
- `package.json` — Add `@anthropic-ai/claude-agent-sdk` dependency.

### Session Lifecycle

```
spawn → Session created (idle, no query running)
  ↓
prompt → query() called with { prompt, cwd, permissionMode, canUseTool }
  ↓         ↓ streams SDKMessage
  ↓    OutputForwarder maps → DaemonEvent → IPC broadcast
  ↓
query completes → prompt_complete emitted, session returns to idle
  ↓
prompt (2nd+) → query() called with { prompt, resume: sessionId }
  ↓
close → query.close(), cleanup
```

Between `spawn` and first `prompt`, no Claude Code process runs. This avoids wasting resources on sessions that are spawned but never used.

### Output Forwarder Mapping

| SDKMessage Type | DaemonEvent |
|---|---|
| `SDKAssistantMessage` | `output { messageType: "assistant_text", chunk }` |
| `SDKPartialAssistantMessage` | `output { messageType: "assistant_text", chunk }` |
| `SDKToolUseSummaryMessage` | `output { messageType: "tool_use", chunk }` |
| `SDKStatusMessage` | `output { messageType: "tool_result", chunk }` |
| `SDKResultMessage` (success) | `prompt_complete { stopReason: "end_turn" }` |
| `SDKResultMessage` (error) | `error` + `prompt_complete { stopReason: "error" }` |
| All other types | Ignored (internal to Claude Code) |

### Permission Proxy Flow

Permissions are handled via the SDK's `canUseTool` callback, not through the output forwarder.

```
Claude Code requests tool use
  ↓
canUseTool(toolName, input, { signal }) called by SDK
  ↓
Session calls PermissionProxy.requestPermission(sessionId, toolName, path, description)
  ↓
PermissionProxy emits permission_request event → IPC → node host → gateway → Telegram
  ↓
User responds (or 30-min timeout)
  ↓
PermissionProxy resolves → Session returns { behavior: "allow" } or { behavior: "deny", message }
```

If `signal` fires (cancel/interrupt), the permission is denied automatically.

### Error Handling

| Scenario | Behavior |
|---|---|
| `query()` throws | Emit `error` + `session_closed { reason: "agent_crashed" }`, clean up |
| `query()` generator completes | Emit `prompt_complete`, session → idle |
| Cancel during permission wait | `signal` fires, permission denied, `interrupt()` stops the turn |
| Session not found | Return error event (existing behavior) |
| Claude Code CLI not installed | `query()` will throw on first prompt, caught and reported as error |

### Session Class Interface

```typescript
interface SessionEvents {
  output: (event: DaemonEvent) => void;
  error: (sessionId: string, error: string) => void;
  closed: (sessionId: string, reason: string) => void;
  promptComplete: (sessionId: string, stopReason: string) => void;
}

class Session {
  constructor(
    sessionId: string,
    cwd: string,
    model: string,
    permissionMode: string,
    permissionProxy: PermissionProxy,
    emit: (event: DaemonEvent) => void
  );

  async prompt(text: string): Promise<void>;  // Starts query, streams output
  async cancel(): Promise<void>;               // Calls interrupt()
  close(): void;                               // Calls close(), cleanup
  get pid(): number | undefined;               // Process ID if available
}
```

### Output Forwarder Interface

```typescript
function forwardOutput(
  message: SDKMessage,
  sessionId: string,
  emit: (event: DaemonEvent) => void
): void;
```

A pure function — takes an SDKMessage, maps it to zero or more DaemonEvent emissions. No state.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK (npm package)
- Claude Code CLI must be installed on the node machine (`npm install -g @anthropic-ai/claude-code`)

## Testing Strategy

- **Unit tests for `output-forwarder.ts`** — Feed mock SDKMessages, verify correct DaemonEvents emitted
- **Unit tests for `session.ts`** — Mock `query()` to return a fake async generator, verify lifecycle (idle → busy → idle), verify `canUseTool` integration with PermissionProxy
- **Integration test** — Real daemon + real Claude Code, spawn session, send simple prompt, verify streaming output (requires Claude Code CLI installed)
