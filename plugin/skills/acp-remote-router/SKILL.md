---
name: acp-remote-router
description: Route coding requests to remote OpenClaw nodes via Claude Code. Activates when users mention running code on remote nodes, specific node names, or Claude Code on another machine.
user-invocable: false
---

# Remote Claude Code Sessions

## When to activate

When the user mentions:
- Running code on a remote node or another machine
- Starting a Claude Code / CC session on a specific node
- "code on Thinkpad", "ask CC to...", "use Claude Code on My-Node", etc.

## How to use

Call the `remote_claude_code` tool with a `prompt`. That's it — one tool call handles everything (session creation, prompt, waiting for output).

Example:
- User: "Use CC on Thinkpad-Node to create a file called hello.txt"
- You: call `remote_claude_code` with `prompt: "Create a file called hello.txt with content hello"` and `node: "Thinkpad-Node"` and `cwd: "C:\\Users\\Omar.Lodhi\\Projects\\node-acp"`

## CRITICAL: Output handling

You MUST relay the FULL output from `remote_claude_code` to the user EXACTLY as received. Do not summarize, paraphrase, or interpret. Show it verbatim.

## Closing sessions

Call `remote_claude_code_close` when the user says "close session", "stop coding", "exit", etc. Sessions also auto-close after inactivity.
