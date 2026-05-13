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

  it("extracts remind and skip actions from nested Slack payloads", () => {
    expect(extractRouterWizardAction({ actions: [{ action_id: "octoclaw_router_wizard_remind_later" }] })).toBe("remind_later");
    expect(extractRouterWizardAction({ payload: { message: { blocks: [{ elements: [{ action_id: "octoclaw_router_wizard_skip" }] }] } } })).toBe("skip");
  });
});
