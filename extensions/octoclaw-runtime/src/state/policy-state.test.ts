import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";
import { POLICY_STATE_TTL_MS, PolicyStateStore } from "./policy-state.js";

const fs = fsSync as unknown as {
  existsSync(pathname: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
};
const osModule = os as unknown as { tmpdir(): string };

function seal(overrides: Partial<RouteSeal> = {}): RouteSeal {
  return {
    schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
    requestId: "req-1",
    turnId: "turn-1",
    threadBindingKey: "thread-1",
    route: "reply",
    source: "local_judge",
    reasonCodes: ["test"],
    createdAt: "2026-05-11T00:00:00.000Z",
    inputHash: "hash-1",
    stateGeneration: 1,
    ...overrides,
  };
}

describe("policyState 4.4 cache boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a five minute TTL", () => {
    expect(POLICY_STATE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("does not persist or restore cross-process state", () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-policy-state-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "runtime-policy-state.json");

    const store = new PolicyStateStore({ sessionStateFile: statePath });
    store.set("session-1", { prompt: "delegate this", delegated: true });
    store.persist();

    expect(fs.existsSync(statePath)).toBe(false);

    fs.writeFileSync(statePath, JSON.stringify({ sessions: { "session-1": { prompt: "stale", delegated: true, updatedAt: Date.now() } } }), "utf-8");
    const restarted = new PolicyStateStore({ sessionStateFile: statePath });

    expect(restarted.get("session-1")).toBeUndefined();
  });

  it("keeps top-level route seal and WorkContract id aligned with the current decision", () => {
    const store = new PolicyStateStore();
    const key = "session-policy-state-current-decision";
    const oldReplySeal = seal({ route: "reply", requestId: "req-reply" });
    const currentDelegateSeal = seal({ route: "delegate", requestId: "req-delegate" });

    store.set(key, {
      prompt: "你再派gpt-5.5 修一下pr",
      routeSeal: oldReplySeal,
      workContractId: "wc-old-reply",
      work_contract_id: "wc-old-reply",
      decision: {
        request: { session_key: key },
        routeSeal: currentDelegateSeal,
        workContractId: "wc-current-delegate",
        work_contract: { workContractId: "wc-current-delegate", route: "delegate" },
        route_decision: { route: "delegate" },
      },
    });

    expect(store.get(key)).toMatchObject({
      routeSeal: { route: "delegate", requestId: "req-delegate" },
      workContractId: "wc-current-delegate",
      work_contract_id: "wc-current-delegate",
      decision: {
        route_decision: { route: "delegate" },
        workContractId: "wc-current-delegate",
      },
    });
  });

  it("does not fuzzy-rebind dispatch context to an arbitrary recent reply state", () => {
    const store = new PolicyStateStore();
    store.set("session-unrelated-reply", {
      prompt: "整理 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
      decision: {
        request: { session_key: "session-unrelated-reply" },
        route_decision: { route: "reply" },
      },
    });

    const resolved = store.getDispatchPolicyContext(
      {},
      "调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
    );

    expect(resolved).toEqual({ key: "", state: null });
  });

  it("matches Slack inbound prompts wrapped by active-run runtime context", () => {
    const store = new PolicyStateStore();
    store.set("agent:main:slack:default:direct:u1:thread:1780494854.015599", {
      prompt: "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
      inboundMessageTs: "1780494854.015599",
      deliveryTarget: {
        surface: "slack",
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494854.015599",
        immutable: true,
      },
      updatedAt: Date.now(),
    });

    const wrappedPrompt = [
      "System (untrusted): [2026-06-03 21:54:15 GMT+8] Slack DM from guanbear:",
      "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
      "",
      "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
    ].join("\n");

    expect(store.findByPrompt(wrappedPrompt)?.key).toBe("agent:main:slack:default:direct:u1:thread:1780494854.015599");
  });

  it("does not fuzzy-bind identical Slack prompts when multiple thread anchors match", () => {
    const store = new PolicyStateStore();
    const prompt = "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险";
    store.set("agent:main:slack:default:direct:u1:thread:1780494854.015599", {
      prompt,
      inboundMessageTs: "1780494854.015599",
      deliveryTarget: {
        surface: "slack",
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494854.015599",
        immutable: true,
      },
      updatedAt: Date.now(),
    });
    store.set("agent:main:slack:default:direct:u1:thread:1780494867.967889", {
      prompt,
      inboundMessageTs: "1780494867.967889",
      deliveryTarget: {
        surface: "slack",
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494867.967889",
        immutable: true,
      },
      updatedAt: Date.now() + 1,
    });

    expect(store.findByPrompt(prompt)).toBeNull();
  });

  it("prefers a matching queued Slack inbound state over stale active-run delegate state", () => {
    const store = new PolicyStateStore({
      resolveKey: (ctx) => String(ctx.sessionKey || ""),
      resolveKeys: (ctx) => [String(ctx.sessionKey || "")],
    });
    store.set("active-run-uuid", {
      prompt: "上一条 active run 里的任务",
      decision: {
        request: { session_key: "active-run-uuid" },
        route_decision: { route: "delegate" },
      },
      budgetedMain: { escalatedAt: "2026-06-03T13:54:32.690Z" },
      updatedAt: Date.now(),
    });
    store.set("agent:main:slack:default:direct:u1:thread:1780494887.586889", {
      prompt: "帮我审计 Macmini 上 OpenClaw/OctoClaw 的后台任务、launchd、cron、gateway 进程和最近一小时 token 调用日志，列出异常项。",
      inboundMessageTs: "1780494887.586889",
      deliveryTarget: {
        surface: "slack",
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494887.586889",
        immutable: true,
      },
      updatedAt: Date.now(),
    });

    const resolved = store.getDispatchPolicyContext(
      { sessionKey: "active-run-uuid" },
      "帮我审计 Macmini 上 OpenClaw/OctoClaw 的后台任务、launchd、cron、gateway 进程和最近一小时 token 调用日志，列出异常项。具体步骤：检查 launchd、cron、gateway 和 token 调用日志。",
    );

    expect(resolved.key).toBe("agent:main:slack:default:direct:u1:thread:1780494887.586889");
    expect(resolved.state?.deliveryTarget).toMatchObject({
      replyToMessageId: "1780494887.586889",
    });
  });
});
