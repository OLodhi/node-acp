// src/daemon.ts
import type { DaemonConfig } from "./config.js";
import { IpcServer } from "./ipc-server.js";
import { SessionManager } from "./session-manager.js";
import { PermissionProxy } from "./permission-proxy.js";
import { Session } from "./session.js";
import { EventBuffer } from "./event-buffer.js";
import type { DaemonRequest, DaemonEvent } from "./ipc-protocol.js";
import { WebUI } from "./web-ui.js";

const BUFFERED_TYPES = new Set(["output", "permission_request", "prompt_complete", "error", "session_closed"]);

export class Daemon {
  private ipcServer: IpcServer;
  private sessionManager: SessionManager;
  private permissionProxy: PermissionProxy;
  private sessions = new Map<string, Session>();
  private eventBuffer: EventBuffer;
  private webUI: WebUI | null = null;

  constructor(private config: DaemonConfig) {
    this.eventBuffer = new EventBuffer(config.maxBufferedEvents);

    const emit = (event: DaemonEvent) => {
      this.broadcastAndBuffer(event);
      // When SessionManager emits session_closed (e.g. TTL expiry), mark buffer as draining
      if (event.type === "session_closed" && "sessionId" in event) {
        this.eventBuffer.markDraining((event as any).sessionId);
      }
    };

    this.sessionManager = new SessionManager(config, emit, (sessionId) => {
      const agentSession = this.sessions.get(sessionId);
      if (agentSession) {
        agentSession.close();
        this.sessions.delete(sessionId);
      }
      this.permissionProxy.cleanupSession(sessionId);
      if (this.webUI) {
        this.webUI.removeSession(sessionId);
      }
    });
    this.permissionProxy = new PermissionProxy(config.permissionTimeoutMinutes, emit);

    this.ipcServer = new IpcServer(config.ipcSocketPath, (req, send) => {
      this.handleRequest(req, send);
    });

    if (config.uiEnabled) {
      this.webUI = new WebUI(config.uiPort);
    }
  }

  private broadcastAndBuffer(event: DaemonEvent): void {
    if (BUFFERED_TYPES.has(event.type) && "sessionId" in event) {
      this.eventBuffer.push((event as any).sessionId, event as any);
    }
    this.ipcServer.broadcast(event);
    // Update web UI session list on state-changing events
    if (this.webUI && ["prompt_complete", "error", "session_closed", "output"].includes(event.type)) {
      this.updateWebUISessions();
    }
  }

  private updateWebUISessions(): void {
    if (!this.webUI) return;
    const snapshots = this.sessionManager.listSessions().map((s) => ({
      id: s.sessionId,
      status: s.status,
      agent: s.agent,
      cwd: s.cwd,
    }));
    this.webUI.updateSessions(snapshots);
  }

  async start(): Promise<void> {
    await this.ipcServer.start();
    console.log(`[acpx-node-daemon] listening on ${this.config.ipcSocketPath}`);
    if (this.webUI) {
      await this.webUI.start();
      console.log(`[acpx-node-daemon] web UI at ${this.webUI.url}`);
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessionManager.listSessions()) {
      // Intentionally NOT buffered — daemon is shutting down
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
    if (this.webUI) await this.webUI.stop();
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
        this.handlePermissionResponse(req, send);
        break;
      case "drain":
        this.handleDrain(req, send);
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

      const emit = (event: DaemonEvent) => this.broadcastAndBuffer(event);

      // Dual writer: terminal + web UI
      const sessionId = req.sessionId;
      const hasWebUI = !!this.webUI;
      console.log(`[daemon] creating session ${sessionId} with webUI=${hasWebUI}`);
      const webUI = this.webUI;
      const writer = (line: string) => {
        console.log(line);
        if (webUI) {
          webUI.pushLine(sessionId, line);
        }
      };

      const agentSession = new Session(
        req.sessionId,
        req.cwd,
        req.model,
        req.permissionMode,
        this.config.claudeBin,
        this.permissionProxy,
        emit,
        writer
      );
      this.sessions.set(req.sessionId, agentSession);

      this.sessionManager.setStatus(req.sessionId, "idle");
      this.updateWebUISessions();

      send({
        type: "spawn_result",
        sessionId: req.sessionId,
        success: true,
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
    this.updateWebUISessions();
    send({ type: "prompt_accepted", sessionId: req.sessionId });

    // Run prompt in background — output streams via broadcastAndBuffer
    agentSession.prompt(req.prompt).then(() => {
      this.sessionManager.setStatus(req.sessionId, "idle");
      this.updateWebUISessions();
    }).catch((err) => {
      this.broadcastAndBuffer({
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
    send({ type: "cancel_accepted", sessionId: req.sessionId });
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
    this.broadcastAndBuffer({
      type: "session_closed",
      sessionId: req.sessionId,
      reason: "user_closed",
    });
    this.eventBuffer.markDraining(req.sessionId);
    if (this.webUI) {
      this.webUI.removeSession(req.sessionId);
    }
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

  private handlePermissionResponse(req: DaemonRequest & { type: "permission_response" }, send: (event: DaemonEvent) => void): void {
    this.permissionProxy.handleResponse(req.sessionId, req.permissionId, req.approved);
    send({ type: "permission_response_result", sessionId: req.sessionId, success: true });
  }

  private handleDrain(req: DaemonRequest & { type: "drain" }, send: (event: DaemonEvent) => void): void {
    if (!this.sessionManager.getSession(req.sessionId) && !this.eventBuffer.hasSession(req.sessionId)) {
      send({ type: "error", sessionId: req.sessionId, error: "Session not found" });
      return;
    }
    const result = this.eventBuffer.drain(req.sessionId);
    send({
      type: "drain_result",
      sessionId: req.sessionId,
      events: result.events,
      hasMore: result.hasMore,
    });
  }
}
