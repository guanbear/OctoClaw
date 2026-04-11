/**
 * Node.js bridge script for persistent stdio communication.
 *
 * Reads JSON lines from stdin, dispatches to the corresponding method,
 * and writes JSON lines back to stdout.
 *
 * Protocol:
 *   Request:  {"id": N, "method": "...", "args": {...}}
 *   Response: {"id": N, "result": {...}} or {"id": N, "error": "..."}
 */

import { __octoclawTest } from "./index.js";
import * as readline from "node:readline";

const methods = {
  inferRoute: (args) =>
    __octoclawTest.inferRouteWithConversationContext(
      args.task,
      args.command,
      args.metadata,
    ),
};

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    // Malformed input – skip silently.
    return;
  }

  const { id, method, args } = req;

  try {
    const fn = methods[method];
    if (!fn) {
      throw new Error(`Unknown method: ${method}`);
    }
    const result = await fn(args || {});
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  } catch (e) {
    const error = e && typeof e === "object" && "message" in e ? e.message : String(e);
    process.stdout.write(JSON.stringify({ id, error }) + "\n");
  }
});

// Keep the process alive – readline handles the stdin lifecycle.
