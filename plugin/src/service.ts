import { AcpxRemoteRuntime } from "./runtime.js";
import { resolveConfig } from "./config.js";
import { NodeBridge } from "./node-bridge.js";

export function createAcpxRemoteService(api: any) {
  let runtime: AcpxRemoteRuntime | null = null;

  return {
    id: "acpx-remote",

    async start() {
      const config = resolveConfig(api.pluginConfig);
      const bridge = new NodeBridge(api.config);
      runtime = new AcpxRemoteRuntime(config, bridge, api.logger);

      // Always register tools so the agent can call them
      runtime.registerTools(api);

      // Also register as ACP runtime backend (for future ACP routing support)
      try {
        const { registerAcpRuntimeBackend } = await import(/* @vite-ignore */ "openclaw/plugin-sdk/acpx" as string);
        registerAcpRuntimeBackend({
          id: "acpx-remote",
          runtime,
          healthy: () => runtime?.isHealthy() ?? false,
        });
        api.logger?.info("[acpx-remote] registered as ACP runtime backend");
      } catch {
        // ACP backend registration not available — tools are still registered
      }

      // Non-blocking probe
      runtime.probeAvailability().catch(() => {});
    },

    async stop() {
      try {
        const { unregisterAcpRuntimeBackend } = await import(/* @vite-ignore */ "openclaw/plugin-sdk/acpx" as string);
        unregisterAcpRuntimeBackend("acpx-remote");
      } catch {
        // Fallback: nothing to unregister
      }
      runtime = null;
      api.logger?.info("[acpx-remote] stopped");
    },
  };
}
