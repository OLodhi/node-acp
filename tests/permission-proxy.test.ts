import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionProxy } from "../src/permission-proxy.js";

describe("PermissionProxy", () => {
  let proxy: PermissionProxy;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];
    proxy = new PermissionProxy(0.01, (event) => emittedEvents.push(event)); // 0.01 min = 600ms timeout for tests
  });

  it("creates a pending permission and emits request event", () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path/file.ts", "Write 10 lines");

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].type).toBe("permission_request");
    expect(emittedEvents[0].sessionId).toBe("sess-1");
    expect(emittedEvents[0].operation).toBe("writeFile");
    expect(typeof emittedEvents[0].permissionId).toBe("string");
  });

  it("resolves true when approved", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const permId = emittedEvents[0].permissionId;

    proxy.handleResponse("sess-1", permId, true);
    const result = await promise;
    expect(result).toBe(true);
  });

  it("resolves false when denied", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const permId = emittedEvents[0].permissionId;

    proxy.handleResponse("sess-1", permId, false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("resolves false on timeout", async () => {
    const promise = proxy.requestPermission("sess-1", "writeFile", "/path", "desc");
    const result = await promise; // 600ms timeout
    expect(result).toBe(false);
  }, 5000);

  it("cleans up pending permissions for a session", async () => {
    const p1 = proxy.requestPermission("sess-1", "writeFile", "/a", "d");
    const p2 = proxy.requestPermission("sess-1", "writeFile", "/b", "d");
    proxy.cleanupSession("sess-1");
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
  });
});
