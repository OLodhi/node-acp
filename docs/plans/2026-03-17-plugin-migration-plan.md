# Implementation Plan: Plugin Migration

**Design:** `docs/specs/2026-03-17-plugin-migration-design.md`
**Estimated tasks:** 12
**Approach:** Each task is a self-contained, testable change. Tasks are ordered so each builds on the previous and the system remains functional throughout.

---

## Phase 1: Prepare the Daemon for Distribution

### Task 1: Make the daemon platform-agnostic and publishable

**Goal:** Remove all hard-coded paths, add daemon management flags, prepare for npm publish.

**Changes to `daemon/` (current `src/`):**

1. **`config.ts`**: Remove hard-coded model default. Accept `ACPX_MODEL`, `ACPX_PERMISSION_MODE`, `ACPX_SOCKET_PATH` env vars as overrides. Auto-detect home directory for default cwd.

2. **`index.ts`**: Add new CLI flags:
   - `--daemon` / `-d`: Detach from terminal. On Windows: spawn self with `detached: true` + `stdio: 'ignore'`, write PID to `~/.acpx-node-daemon.pid`, redirect logs to `~/.acpx-node-daemon.log`. On Unix: same via `nohup` or `fork()`.
   - `--version`: Print version from package.json and exit.
   - `--pid-file <path>`: Override PID file location.
   - `--log-file <path>`: Override log file location.
   - `status ping`: New subcommand — connect to daemon pipe, send a status request for a dummy session, if connection succeeds → print `{"alive":true}` and exit 0, if ENOENT → exit 1.
   - `stop`: Connect to daemon, send a shutdown signal (or read PID file and kill).

3. **`session.ts`**: Replace hard-coded `"claude"` spawn command with configurable `claudeBin` (default: `"claude"`, overridable via `ACPX_CLAUDE_BIN` env var).

4. **`package.json`**:
   - Set `name` to `acpx-node-daemon`
   - Set proper `version`, `description`, `author`, `license`, `repository`
   - Ensure `bin.acpx-node-daemon` points to `dist/index.js`
   - Add `files` field to include only `dist/` and `package.json`

5. **Test**: `npm pack` to verify the package contents. `npx acpx-node-daemon --version` works. `npx acpx-node-daemon start --daemon` starts in background and `npx acpx-node-daemon stop` kills it.

**Files:** `daemon/src/config.ts`, `daemon/src/index.ts`, `daemon/src/session.ts`, `daemon/package.json`

---

### Task 2: Restructure repo as monorepo

**Goal:** Move files into the final directory structure.

1. Create `daemon/` directory, move all current `src/`, `tests/`, `tsconfig.json`, `package.json` into it.
2. Create top-level `src/` for the gateway plugin code.
3. Create top-level `package.json` with workspace config (or keep them independent with a build script).
4. Create top-level `openclaw.plugin.json` manifest.
5. Create top-level `tsconfig.json` for the plugin.
6. Update `.gitignore` for both `daemon/dist/` and `dist/`.
7. Verify `cd daemon && npm test` still passes.
8. Verify `cd daemon && npm run build` still produces working daemon.

**Structure after this task:**
```
openclaw-acpx-remote/
├── openclaw.plugin.json
├── package.json              ← plugin package
├── tsconfig.json             ← plugin tsconfig
├── src/                      ← plugin source (empty for now)
├── skills/
│   └── acp-remote-router/
│       └── SKILL.md
├── daemon/
│   ├── package.json          ← acpx-node-daemon package
│   ├── tsconfig.json
│   ├── src/
│   ├── tests/
│   └── dist/
└── docs/
```

---

## Phase 2: Build the Plugin Shell

### Task 3: Create NodeBridge (proper gateway RPC)

**Goal:** Replace the `createRequire` hack with proper SDK imports for `callGateway`.

1. Create `src/node-bridge.ts`:
   - Try importing `callGateway` from `"openclaw/plugin-sdk/gateway/call"`.
   - If that doesn't resolve at runtime, fallback: use `createRequire` to resolve `openclaw` package and find the gateway call export dynamically (scan exports instead of using a minified symbol name).
   - Implement `NodeBridge` class with:
     - `constructor(api: OpenClawPluginApi)` — extract auth token from `api.config`
     - `resolveNode(displayName: string): Promise<string>` — call `node.list`, cache result
     - `exec(nodeId: string, argv: string[], opts?): Promise<ExecResult>` — call `node.invoke` → `system.run`

2. Write integration test: create NodeBridge, call `resolveNode("Thinkpad-Node")`, verify it returns a node ID.

3. Write unit test: mock callGateway, verify exec() builds correct params.

**Files:** `src/node-bridge.ts`, `tests/node-bridge.test.ts`

