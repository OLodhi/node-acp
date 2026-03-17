import { AcpxRemoteRuntime } from "./runtime.js";
import { resolveConfig } from "./config.js";
import { createNodeExec } from "./node-exec.js";
import { encodeHandle, decodeHandle } from "./handle.js";

const plugin = {
  id: "acpx-remote",
  name: "Remote ACP Sessions",
  description: "Spawn ACP sessions on remote OpenClaw nodes via the node host.",

  register(api: any) {
    const pluginConfig = resolveConfig(api.pluginConfig);
    const openclawConfig = api.config;
    const nodeExec = createNodeExec(openclawConfig);
    const runtime = new AcpxRemoteRuntime(pluginConfig, nodeExec);

    api.logger?.info("[acpx-remote] runtime initialized with callGateway transport");

    // Tool: node_acp_spawn
    api.registerTool({
      name: "node_acp_spawn",
      label: "Spawn remote ACP session",
      description: "Spawn a Claude Code coding session on a remote OpenClaw node. Returns a sessionId and node name to use with node_acp_prompt and node_acp_close.",
      parameters: {
        type: "object",
        properties: {
          node: { type: "string", description: "Name of the OpenClaw node (e.g. Thinkpad-Node)" },
          cwd: { type: "string", description: "Working directory on the node" },
        },
        required: ["node", "cwd"],
      },
      async execute(_toolCallId: string, params: { node: string; cwd: string }) {
        try {
          const handle = await runtime.ensureSession({
            sessionKey: `node-acp-${Date.now()}`,
            agent: "claude",
            mode: "persistent",
            cwd: params.cwd,
            node: params.node,
          });
          const state = decodeHandle(handle);
          return {
            content: [{ type: "text", text: `Session started on ${params.node} in ${params.cwd}.\nSession ID: ${state.sessionId}` }],
            details: { sessionId: state.sessionId, node: params.node, cwd: params.cwd },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Failed to spawn session: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });

    // Tool: node_acp_prompt
    api.registerTool({
      name: "node_acp_prompt",
      label: "Send prompt to remote ACP session",
      description: "Send a prompt to a Claude Code session on a remote node. Auto-approves permissions. Returns a verbatim event log — relay the FULL output to the user exactly as-is without summarizing.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from node_acp_spawn" },
          node: { type: "string", description: "Node name (e.g. Thinkpad-Node)" },
          text: { type: "string", description: "The prompt to send to Claude Code" },
        },
        required: ["sessionId", "node", "text"],
      },
      async execute(_toolCallId: string, params: { sessionId: string; node: string; text: string }) {
        try {
          const handle = encodeHandle(`node-acp-${params.sessionId}`, {
            sessionId: params.sessionId,
            node: params.node,
            cwd: "~",
          });

          const log: string[] = [];
          let stopReason = "unknown";

          for await (const event of runtime.runTurn({
            handle, text: params.text, requestId: `prompt-${Date.now()}`, autoApprove: true,
          })) {
            switch (event.type) {
              case "text_delta":
                if (event.text) log.push(event.text);
                break;
              case "tool_call":
                log.push(`[Tool: ${event.text}]`);
                break;
              case "permission_auto_approved":
                log.push(`[Permission auto-approved: ${event.description}]`);
                break;
              case "permission_request":
                log.push(`[Permission needed: ${event.description} — permissionId: ${event.permissionId}]`);
                break;
              case "done":
                stopReason = event.stopReason || "end_turn";
                break;
              case "error":
                log.push(`[Error: ${event.message}]`);
                return {
                  content: [{ type: "text", text: log.join("\n") || `Error: ${event.message}` }],
                  details: { error: event.message, log },
                };
              case "status":
                if (event.text) log.push(`[${event.tag || "status"}: ${event.text}]`);
                break;
            }
          }

          return {
            content: [{ type: "text", text: log.join("\n") || "(no output)" }],
            details: { log, stopReason },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Prompt failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });

    // Tool: node_acp_permission (manual override — use if autoApprove is off)
    api.registerTool({
      name: "node_acp_permission",
      label: "Respond to permission request",
      description: "Manually approve or deny a permission request from a Claude Code session. Only needed if auto-approve is disabled.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          node: { type: "string", description: "Node name" },
          permissionId: { type: "string", description: "Permission ID from the permission request" },
          approved: { type: "boolean", description: "Whether to approve (true) or deny (false)" },
        },
        required: ["sessionId", "node", "permissionId", "approved"],
      },
      async execute(_toolCallId: string, params: { sessionId: string; node: string; permissionId: string; approved: boolean }) {
        try {
          await runtime.respondToPermission(params.node, params.sessionId, params.permissionId, params.approved);
          return {
            content: [{ type: "text", text: `Permission ${params.approved ? "approved" : "denied"}.` }],
            details: { success: true },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Permission response failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });

    // Tool: node_acp_continue (resume polling after manual permission)
    api.registerTool({
      name: "node_acp_continue",
      label: "Continue polling remote ACP session",
      description: "Resume polling for output after a manual permission response. Returns verbatim event log — relay FULL output to the user exactly as-is.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
          node: { type: "string", description: "Node name" },
        },
        required: ["sessionId", "node"],
      },
      async execute(_toolCallId: string, params: { sessionId: string; node: string }) {
        try {
          const handle = encodeHandle(`node-acp-${params.sessionId}`, {
            sessionId: params.sessionId,
            node: params.node,
            cwd: "~",
          });

          const log: string[] = [];
          let stopReason = "unknown";

          for await (const event of runtime.drainUntilComplete({ handle, autoApprove: true })) {
            switch (event.type) {
              case "text_delta":
                if (event.text) log.push(event.text);
                break;
              case "tool_call":
                log.push(`[Tool: ${event.text}]`);
                break;
              case "permission_auto_approved":
                log.push(`[Permission auto-approved: ${event.description}]`);
                break;
              case "done":
                stopReason = event.stopReason || "end_turn";
                break;
              case "error":
                log.push(`[Error: ${event.message}]`);
                return {
                  content: [{ type: "text", text: log.join("\n") || `Error: ${event.message}` }],
                  details: { error: event.message, log },
                };
              case "status":
                if (event.text) log.push(`[${event.tag || "status"}: ${event.text}]`);
                break;
            }
          }

          return {
            content: [{ type: "text", text: log.join("\n") || "(no output)" }],
            details: { log, stopReason },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Continue failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });

    // Tool: node_acp_close
    api.registerTool({
      name: "node_acp_close",
      label: "Close remote ACP session",
      description: "Close an active Claude Code session on a remote node.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to close" },
          node: { type: "string", description: "Node name" },
        },
        required: ["sessionId", "node"],
      },
      async execute(_toolCallId: string, params: { sessionId: string; node: string }) {
        try {
          const handle = encodeHandle(`node-acp-${params.sessionId}`, {
            sessionId: params.sessionId,
            node: params.node,
            cwd: "~",
          });
          await runtime.close({ handle, reason: "user_closed" });
          return {
            content: [{ type: "text", text: `Session closed on ${params.node}.` }],
            details: { success: true },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Close failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });
  },
};

export default plugin;
