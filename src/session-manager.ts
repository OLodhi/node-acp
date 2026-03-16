import type { DaemonConfig } from "./config.js";
import type { DaemonEvent } from "./ipc-protocol.js";

export interface SessionInfo {
  agent: string;
  cwd: string;
  model: string;
  permissionMode: string;
  ttlMinutes: number;
}

export interface ManagedSession extends SessionInfo {
  sessionId: string;
  pid: number | null;
  status: "starting" | "idle" | "busy" | "closing";
  createdAt: number;
  lastActivityAt: number;
  ttlTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  constructor(
    private config: DaemonConfig,
    private emit: (event: DaemonEvent) => void
  ) {}

  registerSession(sessionId: string, info: SessionInfo): ManagedSession {
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Max concurrent sessions (${this.config.maxConcurrentSessions}) reached`
      );
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const now = Date.now();
    const session: ManagedSession = {
      ...info,
      sessionId,
      pid: null,
      status: "starting",
      createdAt: now,
      lastActivityAt: now,
      ttlTimer: null,
    };

    this.sessions.set(sessionId, session);
    this.resetTtl(sessionId);
    return session;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  setStatus(sessionId: string, status: ManagedSession["status"]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    session.lastActivityAt = Date.now();
    this.resetTtl(sessionId);
  }

  setPid(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.pid = pid;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.ttlTimer) clearTimeout(session.ttlTimer);
    this.sessions.delete(sessionId);
  }

  private resetTtl(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ttlTimer) clearTimeout(session.ttlTimer);

    session.ttlTimer = setTimeout(() => {
      this.emit({
        type: "session_closed",
        sessionId,
        reason: "ttl_expired",
      });
      this.sessions.delete(sessionId);
    }, session.ttlMinutes * 60 * 1000);
  }
}
