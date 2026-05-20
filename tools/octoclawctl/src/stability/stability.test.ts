import { describe, expect, it } from "vitest";
import type { ModelIntelLite } from "@octoclaw/router";
import {
  buildCatalogCasePack,
  evaluateWizardStabilityState,
  resolveRouterModelExpectation,
  runNightlyReplayStabilityLane,
  runSyntheticStabilityFixture,
  sanitizeStabilityArtifact,
  validateStabilityCasePack,
} from "./index.js";

describe("stability smoke v2 catalog", () => {
  it("SSV2-001: loads the post-deploy catalog with core blocker/major cases", () => {
    const pack = buildCatalogCasePack("post_deploy", { generatedAt: "2026-05-20T00:00:00.000Z" });

    expect(pack.schemaVersion).toBe("octoclaw.stability_smoke.case_pack/v2");
    expect(pack.runKind).toBe("post_deploy");
    expect(pack.cases.map((item) => item.id)).toEqual([
      "reply_core.simple_chat",
      "streaming_core.long_reply",
      "delegate_core.native_final",
      "footer_truth.current_model",
      "status_core.read_only",
    ]);
    expect(pack.cases.every((item) => item.severity === "blocker" || item.severity === "major")).toBe(true);
  });

  it("SSV2-002: rejects invalid AI case packs and leaves callers with catalog fallback", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "glm-5.1",
      runKind: "nightly",
      cases: [
        {
          id: "bad.mode",
          mode: "made_up",
          severity: "major",
          tags: ["bad"],
          expect: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("unknown mode");

    const fallback = buildCatalogCasePack("nightly", { generatedAt: "2026-05-20T00:00:00.000Z" });
    expect(fallback.cases.some((item) => item.id === "delegate_core.native_final")).toBe(true);
  });

  it("SSV2-003: enforces the live Slack case cap", () => {
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `live.${index}`,
      mode: "live_slack",
      severity: "major",
      tags: ["generated"],
      prompt: `case ${index}`,
      maxRuntimeMs: 60_000,
      expect: {},
    }));

    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "glm-5.1",
      runKind: "nightly",
      cases,
    }, { maxLiveCases: 8 });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live case cap exceeded");
  });

  it("requires live Slack cases to include prompt and max runtime", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "manual",
      runKind: "manual",
      cases: [
        {
          id: "live.missing-contract",
          mode: "live_slack",
          severity: "major",
          tags: ["live"],
          expect: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live_slack requires prompt");
    expect(result.errors.join("\n")).toContain("live_slack requires positive maxRuntimeMs");
  });

  it("rejects live provider probes unless explicitly allowed", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "manual",
      runKind: "manual",
      cases: [
        {
          id: "provider.live-probe",
          mode: "provider",
          severity: "major",
          tags: ["provider"],
          expect: { providerProbe: "live" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live provider probe requires allowLiveProviderProbe=true");
  });

  it("SSV2-004: redacts secrets and strips transcript/prompt-like fields", () => {
    const sanitized = sanitizeStabilityArtifact({
      error: "failed with xoxb-1234567890-secret and sk-1234567890abcdefghijkl",
      apiKey: "sk-should-not-survive-1234567890",
      prompt: "please do a private thing",
      rawTranscript: "full transcript",
      nested: {
        authorization: "Bearer secret-token",
        fullResponse: "private model output",
      },
    }) as Record<string, unknown>;

    expect(JSON.stringify(sanitized)).not.toContain("xoxb-1234567890-secret");
    expect(JSON.stringify(sanitized)).not.toContain("sk-1234567890abcdefghijkl");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.prompt).toMatch(/^\[STRIPPED:sha256:/u);
    expect(sanitized.rawTranscript).toBe("[STRIPPED]");
    expect(JSON.stringify(sanitized)).not.toContain("private model output");
  });
});

function model(modelKey: string, tier: ModelIntelLite["capability"]["codingTier"], overrides: Partial<ModelIntelLite> = {}): ModelIntelLite {
  const [provider, name] = modelKey.split("/");
  return {
    provider,
    model: name,
    modelKey,
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: [],
    marketPrice: { blendedUsdPerMTok: 10, confidence: "high", sources: ["test"] },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: tier,
      confidence: "high",
      evidence: ["declared"],
      sources: ["test"],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "low",
      recentFailureRate: 0.01,
      p95LatencyMs: 700,
      sources: ["test"],
    },
    plan: {
      type: "pay_as_you_go",
      quotaPressure: "unknown",
      effectiveCostBand: "unknown",
      sources: ["test"],
    },
    sources: ["test"],
    ...overrides,
  };
}

