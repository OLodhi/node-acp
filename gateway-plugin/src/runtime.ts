import { randomUUID } from "node:crypto";
import type { NodeExecFn } from "./node-exec.js";
import type { AcpxRemoteConfig } from "./config.js";
import { encodeHandle, decodeHandle, type AcpRuntimeHandle } from "./handle.js";

export interface AcpRuntimeEvent {
  type: "text_delta" | "status" | "tool_call" | "done" | "error" | "permission_request" | "permission_auto_approved";
  text?: string;
  message?: string;
  tag?: string;
  stopReason?: string;
  stream?: string;
  code?: string;
  retryable?: boolean;
  // Permission-specific fields
  permissionId?: string;
  operation?: string;
  path?: string;
  description?: string;
}

export interface EnsureInput {
  sessionKey: string;
  agent: string;
  mode: string;
  cwd?: string;
  node?: string;
  resumeSessionId?: string;
}

export class AcpxRemoteRuntime {
  constructor(
    private config: AcpxRemoteConfig,
    private nodeExec: NodeExecFn,
  ) {}

  async ensureSession(input: EnsureInput): Promise<AcpRuntimeHandle> {
    const nodeName = input.node || this.config.defaultNode;
    if (!nodeName) {
      throw new Error("No node specified. Use --node <name> or set defaultNode in plugin config.");
    }

    const sessionId = randomUUID();
    const cwd = input.cwd || "~";

    const result = await this.nodeExec(
      nodeName,
      [...this.config.daemonBin.split(" "), "spawn", "--session-id", sessionId, "--cwd", cwd],
    );

    if (!result.success) {
      throw new Error(`Failed to spawn session on ${nodeName}: ${result.stderr}`);
    }

    const spawnResult = this.parseFirstJsonLine(result.stdout);
    if (spawnResult?.success === false) {
      throw new Error(spawnResult.error || "Spawn failed");
    }

    return encodeHandle(input.sessionKey, { sessionId, node: nodeName, cwd });
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const { sessionId, node } = decodeHandle(input.handle);
    await this.nodeExec(node, [...this.config.daemonBin.split(" "), "cancel", sessionId]);
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const { sessionId, node } = decodeHandle(input.handle);
    await this.nodeExec(node, [...this.config.daemonBin.split(" "), "close", sessionId]);
  }

  async respondToPermission(node: string, sessionId: string, permissionId: string, approved: boolean): Promise<void> {
    await this.nodeExec(
      node,
      [...this.config.daemonBin.split(" "), "permission-response", sessionId, permissionId, String(approved)],
    );
  }

