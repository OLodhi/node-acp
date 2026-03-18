import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildPidRegistry } from "../src/child-pid-registry.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ChildPidRegistry", () => {
  const filePath = join(tmpdir(), `test-child-pids-${Date.now()}.json`);
  let registry: ChildPidRegistry;

  beforeEach(() => {
    registry = new ChildPidRegistry(filePath);
  });

  afterEach(() => {
    try { unlinkSync(filePath); } catch {}
  });

  it("registers and unregisters PIDs", () => {
    registry.register(1234);
    registry.register(5678);
    expect(registry.list()).toEqual([1234, 5678]);

    registry.unregister(1234);
    expect(registry.list()).toEqual([5678]);
  });

  it("persists to disk and loads on new instance", () => {
    registry.register(1234);
    registry.register(5678);

    const loaded = new ChildPidRegistry(filePath);
    expect(loaded.list()).toEqual([1234, 5678]);
  });

  it("clear removes all PIDs and deletes file", () => {
    registry.register(1234);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });
});
