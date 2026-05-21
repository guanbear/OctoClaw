import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plugin } from "./extension-entry.js";
import type { IMAdapter, IMSendParams } from "./im/adapter.js";
import { registerIMAdapter } from "./im/index.js";
import {
  buildRouterWizardSlackBlocks,
  buildRouterWizardFeishuBlocks,
  discoverConfiguredRouterModels,
  extractRouterWizardAction,
  handleRouterWizardAction,
  isRouterWizardComplete,
  maybeSendRouterWizardOnboarding,
  routerWizardConfigPath,
  routerWizardOnboardingStatePath,
  type RouterWizardOnboardingSendMessage,
} from "./router-onboarding.js";

let tempHome = "";
let originalOpenclawHome: string | undefined;
const fsModule = fs as unknown as {
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  utimesSync(pathname: string, atime: Date, mtime: Date): void;
};
const osModule = os as unknown as { tmpdir(): string };

beforeEach(() => {
  originalOpenclawHome = process.env.OPENCLAW_HOME;
  tempHome = fsModule.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-router-onboarding-"));
  process.env.OPENCLAW_HOME = tempHome;
});

afterEach(() => {
  if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = originalOpenclawHome;
  fsModule.rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  originalOpenclawHome = undefined;
});

function writeOpenclawConfig(): void {
  fs.writeFileSync(path.join(tempHome, "openclaw.json"), JSON.stringify({
    models: {
      providers: {
        openai: { models: [{ id: "gpt-5.5" }] },
        zhipu: { models: [{ id: "GLM-5.1" }] },
      },
    },
  }), "utf8");
}

function writeModelIntelSnapshot(): void {
  const snapshotDir = path.join(tempHome, "octoclaw", "router-lite");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "model-intel-snapshot.json"), JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "test-snapshot",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models: [
      { provider: "openai", model: "gpt-5.5", modelKey: "openai/gpt-5.5", configured: true },
      { provider: "openai", model: "gpt-5-mini", modelKey: "openai/gpt-5-mini", configured: false },
      { provider: "openai", model: "gpt-5-nano", modelKey: "openai/gpt-5-nano", configured: false },
      { provider: "anthropic", model: "claude-sonnet", modelKey: "anthropic/claude-sonnet", configured: false },
    ],
  }), "utf8");
}

function writeCliModelIntelSnapshot(): void {
  const snapshotDir = path.join(tempHome, "workspace", "tmp", "octopus", "router-lite");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "model-intel-snapshot.json"), JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "test-cli-snapshot",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models: [
      { provider: "zhipu", model: "GLM-5.1", modelKey: "zhipu/GLM-5.1", configured: true },
      { provider: "zhipu", model: "GLM-4.7", modelKey: "zhipu/GLM-4.7", configured: false },
    ],
  }), "utf8");
}

function writeLegacyModelIntelSnapshot(): void {
  const snapshotDir = path.join(tempHome, "octoclaw", "router-lite");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "model-intel-snapshot.json"), JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "test-legacy-snapshot",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models: [
      { provider: "openai", model: "gpt-5.5", modelKey: "openai/gpt-5.5", configured: true },
      { provider: "openai", model: "gpt-5-nano", modelKey: "openai/gpt-5-nano", configured: false },
    ],
  }), "utf8");
}

function writeOpenclawConfigForSameProviderDiscovery(): void {
  fs.writeFileSync(path.join(tempHome, "openclaw.json"), JSON.stringify({
    models: {
      providers: {
        zhipu: { models: [{ id: "GLM-5.1" }] },
        cliproxyapi: { models: [{ id: "gpt-5.5" }] },
        omniroute: { models: [{ id: "cx/gpt-5.4" }] },
      },
    },
  }), "utf8");
}

