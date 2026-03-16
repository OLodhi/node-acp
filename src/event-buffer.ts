import type { DaemonEvent } from "./ipc-protocol.js";

export type BufferedEventType = "output" | "permission_request" | "prompt_complete" | "error" | "session_closed";

interface SessionBuffer {
  events: DaemonEvent[];
  draining: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export class EventBuffer {
  private buffers = new Map<string, SessionBuffer>();

  constructor(private maxEvents: number = 500) {}

  push(sessionId: string, event: DaemonEvent & { type: BufferedEventType }): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], draining: false };
      this.buffers.set(sessionId, buf);
    }
    if (buf.events.length >= this.maxEvents) {
      buf.events.shift();
      console.warn(`[event-buffer] session ${sessionId}: buffer full, dropping oldest event`);
    }
    buf.events.push(event);
  }

  drain(sessionId: string, maxBytes: number = 150_000): { events: DaemonEvent[]; hasMore: boolean } {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.events.length === 0) {
      return { events: [], hasMore: false };
    }

    const result: DaemonEvent[] = [];
    let totalBytes = 0;
    let hasMore = false;

    while (buf.events.length > 0) {
      const next = buf.events[0];
      const nextBytes = JSON.stringify(next).length;
      if (result.length > 0 && totalBytes + nextBytes > maxBytes) {
        hasMore = true;
        break;
      }
      result.push(buf.events.shift()!);
      totalBytes += nextBytes;
    }

    // Auto-cleanup if we drained a session_closed event
    const hasSessionClosed = result.some((e) => e.type === "session_closed");
    if (hasSessionClosed && buf.draining) {
      this.cleanup(sessionId);
    }

    return { events: result, hasMore };
  }

  markDraining(sessionId: string): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], draining: true };
      this.buffers.set(sessionId, buf);
    }
    buf.draining = true;
    // Grace period: cleanup after 60 seconds if not drained
    buf.cleanupTimer = setTimeout(() => {
      this.cleanup(sessionId);
    }, 60_000);
  }

  cleanup(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (buf?.cleanupTimer) {
      clearTimeout(buf.cleanupTimer);
    }
    this.buffers.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.buffers.has(sessionId);
  }
}
