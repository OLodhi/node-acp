import type { DaemonEvent } from "./ipc-protocol.js";

/**
 * Maps an SDK message to zero or more DaemonEvent emissions.
 * Pure function — no state.
 *
 * We forward:
 * - "assistant" messages (final assembled) → extract text and tool_use blocks
 * - "result" messages → prompt_complete (success) or error + prompt_complete (error)
 *
 * We ignore:
 * - "stream_event" (raw Anthropic stream deltas — too granular for IPC consumers)
 * - "system" (init, compact_boundary — internal to Claude Code)
 * - All other types (hooks, auth, status, etc.)
 */
export function forwardOutput(
  message: any,
  sessionId: string,
  emit: (event: DaemonEvent) => void
): void {
  const type = message?.type;
  if (!type) return;

  switch (type) {
    case "assistant": {
      const content = message.message?.content;
      if (!Array.isArray(content)) return;

      const textParts: string[] = [];
      const toolNames: string[] = [];

      for (const block of content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use" && block.name) {
          toolNames.push(block.name);
        }
      }

      if (textParts.length > 0) {
        emit({
          type: "output",
          sessionId,
          messageType: "assistant_text",
          chunk: textParts.join(""),
          timestamp: Date.now(),
        });
      }

      if (toolNames.length > 0) {
        emit({
          type: "output",
          sessionId,
          messageType: "tool_use",
          chunk: toolNames.join(", "),
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "result": {
      if (message.subtype === "success") {
        emit({
          type: "prompt_complete",
          sessionId,
          stopReason: "end_turn",
        });
      } else {
        const errors: string[] = message.errors ?? [];
        emit({
          type: "error",
          sessionId,
          error: errors.join("; ") || "Unknown error",
        });
        emit({
          type: "prompt_complete",
          sessionId,
          stopReason: "error",
        });
      }
      break;
    }

    default:
      break;
  }
}
