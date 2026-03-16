import { describe, it, expect, beforeEach } from "vitest";
import { forwardOutput } from "../src/output-forwarder.js";
import type { DaemonEvent } from "../src/ipc-protocol.js";

describe("OutputForwarder", () => {
  let emitted: DaemonEvent[];
  let emit: (event: DaemonEvent) => void;

  beforeEach(() => {
    emitted = [];
    emit = (event) => emitted.push(event);
  });

  it("forwards assistant messages with text content", () => {
    forwardOutput(
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      sessionId: "sess-1",
      messageType: "assistant_text",
      chunk: "Hello world",
    });
  });

  it("forwards assistant messages with tool_use blocks", () => {
    forwardOutput(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", id: "x", input: { file_path: "/tmp/f" } },
          ],
        },
      },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      messageType: "tool_use",
      chunk: "Read",
    });
  });

  it("handles assistant message with multiple text blocks", () => {
    forwardOutput(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first " },
            { type: "text", text: "second" },
          ],
        },
      },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "output",
      chunk: "first second",
    });
  });

  it("forwards result success as prompt_complete", () => {
    forwardOutput(
      { type: "result", subtype: "success", result: "done", session_id: "x" },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "prompt_complete",
      sessionId: "sess-1",
      stopReason: "end_turn",
    });
  });

  it("forwards result error as error + prompt_complete", () => {
    forwardOutput(
      { type: "result", subtype: "error_during_execution", errors: ["something broke"], session_id: "x" },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "error",
      sessionId: "sess-1",
      error: "something broke",
    });
    expect(emitted[1]).toMatchObject({
      type: "prompt_complete",
      sessionId: "sess-1",
      stopReason: "error",
    });
  });

  it("ignores system messages", () => {
    forwardOutput(
      { type: "system", subtype: "init", session_id: "x" },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(0);
  });

  it("ignores stream_event messages", () => {
    forwardOutput(
      { type: "stream_event", event: { type: "content_block_delta" } },
      "sess-1",
      emit
    );
    expect(emitted).toHaveLength(0);
  });

  it("ignores unknown message types", () => {
    forwardOutput({ type: "hook_started" }, "sess-1", emit);
    expect(emitted).toHaveLength(0);
  });
});
