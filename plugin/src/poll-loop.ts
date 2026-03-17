import type { NodeBridge } from "./node-bridge.js";

export interface PollEvent {
  type: "text_delta" | "status" | "tool_call" | "done" | "error" | "permission_auto_approved";
  text?: string;
  message?: string;
  tag?: string;
  stopReason?: string;
  retryable?: boolean;
  permissionId?: string;
  description?: string;
}

export async function* pollLoop(
  nodeId: string,
  sessionId: string,
  bridge: NodeBridge,
  opts: {
    pollIntervalMs: number;
    maxPollMs?: number;
    signal?: AbortSignal;
    autoApprove?: boolean;
    onDaemonDown?: () => void;
  },
): AsyncIterable<PollEvent> {
  const MAX_RETRIES = 3;
  const MAX_POLL_MS = opts.maxPollMs ?? 300_000;
  const RETRY_DELAY_MS = 2000;
  const MAX_IMMEDIATE_REDRAINS = 10;
  const pollStartMs = Date.now();
  let consecutiveFailures = 0;

  while (true) {
    if (Date.now() - pollStartMs > MAX_POLL_MS) {
      yield { type: "error", message: `Prompt timed out after ${MAX_POLL_MS / 1000} seconds`, retryable: false };
      return;
    }

    if (opts.signal?.aborted) {
      yield { type: "done", stopReason: "cancelled" };
      return;
    }

    await sleep(opts.pollIntervalMs);

    // Drain events
    let drainResult;
    try {
      drainResult = await bridge.exec(nodeId, ["acpx-node-daemon", "drain", sessionId]);

      if (!drainResult.success) {
        const stderr = drainResult.stderr || drainResult.stdout || "";
        if (stderr.includes("Cannot connect") || stderr.includes("ENOENT") || stderr.includes("EPIPE")) {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_RETRIES) {
            opts.onDaemonDown?.();
            yield { type: "error", message: "Daemon is not running on the node (connection refused)", retryable: false };
            return;
          }
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      }
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_RETRIES) {
        opts.onDaemonDown?.();
        yield { type: "error", message: `Lost connection to node after ${MAX_RETRIES} failed drain attempts`, retryable: false };
        return;
      }
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const events = parseNdjson(drainResult.stdout);

    // Session lost
    if (events.length === 1 && events[0].type === "error" && events[0].error?.includes("Session not found")) {
      yield { type: "error", message: "Session was lost (daemon may have restarted or session expired)", retryable: false };
      return;
    }

    const hasMore = events.some((e: any) => e.type === "has_more");
    const realEvents = events.filter((e: any) => e.type !== "has_more");

    for (const event of realEvents) {
      const result = yield* handleEvent(event, nodeId, sessionId, bridge, opts.autoApprove ?? true);
      if (result === "stop") return;
    }

    // Rapid re-drain if hasMore
    if (hasMore) {
      let redrains = 0;
      while (redrains < MAX_IMMEDIATE_REDRAINS) {
        await sleep(100);
        redrains++;
        try {
          const moreResult = await bridge.exec(nodeId, ["acpx-node-daemon", "drain", sessionId]);
          const moreEvents = parseNdjson(moreResult.stdout);
          const moreHasMore = moreEvents.some((e: any) => e.type === "has_more");
          const moreReal = moreEvents.filter((e: any) => e.type !== "has_more");
          for (const event of moreReal) {
            const result = yield* handleEvent(event, nodeId, sessionId, bridge, opts.autoApprove ?? true);
            if (result === "stop") return;
          }
          if (!moreHasMore) break;
        } catch {
          break;
        }
      }
    }
  }
}

async function* handleEvent(
  event: any,
  nodeId: string,
  sessionId: string,
  bridge: NodeBridge,
  autoApprove: boolean,
): AsyncGenerator<PollEvent, "stop" | "continue"> {
  // Auto-approve permissions
  if (event.type === "permission_request" && autoApprove) {
    yield {
      type: "permission_auto_approved",
      permissionId: event.permissionId,
      description: event.description,
      text: `Auto-approved: ${event.description}`,
    };
    try {
      await bridge.exec(nodeId, [
        "acpx-node-daemon", "permission-response", sessionId, event.permissionId, "true",
      ]);
    } catch {
      yield { type: "error", message: `Failed to auto-approve permission: ${event.description}` };
    }
    return "continue";
  }

  const mapped = mapDaemonEvent(event);
  if (mapped) {
    yield mapped;
    if (mapped.type === "done" || mapped.type === "error") return "stop";
  }
  return "continue";
}

function mapDaemonEvent(event: any): PollEvent | null {
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
    default:
      return null;
  }
}

function parseNdjson(stdout: string): any[] {
  return stdout.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
