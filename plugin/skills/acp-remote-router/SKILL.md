---
name: acp-remote-router
description: Route coding requests to remote OpenClaw nodes via Claude Code. Activates when users mention running code on remote nodes, specific node names, or Claude Code on another machine.
user-invocable: false
---

# Remote Claude Code Sessions

You have access to `remote_claude_code` — a tool that runs Claude Code on a remote machine via the acpx-node-daemon. This is the ONLY way to run Claude Code remotely.

## CRITICAL RULES

- ALWAYS use `remote_claude_code` for any request involving Claude Code on a remote node
- NEVER use `exec` to run `claude` CLI directly on the node
- NEVER use native ACP, `sessions_spawn`, or any other session mechanism
- NEVER try to install, start, or manage the daemon yourself — the tool handles this automatically
- NEVER fall back to PowerShell, cmd, or shell commands as an alternative

## When to use

- User asks to run Claude Code / CC on a remote machine or node
- User references a node by name (e.g. "on Thinkpad-Node", "on My-Server")
- User says "ask CC to...", "use Claude Code to...", "code on <node>..."
- User wants to start, continue, or close a remote coding session

## How to use

Call `remote_claude_code` with:
- `prompt` (required): The instruction for Claude Code
- `node` (optional): Node name — uses the configured default if omitted
- `cwd` (optional): Working directory on the node — defaults to home dir

That's it. One tool call handles everything: daemon detection, session creation, prompt delivery, waiting for output, and returning the result.

### Single question
User: "Ask CC on Thinkpad-Node what OS it's running"
→ Call `remote_claude_code` with `prompt: "What OS is this machine running?"` and `node: "Thinkpad-Node"`

### Multi-turn coding
User: "Use CC to fix the bug in auth.ts on Thinkpad-Node, cwd C:\Projects\myapp"
→ Call `remote_claude_code` with `prompt: "Fix the bug in auth.ts"`, `node: "Thinkpad-Node"`, `cwd: "C:\\Projects\\myapp"`

User: "Now add tests for that fix"
→ Call `remote_claude_code` with `prompt: "Add tests for the auth.ts fix"` (no need to specify node/cwd again — the session persists)

### Closing
User: "Close the CC session"
→ Call `remote_claude_code_close`

## Session behavior

- **First prompt**: ~12-15 seconds (cold start — process initializes)
- **Follow-up prompts**: ~2-4 seconds (process stays alive between prompts)
- **Idle timeout**: Process shuts down after ~15 min of inactivity to free memory, but the session stays alive — next prompt respawns automatically
- **Session timeout**: After 2 hours of total inactivity, session closes fully — user must start a new one

## Output handling

Relay the FULL output from `remote_claude_code` to the user EXACTLY as returned. Do not summarize, paraphrase, or interpret. Show it verbatim.

## Error handling

If `remote_claude_code` returns an error:
1. Show the error to the user
2. Ask if they want to retry
3. Do NOT attempt workarounds — no exec, no shell commands, no manual daemon management
