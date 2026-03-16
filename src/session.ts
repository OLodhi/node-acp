import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionProxy } from "./permission-proxy.js";
import type { DaemonEvent } from "./ipc-protocol.js";
import { forwardOutput } from "./output-forwarder.js";

export class Session {
  readonly sessionId: string;

  private _status: "idle" | "busy" = "idle";
  private _resumeSessionId: string | undefined;
  private _pid: number | undefined;
  private currentQuery: any = null;

  private cwd: string;
  private model: string;
  private permissionMode: string;
  private permissionProxy: PermissionProxy;
  private emit: (event: DaemonEvent) => void;

  constructor(
    sessionId: string,
    cwd: string,
    model: string,
    permissionMode: string,
    permissionProxy: PermissionProxy,
    emit: (event: DaemonEvent) => void
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.permissionMode = permissionMode;
    this.permissionProxy = permissionProxy;
    this.emit = emit;
  }

  get status(): "idle" | "busy" {
    return this._status;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get resumeSessionId(): string | undefined {
    return this._resumeSessionId;
  }

  async prompt(text: string): Promise<void> {
    if (this._status === "busy") {
      throw new Error(`Session ${this.sessionId} is busy`);
    }

    this._status = "busy";

    try {
      const options: any = {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          opts: { signal: AbortSignal; toolUseID: string }
        ) => this.handlePermission(toolName, input, opts),
      };

      if (this.model) {
        options.model = this.model;
      }

      if (this._resumeSessionId) {
        options.resume = this._resumeSessionId;
      }

      this.currentQuery = sdkQuery({ prompt: text, options });

      for await (const message of this.currentQuery) {
        // Capture session ID from init message
        if (
          (message as any).type === "system" &&
          (message as any).subtype === "init" &&
          (message as any).session_id
        ) {
          this._resumeSessionId = (message as any).session_id;
        }

        // Forward to output forwarder
        forwardOutput(message, this.sessionId, this.emit);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      console.error(`[session ${this.sessionId}] prompt error:`, errorMsg);
      if (errorStack) console.error(errorStack);
      this.emit({
        type: "error",
        sessionId: this.sessionId,
        error: errorMsg,
      });
    } finally {
      this._status = "idle";
      this.currentQuery = null;
    }
  }

  async cancel(): Promise<void> {
    if (this._status !== "busy" || !this.currentQuery) return;
    try {
      await this.currentQuery.interrupt();
    } catch {
      // Ignore errors during interrupt
    }
  }

  close(): void {
    if (this.currentQuery) {
      try {
        this.currentQuery.close();
      } catch {
        // Ignore errors during close
      }
    }
    this.currentQuery = null;
    this._status = "idle";
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string }
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const path = String(
      input.file_path ?? input.command ?? input.path ?? "(unknown)"
    );
    const description = `${toolName} on ${path}`;

    // Race permission request against abort signal
    const permissionPromise = this.permissionProxy.requestPermission(
      this.sessionId,
      toolName,
      path,
      description
    );

    const abortPromise = new Promise<false>((resolve) => {
      if (opts.signal.aborted) {
        resolve(false);
        return;
      }
      opts.signal.addEventListener("abort", () => resolve(false), { once: true });
    });

    const approved = await Promise.race([permissionPromise, abortPromise]);

    if (approved) {
      return { behavior: "allow" };
    }
    return { behavior: "deny", message: "Permission denied by user" };
  }
}
