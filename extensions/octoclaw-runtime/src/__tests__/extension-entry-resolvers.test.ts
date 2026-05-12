import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPromptContextProjection, extractInboundMessageTimestamp, parseOctoClawStatusFastPathCommand, parseOctoClawTaskActionFastPathCommand, resolveDelegationCapability, resolveReactionAckConfig } from "../extension-entry.js";
import { extractPromptText } from "../extension-entry-helpers.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { policyState } from "../state/policy-state.js";
import { envOverrides } from "../resolve/env.js";
import { resetNeutralInboundAckDedupeForTests } from "../ack/ack-guard.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };
let tempWorkspace = "";
let originalRuntimeDbPath: string | undefined;
let originalWorkspaceEnv: string | undefined;
const ENV_KEYS = [
  "OCTOCLAW_SPAWN_BACKEND",
  "OCTOCLAW_PLANNER_ALLOWLIST",
  "OCTOCLAW_SPECULATIVE_PRELOAD",
] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};






beforeEach(() => {
  originalRuntimeDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
  originalWorkspaceEnv = process.env.WORKSPACE;
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempWorkspace = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-extension-entry-"));
  envOverrides.workspaceRoot = tempWorkspace;
  envOverrides.octoclawRoot = "";
  process.env.WORKSPACE = tempWorkspace;
  process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tempWorkspace, ".octoclaw", "runtime", "octoclaw-runtime.sqlite");
});
afterEach(() => {
  nativeSpawnIntentStore.clearForTests();
  resetNeutralInboundAckDedupeForTests();
  for (const entry of policyState.entries()) {
    policyState.clear(entry.key);
  }
  envOverrides.workspaceRoot = "";
  envOverrides.octoclawRoot = "";
  if (originalRuntimeDbPath === undefined) delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
  else process.env.OCTOCLAW_RUNTIME_DB_PATH = originalRuntimeDbPath;
  if (originalWorkspaceEnv === undefined) delete process.env.WORKSPACE;
  else process.env.WORKSPACE = originalWorkspaceEnv;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv = {};
  originalRuntimeDbPath = undefined;
  originalWorkspaceEnv = undefined;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = "";
});


describe("resolveDelegationCapability", () => {
  it("enables delegation when config requests it", () => {
    const resolved = resolveDelegationCapability({
      pluginConfig: { delegationEnabled: true },
      env: {},
    });

    expect(resolved).toEqual({
      requested: true,
      hostSupported: true,
      enabled: true,
      reason: "",
    });
  });

  it("stays disabled when config or env disables delegation", () => {
    const resolved = resolveDelegationCapability({
      pluginConfig: { delegationEnabled: false },
      env: { OCTOCLAW_DELEGATION_ENABLED: "false" },
    });

    expect(resolved).toEqual({
      requested: false,
      hostSupported: true,
      enabled: false,
      reason: "disabled_by_config",
    });
  });
});


describe("resolveReactionAckConfig", () => {
  it("enables reaction ACK from top-level plugin config without judgeFast", () => {
    expect(resolveReactionAckConfig({ ackReactionEmoji: "eyes" }, {})).toEqual({
      reactionEmoji: "eyes",
      reactionAckEnabled: true,
    });
  });

  it("keeps judgeFast ackReactionEmoji as a backwards-compatible fallback", () => {
    expect(resolveReactionAckConfig({}, { ackReactionEmoji: "ok_hand" })).toEqual({
      reactionEmoji: "ok_hand",
      reactionAckEnabled: true,
    });
    expect(resolveReactionAckConfig({ ackReactionEmoji: "" }, { ackReactionEmoji: "ok_hand" })).toEqual({
      reactionEmoji: "ok_hand",
      reactionAckEnabled: true,
    });
  });
});

