import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import {
  deserializeMessage,
  serializeMessage,
  type DaemonRequest,
  type DaemonEvent,
} from "./ipc-protocol.js";

export type RequestHandler = (
  request: DaemonRequest,
  send: (event: DaemonEvent) => void
) => void;

export class IpcServer {
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();

  constructor(
    private socketPath: string,
    private onRequest: RequestHandler
  ) {}

  async start(): Promise<void> {
    // Clean up stale socket (Unix sockets only; Windows named pipes are not filesystem entries)
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        if (process.platform !== "win32") {
          try {
            unlinkSync(this.socketPath);
          } catch {}
        }
        this.server = null;
        resolve();
      });
    });
  }

  broadcast(event: DaemonEvent): void {
    const data = serializeMessage(event);
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data);
      }
    }
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";

    const send = (event: DaemonEvent) => {
      if (!socket.destroyed) {
        socket.write(serializeMessage(event));
      }
    };

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = deserializeMessage(line) as DaemonRequest;
          this.onRequest(request, send);
        } catch (err) {
          send({
            type: "error",
            sessionId: "unknown",
            error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
    });

    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }
}
