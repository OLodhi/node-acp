# acpx-node-daemon

Remote ACP session dispatch for OpenClaw nodes.

## Build & Test
- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run dev` — watch mode

## Architecture
- IPC protocol: newline-delimited JSON over named pipes (Windows) / Unix sockets
- Sessions wrap ACPX queue owner for Claude Code lifecycle
- See docs/specs/2026-03-16-node-acp-design.md for full spec
