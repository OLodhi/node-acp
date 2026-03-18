import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

describe("SessionManager", () => {
  let manager: SessionManager;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];
    const config = loadConfig({ maxConcurrentSessions: 2 });
    manager = new SessionManager(config, (event) => emittedEvents.push(event));
  });

  it("tracks session state", () => {
    manager.registerSession("sess-1", {
      agent: "claude",
      cwd: "/tmp/project",
      model: "claude-opus-4-6",
      permissionMode: "approve-reads",
      ttlMinutes: 120,
    });

    const session = manager.getSession("sess-1");
    expect(session).toBeDefined();
    expect(session!.status).toBe("starting");
    expect(session!.agent).toBe("claude");
  });

  it("rejects when max concurrent sessions reached", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp/a", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.registerSession("sess-2", {
      agent: "claude", cwd: "/tmp/b", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });

    expect(() => manager.registerSession("sess-3", {
      agent: "claude", cwd: "/tmp/c", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    })).toThrow(/max concurrent/i);
  });

  it("removes session on close", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.removeSession("sess-1");
    expect(manager.getSession("sess-1")).toBeUndefined();
  });

  it("updates session status", () => {
    manager.registerSession("sess-1", {
      agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.setStatus("sess-1", "idle");
    expect(manager.getSession("sess-1")!.status).toBe("idle");
  });

  it("returns undefined for unknown session", () => {
    expect(manager.getSession("nonexistent")).toBeUndefined();
  });

  it("lists active sessions", () => {
    manager.registerSession("s1", {
      agent: "claude", cwd: "/a", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    manager.registerSession("s2", {
      agent: "claude", cwd: "/b", model: "claude-opus-4-6",
      permissionMode: "approve-reads", ttlMinutes: 120,
    });
    expect(manager.listSessions()).toHaveLength(2);
  });

  it("calls onSessionExpired callback on TTL expiry", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const config = loadConfig({ maxConcurrentSessions: 2 });
    const events: any[] = [];
    const mgr = new SessionManager(config, (e) => events.push(e), onExpired);

    mgr.registerSession("s1", {
      agent: "claude", cwd: "/tmp", model: "claude-opus-4-6",
      permissionMode: "default", ttlMinutes: 1,
    });

    vi.advanceTimersByTime(60_001);

    expect(onExpired).toHaveBeenCalledWith("s1");
    expect(mgr.getSession("s1")).toBeUndefined();
    expect(events.some((e) => e.type === "session_closed" && e.reason === "ttl_expired")).toBe(true);

    vi.useRealTimers();
  });
});
