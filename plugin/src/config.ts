export interface AcpxRemoteConfig {
  defaultNode: string;
  model: string;
  permissionMode: string;
  pollIntervalMs: number;
  autoDeployDaemon: boolean;
  sessionTimeoutMinutes: number;
  maxConcurrentSessions: number;
  daemonBin: string[];
  daemonStartArgs: string[];
  sessionMode: "persistent" | "ephemeral";
}

export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): AcpxRemoteConfig {
  // daemonBin can be a string like "node C:/path/to/dist/index.js" or just "acpx-node-daemon"
  const rawBin = (pluginConfig?.daemonBin as string) ?? "acpx-node-daemon";
  const daemonBin = rawBin.split(" ");

  // Extra args passed to `start` command (e.g. ["--ui", "--port", "19100"])
  const rawStartArgs = pluginConfig?.daemonStartArgs;
  const daemonStartArgs = Array.isArray(rawStartArgs)
    ? rawStartArgs.map(String)
    : typeof rawStartArgs === "string"
      ? rawStartArgs.split(" ").filter(Boolean)
      : ["--ui"]; // Default: enable web UI for observability

  return {
    defaultNode: (pluginConfig?.defaultNode as string) ?? "",
    model: (pluginConfig?.model as string) ?? "claude-sonnet-4-6",
    permissionMode: (pluginConfig?.permissionMode as string) ?? "bypassPermissions",
    pollIntervalMs: (pluginConfig?.pollIntervalMs as number) ?? 2000,
    autoDeployDaemon: (pluginConfig?.autoDeployDaemon as boolean) ?? true,
    sessionTimeoutMinutes: (pluginConfig?.sessionTimeoutMinutes as number) ?? 120,
    maxConcurrentSessions: (pluginConfig?.maxConcurrentSessions as number) ?? 4,
    daemonBin,
    daemonStartArgs,
    sessionMode: (pluginConfig?.sessionMode as string as any) ?? "persistent",
  };
}
