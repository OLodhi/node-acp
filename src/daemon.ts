// src/daemon.ts
import type { DaemonConfig } from "./config.js";
import { IpcServer, type RequestHandler } from "./ipc-server.js";
import { SessionManager } from "./session-manager.js";
import { PermissionProxy } from "./permission-proxy.js";
import type { DaemonRequest, DaemonEvent } from "./ipc-protocol.js";

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;

  constructor(private config: DaemonConfig) {
    const emit = (event: DaemonEvent) => this.ipcServer.broadcast(event);

    this.sessionManager = new SessionManager(config, emit);
    this.permissionProxy = new PermissionProxy(config.permissionTimeoutMinutes, emit);

    this.ipcServer = new IpcServer(config.ipcSocketPath, (req, send) => {
      this.handleRequest(req, send);
    });
  }

  async start(): Promise<void> {
    await this.ipcServer.start();
    console.log(`[acpx-node-daemon] listening on ${this.config.ipcSocketPath}`);
  }

  async stop(): Promise<void> {
    // Close all sessions and notify connected clients
    for (const session of this.sessionManager.listSessions()) {
      this.ipcServer.broadcast({
        type: "session_closed",
        sessionId: session.sessionId,
        reason: "daemon_stopped",
      });
      this.permissionProxy.cleanupSession(session.sessionId);
      this.sessionManager.removeSession(session.sessionId);
    }
    await this.ipcServer.stop();
    console.log("[acpx-node-daemon] stopped");
  }

  private handleRequest(req: DaemonRequest, send: (event: DaemonEvent) => void): void {
    switch (req.type) {
      case "spawn":
        this.handleSpawn(req, send);
        break;
      case "prompt":
        this.handlePrompt(req, send);
        break;
      case "cancel":
        this.handleCancel(req, send);
        break;
      case "close":
        this.handleClose(req, send);
        break;
      case "status":
        this.handleStatus(req, send);
        break;
      case "permission_response":
        this.handlePermissionResponse(req);
        break;
    }
  }

  private handleSpawn(req: DaemonRequest & { type: "spawn" }, send: (event: DaemonEvent) => void): void {
    try {
      const session = this.sessionManager.registerSession(req.sessionId, {
        agent: req.agent,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        ttlMinutes: req.timeoutMinutes,
      });

      // TODO: Task 9 — actually spawn Claude Code via ACPX queue owner here
      // For now, mark as idle (ready to accept prompts)
      this.sessionManager.setStatus(req.sessionId, "idle");

      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: true,
        pid: 0, // placeholder until ACPX integration
      });
    } catch (err) {
      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handlePrompt(req: DaemonRequest & { type: "prompt" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    if (session.status !== "idle") {
      send({ type: "error", sessionId: req.sessionId, error: `Session is ${session.status}, not idle` });
      return;
    }

    this.sessionManager.setStatus(req.sessionId, "busy");
    send({ type: "prompt_accepted", sessionId: req.sessionId });

    // TODO: Task 9 — forward prompt to ACPX queue owner
    // For now, send a mock response
    this.ipcServer.broadcast({
      type: "output",
      sessionId: req.sessionId,
      messageType: "assistant_text",
      chunk: `[mock] Received prompt: ${req.prompt}`,
      timestamp: Date.now(),
    });
    this.ipcServer.broadcast({
      type: "prompt_complete",
      sessionId: req.sessionId,
      stopReason: "end_turn",
    });
    this.sessionManager.setStatus(req.sessionId, "idle");
  }

  private handleCancel(req: DaemonRequest & { type: "cancel" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    // TODO: Task 9 — cancel via ACPX
    this.sessionManager.setStatus(req.sessionId, "idle");
  }

  private handleClose(req: DaemonRequest & { type: "close" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    this.permissionProxy.cleanupSession(req.sessionId);
    this.sessionManager.removeSession(req.sessionId);
    // TODO: Task 9 — kill ACPX queue owner process
    this.ipcServer.broadcast({
      type: "session_closed",
      sessionId: req.sessionId,
      reason: "user_closed",
    });
  }

  private handleStatus(req: DaemonRequest & { type: "status" }, send: (event: DaemonEvent) => void): void {
    const session = this.sessionManager.getSession(req.sessionId);
    if (!session) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    send({
      type: "status_result",
      sessionId: session.sessionId,
      status: session.status,
      agent: session.agent,
      cwd: session.cwd,
      model: session.model,
      pid: session.pid ?? 0,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    });
  }

  private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }): void {
    this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
  }
}
