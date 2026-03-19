import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ISession, SessionConfig } from "./session-interface.js";
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

export class PersistentSession implements ISession {
  readonly sessionId: string;

  private _proc: ChildProcess | null = null;
  private _rl: ReadlineInterface | null = null;
  private _status: "idle" | "busy" = "idle";
  private _claudeSessionId: string | undefined;
  private _pid: number | undefined;
  private _spawnPromise: Promise<void> | null = null;
  private _spawnResolve: (() => void) | null = null;
  private _spawnReject: ((err: Error) => void) | null = null;
  private _promptResolve: (() => void) | null = null;
  private _promptReject: ((err: Error) => void) | null = null;
  private _promptCompleteEmitted = false;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _killTimer: ReturnType<typeof setTimeout> | null = null;

  private config: SessionConfig;
  private processIdleMinutes: number;

  constructor(config: SessionConfig, processIdleMinutes: number) {
    this.sessionId = config.sessionId;
    this.config = config;
    this.processIdleMinutes = processIdleMinutes;
  }

  get status(): "idle" | "busy" {
    return this._status;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get resumeSessionId(): string | undefined {
    return this._claudeSessionId;
  }

  async prompt(text: string): Promise<void> {
    if (this._status === "busy") {
      throw new Error(`Session ${this.sessionId} is busy`);
    }

    // Clear idle timer
    this.clearIdleTimer();

    this._status = "busy";
    this._promptCompleteEmitted = false;
    const tag = `[${this.sessionId.slice(0, 8)}]`;

    const writer = this.config.writer ?? ((line: string) => console.log(line));
    writer(`\n${BLUE}${BOLD}━━━ Claude Code Session ${tag} ━━━${RESET}`);
    writer(`${DIM}  cwd: ${this.config.cwd}${RESET}`);
    writer(`${DIM}  prompt: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}${RESET}`);
    writer(`${DIM}  mode: persistent  resume: ${this._claudeSessionId ?? "(new)"}${RESET}\n`);

    // Spawn if no process — write user message immediately (don't wait for init,
    // as the process may not emit init until stdin has data)
    if (!this._proc) {
      this.spawnProcess();
    } else if (this._spawnPromise) {
      // Process is still spawning from a previous call — wait for it
      await this._spawnPromise;
    }

    // Write prompt as NDJSON (format verified against claude --input-format stream-json)
    const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
    this._proc!.stdin!.write(msg);

    // Wait for result message from background reader
    return new Promise<void>((resolve, reject) => {
      this._promptResolve = resolve;
      this._promptReject = reject;
    });
  }

  async cancel(): Promise<void> {
    // For persistent sessions, cancel means kill the process (it will respawn on next prompt)
    if (this._status !== "busy" || !this._proc) return;
    try {
      this._proc.kill("SIGTERM");
    } catch {
      // Ignore
    }
  }

  close(): void {
    this.clearIdleTimer();
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    if (this._proc) {
      try { this._proc.stdin?.end(); } catch { /* ignore */ }
      try { this._proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this._proc = null;
    this._rl = null;
    this._status = "idle";
    this._promptResolve = null;
    this._promptReject = null;
  }

  // --- Private methods ---

  private spawnProcess(): void {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", this.config.permissionMode,
    ];

    if (this.config.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (this._claudeSessionId) {
      args.push("--resume", this._claudeSessionId);
    }

    // Resolve ~ to actual home directory (~ is not valid on Windows)
    const cwd = this.config.cwd === "~" ? homedir() : this.config.cwd;

    const proc = spawn(this.config.claudeBin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    });

    this._proc = proc;
    this._pid = proc.pid;
    if (proc.pid) this.config.pidRegistry?.register(proc.pid);

    // Handle spawn errors
    proc.on("error", (err) => {
      const writer = this.config.writer ?? ((line: string) => console.log(line));
      writer(`${RED}[${this.sessionId.slice(0, 8)}] spawn error: ${err.message}${RESET}`);
      this.config.emit({
        type: "error",
        sessionId: this.sessionId,
        error: `Failed to start claude: ${err.message}`,
      });
    });

    // Collect stderr
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      const writer = this.config.writer ?? ((line: string) => console.log(line));
      writer(`${DIM}  stderr: ${text.slice(0, 500)}${RESET}`);
    });

    // Create spawn promise that resolves when system/init is received
    // The .catch is a no-op to prevent unhandled rejection — actual error handling
    // is in handleProcessExit which propagates to _promptReject
    this._spawnPromise = new Promise<void>((resolve, reject) => {
      this._spawnResolve = resolve;
      this._spawnReject = reject;
    });
    this._spawnPromise.catch(() => {});

    // Handle process close
    proc.on("close", (code: number) => {
      this.handleProcessExit(code ?? 0);
    });

    // Start background reader (fire and forget — runs for process lifetime)
    this.runBackgroundReader();
  }

