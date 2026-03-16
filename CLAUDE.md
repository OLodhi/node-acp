# acpx-node-daemon

Remote ACP session dispatch for OpenClaw nodes.

## Build & Test
- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run dev` — watch mode

## Architecture
- IPC protocol: newline-delimited JSON over named pipes (Windows) / Unix sockets
- Sessions wrap Claude Agent SDK `query()` for Claude Code lifecycle
- Output streams via OutputForwarder mapping SDK messages to daemon events
- Permissions proxied via PermissionProxy with 30-minute timeout
- See docs/specs/2026-03-16-node-acp-design.md for full spec
- See docs/specs/2026-03-16-agent-sdk-integration-design.md for SDK integration spec

## Dependencies
- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK
- Claude Code CLI must be installed on the host machine
