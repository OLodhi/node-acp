import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session } from "../src/session.js";
import { PermissionProxy } from "../src/permission-proxy.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

// Mock the SDK's query function
const mockMessages: any[] = [];
let mockQueryInstance: any = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    const generator = (async function* () {
      for (const msg of mockMessages) {
        yield msg;
      }
    })();
    mockQueryInstance = {
      ...generator,
      [Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
      next: () => generator.next(),
      return: (v: any) => generator.return(v),
      throw: (e: any) => generator.throw(e),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
      initializationResult: vi.fn(async () => ({})),
    };
    return mockQueryInstance;
  },
}));

describe("Session", () => {
  let session: Session;
  let emitted: DaemonEvent[];
  let emit: (event: DaemonEvent) => void;
  let permissionProxy: PermissionProxy;

  beforeEach(() => {
    emitted = [];
    emit = (event) => emitted.push(event);
    permissionProxy = new PermissionProxy(30, emit);
    mockMessages.length = 0;
    mockQueryInstance = null;

    session = new Session(
      "sess-1",
      "/tmp/project",
      "claude-opus-4-6",
      "approve-reads",
      permissionProxy,
      emit
    );
  });

  it("starts in idle status", () => {
    expect(session.status).toBe("idle");
    expect(session.pid).toBeUndefined();
    expect(session.resumeSessionId).toBeUndefined();
  });

  it("transitions to busy on prompt, back to idle when done", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "sdk-sess-123" },
      { type: "result", subtype: "success", session_id: "sdk-sess-123", result: "done" }
    );

    await session.prompt("Hello");
    expect(session.status).toBe("idle");
  });

  it("captures resume session ID from init message", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "sdk-sess-456" },
      { type: "result", subtype: "success", session_id: "sdk-sess-456", result: "done" }
    );

    await session.prompt("Hello");
    expect(session.resumeSessionId).toBe("sdk-sess-456");
  });

  it("emits output events from assistant messages", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi there" }] },
      },
      { type: "result", subtype: "success", session_id: "x", result: "done" }
    );

    await session.prompt("Hello");
    const outputs = emitted.filter((e) => e.type === "output");
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]).toMatchObject({
      messageType: "assistant_text",
      chunk: "Hi there",
    });
  });

  it("emits error events on SDK error result", async () => {
    mockMessages.push(
      { type: "system", subtype: "init", session_id: "x" },
      { type: "result", subtype: "error_during_execution", errors: ["bad stuff"], session_id: "x" }
    );

    await session.prompt("Hello");
    const errors = emitted.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ error: "bad stuff" });
  });

  it("cancel is no-op when idle", async () => {
    await session.cancel();
    expect(session.status).toBe("idle");
  });

  it("close cleans up", () => {
    session.close();
    expect(session.status).toBe("idle");
  });
});