  async *runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    signal?: AbortSignal;
    requestId: string;
    autoApprove?: boolean;
  }): AsyncIterable<AcpRuntimeEvent> {
    const { sessionId, node } = decodeHandle(input.handle);
    const encodedText = Buffer.from(input.text).toString("base64");

    // Send prompt asynchronously
    const promptResult = await this.nodeExec(
      node,
      [...this.config.daemonBin.split(" "), "prompt", sessionId, "--async", "--text-b64", encodedText],
    );

    // Check for immediate error
    if (!promptResult.success) {
      const errMsg = promptResult.stderr || promptResult.stdout || "Prompt command failed";
      yield { type: "error", message: errMsg };
      return;
    }
    const promptResponse = this.parseFirstJsonLine(promptResult.stdout);
    if (promptResponse?.type === "error") {
      yield { type: "error", message: promptResponse.error || "Prompt failed" };
      return;
    }
    if (!promptResponse || promptResponse.type !== "prompt_accepted") {
      yield { type: "error", message: "Unexpected prompt response: " + promptResult.stdout.slice(0, 200) };
      return;
    }

    // Delegate to shared poll loop
    yield* this.pollLoop(input.handle, input.signal, input.autoApprove ?? true);
  }

  async *drainUntilComplete(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
    autoApprove?: boolean;
  }): AsyncIterable<AcpRuntimeEvent> {
    yield* this.pollLoop(input.handle, input.signal, input.autoApprove ?? true);
  }

  private async *pollLoop(
    handle: AcpRuntimeHandle,
    signal?: AbortSignal,
    autoApprove: boolean = true,
  ): AsyncIterable<AcpRuntimeEvent> {
    const { sessionId, node } = decodeHandle(handle);
    let consecutiveFailures = 0;
    const MAX_RETRIES = 3;
    const MAX_POLL_MS = 300_000; // 5 minutes
    const pollStartMs = Date.now();
    const RETRY_DELAY_MS = 2000;
    const MAX_IMMEDIATE_REDRAINS = 10;

    while (true) {
      if (Date.now() - pollStartMs > MAX_POLL_MS) {
        yield { type: "error", message: "Prompt timed out after 300 seconds", retryable: false };
        return;
      }

      if (signal?.aborted) {
        await this.cancel({ handle });
        yield { type: "done", stopReason: "cancelled" };
        return;
      }

      await this.sleep(this.config.pollIntervalMs);

      let drainResult: { exitCode: number; stdout: string; stderr: string; success: boolean };
      try {
        drainResult = await this.nodeExec(
          node,
          [...this.config.daemonBin.split(" "), "drain", sessionId],
        );
        if (!drainResult.success) {
          const stderr = drainResult.stderr || drainResult.stdout || "";
          if (stderr.includes("Cannot connect") || stderr.includes("ENOENT") || stderr.includes("EPIPE")) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_RETRIES) {
              yield { type: "error", message: "Daemon is not running on the node (connection refused)", retryable: false };
              return;
            }
            await this.sleep(RETRY_DELAY_MS);
            continue;
          }
        }
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_RETRIES) {
          yield { type: "error", message: `Lost connection to node after ${MAX_RETRIES} failed drain attempts`, retryable: false };
          return;
        }
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }

      const events = this.parseNdjson(drainResult.stdout);

      if (events.length === 1 && events[0].type === "error" && events[0].error?.includes("Session not found")) {
        yield { type: "error", message: "Session was lost (daemon may have restarted or session expired)", retryable: false };
        return;
      }

      const hasMore = events.some((e: any) => e.type === "has_more");
      const realEvents = events.filter((e: any) => e.type !== "has_more");

      for (const event of realEvents) {
        const result = yield* this.handleEvent(event, node, sessionId, autoApprove);
        if (result === "stop") return;
      }

      if (hasMore) {
        let redrains = 0;
        while (redrains < MAX_IMMEDIATE_REDRAINS) {
          await this.sleep(100);
          redrains++;
          try {
            const moreResult = await this.nodeExec(node, [...this.config.daemonBin.split(" "), "drain", sessionId]);
            const moreEvents = this.parseNdjson(moreResult.stdout);
            const moreHasMore = moreEvents.some((e: any) => e.type === "has_more");
            const moreReal = moreEvents.filter((e: any) => e.type !== "has_more");
            for (const event of moreReal) {
              const result = yield* this.handleEvent(event, node, sessionId, autoApprove);
              if (result === "stop") return;
            }
            if (!moreHasMore) break;
          } catch { break; }
        }
      }
    }
  }

  private async *handleEvent(
    event: any,
    node: string,
    sessionId: string,
    autoApprove: boolean,
  ): AsyncGenerator<AcpRuntimeEvent, "stop" | "continue"> {
    if (event.type === "permission_request" && autoApprove) {
      // Auto-approve: yield the request for logging, approve it, continue
      yield {
        type: "permission_auto_approved",
        permissionId: event.permissionId,
        operation: event.operation,
        path: event.path,
        description: event.description,
        text: `Auto-approved: ${event.description}`,
      };
      try {
        await this.respondToPermission(node, sessionId, event.permissionId, true);
      } catch {
        // If approval fails, yield error but continue polling
        yield { type: "error", message: `Failed to auto-approve permission: ${event.description}` };
      }
      return "continue";
    }

    const mapped = this.mapDaemonEvent(event);
    if (mapped) {
      yield mapped;
      if (mapped.type === "done" || mapped.type === "error" || mapped.type === "permission_request") {
        return "stop";
      }
    }
    return "continue";
  }

  private mapDaemonEvent(event: any): AcpRuntimeEvent | null {
    switch (event.type) {
      case "output":
        if (event.messageType === "assistant_text") {
          return { type: "text_delta", text: event.chunk, tag: "agent_message_chunk" };
        }
        if (event.messageType === "tool_use") {
          return { type: "tool_call", text: event.chunk, tag: "tool_call" };
        }
        return { type: "status", text: event.chunk, tag: event.messageType };
      case "prompt_complete":
        return { type: "done", stopReason: event.stopReason };
      case "error":
        return { type: "error", message: event.error };
      case "session_closed":
        return { type: "done", stopReason: `session_closed: ${event.reason}` };
      case "permission_request":
        return {
          type: "permission_request",
          permissionId: event.permissionId,
          operation: event.operation,
          path: event.path,
          description: event.description,
          text: `Permission requested: ${event.description}`,
        };
      default:
        return null;
    }
  }

  private parseFirstJsonLine(stdout: string): any {
    const firstLine = stdout.split("\n").find((l) => l.trim());
    if (!firstLine) return null;
    try { return JSON.parse(firstLine); } catch { return null; }
  }

  private parseNdjson(stdout: string): any[] {
    return stdout.split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
