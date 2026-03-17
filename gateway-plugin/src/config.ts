export interface AcpxRemoteConfig {
  pollIntervalMs: number;
  daemonBin: string;
  defaultNode: string;
}

export const DEFAULT_CONFIG: AcpxRemoteConfig = {
  pollIntervalMs: 1500,
  daemonBin: "acpx-node-daemon",
  defaultNode: "",
};

export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): AcpxRemoteConfig {
  return {
    pollIntervalMs: (pluginConfig?.pollIntervalMs as number) ?? DEFAULT_CONFIG.pollIntervalMs,
    daemonBin: (pluginConfig?.daemonBin as string) ?? DEFAULT_CONFIG.daemonBin,
    defaultNode: (pluginConfig?.defaultNode as string) ?? DEFAULT_CONFIG.defaultNode,
  };
}
