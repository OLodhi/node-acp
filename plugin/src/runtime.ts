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
    this.daemonManager = new DaemonManager(config.autoDeployDaemon, logger);
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
      "acpx-node-daemon", "spawn",
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
      "acpx-node-daemon", "prompt", sessionId,
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
      pollIntervalMs: this.config.pollIntervalMs,
      signal: input.signal,
      autoApprove: true,
      onDaemonDown: () => this.daemonManager.markNodeDown(nodeId),
    });
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    await this.bridge.exec(nodeId, ["acpx-node-daemon", "cancel", sessionId]);
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    await this.bridge.exec(nodeId, ["acpx-node-daemon", "close", sessionId]);
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<any> {
    const { sessionId, nodeId } = decodeHandle(input.handle);
    const result = await this.bridge.exec(nodeId, ["acpx-node-daemon", "status", sessionId]);
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

      const versionResult = await this.bridge.exec(nodeId, ["acpx-node-daemon", "--version"], { timeoutMs: 15_000 });
      if (versionResult.success) {
        details.push(`Daemon version: ${versionResult.stdout.trim()}`);
      } else {
        details.push("Install with: npm install -g acpx-node-daemon");
        return { ok: false, message: "Daemon not installed on node", details };
      }

      const pingResult = await this.bridge.exec(nodeId, ["acpx-node-daemon", "status", "ping"], { timeoutMs: 10_000 });
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

  // --- Fallback: register tools directly if AcpRuntime registration fails ---

  registerTools(api: any): void {
    this.logger?.info("[acpx-remote] registering tools (fallback mode)");

    api.registerTool({
      name: "node_acp_spawn",
      label: "Spawn remote ACP session",
      description: "Spawn a Claude Code session on a remote OpenClaw node.",
      parameters: {
        type: "object",
        properties: {
          node: { type: "string", description: "Node name" },
          cwd: { type: "string", description: "Working directory on the node" },
        },
        required: ["node", "cwd"],
      },
      execute: async (_id: string, params: { node: string; cwd: string }) => {
        try {
          const handle = await this.ensureSession({
            sessionKey: `node-acp-${Date.now()}`,
            agent: "claude",
            mode: "persistent",
            cwd: params.cwd,
            node: params.node,
          });
          const state = decodeHandle(handle);
          return {
            content: [{ type: "text", text: `Session started on ${params.node} in ${params.cwd}.\nSession ID: ${state.sessionId}` }],
            details: { sessionId: state.sessionId, node: params.node },
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "node_acp_prompt",
      label: "Send prompt to remote ACP session",
      description: "Send a prompt to a Claude Code session on a remote node. Auto-approves permissions. Returns verbatim output.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          node: { type: "string", description: "Node name" },
          text: { type: "string", description: "The prompt" },
        },
        required: ["sessionId", "node", "text"],
      },
      execute: async (_id: string, params: { sessionId: string; node: string; text: string }) => {
        try {
          const nodeId = await this.bridge.resolveNode(params.node);
          const handle = encodeHandle(`node-acp-${params.sessionId}`, {
            sessionId: params.sessionId, nodeId, nodeName: params.node, cwd: "~",
          });
          const log: string[] = [];
          for await (const event of this.runTurn({ handle, text: params.text, requestId: `prompt-${Date.now()}` })) {
            switch (event.type) {
              case "text_delta": if (event.text) log.push(event.text); break;
              case "tool_call": log.push(`[Tool: ${event.text}]`); break;
              case "permission_auto_approved": log.push(`[Permission auto-approved: ${event.description}]`); break;
              case "error": log.push(`[Error: ${event.message}]`); return { content: [{ type: "text", text: log.join("\n") || `Error: ${event.message}` }] };
            }
          }
          return { content: [{ type: "text", text: log.join("\n") || "(no output)" }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "node_acp_close",
      label: "Close remote ACP session",
      description: "Close a Claude Code session on a remote node.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          node: { type: "string", description: "Node name" },
        },
        required: ["sessionId", "node"],
      },
      execute: async (_id: string, params: { sessionId: string; node: string }) => {
        try {
          const nodeId = await this.bridge.resolveNode(params.node);
          const handle = encodeHandle(`node-acp-${params.sessionId}`, {
            sessionId: params.sessionId, nodeId, nodeName: params.node, cwd: "~",
          });
          await this.close({ handle, reason: "user_closed" });
          return { content: [{ type: "text", text: `Session closed on ${params.node}.` }] };
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
