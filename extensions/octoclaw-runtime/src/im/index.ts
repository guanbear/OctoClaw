import { SlackAdapter } from "./slack/index.js";
import type { SlackAdapterConfig } from "./slack/index.js";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

const adapters = new Map<string, SlackAdapter>();

function readSlackReplyToMode(): "off" | "first" | "all" {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(fsSync.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const channels = raw.channels as Record<string, unknown> | undefined;
    const slack = channels?.slack as Record<string, unknown> | undefined;
    const mode = String(slack?.replyToMode || "off").toLowerCase();
    if (mode === "first" || mode === "all") return mode;
    return "off";
  } catch {
    return "off";
  }
}

function buildSlackAdapterConfig(): Partial<SlackAdapterConfig> {
  return { replyToMode: readSlackReplyToMode() };
}

export function getAdapterForSession(sessionKey: string): SlackAdapter | null {
  const lower = sessionKey.toLowerCase();
  if (lower.includes(":slack:")) {
    if (!adapters.has("slack")) {
      adapters.set("slack", new SlackAdapter(buildSlackAdapterConfig()));
    }
    return adapters.get("slack")!;
  }
  return null;
}

export { SlackAdapter } from "./slack/index.js";
export type { SlackAdapterConfig } from "./slack/index.js";