function writeSameProviderDiscoverySnapshot(): void {
  const snapshotDir = path.join(tempHome, "octoclaw", "router-lite");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "model-intel-snapshot.json"), JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "test-same-provider-snapshot",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models: [
      { provider: "zhipu", model: "glm-5.1", modelKey: "zhipu/glm-5.1", configured: true },
      { provider: "zhipu", model: "glm-4.7", modelKey: "zhipu/glm-4.7", configured: false },
      { provider: "cliproxyapi", model: "gpt-5.5", modelKey: "cliproxyapi/gpt-5.5", configured: true },
      { provider: "cliproxyapi", model: "gpt-5.4-mini", modelKey: "cliproxyapi/gpt-5.4-mini", configured: false },
      { provider: "omniroute", model: "cx/gpt-5.4", modelKey: "omniroute/cx/gpt-5.4", configured: true },
      { provider: "omniroute", model: "cx/gpt-5.4-mini", modelKey: "omniroute/cx/gpt-5.4-mini", configured: false },
    ],
  }), "utf8");
}

function writeGatewayFamilyDiscoverySnapshot(): void {
  const snapshotDir = path.join(tempHome, "octoclaw", "router-lite");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "model-intel-snapshot.json"), JSON.stringify({
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "test-gateway-family-snapshot",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sourceStatus: [],
    models: [
      { provider: "cliproxyapi", model: "gpt-5.5", modelKey: "cliproxyapi/gpt-5.5", configured: true },
      { provider: "openai", model: "gpt-5-mini", modelKey: "openai/gpt-5-mini", configured: false },
      { provider: "openai", model: "gpt-5.4-mini", modelKey: "openai/gpt-5.4-mini", configured: false },
      { provider: "zhipu", model: "glm-4.7", modelKey: "zhipu/glm-4.7", configured: false },
    ],
  }), "utf8");
}