describe("stability smoke v2 router and wizard checks", () => {
  it("SSV2-030: computes simple/normal/deep expected models from current router state", () => {
    const models = [
      model("cliproxyapi/gpt-5.5", "frontier", { marketPrice: { blendedUsdPerMTok: 30, confidence: "high", sources: ["test"] } }),
      model("cliproxyapi/gpt-5.4-mini", "mini", { marketPrice: { blendedUsdPerMTok: 1, confidence: "high", sources: ["test"] } }),
      model("zhipu/glm-5.1", "standard", { marketPrice: { blendedUsdPerMTok: 3, confidence: "high", sources: ["test"] } }),
    ];

    expect(resolveRouterModelExpectation({ complexity: "simple", models }).expectedModel).toBe("cliproxyapi/gpt-5.4-mini");
    expect(resolveRouterModelExpectation({ complexity: "normal", models }).expectedModel).toBe("zhipu/glm-5.1");
    expect(resolveRouterModelExpectation({ complexity: "deep", models }).expectedModel).toBe("cliproxyapi/gpt-5.5");
  });

  it("SSV2-031: cooldown excludes a model from expected live choice", () => {
    const result = resolveRouterModelExpectation({
      complexity: "deep",
      models: [
        model("cliproxyapi/gpt-5.5", "frontier", {
          health: { ...model("x/y", "frontier").health, cooldown: true, cooldownReason: "rate_limit_429" },
        }),
        model("zhipu/glm-5.1", "frontier"),
      ],
    });

    expect(result.expectedModel).toBe("zhipu/glm-5.1");
    expect(result.reasonCodes).toContain("cooldown:rate_limit_429:cliproxyapi/gpt-5.5");
  });

  it("SSV2-032: unconfigured discovered models stay proposal-only for live expectations", () => {
    const result = resolveRouterModelExpectation({
      complexity: "simple",
      models: [
        model("cliproxyapi/gpt-5.4-mini", "mini", { configured: false, proposalOnly: true }),
        model("zhipu/glm-5.1", "standard"),
      ],
    });

    expect(result.expectedModel).toBe("zhipu/glm-5.1");
    expect(result.proposalCandidates).toContain("cliproxyapi/gpt-5.4-mini");
    expect(result.rejectedModels).toContainEqual({ model: "cliproxyapi/gpt-5.4-mini", reason: "not_configured" });
  });

  it("SSV2-033: native fallback order is a tie-break, not a quality override", () => {
    const result = resolveRouterModelExpectation({
      complexity: "deep",
      nativeFallbackOrder: ["zhipu/glm-5.1"],
      models: [
        model("zhipu/glm-5.1", "standard", { tags: ["fallback#1"] }),
        model("cliproxyapi/gpt-5.5", "frontier"),
      ],
    });

    expect(result.expectedModel).toBe("cliproxyapi/gpt-5.5");
    expect(result.qualityFloor).toBe("frontier");
  });

  it("SSV2-034: duplicate wizard clicks are idempotent and answered steps are ignored", () => {
    const first = evaluateWizardStabilityState({
      currentStep: 1,
      answeredSteps: [],
      click: { step: 1, value: "start", atMs: 1_000 },
      previousClickAtMs: 0,
    });
    const duplicate = evaluateWizardStabilityState({
      currentStep: 2,
      answeredSteps: [1],
      click: { step: 1, value: "start", atMs: 1_010 },
      previousClickAtMs: 1_000,
    });

    expect(first.gate).toBe("pass");
    expect(first.nextStep).toBe(2);
    expect(duplicate.gate).toBe("pass");
    expect(duplicate.message).toBe("这一步已经回答过");
  });
});

