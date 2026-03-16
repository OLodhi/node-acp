// --- Inbound: node host → daemon ---

export interface SpawnRequest {
  type: "spawn";
  sessionId: string;
  agent: string;
  cwd: string;
  model: string;
  permissionMode: string;
  timeoutMinutes: number;
}

export interface PromptRequest {
  type: "prompt";
  sessionId: string;
  prompt: string;
}

export interface CancelRequest {
  type: "cancel";
  sessionId: string;
}

export interface CloseRequest {
  type: "close";
  sessionId: string;
}

export interface StatusRequest {
  type: "status";
  sessionId: string;
}

export interface PermissionResponseRequest {
  type: "permission_response";
  sessionId: string;
  permissionId: string;
  approved: boolean;
}

export type DaemonRequest =
  | SpawnRequest
  | PromptRequest
  | CancelRequest
  | CloseRequest
  | StatusRequest
  | PermissionResponseRequest;

// --- Outbound: daemon → node host ---

export interface SpawnResultEvent {
  type: "spawn_result";
  sessionId: string;
  success: boolean;
  pid?: number;
  error?: string;
}

export interface PromptAcceptedEvent {
  type: "prompt_accepted";
  sessionId: string;
}

export interface OutputEvent {
  type: "output";
  sessionId: string;
  messageType: string;
  chunk: string;
  timestamp: number;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  sessionId: string;
  permissionId: string;
  operation: string;
  path: string;
  description: string;
}

export interface PromptCompleteEvent {
  type: "prompt_complete";
  sessionId: string;
  stopReason: string;
}

export interface ErrorEvent {
  type: "error";
  sessionId: string;
  error: string;
}

export interface SessionClosedEvent {
  type: "session_closed";
  sessionId: string;
  reason: string;
}

export interface StatusResultEvent {
  type: "status_result";
  sessionId: string;
  status: string;
  agent: string;
  cwd: string;
  model: string;
  pid: number;
  createdAt: number;
  lastActivityAt: number;
}

export type DaemonEvent =
  | SpawnResultEvent
  | PromptAcceptedEvent
  | OutputEvent
  | PermissionRequestEvent
  | PromptCompleteEvent
  | ErrorEvent
  | SessionClosedEvent
  | StatusResultEvent;

// --- Serialization ---

export function serializeMessage(msg: DaemonRequest | DaemonEvent): string {
  return JSON.stringify(msg) + "\n";
}

export function deserializeMessage(line: string): DaemonRequest | DaemonEvent {
  const trimmed = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON: ${trimmed.slice(0, 100)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error(`Message missing 'type' field: ${trimmed.slice(0, 100)}`);
  }
  return parsed as DaemonRequest | DaemonEvent;
}