describe("router wizard Slack onboarding", () => {
  function writeJudgeConfigToOpenclaw(home: string): void {
    const configPath = path.join(home, "openclaw.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {}
    if (!existing.plugins) existing.plugins = {};
    if (!(existing.plugins as Record<string, unknown>).entries) (existing.plugins as Record<string, unknown>).entries = {};
    const entries = (existing.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    if (!entries["octoclaw-runtime"]) entries["octoclaw-runtime"] = {};
    const entry = entries["octoclaw-runtime"] as Record<string, unknown>;
    if (!entry.config) entry.config = {};
    const config = entry.config as Record<string, unknown>;
    config.judgeFast = {
      enabled: true,
      modelId: "gpt-5.4-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "redacted-test-key",
      timeoutMs: 3000,
      timeoutLocalMs: 3000,
      minConfidence: 0.6,
      shadowMode: false,
      judgeAckEnabled: true,
      local: false,
    };
    fs.writeFileSync(configPath, JSON.stringify(existing), "utf8");
  }

  it("builds a Slack interactive onboarding card", () => {
    const blocks = buildRouterWizardSlackBlocks();
    expect(blocks.some((block) => block.type === "actions")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("octoclaw_router_wizard_start_questions");
    expect(JSON.stringify(blocks)).toContain("octoclaw_router_wizard_use_defaults");
  });

  it("sends first-run Slack onboarding once when wizard config is missing", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "1777770001.000001" };
    };

    const first = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });
    const second = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:01.000Z"),
      sendMessage,
    });

    expect(first.sent).toBe(true);
    expect(second).toMatchObject({ sent: false, reason: "already_prompted" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      deliveryKind: "router_wizard_onboarding",
      suppressProjectionFooter: true,
      replyToMessageId: "1777770000.000001",
    });
    expect(sends[0]!.interactiveBlocks?.length).toBeGreaterThan(0);
    expect(fs.existsSync(routerWizardOnboardingStatePath(tempHome))).toBe(true);
  });

  it("does not prompt when router wizard config already exists", async () => {
    fs.mkdirSync(path.dirname(routerWizardConfigPath(tempHome)), { recursive: true });
    fs.writeFileSync(routerWizardConfigPath(tempHome), JSON.stringify({
      schemaVersion: "octoclaw.router_wizard/v1",
      completedAt: "2026-05-14T00:00:00.000Z",
      models: { "openai/gpt-5.5": { planType: "subscription", configuredAt: "2026-05-14T00:00:00.000Z" } },
      privacy: "standard",
      restrictedModels: [],
      overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
    }), "utf8");

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      sendMessage: async () => { throw new Error("should not send"); },
    });

    expect(result).toMatchObject({ sent: false, reason: "wizard_complete" });
  });

  it("prompts again when OpenClaw config has new models missing from wizard config", async () => {
    writeOpenclawConfig();
    fs.mkdirSync(path.dirname(routerWizardConfigPath(tempHome)), { recursive: true });
    fs.writeFileSync(routerWizardConfigPath(tempHome), JSON.stringify({
      schemaVersion: "octoclaw.router_wizard/v1",
      completedAt: "2026-05-14T00:00:00.000Z",
      models: { "openai/gpt-5.5": { planType: "subscription", configuredAt: "2026-05-14T00:00:00.000Z", source: "configured" } },
      privacy: "standard",
      language: "auto",
      restrictedModels: [],
      overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
    }), "utf8");
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      sendMessage: async (params) => {
        sends.push(params);
        return { sent: true, messageId: "1777770001.000001" };
      },
    });

    expect(result.sent).toBe(true);
    expect(sends[0]?.message).toContain("还没完成首次配置");
  });

  it("handles Slack default setup action by writing wizard config", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const result = await handleRouterWizardAction({
      event: { payload: { actions: [{ action_id: "octoclaw_router_wizard_use_defaults", value: "use_defaults" }] } },
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params) => {
        sends.push(params);
        return { sent: true, messageId: "1777770001.000001" };
      },
    });

    expect(result.handled).toBe(true);
    expect(isRouterWizardComplete(tempHome)).toBe(true);
    expect(discoverConfiguredRouterModels(tempHome)).toEqual(["openai/gpt-5.5", "zhipu/GLM-5.1"]);
    expect(sends[0]!.message).toContain("默认配置已启用");
  });

  it("handles V3.1 step button ids through the Slack state wizard", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-15T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true, messageId: `1777770001.${String(sends.length).padStart(6, "0")}` };
      },
    };

    const started = await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "step:1:answer:start", value: "start" }] },
    });
    expect(started).toMatchObject({ handled: true, action: "step:1:start" });
    expect(sends.at(-1)?.message).toContain("是按订阅计费还是按用量计费");

    await handleRouterWizardAction({ ...common, now: new Date("2026-05-15T00:00:01.000Z"), event: { actions: [{ action_id: "step:2:answer:subscription", value: "subscription" }] } });
    await handleRouterWizardAction({ ...common, now: new Date("2026-05-15T00:00:02.000Z"), event: { actions: [{ action_id: "step:2:answer:pay_as_you_go", value: "pay_as_you_go" }] } });
    await handleRouterWizardAction({ ...common, now: new Date("2026-05-15T00:00:03.000Z"), event: { actions: [{ action_id: "step:3:answer:skip", value: "skip" }] } });
    await handleRouterWizardAction({ ...common, now: new Date("2026-05-15T00:00:04.000Z"), event: { actions: [{ action_id: "step:4:answer:cloud_ok", value: "cloud_ok" }] } });
    await handleRouterWizardAction({ ...common, now: new Date("2026-05-15T00:00:05.000Z"), event: { actions: [{ action_id: "step:6:answer:skip", value: "skip" }] } });

    expect(sends.at(-1)?.message).toContain("配置完成");
    const state = JSON.parse(fs.readFileSync(path.join(tempHome, "octoclaw", "router-wizard.state.json"), "utf8"));
    expect(state.step).toBe("step-7-done");
    expect(state.answers.models["openai/gpt-5.5"].planType).toBe("subscription");
  });

  it("runs a Slack question wizard and writes selected answers on confirm", async () => {
    writeOpenclawConfig();
    writeModelIntelSnapshot();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: `1777770001.${String(sends.length).padStart(6, "0")}` };
    };
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] },
    })).action).toBe("start_questions");
    expect(sends.at(-1)?.message).toContain("模型扫描");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] },
    })).action).toBe("model_scan_continue");
    expect(sends.at(-1)?.message).toContain("Plan 类型");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_plan_pay_as_you_go", value: "plan_pay_as_you_go:openai/gpt-5.5" }] },
    })).action).toBe("plan_pay_as_you_go");
    expect(sends.at(-1)?.message).toContain("zhipu/GLM-5.1");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_plan_subscription", value: "plan_subscription:zhipu/GLM-5.1" }] },
    })).action).toBe("plan_subscription");
    expect(sends.at(-1)?.message).toContain("月预算");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_budget_custom" }] },
    })).action).toBe("budget_custom");
    expect(sends.at(-1)?.message).toContain("回复 `budget 100`");

    expect((await handleRouterWizardAction({
      ...common,
      event: { text: "budget 120" },
    })).action).toBe("budget_text");
    expect(sends.at(-1)?.message).toContain("隐私模式");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_custom" }] },
    })).action).toBe("privacy_custom");
    expect(sends.at(-1)?.message).toContain("语言偏好");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_language_zh" }] },
    })).action).toBe("language_zh");
    expect(sends.at(-1)?.message).toContain("禁用模型");

    expect((await handleRouterWizardAction({
      ...common,
      event: { text: "ban openai/gpt-5.5, zhipu/GLM-5.1" },
    })).action).toBe("restricted_models_text");
    expect(sends.at(-1)?.message).toContain("同供应商模型");

    expect(sends.at(-1)?.message).toContain("openai/gpt-5-mini");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_same_provider_add", value: "same_provider_add:openai/gpt-5-mini" }] },
    })).action).toBe("same_provider_add");
    expect(sends.at(-1)?.message).toContain("openai/gpt-5-nano");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_same_provider_skip_one", value: "same_provider_skip_one:openai/gpt-5-nano" }] },
    })).action).toBe("same_provider_skip_one");
    expect(sends.at(-1)?.message).toContain("确认写入");

    const confirmed = await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_confirm" }] },
    });
    expect(confirmed).toMatchObject({ handled: true, action: "confirm" });
    const saved = JSON.parse(fs.readFileSync(routerWizardConfigPath(tempHome), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      schemaVersion: "octoclaw.router_wizard/v1",
      privacy: "standard",
      language: "zh",
      budget: { monthly: 120, currency: "USD" },
      restrictedModels: ["openai/gpt-5.5", "zhipu/GLM-5.1"],
    });
    expect(saved.models).toMatchObject({
      "openai/gpt-5.5": { source: "configured", planType: "pay_as_you_go" },
      "zhipu/GLM-5.1": { source: "configured" },
      "openai/gpt-5-mini": { source: "same_provider_discovery" },
    });
    expect(saved.models).not.toHaveProperty("openai/gpt-5-nano");
    expect(sends.at(-1)?.message).toContain("Auto Router 配置已写入");
  });

  it("uses explicit per-model plan wording without recommendation labels", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true };
      },
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });

    const planSend = sends.at(-1);
    const planBlocks = JSON.stringify(planSend?.interactiveBlocks);
    expect(planSend?.message).toContain("当前确认：`openai/gpt-5.5`（1/2）");
    expect(planSend?.message).toContain("未确认");
    expect(planSend?.message).not.toContain("推荐");
    expect(planBlocks).toContain("按量付费");
    expect(planBlocks).toContain("订阅/Plan");
    expect(planBlocks).toContain("我不确定");
    expect(planBlocks).toContain("剩余全部订阅");
    expect(planBlocks).toContain("剩余全部按量");
  });

  it("ignores stale budget button repeats after the wizard has advanced", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true };
    };
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };
    const budgetEvent = { actions: [{ action_id: "octoclaw_router_wizard_budget_100", value: "budget_100" }] };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: budgetEvent });
    const repeat = await handleRouterWizardAction({ ...common, event: budgetEvent });

    expect(repeat).toMatchObject({ handled: true, action: "budget_100" });
    expect(sends.filter((send) => send.message.includes("隐私模式"))).toHaveLength(1);
  });

  it("lets Slack users restrict configured models with buttons instead of free-form ban text", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true };
    };
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });

    const restrictedSend = sends.at(-1);
    const restrictedBlocks = JSON.stringify(restrictedSend?.interactiveBlocks);
    expect(restrictedSend?.message).toContain("当前确认：`openai/gpt-5.5`（1/2）");
    expect(restrictedSend?.message).not.toContain("ban model-a");
    expect(restrictedBlocks).toContain("octoclaw_router_wizard_restricted_ban");
    expect(restrictedBlocks).toContain("octoclaw_router_wizard_restricted_allow");

    await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_ban", value: "restricted_ban:openai/gpt-5.5" }] },
    });
    expect(sends.at(-1)?.message).toContain("当前确认：`zhipu/GLM-5.1`（2/2）");

    await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_allow", value: "restricted_allow:zhipu/GLM-5.1" }] },
    });
    expect(sends.at(-1)?.message).toContain("同供应商模型");
  });

  it("discovers same-provider candidates case-insensitively across configured providers", async () => {
    writeOpenclawConfigForSameProviderDiscovery();
    writeSameProviderDiscoverySnapshot();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true };
    };
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });

    const sameProviderMessage = sends.at(-1)?.message ?? "";
    expect(sameProviderMessage).toContain("zhipu/glm-4.7");
    expect(sameProviderMessage).toContain("cliproxyapi/gpt-5.4-mini");
    expect(sameProviderMessage).toContain("omniroute/cx/gpt-5.4-mini");
    expect(sameProviderMessage).not.toContain("`zhipu/glm-5.1` → 待确认");
    expect(sameProviderMessage).not.toContain("`cliproxyapi/gpt-5.5` → 待确认");
    expect(sameProviderMessage).not.toContain("`omniroute/cx/gpt-5.4` → 待确认");
  });

  it("loads the model-intel snapshot written by router model-intel refresh", async () => {
    writeOpenclawConfigForSameProviderDiscovery();
    writeCliModelIntelSnapshot();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true };
      },
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });

    expect(sends.at(-1)?.message).toContain("zhipu/GLM-4.7");
  });

  it("uses the newest wizard model-intel snapshot across refresh locations", async () => {
    fs.writeFileSync(path.join(tempHome, "openclaw.json"), JSON.stringify({
      models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
    }), "utf8");
    writeCliModelIntelSnapshot();
    writeLegacyModelIntelSnapshot();
    const legacySnapshot = path.join(tempHome, "octoclaw", "router-lite", "model-intel-snapshot.json");
    const cliSnapshot = path.join(tempHome, "workspace", "tmp", "octopus", "router-lite", "model-intel-snapshot.json");
    fsModule.utimesSync(cliSnapshot, new Date("2026-05-14T00:00:00.000Z"), new Date("2026-05-14T00:00:00.000Z"));
    fsModule.utimesSync(legacySnapshot, new Date("2026-05-14T00:05:00.000Z"), new Date("2026-05-14T00:05:00.000Z"));
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true };
      },
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });

    const message = sends.at(-1)?.message ?? "";
    expect(message).toContain("openai/gpt-5-nano");
    expect(message).not.toContain("zhipu/GLM-4.7");
  });

  it("discovers canonical GPT family candidates for configured gateway aliases", async () => {
    fs.writeFileSync(path.join(tempHome, "openclaw.json"), JSON.stringify({
      models: {
        providers: {
          cliproxyapi: { models: [{ id: "gpt-5.5" }] },
        },
      },
    }), "utf8");
    writeGatewayFamilyDiscoverySnapshot();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true };
      },
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });

    const sameProviderMessage = sends.at(-1)?.message ?? "";
    expect(sameProviderMessage).toContain("cliproxyapi/gpt-5-mini");
    expect(sameProviderMessage).toContain("cliproxyapi/gpt-5.4-mini");
    expect(sameProviderMessage).not.toContain("openai/gpt-5-mini");
    expect(sameProviderMessage).not.toContain("openai/gpt-5.4-mini");
    expect(sameProviderMessage).not.toContain("zhipu/glm-4.7");
  });

  it("preserves gateway route prefixes when mirroring packaged GPT candidates", async () => {
    fs.writeFileSync(path.join(tempHome, "openclaw.json"), JSON.stringify({
      models: {
        providers: {
          omniroute: { models: [{ id: "cx/gpt-5.4" }] },
        },
      },
    }), "utf8");
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage: async (params: Parameters<RouterWizardOnboardingSendMessage>[0]) => {
        sends.push(params);
        return { sent: true };
      },
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });

    const sameProviderMessage = sends.at(-1)?.message ?? "";
    expect(sameProviderMessage).toContain("omniroute/cx/gpt-5.4-mini");
    expect(sameProviderMessage).not.toContain("omniroute/gpt-5.4-mini");
  });

  it("supports all-button question wizard path without free-form text", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true };
    };
    const common = {
      sessionKey: "agent:main:slack:default:direct:u123abc",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_start_questions" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_model_scan_continue" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_plan_confirm" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_100" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_language_auto" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_same_provider_skip" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_confirm" }] } });

    const saved = JSON.parse(fs.readFileSync(routerWizardConfigPath(tempHome), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      privacy: "standard",
      language: "auto",
      budget: { monthly: 100, currency: "USD" },
      restrictedModels: [],
    });
    expect(sends.map((send) => send.message).join("\n")).toContain("确认写入");
  });

  it("registers Slack interactive handlers that start the question wizard", async () => {
    const interactiveHandlers = new Map<string, (ctx: Record<string, unknown>) => Promise<{ handled?: boolean } | void>>();
    const registeredNamespaces: string[] = [];
    const sends: IMSendParams[] = [];
    const adapter: IMAdapter = {
      channel: "slack",
      capabilityLevel: "L2",
      canHandle: (sessionKey) => sessionKey.includes("direct:u123abc"),
      resolveTarget: () => ({ channel: "slack", target: "user:U123ABC", threadTs: "1777770000.000001" }),
      send: async (params) => {
        sends.push(params);
        return { sent: true, delivered: true, messageId: "1777770001.000001", threadTs: params.replyToMessageId };
      },
      react: async () => ({ ok: true }),
    };
    registerIMAdapter(adapter);
    plugin.register({
      pluginConfig: {},
      on: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      registerInteractiveHandler: (registration) => {
        const namespace = String(registration.namespace);
        registeredNamespaces.push(namespace);
        interactiveHandlers.set(namespace, registration.handler as (ctx: Record<string, unknown>) => Promise<{ handled?: boolean } | void>);
      },
      logger: {},
    });

    expect(registeredNamespaces.every((namespace) => /^[A-Za-z0-9._-]+$/.test(namespace))).toBe(true);
    expect(interactiveHandlers.has("step")).toBe(true);

    const handler = interactiveHandlers.get("octoclaw_router_wizard_start_questions");
    expect(handler).toBeTruthy();
    const result = await handler!({
      accountId: "default",
      conversationId: "D0AR3GTPYQL",
      senderId: "U123ABC",
      threadId: "1777770000.000001",
      interaction: {
        actionId: "octoclaw_router_wizard_start_questions",
        value: "start_questions",
        messageTs: "1777770001.000001",
        threadTs: "1777770000.000001",
      },
    });

    expect(result).toMatchObject({ handled: true });
    expect(sends.at(-1)).toMatchObject({
      message: expect.stringContaining("模型扫描"),
      replyToMessageId: "1777770000.000001",
      deliveryKind: "router_wizard_onboarding",
    });
    const state = JSON.parse(fs.readFileSync(routerWizardOnboardingStatePath(tempHome), "utf8")) as Record<string, unknown>;
    expect(state.active).toMatchObject({
      step: "model_scan",
      sessionKey: "agent:main:slack:default:direct:u123abc:thread:1777770000.000001",
    });

    sends.length = 0;
    const stepHandler = interactiveHandlers.get("step");
    expect(stepHandler).toBeTruthy();
    const stepResult = await stepHandler!({
      accountId: "default",
      conversationId: "D0AR3GTPYQL",
      senderId: "U123ABC",
      threadId: "1777770000.000001",
      interaction: {
        actionId: "step:1:answer:start",
        value: "start",
        messageTs: "1777770001.000002",
        threadTs: "1777770000.000001",
      },
    });

    expect(stepResult).toMatchObject({ handled: true });
    expect(sends.at(-1)).toMatchObject({
      message: expect.stringContaining("Plan 类型"),
      replyToMessageId: "1777770000.000001",
      deliveryKind: "router_wizard_onboarding",
    });
  }, 10_000);

  it("extracts remind and skip actions from nested Slack payloads", () => {
    expect(extractRouterWizardAction({ actions: [{ action_id: "octoclaw_router_wizard_remind_later" }] })).toBe("remind_later");
    expect(extractRouterWizardAction({ payload: { message: { blocks: [{ elements: [{ action_id: "octoclaw_router_wizard_skip" }] }] } } })).toBe("skip");
  });

  it("MOF-007: shows Judge warning when Judge is missing during Slack onboarding", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "1777770001.000001" };
    };

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.sent).toBe(true);
    const sent = sends[0]!;
    expect(sent.message).toContain("Judge 未配置");
    expect(sent.message).toContain("octoclawctl init");
    expect(sent.message).toContain("gpt-5.4-mini");
    expect(sent.message).toContain("glm-4.5-air");
    expect(sent.message).toContain("xiaomi/mimo-v2-flash");
    expect(sent.message).toContain("deepseek/deepseek-v4-flash");
    const blocksJson = JSON.stringify(sent.interactiveBlocks);
    expect(blocksJson).toContain("Judge 未配置");
    expect(blocksJson).toContain("glm-4.5-air");
    expect(blocksJson).toContain("xiaomi/mimo-v2-flash");

    expect(isRouterWizardComplete(tempHome)).toBe(false);
  });

  it("MOF-007: router wizard use-defaults does not write Judge config", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "1777770001.000001" };
    };

    const result = await handleRouterWizardAction({
      event: { payload: { actions: [{ action_id: "octoclaw_router_wizard_use_defaults", value: "use_defaults" }] } },
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.handled).toBe(true);
    expect(result.path).toBeTruthy();

    const wizardConfig = JSON.parse(fs.readFileSync(routerWizardConfigPath(tempHome), "utf8")) as Record<string, unknown>;
    expect(wizardConfig.schemaVersion).toBe("octoclaw.router_wizard/v1");

    const openclawConfig = JSON.parse(fs.readFileSync(path.join(tempHome, "openclaw.json"), "utf8")) as Record<string, unknown>;
    const plugins = openclawConfig.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const runtimeEntry = entries?.["octoclaw-runtime"] as Record<string, unknown> | undefined;
    const config = runtimeEntry?.config as Record<string, unknown> | undefined;
    expect(config?.judgeFast).toBeUndefined();
  });

  it("MOF-008: healthy Judge suppresses onboarding warning", async () => {
    writeOpenclawConfig();
    writeJudgeConfigToOpenclaw(tempHome);

    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "1777770001.000001" };
    };

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:slack:default:direct:u123abc",
      replyToMessageId: "1777770000.000001",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.sent).toBe(true);
    const sent = sends[0]!;
    expect(sent.message).not.toContain("Judge 未配置");
    expect(sent.message).not.toContain("octoclawctl init");
    expect(sent.message).toContain("Auto Router");

    const blocksJson = JSON.stringify(sent.interactiveBlocks);
    expect(blocksJson).not.toContain("Judge 未配置");

    expect(blocksJson).toContain("octoclaw_router_wizard_start_questions");
    expect(blocksJson).toContain("octoclaw_router_wizard_use_defaults");
  });
});

