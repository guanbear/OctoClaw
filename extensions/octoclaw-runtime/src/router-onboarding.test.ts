import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plugin } from "./extension-entry.js";
import type { IMAdapter, IMSendParams } from "./im/adapter.js";
import { registerIMAdapter } from "./im/index.js";
import {
  buildRouterWizardSlackBlocks,
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
        interactiveHandlers.set(String(registration.namespace), registration.handler as (ctx: Record<string, unknown>) => Promise<{ handled?: boolean } | void>);
      },
      logger: {},
    });

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
  });

  it("extracts remind and skip actions from nested Slack payloads", () => {
    expect(extractRouterWizardAction({ actions: [{ action_id: "octoclaw_router_wizard_remind_later" }] })).toBe("remind_later");
    expect(extractRouterWizardAction({ payload: { message: { blocks: [{ elements: [{ action_id: "octoclaw_router_wizard_skip" }] }] } } })).toBe("skip");
  });
});
