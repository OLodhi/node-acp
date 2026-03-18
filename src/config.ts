import { homedir } from "node:os";

export interface DaemonConfig {
  maxConcurrentSessions: number;
  defaultAgent: string;
  defaultModel: string;
  defaultPermissionMode: string;
  defaultTtlMinutes: number;
  permissionTimeoutMinutes: number;
  maxBufferedEvents: number;
  ipcSocketPath: string;
  claudeBin: string;
  defaultCwd: string;
  uiEnabled: boolean;
  uiPort: number;
  sessionMode: "persistent" | "ephemeral";
  processIdleMinutes: number;
}

const DEFAULT_SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\acpx-node-daemon"
    : "/tmp/acpx-node-daemon.sock";

export function loadConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  return {
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
    defaultAgent: overrides.defaultAgent ?? "claude",
    defaultModel: process.env.ACPX_MODEL ?? overrides.defaultModel ?? "",
    defaultPermissionMode: process.env.ACPX_PERMISSION_MODE ?? overrides.defaultPermissionMode ?? "bypassPermissions",
    defaultTtlMinutes: overrides.defaultTtlMinutes ?? 120,
    permissionTimeoutMinutes: overrides.permissionTimeoutMinutes ?? 30,
    maxBufferedEvents: overrides.maxBufferedEvents ?? 500,
    ipcSocketPath: process.env.ACPX_SOCKET_PATH ?? overrides.ipcSocketPath ?? DEFAULT_SOCKET_PATH,
    claudeBin: process.env.ACPX_CLAUDE_BIN ?? overrides.claudeBin ?? "claude",
    defaultCwd: overrides.defaultCwd ?? homedir(),
    uiEnabled: overrides.uiEnabled ?? false,
    uiPort: parseInt(process.env.ACPX_UI_PORT ?? String(overrides.uiPort ?? 19100), 10),
    sessionMode: (process.env.ACPX_SESSION_MODE as any) ?? overrides.sessionMode ?? "persistent",
    processIdleMinutes: overrides.processIdleMinutes ?? 15,
  };
}
