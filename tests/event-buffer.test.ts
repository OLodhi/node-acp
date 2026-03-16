import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBuffer } from "../src/event-buffer.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

describe("EventBuffer", () => {
  let buffer: EventBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new EventBuffer(500);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeOutput = (sessionId: string, chunk: string): DaemonEvent & { type: "output" } => ({
    type: "output",
    sessionId,
    messageType: "assistant_text",
    chunk,
    timestamp: Date.now(),
  });

  it("push and drain returns events in order", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.push("s1", makeOutput("s1", "world"));
    const result = buffer.drain("s1");
    expect(result.events).toHaveLength(2);
    expect((result.events[0] as any).chunk).toBe("hello");
    expect((result.events[1] as any).chunk).toBe("world");
    expect(result.hasMore).toBe(false);
  });

  it("drain clears the buffer", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.drain("s1");
    const result = buffer.drain("s1");
    expect(result.events).toHaveLength(0);
  });

  it("drain returns empty for unknown session", () => {
    const result = buffer.drain("nonexistent");
    expect(result.events).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("hasSession returns true after push", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    expect(buffer.hasSession("s1")).toBe(true);
  });

  it("hasSession returns false for unknown session", () => {
    expect(buffer.hasSession("nonexistent")).toBe(false);
  });

  it("isolates events between sessions", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.push("s2", makeOutput("s2", "world"));
    const r1 = buffer.drain("s1");
    const r2 = buffer.drain("s2");
    expect(r1.events).toHaveLength(1);
    expect(r2.events).toHaveLength(1);
    expect((r1.events[0] as any).chunk).toBe("hello");
    expect((r2.events[0] as any).chunk).toBe("world");
  });

  it("drops oldest events when buffer is full", () => {
    const small = new EventBuffer(3);
    small.push("s1", makeOutput("s1", "a"));
    small.push("s1", makeOutput("s1", "b"));
    small.push("s1", makeOutput("s1", "c"));
    small.push("s1", makeOutput("s1", "d"));
    const result = small.drain("s1");
    expect(result.events).toHaveLength(3);
    expect((result.events[0] as any).chunk).toBe("b");
    expect((result.events[2] as any).chunk).toBe("d");
  });

  it("returns hasMore true when events exceed maxBytes", () => {
    const bigChunk = "x".repeat(100_000);
    buffer.push("s1", makeOutput("s1", bigChunk));
    buffer.push("s1", makeOutput("s1", bigChunk));
    const result = buffer.drain("s1", 150_000);
    expect(result.events).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    // Second drain gets the rest
    const result2 = buffer.drain("s1", 150_000);
    expect(result2.events).toHaveLength(1);
    expect(result2.hasMore).toBe(false);
  });

  it("always returns at least one event even if it exceeds maxBytes", () => {
    const bigChunk = "x".repeat(200_000);
    buffer.push("s1", makeOutput("s1", bigChunk));
    const result = buffer.drain("s1", 150_000);
    expect(result.events).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it("markDraining keeps buffer alive after cleanup timer", () => {
    buffer.push("s1", { type: "session_closed", sessionId: "s1", reason: "ttl" } as any);
    buffer.markDraining("s1");
    expect(buffer.hasSession("s1")).toBe(true);
    // Before timer fires, drain should work
    const result = buffer.drain("s1");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("session_closed");
    // After draining session_closed, buffer is cleaned up
    expect(buffer.hasSession("s1")).toBe(false);
  });

  it("markDraining auto-cleans after 60 seconds if not drained", () => {
    buffer.push("s1", { type: "session_closed", sessionId: "s1", reason: "ttl" } as any);
    buffer.markDraining("s1");
    expect(buffer.hasSession("s1")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(buffer.hasSession("s1")).toBe(false);
  });

  it("cleanup clears timer and removes buffer", () => {
    buffer.push("s1", makeOutput("s1", "hello"));
    buffer.markDraining("s1");
    buffer.cleanup("s1");
    expect(buffer.hasSession("s1")).toBe(false);
  });
});
