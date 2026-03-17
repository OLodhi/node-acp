import { describe, it, expect } from "vitest";
import { loadConfig, type DaemonConfig } from "../src/config.js";

describe("Config", () => {
  it("returns defaults when no overrides", () => {
    const config = loadConfig({});
    expect(config.maxConcurrentSessions).toBe(4);
    expect(config.defaultAgent).toBe("claude");
    expect(config.defaultModel).toBe("");
    expect(config.defaultPermissionMode).toBe("bypassPermissions");
    expect(config.claudeBin).toBe("claude");
    expect(typeof config.defaultCwd).toBe("string");
    expect(config.maxBufferedEvents).toBe(500);
    expect(config.defaultTtlMinutes).toBe(120);
    expect(config.permissionTimeoutMinutes).toBe(30);
  });

  it("overrides defaults with provided values", () => {
    const config = loadConfig({ maxConcurrentSessions: 8, defaultTtlMinutes: 60 });
    expect(config.maxConcurrentSessions).toBe(8);
    expect(config.defaultTtlMinutes).toBe(60);
    expect(config.defaultAgent).toBe("claude"); // unchanged
  });

  it("resolves platform-specific socket path", () => {
    const config = loadConfig({});
    if (process.platform === "win32") {
      expect(config.ipcSocketPath).toMatch(/\\\\.\\pipe\\/);
    } else {
      expect(config.ipcSocketPath).toMatch(/\.sock$/);
    }
  });
});
