import { AcpxRemoteRuntime } from "./runtime.js";
import { resolveConfig } from "./config.js";
import { NodeBridge } from "./node-bridge.js";

const plugin = {
  id: "acpx-remote",
  name: "Remote ACP Sessions",
  register(api: any) {
    const config = resolveConfig(api.pluginConfig);
    let bridge: NodeBridge;
    let runtime: AcpxRemoteRuntime;

    try {
      bridge = new NodeBridge(api.config, api.logger);
      runtime = new AcpxRemoteRuntime(config, bridge, api.logger);
    } catch (err: any) {
      api.logger?.error(`[acpx-remote] failed to initialize: ${err.message}`);
      return;
    }

    // Register tools directly in register() so they're visible to the agent
    runtime.registerTools(api);
    api.logger?.info("[acpx-remote] tools registered");

    // Also try ACP backend registration
    try {
      const sdk = require("openclaw/plugin-sdk/acpx");
      if (sdk?.registerAcpRuntimeBackend) {
        sdk.registerAcpRuntimeBackend({
          id: "acpx-remote",
          runtime,
          healthy: () => runtime.isHealthy(),
        });
        api.logger?.info("[acpx-remote] registered as ACP runtime backend");
      }
    } catch {
      // ACP backend not available
    }

    // Background probe
    runtime.probeAvailability().catch(() => {});
  },
};

export default plugin;
