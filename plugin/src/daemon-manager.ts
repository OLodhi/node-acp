import type { NodeBridge } from "./node-bridge.js";

type NodeStatus = "unknown" | "not_installed" | "installed" | "running";

export class DaemonManager {
  private nodeStatus = new Map<string, NodeStatus>();

  constructor(
    private autoDeployDaemon: boolean,
    private logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
  ) {}

  async ensureDaemonReady(nodeId: string, bridge: NodeBridge): Promise<void> {
    // Skip if we already know it's running (reset on errors)
    if (this.nodeStatus.get(nodeId) === "running") {
      // Quick ping to verify
      const ping = await bridge.exec(nodeId, ["acpx-node-daemon", "status", "ping"], { timeoutMs: 10_000 });
      if (ping.success && ping.stdout.includes("alive")) return;
      this.nodeStatus.set(nodeId, "unknown");
    }

    // 1. Try pinging the daemon
    this.logger?.info(`[acpx-remote] checking daemon on node ${nodeId}...`);
    const pingResult = await bridge.exec(nodeId, ["acpx-node-daemon", "status", "ping"], { timeoutMs: 10_000 });
    if (pingResult.success && pingResult.stdout.includes("alive")) {
      this.nodeStatus.set(nodeId, "running");
      this.logger?.info(`[acpx-remote] daemon already running on ${nodeId}`);
      return;
    }

    // 2. Check if installed
    const versionResult = await bridge.exec(nodeId, ["acpx-node-daemon", "--version"], { timeoutMs: 15_000 });
    if (!versionResult.success) {
      if (!this.autoDeployDaemon) {
        throw new Error(
          `Daemon not installed on node. Install it with: npm install -g acpx-node-daemon`
        );
      }

      // 3. Install
      this.logger?.info(`[acpx-remote] installing daemon on ${nodeId}...`);
      const installResult = await bridge.exec(
        nodeId,
        ["npm", "install", "-g", "acpx-node-daemon"],
        { timeoutMs: 120_000 },
      );
      if (!installResult.success) {
        throw new Error(`Failed to install daemon on node: ${installResult.stderr}`);
      }
      this.nodeStatus.set(nodeId, "installed");
      this.logger?.info(`[acpx-remote] daemon installed on ${nodeId}`);
    } else {
      this.nodeStatus.set(nodeId, "installed");
    }

    // 4. Start in background
    this.logger?.info(`[acpx-remote] starting daemon on ${nodeId}...`);
    await bridge.exec(nodeId, ["acpx-node-daemon", "start", "--daemon"], { timeoutMs: 15_000 });

    // 5. Wait for it to be ready
    await this.waitForDaemon(nodeId, bridge);
    this.logger?.info(`[acpx-remote] daemon ready on ${nodeId}`);
  }

  private async waitForDaemon(nodeId: string, bridge: NodeBridge, maxAttempts = 10): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const ping = await bridge.exec(nodeId, ["acpx-node-daemon", "status", "ping"], { timeoutMs: 10_000 });
      if (ping.success && ping.stdout.includes("alive")) {
        this.nodeStatus.set(nodeId, "running");
        return;
      }
    }
    throw new Error(`Daemon failed to start on node within ${maxAttempts} seconds`);
  }

  markNodeDown(nodeId: string): void {
    this.nodeStatus.set(nodeId, "unknown");
  }
}