describe("stability smoke v2 synthetic fixtures", () => {
  it("SSV2-020: accepts escaped spawn JSON when canonical content matches", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.spawn_intent_hash_escape",
      kind: "escaped_spawn_json",
      expectedSpawnArgs: { task: "line one\nline two" },
      observedSpawnArgsText: "{\"task\":\"line one\\nline two\"}",
    });

    expect(result.gate).toBe("pass");
    expect(result.failures.map((item) => item.code)).not.toContain("spawn_missing");
  });

  it("SSV2-021: classifies late ACK separately while preserving final delivery evidence", () => {
    const result = runSyntheticStabilityFixture({
      id: "ack.thread_anchor",
      kind: "late_ack",
      ackMs: 95_000,
      ackDeadlineMs: 90_000,
      finalDelivered: true,
      threadTs: "1770000000.000001",
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("ack_late");
    expect(result.failures[0]?.threadTs).toBe("1770000000.000001");
    expect(result.evidence.finalDelivered).toBe(true);
  });

  it("SSV2-022: provider 402 fixture rejects bare Slack provider errors", () => {
    const result = runSyntheticStabilityFixture({
      id: "provider.402_or_429_fallback",
      kind: "provider_status",
      statusCode: 402,
      slackText: "402 status code (no body)",
      fallbackAvailable: true,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("provider_bare_error");
  });

  it("SSV2-023: restart shutdown message is classified as gateway restart drop", () => {
    const result = runSyntheticStabilityFixture({
      id: "restart.shutting_down_message",
      kind: "restart_shutdown",
      slackText: "Previous run is still shutting down. Please try again in a moment.",
      restartWindowMs: 12_000,
    });

    expect(result.failures.map((item) => item.code)).toContain("gateway_restart_drop");
    expect(result.failures[0]?.stageMs?.restartWindowMs).toBe(12_000);
  });

  it("SSV2-024: wizard start cannot jump directly to completed", () => {
    const result = runSyntheticStabilityFixture({
      id: "wizard.start_resume_idempotent",
      kind: "wizard_start",
      nextState: "completed",
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("wizard_flow_stuck");
  });

  it("SSV2-025: missing replay makes replay-backed lanes unknown without faking pass", () => {
    const result = runNightlyReplayStabilityLane(undefined);

    expect(result.gate).toBe("unknown");
    expect(result.lanes.every((lane) => lane.gate === "unknown")).toBe(true);
    expect(result.failures.map((item) => item.code)).toContain("replay_missing");
  });

  it("SSV2-026: reuses nightly classifiers for replay-backed lanes", () => {
    const result = runNightlyReplayStabilityLane([
      {
        schema_version: "octoclaw.runtime_policy.replay_event/v1",
        event: "policy_resolved",
        at: "2026-05-20T00:00:00.000Z",
        sessionKey: "slack:channel:C123:thread:456",
        route: "delegate",
        systemPreferredRoute: "delegate",
        routerDecisionValid: true,
        confidence: 0.9,
        routeCommitId: "wc-001",
        turnId: "turn-1",
      },
      {
        schema_version: "octoclaw.runtime_policy.replay_event/v1",
        event: "route_commit_ack",
        at: "2026-05-20T00:00:00.100Z",
        sessionKey: "slack:channel:C123:thread:456",
        routeCommitId: "wc-001",
        turnId: "turn-1",
        ackSent: true,
        ack_delivery_state: "sent",
      },
    ]);

    expect(result.nightlyReport?.lanes.map((lane) => lane.lane)).toContain("route_quality");
    expect(result.lanes.map((lane) => lane.name)).toContain("nightly:route_quality");
    expect(result.lanes.map((lane) => lane.name)).toContain("nightly:route_commit_ack");
  });
});