**Risk:** The `callGateway` import path may not work. If blocked, document the issue and use the cleanest possible fallback (dynamic require with export scanning instead of hardcoded `oc.Ks`).

---

### Task 4: Create plugin entry and service lifecycle

**Goal:** Register as an ACP runtime backend.

1. Create `src/index.ts` — plugin definition with `register(api)` calling `api.registerService()`.
2. Create `src/service.ts` — service with `start()` and `stop()`:
   - `start()`: Create `AcpxRemoteRuntime`, call `registerAcpRuntimeBackend({ id: "acpx-remote", runtime, healthy })`.
   - `stop()`: Call `unregisterAcpRuntimeBackend("acpx-remote")`.
3. Create `src/config.ts` — resolve plugin config with defaults.
4. Create `openclaw.plugin.json` with config schema and UI hints.
5. Update top-level `package.json` with `"openclaw": { "extensions": ["./src/index.ts"] }`.

**Files:** `src/index.ts`, `src/service.ts`, `src/config.ts`, `openclaw.plugin.json`, `package.json`

**Test:** Load plugin in OpenClaw (add to `plugins.load.paths`), verify `[acpx-remote] runtime registered` in logs.

---

### Task 5: Implement AcpxRemoteRuntime (ensureSession + close + cancel)

**Goal:** Implement the non-polling parts of AcpRuntime.

1. Create `src/runtime.ts` — `AcpxRemoteRuntime implements AcpRuntime`:
   - `ensureSession(input)`: Call `NodeBridge.exec` to run `acpx-node-daemon spawn --session-id <uuid> --cwd <cwd>`. Return `AcpRuntimeHandle` with encoded state.
   - `cancel(input)`: Decode handle, call `acpx-node-daemon cancel <sessionId>`.
   - `close(input)`: Decode handle, call `acpx-node-daemon close <sessionId>`.
   - `getStatus(input)`: Call `acpx-node-daemon status <sessionId>`, parse response.
   - `doctor()`: Call `acpx-node-daemon --version` on the default node. Report health.

2. Create `src/handle.ts` — encode/decode handle state (`sessionId`, `nodeId`, `cwd`) as base64url JSON in `runtimeSessionName`.

**Files:** `src/runtime.ts`, `src/handle.ts`

**Test:** SSH into gateway, restart OpenClaw, use `/acp spawn` to create a remote session.

---

### Task 6: Implement runTurn with poll loop

**Goal:** The core prompt flow — send prompt, drain poll, yield events.

1. Create `src/poll-loop.ts` — extracted async generator:
   - Same logic as current `runtime.ts` `pollLoop()` but refactored to yield `AcpRuntimeEvent` types directly (not the custom `AcpRuntimeEvent` we defined — the real SDK types).
   - Auto-approve permissions inline.
   - Detect daemon-down, session-lost, timeout.

2. In `src/runtime.ts`, implement `runTurn(input)`:
   - Base64-encode prompt text.
   - Call `acpx-node-daemon prompt <sessionId> --async --text-b64 <encoded>`.
   - Parse `prompt_accepted` response.
   - Yield events from `pollLoop()`.

3. Map daemon events to `AcpRuntimeEvent`:
   - `output(assistant_text)` → `{ type: "text_delta", text, stream: "output", tag: "agent_message_chunk" }`
   - `output(tool_use)` → `{ type: "tool_call", text, tag: "tool_call" }`
   - `prompt_complete(end_turn)` → `{ type: "done", stopReason: "end_turn" }`
   - `prompt_complete(error)` → `{ type: "error", message: "..." }`
   - `error` → `{ type: "error", message: "..." }`

**Files:** `src/poll-loop.ts`, `src/runtime.ts` (update)

**Test:** From Telegram, send a coding prompt. Verify output streams back correctly.

---

## Phase 3: Auto-Deploy and Auto-Start

### Task 7: Implement DaemonManager

**Goal:** Automatically install and start the daemon on nodes.

1. Create `src/daemon-manager.ts`:
   - `ensureDaemonReady(nodeId, bridge)`:
     1. Ping daemon (`acpx-node-daemon status ping`) → if alive, return.
     2. Check installed (`acpx-node-daemon --version`) → if not found, install.
     3. Install: `npm install -g acpx-node-daemon` (with 120s timeout).
     4. Start: `acpx-node-daemon start --daemon` (background).
     5. Wait: retry ping up to 10 times with 1s delay.
   - Track per-node status to avoid redundant checks.
   - Respect `config.autoDeployDaemon` flag — if false, skip install step and error if not found.

2. Wire into `runtime.ts` — call `daemonManager.ensureDaemonReady()` at the start of `ensureSession()`.

**Files:** `src/daemon-manager.ts`, `src/runtime.ts` (update)

**Test:** Remove daemon from node, trigger a session — verify it auto-installs and starts.

