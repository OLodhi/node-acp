import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { createConnection } from "node:net";
import { serializeMessage, deserializeMessage, type DaemonEvent } from "../src/ipc-protocol.js";

// Helper: send a request and collect responses
function sendRequest(socketPath: string, request: any): Promise<DaemonEvent[]> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    const events: DaemonEvent[] = [];
    let buffer = "";

    client.on("connect", () => {
      client.write(serializeMessage(request));
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        events.push(deserializeMessage(line) as DaemonEvent);
      }
    });

    client.on("error", reject);

    // Give it a moment then disconnect
    setTimeout(() => {
      client.destroy();
      resolve(events);
    }, 200);
  });
}

describe("Daemon drain/cancel/permission-response", () => {
  let daemon: Daemon;
  const socketPath = process.platform === "win32"
    ? "\\\\.\\pipe\\acpx-node-daemon-test-" + Date.now()
    : "/tmp/acpx-node-daemon-test-" + Date.now() + ".sock";

  beforeEach(async () => {
    const config = loadConfig({ ipcSocketPath: socketPath });
    daemon = new Daemon(config);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("drain returns error for unknown session", async () => {
    const events = await sendRequest(socketPath, {
      type: "drain",
      sessionId: "nonexistent",
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
  });

  it("drain returns empty events for session with no output", async () => {
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    const events = await sendRequest(socketPath, {
      type: "drain",
      sessionId: "s1",
    });
    const drainResult = events.find((e) => e.type === "drain_result") as any;
    expect(drainResult).toBeDefined();
    expect(drainResult.events).toHaveLength(0);
    expect(drainResult.hasMore).toBe(false);
  });

  it("cancel returns cancel_accepted", async () => {
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    const events = await sendRequest(socketPath, {
      type: "cancel",
      sessionId: "s1",
    });
    const accepted = events.find((e) => e.type === "cancel_accepted");
    expect(accepted).toBeDefined();
  });

  it("permission_response returns permission_response_result", async () => {
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    const events = await sendRequest(socketPath, {
      type: "permission_response",
      sessionId: "s1",
      permissionId: "perm-1",
      approved: true,
    });
    const result = events.find((e) => e.type === "permission_response_result");
    expect(result).toBeDefined();
  });

  it("close buffers session_closed and drain returns it", async () => {
    await sendRequest(socketPath, {
      type: "spawn",
      sessionId: "s1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      timeoutMinutes: 120,
    });

    // Close the session
    await sendRequest(socketPath, {
      type: "close",
      sessionId: "s1",
    });

    // Drain should get the session_closed event (tombstone pattern)
    const events = await sendRequest(socketPath, {
      type: "drain",
      sessionId: "s1",
    });
    const drainResult = events.find((e) => e.type === "drain_result") as any;
    expect(drainResult).toBeDefined();
    const sessionClosed = drainResult.events.find((e: any) => e.type === "session_closed");
    expect(sessionClosed).toBeDefined();
    expect(sessionClosed.reason).toBe("user_closed");
  });
});
