#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { Daemon } from "./daemon.js";
import { loadConfig } from "./config.js";
import { serializeMessage, deserializeMessage, type DaemonEvent } from "./ipc-protocol.js";

const VERSION = "0.2.0";

const args = process.argv.slice(2);
const command = args[0];

// --version flag
if (command === "--version" || command === "-V") {
  console.log(VERSION);
  process.exit(0);
}

if (!command || command === "--help" || command === "-h") {
  console.log(`acpx-node-daemon v${VERSION}

Usage:
  acpx-node-daemon start [--daemon]                               Start the daemon
  acpx-node-daemon stop                                            Stop the daemon
  acpx-node-daemon spawn --cwd <path> [--session-id <uuid>]       Spawn a session
  acpx-node-daemon prompt <sessionId> [--text-b64 <b64>] [--async] [text...]  Send a prompt
  acpx-node-daemon drain <sessionId>                               Drain buffered events
  acpx-node-daemon status ping                                     Check if daemon is alive
  acpx-node-daemon status <sessionId>                              Check session status
  acpx-node-daemon cancel <sessionId>                              Cancel current turn
  acpx-node-daemon close <sessionId>                               Close a session
  acpx-node-daemon permission-response <sid> <pid> <true|false>    Respond to permission
  acpx-node-daemon --version                                       Print version

Environment:
  ACPX_MODEL              Override default model
  ACPX_PERMISSION_MODE    Override permission mode
  ACPX_SOCKET_PATH        Override IPC socket path
  ACPX_CLAUDE_BIN         Override claude binary name/path`);
  process.exit(0);
}

const config = loadConfig({});
const pidFile = getFlag(args, "--pid-file") ?? join(homedir(), ".acpx-node-daemon.pid");
const logFile = getFlag(args, "--log-file") ?? join(homedir(), ".acpx-node-daemon.log");