describe("router wizard Feishu onboarding", () => {
  it("MOF-009: Feishu onboarding renders a card", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "om_feishu_001" };
    };

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      replyToMessageId: "om_parent",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.sent).toBe(true);
    const sent = sends[0]!;
    expect(sent.interactiveBlocks!.length).toBeGreaterThan(0);

    const blocksJson = JSON.stringify(sent.interactiveBlocks);
    expect(blocksJson).toContain("feishu_card");
    expect(blocksJson).toContain("start_questions");
    expect(blocksJson).toContain("use_defaults");
    expect(blocksJson).toContain("remind_later");
    expect(blocksJson).toContain("skip");

    expect(sent.message).toContain("还没完成首次配置");
  });

  it("MOF-009: Feishu onboarding card includes text fallback", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "om_feishu_002" };
    };

    await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    const sent = sends[0]!;
    expect(sent.message).toContain("Auto Router");
    expect(sent.message).toContain("octoclawctl router wizard");
  });

  it("MOF-010: Feishu wizard button advances the same state", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: `om_feishu_${sends.length}` };
    };
    const common = {
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      replyToMessageId: "om_parent",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    const started = await handleRouterWizardAction({
      ...common,
      event: { action: { value: "start_questions", tag: "button" } },
    });
    expect(started).toMatchObject({ handled: true, action: "start_questions" });
    expect(sends.at(-1)?.interactiveBlocks?.some((b) => b.type === "feishu_card")).toBe(true);
    expect(sends.at(-1)?.message).toContain("模型扫描");
  });

  it("MOF-010: Feishu wizard full question flow uses Feishu cards", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: `om_feishu_${sends.length}` };
    };
    const common = {
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      replyToMessageId: "om_parent",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    await handleRouterWizardAction({ ...common, event: { action: { value: "start_questions", tag: "button" } } });
    expect(sends.at(-1)?.interactiveBlocks?.some((b) => b.type === "feishu_card")).toBe(true);

    await handleRouterWizardAction({ ...common, event: { action: { value: "model_scan_continue", tag: "button" } } });
    expect(sends.at(-1)?.message).toContain("Plan 类型");

    await handleRouterWizardAction({ ...common, event: { action: { value: "plan_confirm", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "budget_100", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "privacy_standard", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "language_auto", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "restricted_none", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "same_provider_skip", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "confirm", tag: "button" } } });

    const confirmed = sends.at(-1)!;
    expect(confirmed.message).toContain("配置已写入");
    expect(isRouterWizardComplete(tempHome)).toBe(true);
  });

  it("MOF-011: Feishu duplicate click is idempotent", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: `om_dup_${sends.length}` };
    };
    const common = {
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      replyToMessageId: "om_parent",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    };

    await handleRouterWizardAction({ ...common, event: { action: { value: "start_questions", tag: "button" } } });
    await handleRouterWizardAction({ ...common, event: { action: { value: "model_scan_continue", tag: "button" } } });

    const stateBefore = JSON.parse(fs.readFileSync(routerWizardOnboardingStatePath(tempHome), "utf8")) as Record<string, unknown>;
    const activeBefore = JSON.stringify((stateBefore as Record<string, unknown>).active);

    const repeat = await handleRouterWizardAction({ ...common, event: { action: { value: "model_scan_continue", tag: "button" } } });
    expect(repeat.handled).toBe(true);

    const stateAfter = JSON.parse(fs.readFileSync(routerWizardOnboardingStatePath(tempHome), "utf8")) as Record<string, unknown>;
    const activeAfter = JSON.stringify((stateAfter as Record<string, unknown>).active);
    expect(activeAfter).toBe(activeBefore);

    expect(sends.at(-1)?.message).toContain("这一步已经回答过");
  });

  it("MOF-012: Feishu unknown action does not mutate state", async () => {
    writeOpenclawConfig();
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: `om_unk_${sends.length}` };
    };

    const result = await handleRouterWizardAction({
      event: { action: { value: "totally_unknown_action", tag: "button" } },
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.handled).toBe(true);
    expect(result.action).toBe("unknown");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.message).toContain("无法识别");
    expect(fs.existsSync(routerWizardOnboardingStatePath(tempHome))).toBe(false);
  });

  it("MOF-013: Feishu onboarding card send failure is reported when the injected sender has no adapter fallback", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      if (params.interactiveBlocks?.some((b) => b.type === "feishu_card")) {
        return { sent: false, error: "card_send_failed" };
      }
      return { sent: true, messageId: "om_text_fallback" };
    };

    const result = await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("card_send_failed");
  });

  it("MOF-019: Feishu onboarding does not attempt streaming", async () => {
    const sends: Parameters<RouterWizardOnboardingSendMessage>[0][] = [];
    const sendMessage: RouterWizardOnboardingSendMessage = async (params) => {
      sends.push(params);
      return { sent: true, messageId: "om_no_stream" };
    };

    await maybeSendRouterWizardOnboarding({
      sessionKey: "agent:main:feishu:default:direct:ou_AbcDef",
      openclawHome: tempHome,
      now: new Date("2026-05-14T00:00:00.000Z"),
      sendMessage,
    });

    const sent = sends[0]!;
    expect(sent.interactiveBlocks!.every((b) => b.type === "feishu_card")).toBe(true);
  });

  it("MOF-009: Feishu builds onboarding card blocks", () => {
    const blocks = buildRouterWizardFeishuBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]).toMatchObject({ type: "feishu_card" });
    const cardJson = JSON.stringify(blocks);
    expect(cardJson).toContain("start_questions");
    expect(cardJson).toContain("use_defaults");
    expect(cardJson).toContain("remind_later");
    expect(cardJson).toContain("skip");
  });

});
