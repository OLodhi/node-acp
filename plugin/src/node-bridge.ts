import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export class NodeBridge {
  private callGateway: any;
  private token: string;
  private nodeIdCache = new Map<string, string>();
  private logger?: any;
  private nodePlatform: "win32" | "posix";

  constructor(openclawConfig: any, logger?: any, nodePlatform?: string) {
    this.token = openclawConfig?.gateway?.auth?.token ?? "";
    this.logger = logger;
    this.nodePlatform = nodePlatform === "posix" ? "posix" : "win32"; // default win32 for now
    this.callGateway = this.resolveCallGateway();
  }

  private resolveCallGateway(): any {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    // Strategy 1: Try require from main process context (works when loaded by openclaw)
    for (const base of [import.meta.url, process.argv[1], __filename].filter(Boolean)) {
      try {
        const req = createRequire(base as string);
        const mod = req("openclaw/plugin-sdk/gateway/call");
        if (mod?.callGateway) return mod.callGateway;
      } catch {}
    }

    // Strategy 2: Scan openclaw dist bundles for callGateway by function name
    const searchPaths = [
      // Global npm on Linux
      path.join(process.env.HOME || "", ".npm-global/lib/node_modules/openclaw/dist"),
      // Global npm default
      "/usr/local/lib/node_modules/openclaw/dist",
      "/usr/lib/node_modules/openclaw/dist",
      // Windows global npm
      path.join(process.env.APPDATA || "", "npm/node_modules/openclaw/dist"),
    ];

    // Also try to find openclaw from the running process
    try {
      const mainScript = process.argv[1] || "";
      if (mainScript.includes("openclaw")) {
        const ocDir = mainScript.substring(0, mainScript.indexOf("openclaw") + "openclaw".length);
        searchPaths.unshift(path.join(ocDir, "dist"));
      }
    } catch {}

    for (const distDir of searchPaths) {
      try {
        if (!fs.existsSync(distDir)) continue;
        const bundles = fs.readdirSync(distDir)
          .filter((f: string) => f.startsWith("auth-profiles") && f.endsWith(".js") && !f.includes(".runtime"));

        for (const file of bundles) {
          try {
            const req = createRequire(path.join(distDir, file));
            const mod = req(path.join(distDir, file));
            for (const val of Object.values(mod)) {
              if (typeof val === "function" && (val as any).name === "callGateway") {
                return val;
              }
            }
          } catch { continue; }
        }
      } catch { continue; }
    }

    throw new Error(
      "[acpx-remote] Could not resolve callGateway from OpenClaw SDK. " +
      "Ensure openclaw is installed and the plugin is loaded from a configured path."
    );
  }

  /**
   * Wrap a command argv for the target node platform's shell,
   * but ONLY for POSIX nodes. On Windows, system.run already uses
   * windowsHide:true — wrapping in cmd.exe causes a visible console flash.
   * Instead, we pass argv directly and rely on the daemonBin config
   * providing a resolvable executable (e.g. "node path/to/script.js").
   */
  private wrapForShell(argv: string[]): string[] {
    if (this.nodePlatform !== "win32") {
      // POSIX: use login shell for full PATH resolution
      return ["/bin/sh", "-lc", argv.join(" ")];
    }
    // Windows: pass argv directly — system.run spawns with windowsHide:true
    return argv;
  }

  async resolveNode(displayName: string): Promise<string> {
    const cached = this.nodeIdCache.get(displayName);
    if (cached) return cached;

    const result = await this.callGateway({
      token: this.token,
      method: "node.list",
      params: {},
      timeoutMs: 10_000,
      clientName: "gateway-client",
      mode: "backend",
      scopes: ["operator.read"],
    });

    for (const node of result?.nodes ?? []) {
      if (node.displayName === displayName || node.nodeId === displayName) {
        this.nodeIdCache.set(displayName, node.nodeId);
        // Auto-detect platform from node info if available
        if (node.platform) {
          this.nodePlatform = node.platform.startsWith("win") ? "win32" : "posix";
        }
        return node.nodeId;
      }
    }
    throw new Error(`Node "${displayName}" not found or not connected`);
  }

  async exec(
    nodeIdOrName: string,
    argv: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Resolve display name to node ID if needed
    const nodeId = this.nodeIdCache.has(nodeIdOrName)
      ? this.nodeIdCache.get(nodeIdOrName)!
      : nodeIdOrName.length === 64 // hashed node IDs are 64 chars
        ? nodeIdOrName
        : await this.resolveNode(nodeIdOrName);

    const timeoutMs = opts?.timeoutMs ?? 30_000;

    // Wrap command in platform shell for PATH resolution
    // (matches OpenClaw's native buildNodeShellCommand behavior)
    const shellArgv = this.wrapForShell(argv);

    let result: any;
    try {
      result = await this.callGateway({
        token: this.token,
        method: "node.invoke",
        params: {
          nodeId,
          command: "system.run",
          params: {
            command: shellArgv,
            cwd: opts?.cwd ?? undefined, // omit cwd to use node's default (~ doesn't work without shell)
            timeoutMs,
          },
          timeoutMs,
          idempotencyKey: randomUUID(),
        },
        timeoutMs: timeoutMs + 5_000,
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.write"],
      });
    } catch (err: any) {
      this.logger?.error(`[acpx-remote] callGateway error: ${err.message}`);
      return { exitCode: 1, stdout: "", stderr: err.message ?? "callGateway failed", success: false };
    }

    // Log raw response for debugging
    this.logger?.info(`[acpx-remote] system.run raw response: ${JSON.stringify(result)?.slice(0, 500)}`);

    const payload = result?.payload ?? result;
    return {
      exitCode: payload?.exitCode ?? (payload?.success ? 0 : 1),
      stdout: payload?.stdout ?? "",
      stderr: payload?.stderr ?? payload?.error ?? "",
      success: payload?.success ?? false,
    };
  }
}
