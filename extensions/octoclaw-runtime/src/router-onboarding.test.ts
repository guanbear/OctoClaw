import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const fsModule = fs as unknown as {
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

beforeEach(() => {
  tempHome = fsModule.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-router-onboarding-"));
});

afterEach(() => {
  fsModule.rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
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

  it("runs a Slack question wizard and writes selected answers on confirm", async () => {
    writeOpenclawConfig();
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
    expect(sends.at(-1)?.message).toContain("隐私模式");

    expect((await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_local_only" }] },
    })).action).toBe("privacy_local_only");
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
    expect(sends.at(-1)?.message).toContain("禁用模型");

    expect((await handleRouterWizardAction({
      ...common,
      event: { text: "ban openai/gpt-5.5, zhipu/GLM-5.1" },
    })).action).toBe("restricted_models_text");
    expect(sends.at(-1)?.message).toContain("确认写入");

    const confirmed = await handleRouterWizardAction({
      ...common,
      event: { actions: [{ action_id: "octoclaw_router_wizard_confirm" }] },
    });
    expect(confirmed).toMatchObject({ handled: true, action: "confirm" });
    const saved = JSON.parse(fs.readFileSync(routerWizardConfigPath(tempHome), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      schemaVersion: "octoclaw.router_wizard/v1",
      privacy: "local_only",
      budget: { monthly: 120, currency: "USD" },
      restrictedModels: ["openai/gpt-5.5", "zhipu/GLM-5.1"],
    });
    expect(Object.keys(saved.models as Record<string, unknown>)).toEqual(["openai/gpt-5.5", "zhipu/GLM-5.1"]);
    expect(sends.at(-1)?.message).toContain("Auto Router 配置已写入");
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
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_privacy_standard" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_budget_100" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_restricted_none" }] } });
    await handleRouterWizardAction({ ...common, event: { actions: [{ action_id: "octoclaw_router_wizard_confirm" }] } });

    const saved = JSON.parse(fs.readFileSync(routerWizardConfigPath(tempHome), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      privacy: "standard",
      budget: { monthly: 100, currency: "USD" },
      restrictedModels: [],
    });
    expect(sends.map((send) => send.message).join("\n")).toContain("确认写入");
  });

  it("extracts remind and skip actions from nested Slack payloads", () => {
    expect(extractRouterWizardAction({ actions: [{ action_id: "octoclaw_router_wizard_remind_later" }] })).toBe("remind_later");
    expect(extractRouterWizardAction({ payload: { message: { blocks: [{ elements: [{ action_id: "octoclaw_router_wizard_skip" }] }] } } })).toBe("skip");
  });
});
