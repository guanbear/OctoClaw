import { describe, expect, it } from "vitest";

import {
  buildFastDelegatePromptHint,
  createInMemoryFastSpawnPlanDraftStore,
  evaluateFastDelegateAdmission,
  fastDelegatePromptHash,
} from "./draft.js";

const ctx = {
  sessionKey: "agent:main:slack:channel:c0as4dappu3",
  sessionId: "agent:main:slack:channel:c0as4dappu3",
  channelId: "C0AS4DAPPU3",
  messageProvider: "slack",
  messageTs: "1777734999.123456",
  trigger: "message",
};

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const expectedDeliverable = "A verified release note summary with references.";
  return {
    route_decision: {
      route: "delegate",
      route_source: "judge",
      final_judge_source: "local",
      expected_deliverable: expectedDeliverable,
    },
    judge_confidence: 0.86,
    request: {
      metadata: {
        session_key: ctx.sessionKey,
        conversation_control: {
          intent_class: "delegated_work",
        },
      },
    },
    delegation_ticket_candidate: {
      ticket_decision: "ticket_would_issue",
      is_new_work: true,
      expected_deliverable: expectedDeliverable,
    },
    ...overrides,
  };
}

interface PassThroughFixture {
  enabled?: boolean;
  expected?: "passed" | "disabled";
  reason: string;
  decision?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  activeDuplicate?: boolean;
}

const passThroughFixtures: Array<[string, PassThroughFixture]> = [
  ["disabled", { enabled: false, expected: "disabled", reason: "disabled" }],
  ["reply route", {
    decision: decision({ route_decision: { route: "reply" } }),
    reason: "route_not_delegate",
  }],
  ["low confidence", {
    decision: decision({ judge_confidence: 0.5 }),
    reason: "confidence_below_threshold",
  }],
  ["degraded judge", {
    decision: decision({ _judge_shadow_log: { judge_schema_degraded: true } }),
    reason: "judge_not_safe",
  }],
  ["timeout judge", {
    decision: decision({ route_decision: { route: "delegate", judge_timeout: true } }),
    reason: "judge_not_safe",
  }],
  ["missing deliverable", {
    decision: decision({ delegation_ticket_candidate: {}, route_decision: { route: "delegate" } }),
    reason: "missing_expected_deliverable",
  }],
  ["ticket denied", {
    decision: decision({
      delegation_ticket_candidate: {
        ticket_decision: "ticket_not_issued",
        ticket_denial_reason: "not_new_work",
        expected_deliverable: "A verified release note summary with references.",
      },
    }),
    reason: "admission_not_allowed",
  }],
  ["execution follow-up", {
    decision: decision({ request: { metadata: { conversation_control: { intent_class: "execution_followup" } } } }),
    reason: "execution_followup",
  }],
  ["approval needed", { decision: decision({ requires_approval: true }), reason: "requires_approval" }],
  ["duplicate active work", { activeDuplicate: true, reason: "active_duplicate" }],
  ["subagent context", {
    ctx: { sessionKey: "agent:main:subagent:child-1", sessionId: "agent:main:subagent:child-1" },
    reason: "unmanaged_context",
  }],
];

