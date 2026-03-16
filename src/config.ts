export interface DaemonConfig {
  maxConcurrentSessions: number;
  defaultAgent: string;
  defaultModel: string;
  defaultPermissionMode: string;
  defaultTtlMinutes: number;
  permissionTimeoutMinutes: number;
  ipcSocketPath: string;
}

const DEFAULT_SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\acpx-node-daemon"
    : "/tmp/acpx-node-daemon.sock";

export function loadConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  return {
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
    defaultAgent: overrides.defaultAgent ?? "claude",
    defaultModel: overrides.defaultModel ?? "claude-opus-4-6",
    defaultPermissionMode: overrides.defaultPermissionMode ?? "default",
    defaultTtlMinutes: overrides.defaultTtlMinutes ?? 120,
    permissionTimeoutMinutes: overrides.permissionTimeoutMinutes ?? 30,
    ipcSocketPath: overrides.ipcSocketPath ?? DEFAULT_SOCKET_PATH,
  };
}
