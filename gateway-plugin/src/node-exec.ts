import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

export interface NodeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export type NodeExecFn = (
  nodeName: string,
  argv: string[],
  timeoutMs?: number,
) => Promise<NodeExecResult>;

export function createNodeExec(openclawConfig: any): NodeExecFn {
  const req = createRequire(import.meta.url);
  const oc = req("/home/omar/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-DRjqKE3G.js");
  const callGateway = oc.Ks;
  const token = openclawConfig?.gateway?.auth?.token;

  const nodeIdCache = new Map<string, { id: string; platform: string }>();

  async function resolveNode(displayName: string): Promise<{ id: string; platform: string }> {
    const cached = nodeIdCache.get(displayName);
    if (cached) return cached;

    const result = await callGateway({
      token, method: "node.list", params: {},
      timeoutMs: 10000, clientName: "gateway-client", mode: "backend",
      scopes: ["operator.read"],
    });

    for (const node of result?.nodes ?? []) {
      if (node.displayName === displayName || node.nodeId === displayName) {
        const entry = { id: node.nodeId, platform: node.platform || "linux" };
        nodeIdCache.set(displayName, entry);
        return entry;
      }
    }
    throw new Error(`Node "${displayName}" not found or not connected`);
  }

  return async (nodeName: string, argv: string[], timeoutMs: number = 30000): Promise<NodeExecResult> => {
    const node = await resolveNode(nodeName);

    const result = await callGateway({
      token, method: "node.invoke",
      params: {
        nodeId: node.id,
        command: "system.run",
        params: {
          command: argv,
          cwd: "C:/Users/Omar.Lodhi",
          timeoutMs,
        },
        timeoutMs,
        idempotencyKey: randomUUID(),
      },
      timeoutMs: timeoutMs + 5000,
      clientName: "gateway-client",
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
  };
}
