import type { NodeBridge } from "./node-bridge.js";

type NodeStatus = "unknown" | "not_installed" | "installed" | "running";

export class DaemonManager {
  private nodeStatus = new Map<string, NodeStatus>();

  constructor(
    private daemonBin: string[],
    private daemonStartArgs: string[],
    private autoDeployDaemon: boolean,
    private logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
  ) {}

  async ensureDaemonReady(nodeId: string, bridge: NodeBridge): Promise<void> {
    // Skip if we already know it's running (reset on errors)
    if (this.nodeStatus.get(nodeId) === "running") {
      const ping = await bridge.exec(nodeId, [...this.daemonBin, "status", "ping"], { timeoutMs: 10_000 });
      if (ping.success && ping.stdout.includes("alive")) return;
      this.nodeStatus.set(nodeId, "unknown");
    }

    // 1. Try pinging the daemon
    this.logger?.info(`[acpx-remote] checking daemon on node ${nodeId}...`);
    const pingResult = await bridge.exec(nodeId, [...this.daemonBin, "status", "ping"], { timeoutMs: 10_000 });
    this.logger?.info(`[acpx-remote] ping result: success=${pingResult.success} stdout=${JSON.stringify(pingResult.stdout?.slice(0,200))} stderr=${JSON.stringify(pingResult.stderr?.slice(0,200))}`);
    if (pingResult.success && pingResult.stdout.includes("alive")) {
      this.nodeStatus.set(nodeId, "running");
      this.logger?.info(`[acpx-remote] daemon already running on ${nodeId}`);
      return;
    }

    // 2. Check if installed
    const versionResult = await bridge.exec(nodeId, [...this.daemonBin, "--version"], { timeoutMs: 15_000 });
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

    // 4. Start in background (try standard --daemon first)
    this.logger?.info(`[acpx-remote] starting daemon on ${nodeId}...`);
    const startResult = await bridge.exec(nodeId, [...this.daemonBin, "start", "--daemon", ...this.daemonStartArgs], { timeoutMs: 15_000 });
    this.logger?.info(`[acpx-remote] start result: exit=${startResult.exitCode} stdout=${startResult.stdout?.slice(0,300)} stderr=${startResult.stderr?.slice(0,300)}`);

    // 5. Wait for it to be ready
    const ready = await this.waitForDaemon(nodeId, bridge, 10);
    if (ready) {
      this.logger?.info(`[acpx-remote] daemon ready on ${nodeId}`);
      return;
    }

    // 6. Standard start failed — collect diagnostics and try shell-level fallback
    this.logger?.warn(`[acpx-remote] daemon did not become ready via --daemon flag. Checking logs...`);
    await this.logDaemonDiagnostics(nodeId, bridge);

    // Try shell-level background start (survives system.run process tree cleanup)
    this.logger?.info(`[acpx-remote] trying shell-level background start...`);
    await this.shellStartDaemon(nodeId, bridge);

    // Wait again after shell start
    const readyAfterShell = await this.waitForDaemon(nodeId, bridge, 12);
    if (readyAfterShell) {
      this.logger?.info(`[acpx-remote] daemon ready on ${nodeId} (via shell start)`);
      return;
    }

    // Final diagnostics
    await this.logDaemonDiagnostics(nodeId, bridge);
    throw new Error(
      `Daemon failed to start on node after both --daemon and shell-level start. ` +
      `Check daemon logs on the node: ${this.daemonBin.join(" ")} logs`
    );
  }

  /**
   * Returns true if daemon becomes ready, false if it times out.
   */
  private async waitForDaemon(nodeId: string, bridge: NodeBridge, maxAttempts = 12): Promise<boolean> {
    let delayMs = 500;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const ping = await bridge.exec(nodeId, [...this.daemonBin, "status", "ping"], { timeoutMs: 10_000 });
      if (ping.success && ping.stdout.includes("alive")) {
        this.nodeStatus.set(nodeId, "running");
        return true;
      }
      delayMs = Math.min(delayMs * 1.5, 5000); // Cap at 5s between polls
    }
    return false;
  }

  /**
   * Shell-level daemon start that survives process tree cleanup.
   * Tries bash (Unix) first, then cmd (Windows).
   */
  private async shellStartDaemon(nodeId: string, bridge: NodeBridge): Promise<void> {
    const daemonCmd = this.daemonBin.join(" ");
    const extraArgs = this.daemonStartArgs.join(" ");
    const fullStartCmd = `${daemonCmd} start ${extraArgs}`.trim();

    // Try bash/sh (Unix)
    const bashResult = await bridge.exec(nodeId, [
      "bash", "-c",
      `nohup ${fullStartCmd} >> "$HOME/.acpx-node-daemon.log" 2>&1 & disown; sleep 1; echo started`,
    ], { timeoutMs: 20_000 }).catch(() => null);

    if (bashResult?.success) {
      this.logger?.info(`[acpx-remote] shell start (bash) succeeded: ${bashResult.stdout?.slice(0, 100)}`);
      return;
    }
    this.logger?.info(`[acpx-remote] bash start failed, trying cmd...`);

    // Try cmd (Windows) — start /b creates a detached background process
    const cmdResult = await bridge.exec(nodeId, [
      "cmd", "/c",
      `start /b "" ${fullStartCmd}`,
    ], { timeoutMs: 15_000 }).catch(() => null);

    if (cmdResult?.success) {
      this.logger?.info(`[acpx-remote] shell start (cmd) succeeded`);
      return;
    }

    this.logger?.warn(`[acpx-remote] both shell start methods failed`);
  }

  /**
   * Read recent daemon logs for diagnostics.
   */
  private async logDaemonDiagnostics(nodeId: string, bridge: NodeBridge): Promise<void> {
    try {
      const logResult = await bridge.exec(
        nodeId,
        [...this.daemonBin, "logs", "--tail", "20"],
        { timeoutMs: 5_000 },
      );
      if (logResult.stdout) {
        this.logger?.error(`[acpx-remote] daemon log (last 20 lines):\n${logResult.stdout}`);
      } else {
        this.logger?.warn(`[acpx-remote] no daemon logs available`);
      }
    } catch {
      this.logger?.warn(`[acpx-remote] could not read daemon logs`);
    }
  }

  markNodeDown(nodeId: string): void {
    this.nodeStatus.set(nodeId, "unknown");
  }
}
