export interface AcpxRemoteConfig {
  defaultNode: string;
  model: string;
  permissionMode: string;
  pollIntervalMs: number;
  autoDeployDaemon: boolean;
  sessionTimeoutMinutes: number;
  maxConcurrentSessions: number;
}

export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): AcpxRemoteConfig {
  return {
    defaultNode: (pluginConfig?.defaultNode as string) ?? "",
    model: (pluginConfig?.model as string) ?? "claude-sonnet-4-6",
    permissionMode: (pluginConfig?.permissionMode as string) ?? "bypassPermissions",
    pollIntervalMs: (pluginConfig?.pollIntervalMs as number) ?? 2000,
    autoDeployDaemon: (pluginConfig?.autoDeployDaemon as boolean) ?? true,
    sessionTimeoutMinutes: (pluginConfig?.sessionTimeoutMinutes as number) ?? 120,
    maxConcurrentSessions: (pluginConfig?.maxConcurrentSessions as number) ?? 4,
  };
}
