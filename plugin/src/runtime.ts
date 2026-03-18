import { randomUUID } from "node:crypto";
import type { AcpxRemoteConfig } from "./config.js";
import type { NodeBridge } from "./node-bridge.js";
import { DaemonManager } from "./daemon-manager.js";
import { encodeHandle, decodeHandle, type AcpRuntimeHandle } from "./handle.js";
import { pollLoop, type PollEvent } from "./poll-loop.js";

export class AcpxRemoteRuntime {
  private daemonManager: DaemonManager;
  private healthy = false;

  constructor(
    private config: AcpxRemoteConfig,
    private bridge: NodeBridge,
    private logger?: any,
  ) {
    this.daemonManager = new DaemonManager(config.daemonBin, config.daemonStartArgs, config.autoDeployDaemon, logger);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    if (!this.config.defaultNode) {
      this.logger?.warn("[acpx-remote] no defaultNode configured");
      return;
    }
    try {
      await this.bridge.resolveNode(this.config.defaultNode);
      this.healthy = true;
      this.logger?.info(`[acpx-remote] node "${this.config.defaultNode}" reachable`);
    } catch (err: any) {
      this.logger?.warn(`[acpx-remote] node "${this.config.defaultNode}" not reachable: ${err.message}`);
    }
  }

  // --- AcpRuntime interface ---

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: string;
    cwd?: string;
    node?: string;
  }): Promise<AcpRuntimeHandle> {
    const nodeName = input.node || this.config.defaultNode;
    if (!nodeName) {
      throw new Error("No node specified and no defaultNode configured.");
    }

    const nodeId = await this.bridge.resolveNode(nodeName);
    await this.daemonManager.ensureDaemonReady(nodeId, this.bridge);

    const sessionId = randomUUID();
    const cwd = input.cwd || "~";

    const result = await this.bridge.exec(nodeId, [
      ...this.config.daemonBin, "spawn",
      "--session-id", sessionId,
      "--cwd", cwd,
    ]);

    if (!result.success) {
      throw new Error(`Failed to spawn session: ${result.stderr}`);
    }

    const spawnResult = parseFirstJsonLine(result.stdout);
    if (spawnResult?.success === false) {
      throw new Error(spawnResult.error || "Spawn failed");
    }

    this.healthy = true;
    return encodeHandle(input.sessionKey, { sessionId, nodeId, nodeName, cwd });
  }

  async *runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    mode?: string;
    requestId: string;
    signal?: AbortSignal;
  }): AsyncIterable<PollEvent> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    const encodedText = Buffer.from(input.text).toString("base64");

    // Send prompt asynchronously
    const promptResult = await this.bridge.exec(nodeId, [
      ...this.config.daemonBin, "prompt", sessionId,
      "--async", "--text-b64", encodedText,
    ]);

    if (!promptResult.success) {
      yield { type: "error", message: promptResult.stderr || promptResult.stdout || "Prompt command failed" };
      return;
    }

    const promptResponse = parseFirstJsonLine(promptResult.stdout);
    if (promptResponse?.type === "error") {
      yield { type: "error", message: promptResponse.error || "Prompt failed" };
      return;
    }
    if (!promptResponse || promptResponse.type !== "prompt_accepted") {
      yield { type: "error", message: "Unexpected prompt response: " + promptResult.stdout.slice(0, 200) };
      return;
    }

    // Poll for results
    yield* pollLoop(nodeId, sessionId, this.bridge, {
      daemonBin: this.config.daemonBin,
      pollIntervalMs: this.config.pollIntervalMs,
      signal: input.signal,
      autoApprove: true,
      onDaemonDown: () => this.daemonManager.markNodeDown(nodeId),
    });
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    await this.bridge.exec(nodeId, [...this.config.daemonBin, "cancel", sessionId]);
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    await this.bridge.exec(nodeId, [...this.config.daemonBin, "close", sessionId]);
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<any> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    const result = await this.bridge.exec(nodeId, [...this.config.daemonBin, "status", sessionId]);
    if (!result.success) return { summary: "Unknown" };
    const status = parseFirstJsonLine(result.stdout);
    return {
      summary: status?.status ?? "unknown",
      backendSessionId: sessionId,
      details: status,
    };
  }

  async doctor(): Promise<{ ok: boolean; message: string; details?: string[] }> {
    if (!this.config.defaultNode) {
      return { ok: false, message: "No defaultNode configured" };
    }

    const details: string[] = [];
    try {
      const nodeId = await this.bridge.resolveNode(this.config.defaultNode);
      details.push(`Node "${this.config.defaultNode}" resolved (${nodeId.slice(0, 12)}...)`);

      const versionResult = await this.bridge.exec(nodeId, [...this.config.daemonBin, "--version"], { timeoutMs: 15_000 });
      if (versionResult.success) {
        details.push(`Daemon version: ${versionResult.stdout.trim()}`);
      } else {
        details.push("Install with: npm install -g acpx-node-daemon");
        return { ok: false, message: "Daemon not installed on node", details };
      }

      const pingResult = await this.bridge.exec(nodeId, [...this.config.daemonBin, "status", "ping"], { timeoutMs: 10_000 });
      if (pingResult.success && pingResult.stdout.includes("alive")) {
        details.push("Daemon is running");
        return { ok: true, message: "Remote ACP daemon is healthy", details };
      } else {
        return { ok: false, message: "Daemon is installed but not running", details };
      }
    } catch (err: any) {
      return { ok: false, message: err.message, details };
    }
  }

  // --- Tool registration ---

  // Tracks active sessions per node so we can reuse them
  private activeSessions = new Map<string, { sessionId: string; nodeId: string; nodeName: string; cwd: string }>();

  registerTools(api: any): void {
    this.logger?.info("[acpx-remote] registering tools");

    // Single tool: spawn (if needed) + prompt + return result — all in one call
    api.registerTool({
      name: "remote_claude_code",
      label: "Run Claude Code on a remote machine",
      description: "Run a Claude Code prompt on a remote machine via OpenClaw. Automatically manages the session — spawns one if needed, sends the prompt, waits for completion, and returns the full verbatim output. Relay the output to the user EXACTLY as returned, do not summarize.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt to send to Claude Code" },
          node: { type: "string", description: "Node name (e.g. Thinkpad-Node). Uses default if omitted." },
          cwd: { type: "string", description: "Working directory on the node. Reuses previous if omitted." },
        },
        required: ["prompt"],
      },
      execute: async (_id: string, params: { prompt: string; node?: string; cwd?: string }) => {
        try {
          const nodeName = params.node || this.config.defaultNode;
          if (!nodeName) {
            return { content: [{ type: "text", text: "Error: No node specified and no defaultNode configured." }] };
          }

          // Reuse existing session or spawn a new one
          let session = this.activeSessions.get(nodeName);
          if (params.cwd && session && session.cwd !== params.cwd) {
            // CWD changed — close old session and spawn new
            try {
              const oldHandle = encodeHandle(`node-acp-${session.sessionId}`, session);
              await this.close({ handle: oldHandle, reason: "cwd_changed" });
            } catch {}
            session = undefined;
          }

          if (!session) {
            const cwd = params.cwd || "~";
            const handle = await this.ensureSession({
              sessionKey: `node-acp-${Date.now()}`,
              agent: "claude",
              mode: "persistent",
              cwd,
              node: nodeName,
            });
            const state = decodeHandle(handle);
            session = { sessionId: state.sessionId, nodeId: state.nodeId, nodeName: state.nodeName, cwd: state.cwd };
            this.activeSessions.set(nodeName, session);
          }

          // Send prompt and collect output
          const handle = encodeHandle(`node-acp-${session.sessionId}`, session);
          const log: string[] = [];
          for await (const event of this.runTurn({ handle, text: params.prompt, requestId: `prompt-${Date.now()}` })) {
            switch (event.type) {
              case "text_delta": if (event.text) log.push(event.text); break;
              case "tool_call": log.push(`[Tool: ${event.text}]`); break;
              case "permission_auto_approved": log.push(`[Permission auto-approved: ${event.description}]`); break;
              case "error":
                log.push(`[Error: ${event.message}]`);
                // Session might be dead — close it on daemon and clear locally
                try {
                  const closeHandle = encodeHandle(`node-acp-${session!.sessionId}`, session!);
                  await this.close({ handle: closeHandle, reason: "error_cleanup" });
                } catch {}
                this.activeSessions.delete(nodeName);
                return { content: [{ type: "text", text: log.join("\n") || `Error: ${event.message}` }] };
            }
          }
          return { content: [{ type: "text", text: log.join("\n") || "(no output)" }] };
        } catch (err: any) {
          // Clear session on failure — close on daemon first
          const failedNodeName = params.node || this.config.defaultNode;
          if (failedNodeName) {
            const failedSession = this.activeSessions.get(failedNodeName);
            if (failedSession) {
              try {
                const closeHandle = encodeHandle(`node-acp-${failedSession.sessionId}`, failedSession);
                await this.close({ handle: closeHandle, reason: "error_cleanup" });
              } catch {}
            }
            this.activeSessions.delete(failedNodeName);
          }
          return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
        }
      },
    });

    // Close tool — for explicit session cleanup
    api.registerTool({
      name: "remote_claude_code_close",
      label: "Close remote Claude Code session",
      description: "Close the active Claude Code session on a remote machine.",
      parameters: {
        type: "object",
        properties: {
          node: { type: "string", description: "Node name. Uses default if omitted." },
        },
      },
      execute: async (_id: string, params: { node?: string }) => {
        try {
          const nodeName = params.node || this.config.defaultNode;
          const session = this.activeSessions.get(nodeName);
          if (!session) {
            return { content: [{ type: "text", text: "No active session on that node." }] };
          }
          const handle = encodeHandle(`node-acp-${session.sessionId}`, session);
          await this.close({ handle, reason: "user_closed" });
          this.activeSessions.delete(nodeName);
          return { content: [{ type: "text", text: `Session closed on ${nodeName}.` }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Close failed: ${err.message}` }] };
        }
      },
    });
  }
}

function parseFirstJsonLine(stdout: string): any {
  const firstLine = stdout.split("\n").find((l) => l.trim());
  if (!firstLine) return null;
  try { return JSON.parse(firstLine); } catch { return null; }
}
