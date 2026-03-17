import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { PermissionProxy } from "./permission-proxy.js";
import type { DaemonEvent } from "./ipc-protocol.js";
import { forwardOutput } from "./output-forwarder.js";

// ANSI color helpers
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

export class Session {
  readonly sessionId: string;

  private _status: "idle" | "busy" = "idle";
  private _resumeSessionId: string | undefined;
  private _pid: number | undefined;
  private currentProcess: ChildProcess | null = null;

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
    const tag = `[${this.sessionId.slice(0, 8)}]`;

    try {
      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", this.permissionMode,
      ];

      if (this.permissionMode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
      }

      if (this.model) {
        args.push("--model", this.model);
      }

      if (this._resumeSessionId) {
        args.push("--resume", this._resumeSessionId);
      }

      console.log(`\n${BLUE}${BOLD}━━━ Claude Code Session ${tag} ━━━${RESET}`);
      console.log(`${DIM}  cwd: ${this.cwd}${RESET}`);
      console.log(`${DIM}  prompt: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}${RESET}`);
      console.log(`${DIM}  resume: ${this._resumeSessionId ?? "(new session)"}${RESET}\n`);

      const proc = spawn("claude", args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        env: { ...process.env },
      });

      this.currentProcess = proc;
      this._pid = proc.pid;

      // Pipe prompt text to stdin, then close it so claude reads the prompt
      proc.stdin!.write(text);
      proc.stdin!.end();

      // Handle spawn errors without crashing the daemon
      proc.on("error", (err) => {
        console.error(`${RED}${tag} spawn error: ${err.message}${RESET}`);
        this.emit({ type: "error", sessionId: this.sessionId, error: `Failed to start claude: ${err.message}` });
      });

      const rl = createInterface({ input: proc.stdout! });

      for await (const line of rl) {
        if (!line.trim()) continue;

        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        // Capture session ID from init
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          this._resumeSessionId = msg.session_id;
          console.log(`${BLUE}  session: ${msg.session_id.slice(0, 8)}  model: ${msg.model ?? "?"}  mode: ${msg.permissionMode ?? "?"}${RESET}`);
        }

        // Render to console
        this.renderMessage(tag, msg);

        // Forward to IPC event system (reuses existing output forwarder)
        forwardOutput(msg, this.sessionId, this.emit);
      }

      // Wait for process to exit
      const exitCode = await new Promise<number>((resolve) => {
        proc.on("close", (code) => resolve(code ?? 0));
      });

      if (exitCode !== 0) {
        // Collect stderr
        let stderr = "";
        proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        // Give a moment for stderr to flush
        await new Promise((r) => setTimeout(r, 100));
        if (stderr) {
          console.log(`${RED}  stderr: ${stderr.slice(0, 500)}${RESET}`);
        }
      }

      console.log(`\n${BLUE}${BOLD}━━━ Session ${tag} turn complete (exit=${exitCode}) ━━━${RESET}\n`);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`${RED}${tag} error: ${errorMsg}${RESET}`);
      this.emit({
        type: "error",
        sessionId: this.sessionId,
        error: errorMsg,
      });
    } finally {
      this._status = "idle";
      this.currentProcess = null;
    }
  }

  async cancel(): Promise<void> {
    if (this._status !== "busy" || !this.currentProcess) return;
    try {
      this.currentProcess.kill("SIGTERM");
    } catch {
      // Ignore
    }
  }

  close(): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
    this.currentProcess = null;
    this._status = "idle";
  }

  private renderMessage(tag: string, msg: any): void {
    switch (msg.type) {
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (block.type === "text" && block.text) {
            console.log(`${BOLD}${block.text}${RESET}`);
          } else if (block.type === "tool_use") {
            const inputPreview = this.formatToolInput(block.name, block.input);
            console.log(`${YELLOW}  ▶ ${block.name}${RESET} ${DIM}${inputPreview}${RESET}`);
          }
        }
        break;
      }

      case "tool_result":
      case "user": {
        // Tool results from Claude Code
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (block.type === "tool_result") {
            const text = typeof block.content === "string" ? block.content
              : Array.isArray(block.content)
                ? block.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                : "";
            if (block.is_error) {
              console.log(`${RED}  ✗ ${text.slice(0, 300)}${RESET}`);
            } else if (text) {
              // Show first few lines of tool output
              const lines = text.split("\n");
              const preview = lines.slice(0, 8).join("\n");
              const more = lines.length > 8 ? `\n${DIM}  ... (${lines.length - 8} more lines)${RESET}` : "";
              console.log(`${GREEN}  ✓ ${preview}${more}${RESET}`);
            }
          }
        }
        break;
      }

      case "result": {
        const cost = msg.total_cost_usd ? `$${msg.total_cost_usd.toFixed(4)}` : "";
        const turns = msg.num_turns ? `${msg.num_turns} turns` : "";
        const duration = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : "";
        const info = [turns, duration, cost].filter(Boolean).join("  ");

        if (msg.subtype === "success") {
          console.log(`${GREEN}${BOLD}  ✓ Complete${RESET} ${DIM}${info}${RESET}`);
        } else {
          const errorText = msg.error ?? "unknown error";
          console.log(`${RED}${BOLD}  ✗ Failed: ${errorText}${RESET} ${DIM}${info}${RESET}`);
        }
        break;
      }

      case "system": {
        // Show interesting system events
        if (msg.subtype === "init") return; // Already handled above
        if (msg.subtype && !["hook_started", "hook_response"].includes(msg.subtype)) {
          console.log(`${CYAN}  [${msg.subtype}]${RESET}`);
        }
        break;
      }
    }
  }

  private formatToolInput(toolName: string, input: any): string {
    if (!input) return "";
    switch (toolName) {
      case "Read":
        return input.file_path ?? "";
      case "Write":
        return input.file_path ?? "";
      case "Edit":
        return input.file_path ?? "";
      case "Bash":
        return (input.command ?? "").slice(0, 120);
      case "Glob":
        return input.pattern ?? "";
      case "Grep":
        return `/${input.pattern ?? ""}/ ${input.path ?? ""}`;
      case "WebFetch":
        return input.url ?? "";
      case "WebSearch":
        return input.query ?? "";
      default:
        return JSON.stringify(input).slice(0, 100);
    }
  }

  // Keep for non-bypass permission modes (unused in bypass mode)
  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string }
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const path = String(input.file_path ?? input.command ?? input.path ?? "(unknown)");
    const description = `${toolName} on ${path}`;
    const permissionPromise = this.permissionProxy.requestPermission(this.sessionId, toolName, path, description);
    const abortPromise = new Promise<false>((resolve) => {
      if (opts.signal.aborted) { resolve(false); return; }
      opts.signal.addEventListener("abort", () => resolve(false), { once: true });
    });
    const approved = await Promise.race([permissionPromise, abortPromise]);
    if (approved) return { behavior: "allow" };
    return { behavior: "deny", message: "Permission denied by user" };
  }
}
