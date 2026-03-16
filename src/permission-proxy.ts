import { randomUUID } from "node:crypto";
import type { DaemonEvent, PermissionRequestEvent } from "./ipc-protocol.js";

interface PendingPermission {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class PermissionProxy {
  private pending = new Map<string, Map<string, PendingPermission>>();

  constructor(
    private timeoutMinutes: number,
    private emit: (event: DaemonEvent) => void
  ) {}

  async requestPermission(
    sessionId: string,
    operation: string,
    path: string,
    description: string
  ): Promise<boolean> {
    const permissionId = randomUUID();

    if (!this.pending.has(sessionId)) {
      this.pending.set(sessionId, new Map());
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.get(sessionId)?.delete(permissionId);
        resolve(false);
      }, this.timeoutMinutes * 60 * 1000);

      this.pending.get(sessionId)!.set(permissionId, { resolve, timeout });

      const event: PermissionRequestEvent = {
        type: "permission_request",
        sessionId,
        permissionId,
        operation,
        path,
        description,
      };
      this.emit(event);
    });
  }

  handleResponse(sessionId: string, permissionId: string, approved: boolean): void {
    const sessionPerms = this.pending.get(sessionId);
    if (!sessionPerms) return;

    const pending = sessionPerms.get(permissionId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    sessionPerms.delete(permissionId);
    pending.resolve(approved);
  }

  cleanupSession(sessionId: string): void {
    const sessionPerms = this.pending.get(sessionId);
    if (!sessionPerms) return;

    for (const [, pending] of sessionPerms) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pending.delete(sessionId);
  }
}