  private async runBackgroundReader(): Promise<void> {
    if (!this._proc?.stdout) return;

    const rl = createInterface({ input: this._proc.stdout });
    this._rl = rl;
    const tag = `[${this.sessionId.slice(0, 8)}]`;
    const writer = this.config.writer ?? ((line: string) => console.log(line));

    try {
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
          this._claudeSessionId = msg.session_id;
          writer(`${BLUE}  session: ${msg.session_id.slice(0, 8)}  model: ${msg.model ?? "?"}  mode: ${msg.permissionMode ?? "?"}${RESET}`);

          // Resolve spawn promise
          if (this._spawnResolve) {
            const resolve = this._spawnResolve;
            this._spawnResolve = null;
            this._spawnReject = null;
            this._spawnPromise = null;
            resolve();
          }
        }

        // Render to console
        this.renderMessage(tag, msg);

        // Forward to IPC event system
        const trackingEmit = (event: DaemonEvent) => {
          if (event.type === "prompt_complete") this._promptCompleteEmitted = true;
          this.config.emit(event);
        };
        forwardOutput(msg, this.sessionId, trackingEmit);

        // On result: resolve prompt, go idle, restart idle timer
        if (msg.type === "result") {
          this._status = "idle";
          this.startIdleTimer();
          this.config.onActivity?.();

          if (this._promptResolve) {
            const resolve = this._promptResolve;
            this._promptResolve = null;
            this._promptReject = null;
            resolve();
          }
        }

        // On assistant messages, call onActivity
        if (msg.type === "assistant") {
          this.config.onActivity?.();
        }
      }
    } catch {
      // readline closed or destroyed — fall through to exit handling
    }

    // Reader loop ended — if process exit hasn't been handled via close event,
    // handle it here (the close event handler is the primary path)
  }

  private handleProcessExit(exitCode: number): void {
    const tag = `[${this.sessionId.slice(0, 8)}]`;
    const writer = this.config.writer ?? ((line: string) => console.log(line));

    // If still spawning, reject spawn promise
    if (this._spawnReject) {
      const reject = this._spawnReject;
      this._spawnResolve = null;
      this._spawnReject = null;
      this._spawnPromise = null;
      reject(new Error(`Claude process exited during spawn with code ${exitCode}`));
    }

    // If busy, emit error + prompt_complete and reject prompt promise
    if (this._status === "busy") {
      if (!this._promptCompleteEmitted) {
        this.config.emit({
          type: "error",
          sessionId: this.sessionId,
          error: `Claude process crashed with exit code ${exitCode}`,
        });
        this.config.emit({
          type: "prompt_complete",
          sessionId: this.sessionId,
          stopReason: `exit_code_${exitCode}`,
        });
        this._promptCompleteEmitted = true;
      }

      if (this._promptReject) {
        const reject = this._promptReject;
        this._promptResolve = null;
        this._promptReject = null;
        reject(new Error(`Claude process crashed with exit code ${exitCode}`));
      }

      this._status = "idle";
    }

    // Unregister PID
    if (this._pid) {
      this.config.pidRegistry?.unregister(this._pid);
    }

    // Clean up references
    const wasIdle = this._status === "idle";
    this._proc = null;
    this._rl = null;
    this._pid = undefined;

    writer(`${DIM}  [process exited code=${exitCode}]${RESET}`);

    // If the process exited while idle, notify daemon to free the session slot.
    // Without this, the session stays registered against maxConcurrentSessions
    // until TTL expiry (2 hours), blocking new sessions.
    if (wasIdle) {
      this.config.onSessionDead?.();
    }
  }

  private clearIdleTimer(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.processIdleMinutes <= 0) return;

    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (!this._proc || this._status === "busy") return;

      const writer = this.config.writer ?? ((line: string) => console.log(line));
      writer(`${DIM}  [idle timeout — shutting down process]${RESET}`);

      // Graceful: close stdin first
      try { this._proc.stdin?.end(); } catch { /* ignore */ }

      // Force kill after 5 seconds
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        if (this._proc) {
          try { this._proc.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 5000);
    }, this.processIdleMinutes * 60 * 1000);
  }

  private renderMessage(tag: string, msg: any): void {
    const writer = this.config.writer ?? ((line: string) => console.log(line));

    switch (msg.type) {
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (block.type === "text" && block.text) {
            writer(`${BOLD}${block.text}${RESET}`);
          } else if (block.type === "tool_use") {
            const inputPreview = this.formatToolInput(block.name, block.input);
            writer(`${YELLOW}  ▶ ${block.name}${RESET} ${DIM}${inputPreview}${RESET}`);
          }
        }
        break;
      }

      case "tool_result":
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (block.type === "tool_result") {
            const text = typeof block.content === "string" ? block.content
              : Array.isArray(block.content)
                ? block.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                : "";
            if (block.is_error) {
              writer(`${RED}  ✗ ${text.slice(0, 300)}${RESET}`);
            } else if (text) {
              const lines = text.split("\n");
              const preview = lines.slice(0, 8).join("\n");
              const more = lines.length > 8 ? `\n${DIM}  ... (${lines.length - 8} more lines)${RESET}` : "";
              writer(`${GREEN}  ✓ ${preview}${more}${RESET}`);
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
          writer(`${GREEN}${BOLD}  ✓ Complete${RESET} ${DIM}${info}${RESET}`);
        } else {
          const errorText = msg.error ?? "unknown error";
          writer(`${RED}${BOLD}  ✗ Failed: ${errorText}${RESET} ${DIM}${info}${RESET}`);
        }
        break;
      }

      case "system": {
        if (msg.subtype === "init") return; // Already handled in reader
        if (msg.subtype && !["hook_started", "hook_response"].includes(msg.subtype)) {
          writer(`${CYAN}  [${msg.subtype}]${RESET}`);
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
}
