import { describe, it, expect, afterEach } from "vitest";
import { createConnection } from "node:net";
import { IpcServer } from "../src/ipc-server.js";
import { serializeMessage, type DaemonRequest, type DaemonEvent } from "../src/ipc-protocol.js";

const TEST_PIPE = process.platform === "win32"
  ? "\\\\.\\pipe\\acpx-node-daemon-test-" + process.pid
  : "/tmp/acpx-node-daemon-test-" + process.pid + ".sock";

let server: IpcServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe("IpcServer", () => {
  it("starts and accepts connections", async () => {
    const requests: DaemonRequest[] = [];
    server = new IpcServer(TEST_PIPE, (req, send) => {
      requests.push(req);
    });
    await server.start();

    const client = createConnection(TEST_PIPE);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    const req: DaemonRequest = {
      type: "status",
      sessionId: "test-123",
    };
    client.write(serializeMessage(req));

    await new Promise((r) => setTimeout(r, 50));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(req);

    client.destroy();
  });

  it("sends events back to connected clients", async () => {
    let sendFn: ((event: DaemonEvent) => void) | null = null;
    server = new IpcServer(TEST_PIPE, (_req, send) => {
      sendFn = send;
    });
    await server.start();

    const client = createConnection(TEST_PIPE);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    // Trigger a request so we get the send function
    client.write(serializeMessage({ type: "status", sessionId: "x" }));
    await new Promise((r) => setTimeout(r, 50));

    const received: string[] = [];
    client.on("data", (data) => received.push(data.toString()));

    const event: DaemonEvent = {
      type: "status_result",
      sessionId: "x",
      status: "idle",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      pid: 123,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    sendFn!(event);

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThan(0);
    const parsed = JSON.parse(received[0].trim());
    expect(parsed.type).toBe("status_result");
    expect(parsed.sessionId).toBe("x");

    client.destroy();
  });

  it("stops cleanly", async () => {
    server = new IpcServer(TEST_PIPE, () => {});
    await server.start();
    await server.stop();
    server = null;

    // Verify cannot connect after stop
    const client = createConnection(TEST_PIPE);
    const error = await new Promise<Error>((resolve) => {
      client.on("error", resolve);
    });
    expect(error.message).toMatch(/ENOENT|ECONNREFUSED/);
  });
});
