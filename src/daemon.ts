// src/daemon.ts
import type { DaemonConfig } from "./config.js";
import { IpcServer } from "./ipc-server.js";
import { SessionManager } from "./session-manager.js";
import { PermissionProxy } from "./permission-proxy.js";
import { Session } from "./session.js";
import type { DaemonRequest, DaemonEvent } from "./ipc-protocol.js";

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;
  private sessions = new Map<string, Session>();

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
    for (const session of this.sessionManager.listSessions()) {
      this.ipcServer.broadcast({
        type: "session_closed",
        sessionId: session.sessionId,
        reason: "daemon_stopped",
      });
      const agentSession = this.sessions.get(session.sessionId);
      if (agentSession) agentSession.close();
      this.permissionProxy.cleanupSession(session.sessionId);
      this.sessionManager.removeSession(session.sessionId);
    }
    this.sessions.clear();
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
      this.sessionManager.registerSession(req.sessionId, {
        agent: req.agent,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        ttlMinutes: req.timeoutMinutes,
      });

      const emit = (event: DaemonEvent) => this.ipcServer.broadcast(event);

      const agentSession = new Session(
        req.sessionId,
        req.cwd,
        req.model,
        req.permissionMode,
        this.permissionProxy,
        emit
      );
      this.sessions.set(req.sessionId, agentSession);

      this.sessionManager.setStatus(req.sessionId, "idle");

      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: true,
        // pid is undefined until first prompt starts Claude Code
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
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    if (managed.status !== "idle") {
      send({ type: "error", sessionId: req.sessionId, error: `Session is ${managed.status}, not idle` });
      return;
    }

    const agentSession = this.sessions.get(req.sessionId);
    if (!agentSession) {
      send({ type: "error", sessionId: req.sessionId, error: "Agent session not found" });
      return;
    }

    this.sessionManager.setStatus(req.sessionId, "busy");
    send({ type: "prompt_accepted", sessionId: req.sessionId });

    // Run prompt in background — output streams via broadcast
    agentSession.prompt(req.prompt).then(() => {
      this.sessionManager.setStatus(req.sessionId, "idle");
    }).catch((err) => {
      this.ipcServer.broadcast({
        type: "error",
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sessionManager.setStatus(req.sessionId, "idle");
    });
  }

  private handleCancel(req: DaemonRequest & { type: "cancel" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    if (agentSession) {
      agentSession.cancel();
    }
  }

  private handleClose(req: DaemonRequest & { type: "close" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    if (agentSession) {
      agentSession.close();
      this.sessions.delete(req.sessionId);
    }
    this.permissionProxy.cleanupSession(req.sessionId);
    this.sessionManager.removeSession(req.sessionId);
    this.ipcServer.broadcast({
      type: "session_closed",
      sessionId: req.sessionId,
      reason: "user_closed",
    });
  }

  private handleStatus(req: DaemonRequest & { type: "status" }, send: (event: DaemonEvent) => void): void {
    const managed = this.sessionManager.getSession(req.sessionId);
    if (!managed) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const agentSession = this.sessions.get(req.sessionId);
    send({
      type: "status_result",
      sessionId: managed.sessionId,
      status: managed.status,
      agent: managed.agent,
      cwd: managed.cwd,
      model: managed.model,
      pid: agentSession?.pid ?? 0,
      createdAt: managed.createdAt,
      lastActivityAt: managed.lastActivityAt,
    });
  }

  private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }): void {
    this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
  }
}
