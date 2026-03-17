---
name: acp-remote-router
description: Route coding session requests to remote OpenClaw nodes via the acpx-remote ACP backend. Activates when users mention running code on remote nodes or specific node names.
user-invocable: false
---

# Remote ACP Session Routing

## When to activate

When the user mentions:
- Running code on a remote node or another machine
- Starting a coding/Claude Code session on a specific node name
- "code on Thinkpad", "start session on My-Node", etc.

## How it works

The acpx-remote backend registers as an ACP runtime. Use standard ACP commands — the backend handles remote session lifecycle automatically, including daemon deployment and startup on the target node.

## CRITICAL: Output handling

You MUST relay the FULL output from Claude Code to the user EXACTLY as received. Do not summarize, paraphrase, or interpret the output. Show it verbatim.
