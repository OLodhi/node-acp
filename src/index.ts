#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Daemon } from "./daemon.js";
import { loadConfig } from "./config.js";
import { serializeMessage, deserializeMessage, type DaemonEvent } from "./ipc-protocol.js";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`acpx-node-daemon v0.1.0

Usage:
  acpx-node-daemon start                              Start the daemon
  acpx-node-daemon spawn --agent <agent> --cwd <path> Spawn a session
  acpx-node-daemon prompt <sessionId> <text>           Send a prompt
  acpx-node-daemon status <sessionId>                  Check session status
  acpx-node-daemon cancel <sessionId>                  Cancel current turn
  acpx-node-daemon close <sessionId>                   Close a session
  acpx-node-daemon stop                                Stop the daemon`);
  process.exit(0);
}

const config = loadConfig({});

if (command === "start") {
  const daemon = new Daemon(config);
  await daemon.start();

  const shutdown = async () => {
    console.log("\nShutting down...");
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  // Client commands — connect to running daemon
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
        console.log(JSON.stringify(event, null, 2));

        // Exit after terminal events
        if (
          event.type === "spawn_result" ||
          event.type === "status_result" ||
          event.type === "error" ||
          event.type === "session_closed" ||
          event.type === "prompt_complete"
        ) {
          client.destroy();
        }
      }
    });
  };

  switch (command) {
    case "spawn": {
      const agent = getFlag(args, "--agent") ?? config.defaultAgent;
      const cwd = getFlag(args, "--cwd");
      if (!cwd) {
        console.error("Error: --cwd is required");
        process.exit(1);
      }
      sendAndListen({
        type: "spawn",
        sessionId: randomUUID(),
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
      const prompt = args.slice(2).join(" ");
      if (!sessionId || !prompt) {
        console.error("Usage: acpx-node-daemon prompt <sessionId> <text>");
        process.exit(1);
      }
      sendAndListen({ type: "prompt", sessionId, prompt });
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
    case "stop":
      console.error("'stop' is not yet implemented. Kill the daemon process directly (Ctrl+C or SIGTERM).");
      process.exit(1);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