---

### Task 8: Publish daemon to npm

**Goal:** `npm install -g acpx-node-daemon` works on any machine.

1. Finalize `daemon/package.json`:
   - Name: `acpx-node-daemon`
   - Version: `0.2.0` (breaking change from standalone to distributable)
   - Bin: `{ "acpx-node-daemon": "dist/index.js" }`
   - Files: `["dist/", "package.json", "README.md"]`
   - Remove `@anthropic-ai/claude-agent-sdk` from dependencies (no longer used — we spawn CLI directly)

2. Build: `cd daemon && npm run build`

3. Test locally: `npm pack`, then `npm install -g ./acpx-node-daemon-0.2.0.tgz` on the Thinkpad. Verify `acpx-node-daemon --version` and `acpx-node-daemon start` work.

4. Publish: `cd daemon && npm publish` (or `npm publish --access public` for scoped packages).

**Files:** `daemon/package.json`, `daemon/README.md`

---

## Phase 4: Polish and Distribution

### Task 9: Update skill definition

**Goal:** Replace custom tool routing with ACP-native routing.

1. Rewrite `skills/acp-remote-router/SKILL.md`:
   - Remove references to custom tools (`node_acp_spawn`, etc.)
   - Reference the standard `/acp` commands
   - Keep the instruction to relay output verbatim
   - Add instructions for when to route to remote vs local

2. Update `openclaw.plugin.json` to reference the skill.

**Files:** `skills/acp-remote-router/SKILL.md`, `openclaw.plugin.json`

---

### Task 10: Remove old code and clean up

**Goal:** Remove the legacy gateway-plugin directory and old tool registrations.

1. Delete `gateway-plugin/` directory from the repo (replaced by top-level `src/`).
2. Remove any remaining hard-coded paths in daemon code.
3. Remove `@anthropic-ai/claude-agent-sdk` dependency from daemon (replaced by CLI spawn).
4. Update root `.gitignore`.
5. Run full test suite in `daemon/`.
6. Verify plugin loads cleanly on the gateway.

**Files:** Various cleanup

---

### Task 11: Write user documentation

**Goal:** A README that a new user can follow to install and configure the plugin.

1. Rewrite `README.md` focused on the user experience:
   - What it does (1 paragraph)
   - Prerequisites (OpenClaw gateway, a paired node, Claude Code CLI on the node)
   - Install: `openclaw plugins install openclaw-acpx-remote`
   - Configure: Show the minimal `openclaw.json` config
   - Usage: Send a message via Telegram
   - Troubleshooting: Common issues and fixes
   - Advanced: Custom model, permission modes, daemon management

2. Add `daemon/README.md` for the daemon npm package (minimal — just what it is, how to install, how to start).

**Files:** `README.md`, `daemon/README.md`

---

### Task 12: Publish plugin to npm

**Goal:** `openclaw plugins install openclaw-acpx-remote` works.

1. Finalize top-level `package.json`:
   - Name: `openclaw-acpx-remote`
   - Version: `1.0.0`
   - Add `peerDependencies: { "openclaw": ">=2026.2.0" }`
   - Files: `["dist/", "openclaw.plugin.json", "skills/", "package.json", "README.md"]`

2. Build: `npm run build`

3. Test: `npm pack`, then `openclaw plugins install ./openclaw-acpx-remote-1.0.0.tgz` on the gateway. Verify plugin loads and creates sessions.

4. Publish: `npm publish`

5. Test end-to-end: `openclaw plugins install openclaw-acpx-remote` on a clean gateway. Configure. Send Telegram message. Verify full flow.

**Files:** `package.json`

---

## Task Dependency Graph

```
Phase 1 (Daemon prep)
  Task 1: Make daemon publishable
  Task 2: Restructure repo
    ↓
Phase 2 (Plugin shell)
  Task 3: NodeBridge ──────────┐
  Task 4: Plugin entry ────────┤
  Task 5: Runtime (non-poll) ──┤
  Task 6: runTurn + poll loop ─┘
    ↓
Phase 3 (Auto-deploy)
  Task 7: DaemonManager
  Task 8: Publish daemon to npm
    ↓
Phase 4 (Polish)
  Task 9: Update skill
  Task 10: Clean up legacy
  Task 11: User docs
  Task 12: Publish plugin to npm
```

## Rollback Strategy

Throughout the migration, the existing system (standalone daemon + custom tools) continues to work. The new plugin registers as a separate backend (`acpx-remote`), so it doesn't conflict with the current setup. To rollback:

1. Set `acp.backend` back to `"acpx"` in `openclaw.json`
2. Re-enable the old `acpx-remote` plugin entry with custom tools
3. Start the daemon manually as before

The old code is preserved in git history and can be restored at any point.
