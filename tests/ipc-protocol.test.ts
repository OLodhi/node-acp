import { describe, it, expect } from "vitest";
import {
  serializeMessage,
  deserializeMessage,
  type DaemonRequest,
  type DaemonEvent,
} from "../src/ipc-protocol.js";

describe("IPC Protocol", () => {
  it("serializes a spawn request", () => {
    const req: DaemonRequest = {
      type: "spawn",
      sessionId: "test-123",
      agent: "claude",
      cwd: "C:\\Users\\Omar\\Projects\\MyProject",
      model: "claude-opus-4-6",
      permissionMode: "approve-reads",
      timeoutMinutes: 120,
    };
    const serialized = serializeMessage(req);
    expect(serialized).toBe(JSON.stringify(req) + "\n");
  });

  it("deserializes a spawn_result event", () => {
    const event: DaemonEvent = {
      type: "spawn_result",
      sessionId: "test-123",
      success: true,
      pid: 12345,
    };
    const line = JSON.stringify(event);
    const result = deserializeMessage(line);
    expect(result).toEqual(event);
  });

  it("deserializes an output event", () => {
    const event: DaemonEvent = {
      type: "output",
      sessionId: "test-123",
      messageType: "assistant_text",
      chunk: "Reading src/auth.ts...",
      timestamp: 1773600000000,
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("deserializes a permission_request event", () => {
    const event: DaemonEvent = {
      type: "permission_request",
      sessionId: "test-123",
      permissionId: "perm-456",
      operation: "writeFile",
      path: "C:\\Users\\Omar\\Projects\\src\\auth.ts",
      description: "Write 45 lines to src/auth.ts",
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("serializes a drain request", () => {
    const req: DaemonRequest = {
      type: "drain",
      sessionId: "test-123",
    };
    const serialized = serializeMessage(req);
    expect(serialized).toBe(JSON.stringify(req) + "\n");
  });

  it("deserializes a drain_result event", () => {
    const event: DaemonEvent = {
      type: "drain_result",
      sessionId: "test-123",
      events: [
        { type: "output", sessionId: "test-123", messageType: "assistant_text", chunk: "hello", timestamp: 1234 },
      ],
      hasMore: false,
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("deserializes a cancel_accepted event", () => {
    const event: DaemonEvent = {
      type: "cancel_accepted",
      sessionId: "test-123",
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("deserializes a permission_response_result event", () => {
    const event: DaemonEvent = {
      type: "permission_response_result",
      sessionId: "test-123",
      success: true,
    };
    const result = deserializeMessage(JSON.stringify(event));
    expect(result).toEqual(event);
  });

  it("rejects invalid JSON", () => {
    expect(() => deserializeMessage("not json")).toThrow();
  });

  it("rejects messages missing type field", () => {
    expect(() => deserializeMessage('{"sessionId":"x"}')).toThrow();
  });
});
