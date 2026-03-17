export interface HandleState {
  sessionId: string;
  node: string;
  cwd: string;
}

export interface AcpRuntimeHandle {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
}

const BACKEND_ID = "acpx-remote";

export function encodeHandle(sessionKey: string, state: HandleState): AcpRuntimeHandle {
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64url");
  return {
    sessionKey,
    backend: BACKEND_ID,
    runtimeSessionName: encoded,
    cwd: state.cwd,
  };
}

export function decodeHandle(handle: AcpRuntimeHandle): HandleState {
  return JSON.parse(Buffer.from(handle.runtimeSessionName, "base64url").toString("utf-8"));
}
