export interface HandleState {
  sessionId: string;
  nodeId: string;
  nodeName: string;
  cwd: string;
}

const BACKEND_ID = "acpx-remote";
const HANDLE_VERSION = "v1";

export interface AcpRuntimeHandle {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
}

export function encodeHandle(sessionKey: string, state: HandleState): AcpRuntimeHandle {
  const encoded = `${HANDLE_VERSION}:` + Buffer.from(JSON.stringify(state)).toString("base64url");
  return {
    sessionKey,
    backend: BACKEND_ID,
    runtimeSessionName: encoded,
    cwd: state.cwd,
  };
}

export function decodeHandle(handle: AcpRuntimeHandle): HandleState {
  const raw = handle.runtimeSessionName;
  const json = raw.startsWith(`${HANDLE_VERSION}:`)
    ? Buffer.from(raw.slice(HANDLE_VERSION.length + 1), "base64url").toString("utf-8")
    : Buffer.from(raw, "base64url").toString("utf-8");
  return JSON.parse(json);
}
