import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "node:fs";
import path from "node:path";

import { resolvePolicyDecisionForContext } from "../resolve/policy-resolver.js";
import { policyState } from "../state/policy-state.js";
import { extractBeforeDispatchPrompt } from "./probe.js";

const fs = fsSync as unknown as {
  mkdtempSync(prefix: string): string;
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function judgeResponse(route: "reply" | "delegate", confidence = 0.86): Response {
  return jsonResponse({
    choices: [{
      message: {
        content: JSON.stringify({
          route,
          confidence,
          abstain_reason: null,
          ack_text: "收到",
          is_new_work: route === "delegate",
          expected_deliverable: route === "delegate" ? "A verified delegated result packet." : null,
          scope: route === "delegate" ? "local" : undefined,
          tool_need_hint: route === "delegate" ? "required" : undefined,
          duration_hint: route === "delegate" ? "medium" : undefined,
        }),
      },
    }],
  });
}

const judgeConfig = {
  enabled: true,
  shadowMode: false,
  modelId: "test-local-judge",
  baseUrl: "http://localhost:19999/v1",
  apiKey: "test-key",
  timeoutMs: 1500,
  timeoutLocalMs: 800,
  minConfidence: 0.6,
  local: true,
  judgeAckEnabled: true,
};

const stateKey = "agent:main:slack:channel:c0as4dappu3";
const ctx = {
  sessionKey: stateKey,
  sessionId: stateKey,
  channelId: "C0AS4DAPPU3",
  messageProvider: "slack",
  messageTs: "1777734999.123456",
  trigger: "message",
};
const prompt = "请让子 agent 查 OpenClaw 2026.4.29 release notes，并给我 5 句话总结。";

describe("before-dispatch fast delegate no-double-judge proof", () => {
  let tmpRoot = "";
  const oldWorkspace = process.env.WORKSPACE;
  const oldDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
  const oldLedger = process.env.OCTOCLAW_RUNTIME_LEDGER;
  const oldJudgeFast = process.env.OCTOCLAW_JUDGE_FAST;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpRoot = fs.mkdtempSync(path.join("/tmp", "octoclaw-fast-delegate-"));
    fs.mkdirSync(path.join(tmpRoot, "tmp", "octopus"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".octoclaw", "runtime"), { recursive: true });
    process.env.WORKSPACE = tmpRoot;
    process.env.OCTOCLAW_RUNTIME_DB_PATH = path.join(tmpRoot, ".octoclaw", "runtime", "runtime.sqlite");
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    process.env.OCTOCLAW_JUDGE_FAST = JSON.stringify(judgeConfig);
    policyState.clear(stateKey);
  });

  afterEach(() => {
    policyState.clear(stateKey);
    process.env.WORKSPACE = oldWorkspace;
    process.env.OCTOCLAW_RUNTIME_DB_PATH = oldDbPath;
    process.env.OCTOCLAW_RUNTIME_LEDGER = oldLedger;
    process.env.OCTOCLAW_JUDGE_FAST = oldJudgeFast;
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reuses the cached policy decision across before-dispatch and later lifecycle hooks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(judgeResponse("delegate"));

    const beforeDispatchPrompt = extractBeforeDispatchPrompt({ body: prompt });
    const beforeDispatch = await resolvePolicyDecisionForContext(beforeDispatchPrompt, ctx, process.cwd());
    const beforeModelResolve = await resolvePolicyDecisionForContext(prompt, ctx, process.cwd());
    const beforePromptBuild = await resolvePolicyDecisionForContext({ prompt }, ctx, process.cwd());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(beforeDispatch?.stateKey).toBe(stateKey);
    expect(beforeModelResolve?.stateKey).toBe(stateKey);
    expect(beforePromptBuild?.stateKey).toBe(stateKey);
    expect(beforeModelResolve?.decision.workContractId).toBe(beforeDispatch?.decision.workContractId);
    expect(beforePromptBuild?.decision.workContractId).toBe(beforeDispatch?.decision.workContractId);
    expect(beforeModelResolve?.decision.route_decision).toMatchObject({ route: "delegate" });
    expect(beforePromptBuild?.decision.route_decision).toMatchObject({ route: "delegate" });
    expect(policyState.get(stateKey)?.prompt).toBe(prompt);
    expect(policyState.get(stateKey)?.workContractId).toBe(beforeDispatch?.decision.workContractId);
  });

  it("caches timeout/degraded pass-through for the same turn instead of retrying judge", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timeout", "AbortError"));

    const beforeDispatch = await resolvePolicyDecisionForContext(prompt, ctx, process.cwd());
    const beforeModelResolve = await resolvePolicyDecisionForContext({ prompt }, ctx, process.cwd());
    const beforePromptBuild = await resolvePolicyDecisionForContext({ raw: prompt }, ctx, process.cwd());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(beforeDispatch?.decision.route_decision).toMatchObject({
      route: "reply",
      judge_timeout: true,
    });
    expect(beforeModelResolve?.decision.workContractId).toBe(beforeDispatch?.decision.workContractId);
    expect(beforePromptBuild?.decision.workContractId).toBe(beforeDispatch?.decision.workContractId);
    expect(beforeModelResolve?.decision.route_decision).toMatchObject({ route: "reply", judge_timeout: true });
    expect(beforePromptBuild?.decision.route_decision).toMatchObject({ route: "reply", judge_timeout: true });
  });
});
