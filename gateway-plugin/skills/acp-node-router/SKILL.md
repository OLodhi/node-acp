---
name: acp-node-router
description: Route coding session requests to remote OpenClaw nodes. Use node_acp_spawn, node_acp_prompt, and node_acp_close tools to manage Claude Code sessions on remote nodes like Thinkpad-Node.
user-invocable: false
---

# Remote ACP Session Routing

## When to activate

Activate when the user mentions any of:
- Starting a coding session on a specific node or remote machine
- References to "Thinkpad", "Thinkpad-Node", or other node names for coding tasks
- "spawn a session on node", "code on node", "start Claude Code on Thinkpad"
- Explicitly mentions node_acp tools

## Available tools

- **node_acp_spawn** — Start a Claude Code session on a remote node
- **node_acp_prompt** — Send a prompt and get verbatim output (auto-approves permissions)
- **node_acp_close** — End the session

## CRITICAL: Output handling

**You MUST relay the FULL output from node_acp_prompt to the user EXACTLY as returned.** Do not summarize, paraphrase, or interpret the output. Show it verbatim. The user wants to see exactly what Claude Code produced.

If the output includes `[Permission auto-approved: ...]` lines, include those too — the user wants to see what permissions were granted.

If the output includes `[Tool: ...]` lines, include those — the user wants to see what tools Claude Code used.

## Spawning a session

1. Call `node_acp_spawn` with `node` and `cwd` parameters
2. Store the returned `sessionId`
3. Tell the user the session ID and that it's ready

## Sending prompts

1. Call `node_acp_prompt` with `sessionId`, `node`, and the user's message as `text`
2. The tool auto-approves all permission requests (file writes, bash commands, etc.)
3. **Show the FULL returned output to the user verbatim**

## Closing a session

When the user says "exit", "close", "stop coding", or similar:
1. Call `node_acp_close` with the `sessionId`

## Error handling

| Error | Response |
|-------|----------|
| "Session not found" | "Session expired or was lost. Start a new one with node_acp_spawn." |
| "Daemon is not running" | "The daemon on the node is down. It needs to be restarted." |
| "node not connected" | "The node is offline." |
| "Session is busy" | "Claude Code is still working on the previous prompt. Wait for it to finish." |