if (command === "start") {
  const isDaemon = args.includes("--daemon") || args.includes("-d");

  if (isDaemon) {
    // Spawn self detached and exit
    const selfArgs = process.argv.slice(1).filter((a) => a !== "--daemon" && a !== "-d");
    const child = spawnChild(process.execPath, selfArgs, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    child.unref();

    if (child.pid) {
      writeFileSync(pidFile, String(child.pid));
      console.log(JSON.stringify({ pid: child.pid, pidFile, socketPath: config.ipcSocketPath }));
    }
    process.exit(0);
  }

  // Foreground start
  const daemon = new Daemon(config);
  await daemon.start();

  // Write PID file
  writeFileSync(pidFile, String(process.pid));

  const shutdown = async () => {
    console.log("\nShutting down...");
    await daemon.stop();
    try { unlinkSync(pidFile); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === "stop") {
  // Read PID file and kill
  if (!existsSync(pidFile)) {
    console.error(`No PID file found at ${pidFile}. Is the daemon running?`);
    process.exit(1);
  }
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    console.error(`Invalid PID in ${pidFile}`);
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(JSON.stringify({ stopped: true, pid }));
    try { unlinkSync(pidFile); } catch {}
  } catch (err: any) {
    if (err.code === "ESRCH") {
      console.error(`Process ${pid} not found (already stopped?)`);
      try { unlinkSync(pidFile); } catch {}
    } else {
      console.error(`Failed to stop daemon (pid ${pid}): ${err.message}`);
    }
    process.exit(1);
  }
} else {
  // Client commands — connect to running daemon

  // Special case: status ping — just check if daemon is reachable
  if (command === "status" && args[1] === "ping") {
    const client = createConnection(config.ipcSocketPath);
    client.on("connect", () => {
      console.log(JSON.stringify({ alive: true }));
      client.destroy();
      process.exit(0);
    });
    client.on("error", () => {
      console.log(JSON.stringify({ alive: false }));
      process.exit(1);
    });
  } else {
    const client = createConnection(config.ipcSocketPath);

    client.on("error", (err) => {
      console.error(`Cannot connect to daemon: ${err.message}`);
      console.error("Is the daemon running? Start it with: acpx-node-daemon start");
      process.exit(1);
    });

    await new Promise<void>((resolve) => client.on("connect", resolve));

    const sendAndListen = (msg: any) => {
      client.write(serializeMessage(msg));

      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = deserializeMessage(line) as DaemonEvent;

          // Special handling for drain_result: print inner events as ndjson
          if (event.type === "drain_result" && "events" in event) {
            const drainResult = event as any;
            for (const inner of drainResult.events) {
              console.log(JSON.stringify(inner));
            }
            if (drainResult.hasMore) {
              console.log(JSON.stringify({ type: "has_more" }));
            }
            client.destroy();
            return;
          }

          console.log(JSON.stringify(event));

          // Exit after terminal events
          if (
            event.type === "spawn_result" ||
            event.type === "status_result" ||
            event.type === "error" ||
            event.type === "session_closed" ||
            event.type === "prompt_complete" ||
            event.type === "cancel_accepted" ||
            event.type === "permission_response_result"
          ) {
            client.destroy();
          }
        }
      });
    };

    switch (command) {
      case "spawn": {
        const agent = getFlag(args, "--agent") ?? config.defaultAgent;
        const cwd = getFlag(args, "--cwd") ?? config.defaultCwd;
        sendAndListen({
          type: "spawn",
          sessionId: getFlag(args, "--session-id") ?? randomUUID(),
          agent,
          cwd,
          model: getFlag(args, "--model") ?? config.defaultModel,
          permissionMode: config.defaultPermissionMode,
          timeoutMinutes: config.defaultTtlMinutes,
        });
        break;
      }
      case "prompt": {
        const sessionId = args[1];
        if (!sessionId) {
          console.error("Usage: acpx-node-daemon prompt <sessionId> [--text-b64 <b64>] [--async] [text...]");
          process.exit(1);
        }

        const textB64 = getFlag(args, "--text-b64");
        let prompt: string;
        if (textB64) {
          prompt = Buffer.from(textB64, "base64").toString("utf-8");
        } else {
          const textArgs = args.slice(2).filter((a) => a !== "--async" && a !== "--text-b64");
          prompt = textArgs.join(" ");
        }

        if (!prompt) {
          console.error("Error: prompt text required (positional args or --text-b64)");
          process.exit(1);
        }

        const isAsync = args.includes("--async");

        if (isAsync) {
          client.write(serializeMessage({ type: "prompt", sessionId, prompt }));
          let buf = "";
          client.on("data", (data) => {
            buf += data.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = deserializeMessage(line) as DaemonEvent;
              console.log(JSON.stringify(event));
              if (event.type === "prompt_accepted" || event.type === "error") {
                client.destroy();
              }
            }
          });
        } else {
          sendAndListen({ type: "prompt", sessionId, prompt });
        }
        break;
      }
      case "status": {
        const sessionId = args[1];
        if (!sessionId) { console.error("Usage: acpx-node-daemon status <sessionId>"); process.exit(1); }
        sendAndListen({ type: "status", sessionId });
        break;
      }
      case "cancel": {
        const sessionId = args[1];
        if (!sessionId) { console.error("Usage: acpx-node-daemon cancel <sessionId>"); process.exit(1); }
        sendAndListen({ type: "cancel", sessionId });
        break;
      }
      case "close": {
        const sessionId = args[1];
        if (!sessionId) { console.error("Usage: acpx-node-daemon close <sessionId>"); process.exit(1); }
        sendAndListen({ type: "close", sessionId });
        break;
      }
      case "drain": {
        const sessionId = args[1];
        if (!sessionId) {
          console.error("Usage: acpx-node-daemon drain <sessionId>");
          process.exit(1);
        }
        sendAndListen({ type: "drain", sessionId });
        break;
      }
      case "permission-response": {
        const sessionId = args[1];
        const permissionId = args[2];
        const approved = args[3];
        if (!sessionId || !permissionId || !approved) {
          console.error("Usage: acpx-node-daemon permission-response <sessionId> <permissionId> <true|false>");
          process.exit(1);
        }
        sendAndListen({
          type: "permission_response",
          sessionId,
          permissionId,
          approved: approved === "true",
        });
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
