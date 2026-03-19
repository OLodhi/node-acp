import type { ChildPidRegistry } from "./child-pid-registry.js";
import type { PermissionProxy } from "./permission-proxy.js";
import type { DaemonEvent } from "./ipc-protocol.js";

export interface ISession {
  readonly sessionId: string;
  readonly status: "idle" | "busy";
  readonly pid: number | undefined;
  readonly resumeSessionId: string | undefined;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}

export interface SessionConfig {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: string;
  claudeBin: string;
  permissionProxy: PermissionProxy;
  emit: (event: DaemonEvent) => void;
  writer?: (line: string) => void;
  pidRegistry?: ChildPidRegistry;
  onActivity?: () => void;
  onSessionDead?: () => void;  // Called when persistent process exits while idle — daemon should close the session
}