describe("parseOctoClawStatusFastPathCommand", () => {
  it("accepts explicit status panel commands without routing through judge/model", () => {
    expect(parseOctoClawStatusFastPathCommand("八爪鱼状态")).toEqual({ trigger: "八爪鱼状态", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("octoclaw status")).toEqual({ trigger: "octoclaw status", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("状态面板")).toEqual({ trigger: "状态面板", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("任务面板")).toEqual({ trigger: "任务面板", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("派发状态")).toEqual({ trigger: "派发状态", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("/octostatus")).toEqual({ trigger: "/octostatus", format: "anchors" });
  });

  it("supports Slack mentions, trailing punctuation, and explicit formats", () => {
    expect(parseOctoClawStatusFastPathCommand("<@U123> 八爪鱼状态？")).toEqual({ trigger: "八爪鱼状态", format: "anchors" });
    expect(parseOctoClawStatusFastPathCommand("OCTOCLAW   STATUS compact")).toEqual({ trigger: "octoclaw status", format: "compact" });
    expect(parseOctoClawStatusFastPathCommand("/octostatus raw")).toEqual({ trigger: "/octostatus", format: "raw" });
  });

  it("does not catch broader natural-language status questions", () => {
    expect(parseOctoClawStatusFastPathCommand("八爪鱼状态怎么样")).toBeNull();
    expect(parseOctoClawStatusFastPathCommand("看下 octoclaw status")).toBeNull();
    expect(parseOctoClawStatusFastPathCommand("状态面板发我一下")).toBeNull();
  });
});

describe("parseOctoClawTaskActionFastPathCommand", () => {
  it("accepts exact details commands with full or short work contract ids", () => {
    expect(parseOctoClawTaskActionFastPathCommand("查看任务 wc=wc-cd096 详情")).toEqual({
      action: "details",
      taskId: "wc-cd096",
      trigger: "查看任务",
    });
    expect(parseOctoClawTaskActionFastPathCommand("任务详情 wc-cd096bf3039cf9f0")).toEqual({
      action: "details",
      taskId: "wc-cd096bf3039cf9f0",
      trigger: "任务详情",
    });
    expect(parseOctoClawTaskActionFastPathCommand("octoclaw details wc-cd096")).toEqual({
      action: "details",
      taskId: "wc-cd096",
      trigger: "octoclaw details",
    });
  });

  it("does not catch broader natural-language details questions", () => {
    expect(parseOctoClawTaskActionFastPathCommand("看下 wc-cd096 怎么回事")).toBeNull();
    expect(parseOctoClawTaskActionFastPathCommand("查看任务详情")).toBeNull();
  });
});

describe("extractPromptText", () => {
  it("reads before_dispatch content/body fields before falling back to messages", () => {
    expect(extractPromptText({ content: "状态面板" })).toBe("状态面板");
    expect(extractPromptText({ body: [{ type: "text", text: "查看任务 wc=wc-cd096 详情" }] })).toBe("查看任务 wc=wc-cd096 详情");
  });
});


describe("buildPromptContextProjection", () => {
  it("keeps route policy projections out of user prependContext", () => {
    const projected = buildPromptContextProjection({
      prependSystem: ["Use status tools for status questions."],
      contextPayload: "route=delegate | worker_pool=octoclaw-research | allowed_control_tools=octoclaw_status",
      shouldInjectPolicyProjection: true,
    });

    expect(projected?.prependContext).toBeUndefined();
    expect(projected?.prependSystemContext).toContain("[OctoClaw policy projection]");
    expect(projected?.prependSystemContext).toContain("route=delegate");
  });

  it("returns undefined when there is nothing to inject", () => {
    expect(buildPromptContextProjection({
      prependSystem: [],
      contextPayload: "",
      shouldInjectPolicyProjection: false,
    })).toBeUndefined();
  });
});


describe("extractInboundMessageTimestamp", () => {
  it("finds nested Slack timestamps from provider payloads", () => {
    expect(extractInboundMessageTimestamp({ payload: { event: { message: { ts: "1777333611.122709" } } } }, {}, "")).toBe("1777333611.122709");
  });

  it("falls back to prompt metadata JSON", () => {
    expect(extractInboundMessageTimestamp({}, {}, '{"message_ts":"1777333628.133229"}')).toBe("1777333628.133229");
  });

  it("finds embedded Slack thread timestamps in session keys", () => {
    expect(extractInboundMessageTimestamp(
      { sessionKey: "agent:main:slack:channel:c0as4dappu3:thread:1777737951.706329" },
      {},
      "",
    )).toBe("1777737951.706329");
  });
});