describe("fast delegate draft admission", () => {
  it("allows only draft staging for high-confidence delegated work", () => {
    const prompt = "请让子 agent 查 OpenClaw 2026.4.29 release notes，并给我 5 句话总结。";
    const result = evaluateFastDelegateAdmission({
      enabled: true,
      prompt,
      ctx,
      decision: decision(),
      nowMs: 1_000,
    });

    expect(result.handled).toBe(false);
    expect(result.result).toBe("allowed");
    expect(result.draft).toMatchObject({
      kind: "native_planner_acceleration",
      status: "draft",
      stateKey: ctx.sessionKey,
      sessionKey: ctx.sessionKey,
      promptHash: fastDelegatePromptHash(prompt),
      route: "delegate",
      expectedDeliverable: "A verified release note summary with references.",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      sessionsSpawnArgsDraft: {
        promptHash: fastDelegatePromptHash(prompt),
        context: "isolated",
        lightContext: true,
      },
    });
    expect(result.replay).toMatchObject({
      event: "fast_delegate_evaluated",
      fast_delegate_result: "allowed",
      reason: "high_confidence_delegate",
      prompt_hash: fastDelegatePromptHash(prompt),
      expected_deliverable_present: true,
    });
  });

  it.each(passThroughFixtures)("passes through %s without a draft", (_label, fixture) => {
    const result = evaluateFastDelegateAdmission({
      enabled: fixture.enabled ?? true,
      prompt: "请处理这个任务。",
      ctx: fixture.ctx ?? ctx,
      decision: fixture.decision ?? decision(),
      activeDuplicate: fixture.activeDuplicate,
    });

    expect(result.handled).toBe(false);
    expect(result.result).toBe(fixture.expected ?? "passed");
    expect(result.reason).toBe(fixture.reason);
    expect(result.draft).toBeUndefined();
  });

  it("uses an atomic consume contract for prompt injection and dispatch", () => {
    const prompt = "请让子 agent 做一个多步验证。";
    const allowed = evaluateFastDelegateAdmission({
      enabled: true,
      prompt,
      ctx,
      decision: decision(),
      nowMs: 10_000,
    });
    const draft = allowed.draft;
    expect(draft).toBeDefined();

    const store = createInMemoryFastSpawnPlanDraftStore();
    store.put(draft!);

    expect(store.consume({
      planId: draft!.planId,
      stateKey: "agent:main:slack:channel:other",
      promptHash: draft!.promptHash,
      nowMs: 10_001,
    })).toEqual({ ok: false, reason: "state_key_mismatch" });
    expect(store.consume({
      planId: draft!.planId,
      stateKey: draft!.stateKey,
      promptHash: fastDelegatePromptHash("different"),
      nowMs: 10_002,
    })).toEqual({ ok: false, reason: "prompt_hash_mismatch" });

    const consumed = store.consume({
      planId: draft!.planId,
      stateKey: draft!.stateKey,
      promptHash: draft!.promptHash,
      nowMs: 10_003,
    });
    expect(consumed).toMatchObject({ ok: true, draft });
    expect(store.consume({
      planId: draft!.planId,
      stateKey: draft!.stateKey,
      promptHash: draft!.promptHash,
      nowMs: 10_004,
    })).toEqual({ ok: false, reason: "missing" });
  });

  it("expires stale drafts instead of materializing native spawn state", () => {
    const allowed = evaluateFastDelegateAdmission({
      enabled: true,
      prompt: "请让子 agent 做一个多步验证。",
      ctx,
      decision: decision(),
      nowMs: 10_000,
      ttlMs: 100,
    });
    const store = createInMemoryFastSpawnPlanDraftStore();
    store.put(allowed.draft!);

    expect(store.consume({
      planId: allowed.draft!.planId,
      stateKey: allowed.draft!.stateKey,
      promptHash: allowed.draft!.promptHash,
      nowMs: 10_101,
    })).toEqual({ ok: false, reason: "expired" });
    expect(store.size()).toBe(0);
  });

  it("injects only a minimal native planner hint", () => {
    const allowed = evaluateFastDelegateAdmission({
      enabled: true,
      prompt: "请让子 agent 做一个多步验证。",
      ctx,
      decision: decision(),
      nowMs: 10_000,
    });

    const hint = buildFastDelegatePromptHint(allowed.draft!);
    expect(hint).toContain("octoclaw_dispatch");
    expect(hint).toContain("fast=true");
    expect(hint).toContain(`spawnPlanId=${allowed.draft!.planId}`);
    expect(hint).toContain("sessions_spawn");
    expect(hint).toContain("octoclaw_dispatch_confirm");
    expect(hint).toContain("accepted run evidence");
    expect(hint).not.toContain("chat.postMessage");
  });
});
