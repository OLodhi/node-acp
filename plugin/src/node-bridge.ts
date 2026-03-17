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

  constructor(openclawConfig: any) {
    this.token = openclawConfig?.gateway?.auth?.token ?? "";
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

  async resolveNode(displayName: string): Promise<string> {
    const cached = this.nodeIdCache.get(displayName);
    if (cached) return cached;

    const result = await this.callGateway({
      token: this.token,
      method: "node.list",
      params: {},
      timeoutMs: 10_000,
      clientName: "acpx-remote",
      mode: "backend",
      scopes: ["operator.read"],
    });

    for (const node of result?.nodes ?? []) {
      if (node.displayName === displayName || node.nodeId === displayName) {
        this.nodeIdCache.set(displayName, node.nodeId);
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

    const result = await this.callGateway({
      token: this.token,
      method: "node.invoke",
      params: {
        nodeId,
        command: "system.run",
        params: {
          command: argv,
          cwd: opts?.cwd ?? "~",
          timeoutMs,
        },
        timeoutMs,
        idempotencyKey: randomUUID(),
      },
      timeoutMs: timeoutMs + 5_000,
      clientName: "acpx-remote",
      mode: "backend",
      scopes: ["operator.write"],
    });

    const payload = result?.payload ?? result;
    return {
      exitCode: payload?.exitCode ?? (payload?.success ? 0 : 1),
      stdout: payload?.stdout ?? "",
      stderr: payload?.stderr ?? payload?.error ?? "",
      success: payload?.success ?? false,
    };
  }
}
