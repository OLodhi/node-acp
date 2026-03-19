import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WEB_UI_HTML } from "./web-ui-html.js";

interface SessionSnapshot {
  id: string;
  status: string;
  agent?: string;
  cwd?: string;
}

export class WebUI {
  private server: Server | null = null;
  private sseClients = new Set<ServerResponse>();
  private lineBuffers = new Map<string, string[]>();
  private sessionList: SessionSnapshot[] = [];
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private port: number = 19100,
    private host: string = "127.0.0.1",
    private maxBufferLines: number = 1000,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        // Keep-alive pings to prevent SSE timeout
        this.keepAliveInterval = setInterval(() => {
          for (const client of this.sseClients) {
            try { client.write(": keepalive\n\n"); } catch {}
          }
        }, 15_000);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  pushLine(sessionId: string, line: string): void {
    // Buffer per session
    let buf = this.lineBuffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.lineBuffers.set(sessionId, buf);
    }
    buf.push(line);
    if (buf.length > this.maxBufferLines) {
      buf.shift();
    }

    // Push to all SSE clients (default event, no named event for browser compat)
    const data = JSON.stringify({ type: "line", sessionId, text: line });
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {}
    }
  }

  removeSession(sessionId: string): void {
    this.lineBuffers.delete(sessionId);
    // Remove from session list and push update to all SSE clients
    this.sessionList = this.sessionList.filter((s) => s.id !== sessionId);
    const data = JSON.stringify({ type: "sessions", sessions: this.sessionList });
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {}
    }
  }

  updateSessions(sessions: SessionSnapshot[]): void {
    this.sessionList = sessions;
    const data = JSON.stringify({ type: "sessions", sessions });
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {}
    }
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  private getTotalLineCount(): number {
    let count = 0;
    for (const lines of this.lineBuffers.values()) count += lines.length;
    return count;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(WEB_UI_HTML);
      return;
    }

    if (url === "/events") {
      this.handleSSE(req, res);
      return;
    }

    if (url === "/api/sessions") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(this.sessionList));
      return;
    }

    // Polling endpoint: returns new lines since last poll
    if (url.startsWith("/api/poll")) {
      const since = parseInt(new URL(url, `http://${this.host}`).searchParams.get("since") ?? "0", 10);
      const allLines: { sessionId: string; text: string; idx: number }[] = [];
      for (const [sessionId, lines] of this.lineBuffers) {
        for (let i = Math.max(0, since); i < lines.length; i++) {
          allLines.push({ sessionId, text: lines[i], idx: i });
        }
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify({ lines: allLines, total: this.getTotalLineCount(), sessions: this.sessionList }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.sseClients.add(res);

    // Replay buffered lines for all sessions
    for (const [sessionId, lines] of this.lineBuffers) {
      const data = JSON.stringify({ type: "replay", sessionId, lines });
      res.write(`data: ${data}\n\n`);
    }

    // Send current session list
    const sessData = JSON.stringify({ type: "sessions", sessions: this.sessionList });
    res.write(`data: ${sessData}\n\n`);

    req.on("close", () => {
      this.sseClients.delete(res);
    });
  }
}
