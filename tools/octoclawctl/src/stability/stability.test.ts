import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelIntelLite } from "@octoclaw/router";
import {
  buildCatalogCasePack,
  buildAiCaseSelectionPrompt,
  buildAiReviewPrompt,
  classifyStabilityFailure,
  evaluateWizardStabilityState,
  evaluateFixDraftGuard,
  resolveRouterModelExpectation,
  runStabilityOrchestration,
  runNightlyReplayStabilityLane,
  runSyntheticStabilityFixture,
  sanitizeStabilityArtifact,
  selectStabilityCasePackFromAi,
  shouldRunFixDraft,
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
      "provider.post_deploy_fallback",
      "restart.post_deploy_recovery",
    ]);
    expect(pack.cases.every((item) => item.severity === "blocker" || item.severity === "major")).toBe(true);
  });

  it("SSV2-001: nightly and full catalog cases carry executable fixture metadata for historical regressions", () => {
    const nightly = buildCatalogCasePack("nightly", { generatedAt: "2026-05-20T00:00:00.000Z" });
    const full = buildCatalogCasePack("full_3d", { generatedAt: "2026-05-20T00:00:00.000Z" });

    expect(nightly.cases.find((item) => item.id === "ack.thread_anchor")?.expect).toMatchObject({
      fixtureKind: "ack_thread",
      expectedThreadTs: "thread-ok",
      observedThreadTs: "thread-ok",
    });
    expect(nightly.cases.find((item) => item.id === "footer.no_delegate_without_spawn")?.expect).toMatchObject({
      fixtureKind: "delegate_footer",
      failureCode: "delegate_footer_without_spawn",
    });
    expect(nightly.cases.find((item) => item.id === "exec.heavy_main_tool_after_escalation")?.expect).toMatchObject({
      fixtureKind: "main_tool_guard",
      failureCode: "main_tool_after_escalation",
    });
    expect(nightly.cases.find((item) => item.id === "delegate.spawn_mismatch_recovery")?.expect).toMatchObject({
      fixtureKind: "native_spawn_recovery",
      failureCode: "native_spawn_redispatch_after_mismatch",
    });
    expect(nightly.cases.find((item) => item.id === "provider.402_or_429_fallback")?.expect).toMatchObject({
      fixtureKind: "provider_status",
      failureCode: "provider_bare_error",
    });
    expect(full.cases.find((item) => item.id === "delivery.duplicate_final_parent_echo")?.expect).toMatchObject({
      fixtureKind: "native_final_delivery",
      failureCode: "parent_echo_after_native_final",
    });
    expect(nightly.cases.find((item) => item.id === "delegate.parallel_children_status_panel")?.expect).toMatchObject({
      fixtureKind: "parallel_children_status",
      expectedChildCount: 2,
      visibleChildCount: 2,
      mainResponsiveDuringChildren: true,
    });
    expect(full.cases.find((item) => item.id === "delegate.parallel_two_children_status")).toMatchObject({
      mode: "live_slack",
      severity: "major",
      tags: expect.arrayContaining(["slack", "delegate", "parallel", "status"]),
      expect: expect.objectContaining({
        route: "delegate",
        minSpawnEvidence: 2,
        statusPanelMinChildren: 2,
        mainResponsiveDuringChildren: true,
        footerDifficultyRequired: true,
      }),
    });
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

describe("stability smoke v2 AI selection and review guards", () => {
  it("SSV2-040: invalid AI JSON falls back to the catalog nightly pack", () => {
    const result = selectStabilityCasePackFromAi("not json", {
      generatedAt: "2026-05-20T00:00:00.000Z",
      maxLiveCases: 8,
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.pack.generatedBy).toBe("catalog");
    expect(result.pack.runKind).toBe("nightly");
    expect(result.failureCode).toBe("smoke_spec_mismatch");
  });

  it("SSV2-041: low confidence asks GPT-5.5 to review without adding live cases", () => {
    const prompt = buildAiCaseSelectionPrompt({
      recentReportSummaries: ["ack_misleading_text yesterday"],
      modelListSummary: "zhipu/glm-5.1, cliproxyapi/gpt-5.5",
    });
    const result = selectStabilityCasePackFromAi(JSON.stringify({
      confidence: 0.4,
      casePack: buildCatalogCasePack("nightly", { generatedAt: "2026-05-20T00:00:00.000Z" }),
    }), { generatedAt: "2026-05-20T00:00:00.000Z", maxLiveCases: 8 });

    expect(prompt.model).toBe("zhipu/GLM-5.1");
    expect(result.escalationModel).toBe("cliproxyapi/gpt-5.5");
    expect(result.pack.cases.filter((item) => item.mode === "live_slack").length).toBeLessThanOrEqual(8);
  });

  it("SSV2-042: AI review prompt uses failure packets and redacts secrets", () => {
    const prompt = buildAiReviewPrompt([
      {
        code: "provider_bare_error",
        severity: "major",
        caseId: "provider.402_or_429_fallback",
        mode: "provider",
        artifactPaths: { error: "xoxb-secret-token" },
      },
    ]);

    expect(prompt.model).toBe("zhipu/GLM-5.1");
    expect(prompt.prompt).toContain("provider_bare_error");
    expect(prompt.prompt).not.toContain("xoxb-secret-token");
  });

  it("SSV2-043: fix draft skips environment-only issues", () => {
    const classified = classifyStabilityFailure({
      code: "gateway_restart_drop",
      severity: "major",
      caseId: "restart.shutting_down_message",
      mode: "synthetic",
    });

    expect(classified.classification).toBe("environment_issue");
    expect(shouldRunFixDraft([classified])).toBe(false);
  });

  it("SSV2-044: fix draft runs only for blocker or major runtime bugs", () => {
    const runtimeBug = classifyStabilityFailure({
      code: "delegate_footer_without_spawn",
      severity: "major",
      caseId: "delegate_core.native_final",
      mode: "live_slack",
    });

    expect(runtimeBug.classification).toBe("runtime_bug");
    expect(shouldRunFixDraft([runtimeBug])).toBe(true);
  });

  it("SSV2-045: confirmation guard blocks commit push deploy restart and config mutation", () => {
    const result = evaluateFixDraftGuard({
      filesChanged: 1,
      linesChanged: 20,
      touchesHotPath: false,
      validationPassed: true,
      attemptedCommands: ["git commit -m test", "openclaw gateway restart"],
      mutatesOpenClawConfig: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["blocked_command:commit", "blocked_command:restart", "blocked_openclaw_config_mutation"]));
  });

  it("SSV2-046: size and risk guard marks large or hot-path drafts for human review", () => {
    const result = evaluateFixDraftGuard({
      filesChanged: 6,
      linesChanged: 301,
      touchesHotPath: true,
      validationPassed: false,
      attemptedCommands: [],
      mutatesOpenClawConfig: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["too_many_files", "too_many_lines", "hot_path_touched", "validation_failed"]));
  });
});

describe("stability smoke v2 synthetic fixtures", () => {
  it("SSV2-051: honors Slack acceptance config token env names when classifying live availability", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-config-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    const configPath = path.join(tmpDir, "slack-acceptance.json");
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({
        botTokenEnv: "OCTOCLAW_SLACK_ACCEPTANCE_BOT_TOKEN",
        userTokenEnv: "OCTOCLAW_SLACK_ACCEPTANCE_USER_TOKEN",
        sessionKey: "octoclaw:stability:test",
        target: { channel: "CSTABILITY", allowDm: false, allowProductionTarget: false },
        isolation: { enabled: true, allowUserToken: true },
      }), "utf8");

      const result = await runStabilityOrchestration({
        subcommand: "post-deploy",
        outputDir,
        config: configPath,
        env: {
          OCTOCLAW_SLACK_ACCEPTANCE_BOT_TOKEN: "xoxb-test-token",
          OCTOCLAW_SLACK_ACCEPTANCE_USER_TOKEN: "xoxp-test-token",
        },
      });

      const liveLane = result.lanes.find((lane) => lane.name === "slack_delivery");
      expect(result.skippedLiveReason).toBeUndefined();
      expect(liveLane?.failureCodes).toEqual(["live_slack_not_run"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-051: preserves live Slack failure diagnostics in stability reports", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-live-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "post-deploy",
        outputDir,
        env: {},
        liveSlackReport: {
          overallGate: "fail",
          cases: [
            {
              id: "delegate_core.native_final",
              status: "fail",
              threadTs: "1779247876.372879",
              errors: ["footer_via_mismatch:expected=native_announce:actual=budgeted_main_escalation"],
              progress: [{ event: "final_timed_out", elapsedMs: 180000, detail: "required final missing" }],
            },
          ],
        },
      });

      const failure = result.failures.find((item) => item.caseId === "delegate_core.native_final");
      expect(failure?.threadTs).toBe("1779247876.372879");
      expect(failure?.errors).toContain("footer_via_mismatch:expected=native_announce:actual=budgeted_main_escalation");
      expect(failure?.progress?.[0]?.event).toBe("final_timed_out");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-052: post-deploy smoke does not require nightly replay evidence", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-post-deploy-no-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "post-deploy",
        outputDir,
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
          ],
        },
      });

      expect(result.overallGate).toBe("pass");
      expect(result.failures.find((item) => item.caseId === "nightly_replay")).toBeUndefined();
      expect(result.lanes.some((lane) => lane.name.startsWith("nightly:"))).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-053: live Slack reports must include every catalog live case for the selected run kind", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-missing-live-case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "full",
        outputDir,
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
          ],
        },
      });

      expect(result.overallGate).toBe("unknown");
      expect(result.failures).toContainEqual(expect.objectContaining({
        code: "live_slack_case_missing",
        caseId: "delegate.parallel_two_children_status",
        mode: "live_slack",
      }));
      expect(result.lanes.find((lane) => lane.name === "slack_delivery")?.failureCodes).toContain("live_slack_case_missing");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-024: orchestration executes wizard fixtures instead of leaving the lane unknown", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-wizard-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "nightly",
        outputDir,
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
          ],
        },
      });

      expect(result.lanes.find((lane) => lane.name === "wizard_contract")?.gate).toBe("pass");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-052b: nightly smoke reads replayPath from the configured Slack acceptance config", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-nightly-replay-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    const replayPath = path.join(tmpDir, "runtime-policy-replay.jsonl");
    const configPath = path.join(tmpDir, "slack-acceptance.json");
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(replayPath, [
        JSON.stringify({
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
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "route_commit_ack",
          at: "2026-05-20T00:00:00.100Z",
          sessionKey: "slack:channel:C123:thread:456",
          routeCommitId: "wc-001",
          turnId: "turn-1",
          ackSent: true,
          ack_delivery_state: "sent",
        }),
      ].join("\n"), "utf8");
      await fs.writeFile(configPath, JSON.stringify({ replayPath }), "utf8");

      const result = await runStabilityOrchestration({
        subcommand: "nightly",
        outputDir,
        config: configPath,
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
            { id: "delegate.parallel_two_children_status", status: "pass" },
          ],
        },
      });

      expect(result.failures.map((item) => item.code)).not.toContain("replay_missing");
      expect(result.lanes.map((lane) => lane.name)).toContain("nightly:route_quality");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-052c: ad-hoc stability runs can scope replay lanes to events after run start", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-nightly-replay-since-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    const replayPath = path.join(tmpDir, "runtime-policy-replay.jsonl");
    const configPath = path.join(tmpDir, "slack-acceptance.json");
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(replayPath, [
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "execution_transition",
          at: "2026-05-20T00:00:00.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:old",
          transitionKind: "spawn_failed",
          sent: true,
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "policy_resolve_completed",
          at: "2026-05-20T01:00:01.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:new",
          route: "reply",
          decision_bucket: "must_reply",
          workContractId: "wc-new",
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "neutral_inbound_ack",
          at: "2026-05-20T01:00:02.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:new",
          replyToMessageId: "new",
          hookName: "message_received",
          sent: true,
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "execution_transition",
          at: "2026-05-20T01:00:03.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:new",
          transitionKind: "spawn_started",
          sent: true,
          workContractId: "wc-new",
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "sessions_spawn_intent_allowed",
          at: "2026-05-20T01:00:04.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:new",
          route: "delegate",
          work_contract_id: "wc-new",
        }),
        JSON.stringify({
          schema_version: "octoclaw.runtime_policy.replay_event/v1",
          event: "native_announce_final_delivered",
          at: "2026-05-20T01:00:05.000Z",
          sessionKey: "agent:main:slack:channel:C_REAL:thread:new",
          workContractId: "wc-new",
        }),
      ].join("\n"), "utf8");
      await fs.writeFile(configPath, JSON.stringify({ replayPath }), "utf8");

      const result = await runStabilityOrchestration({
        subcommand: "nightly",
        outputDir,
        config: configPath,
        replaySince: "2026-05-20T01:00:00.000Z",
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
          ],
        },
      });

      expect(result.failures.map((item) => item.code)).not.toContain("nightly_execution_transition_fail");
      expect(result.lanes.find((lane) => lane.name === "nightly:execution_transition")?.gate).toBe("pass");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-023: full recovery fixture does not reuse the shutdown failure text", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-full-restart-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "full",
        outputDir,
        env: {},
        liveSlackReport: {
          overallGate: "pass",
          cases: [
            { id: "reply_core.simple_chat", status: "pass" },
            { id: "streaming_core.long_reply", status: "pass" },
            { id: "delegate_core.native_final", status: "pass" },
            { id: "footer_truth.current_model", status: "pass" },
            { id: "status_core.read_only", status: "pass" },
          ],
        },
      });

      expect(result.failures.find((item) => item.caseId === "restart.interruption_recovery")).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("SSV2-025: parallel children fixture passes when both children are visible and main remains responsive", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.parallel_children_status_panel",
      kind: "parallel_children_status",
      expectedChildCount: 2,
      visibleChildCount: 2,
      mainResponsiveDuringChildren: true,
      children: [
        { workContractId: "wc-a", childSessionKey: "agent:main:subagent:a", status: "running", title: "task A" },
        { workContractId: "wc-b", childSessionKey: "agent:main:subagent:b", status: "running", title: "task B" },
      ],
    });

    expect(result.gate).toBe("pass");
    expect(result.evidence).toMatchObject({
      expectedChildCount: 2,
      visibleChildCount: 2,
      mainResponsiveDuringChildren: true,
    });
  });

  it("SSV2-026: parallel children fixture fails when the status panel hides a running child", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.parallel_children_status_panel",
      kind: "parallel_children_status",
      expectedChildCount: 2,
      visibleChildCount: 1,
      mainResponsiveDuringChildren: true,
      children: [
        { workContractId: "wc-a", childSessionKey: "agent:main:subagent:a", status: "running", title: "task A" },
        { workContractId: "wc-b", childSessionKey: "agent:main:subagent:b", status: "running", title: "task B" },
      ],
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("parallel_status_missing_child");
  });

  it("SSV2-027: parallel children fixture fails when main cannot respond during children", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.parallel_children_status_panel",
      kind: "parallel_children_status",
      expectedChildCount: 2,
      visibleChildCount: 2,
      mainResponsiveDuringChildren: false,
      children: [
        { workContractId: "wc-a", childSessionKey: "agent:main:subagent:a", status: "running", title: "task A" },
        { workContractId: "wc-b", childSessionKey: "agent:main:subagent:b", status: "running", title: "task B" },
      ],
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("parallel_main_unresponsive");
  });

  it("SSV2-013/SSV2-022: orchestration treats expected synthetic regression classifications as pass evidence", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `stability-expected-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputDir = path.join(tmpDir, "reports");
    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const result = await runStabilityOrchestration({
        subcommand: "nightly",
        outputDir,
        env: {},
      });

      expect(result.lanes.find((lane) => lane.name === "synthetic_fixtures")?.gate).toBe("pass");
      expect(result.lanes.find((lane) => lane.name === "synthetic_fixtures")?.caseIds).toContain("footer.no_delegate_without_spawn");
      expect(result.failures.find((item) => item.caseId === "footer.no_delegate_without_spawn")).toBeUndefined();
      expect(result.lanes.find((lane) => lane.name === "provider_resilience")?.gate).toBe("pass");
      expect(result.failures.find((item) => item.caseId === "provider.402_or_429_fallback")).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

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

  it("SSV2-021: classifies ACK delivered outside the target thread", () => {
    const result = runSyntheticStabilityFixture({
      id: "ack.thread_anchor",
      kind: "ack_thread",
      expectedThreadTs: "1770000000.000001",
      observedThreadTs: "1770000000.000999",
      ackText: "任务已启动。",
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("ack_wrong_thread");
    expect(result.failures[0]?.threadTs).toBe("1770000000.000999");
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

  it("SSV2-022: provider fallback unavailable must be clear instead of a raw provider error", () => {
    const result = runSyntheticStabilityFixture({
      id: "provider.402_or_429_fallback",
      kind: "provider_status",
      statusCode: 429,
      slackText: "429 status code (no body)",
      fallbackAvailable: false,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("provider_no_fallback");
  });

  it("SSV2-013: delegate footer without spawn evidence is covered synthetically", () => {
    const result = runSyntheticStabilityFixture({
      id: "footer.no_delegate_without_spawn",
      kind: "delegate_footer",
      footerRoute: "delegate",
      hasSpawnIntent: false,
      hasChildSession: false,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("delegate_footer_without_spawn");
  });

  it("SSV2-016: delegate footer without difficulty is covered synthetically", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.native_final_footer",
      kind: "delegate_footer",
      footerRoute: "delegate",
      hasSpawnIntent: true,
      hasChildSession: true,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("delegate_footer_missing_difficulty");
  });

  it("SSV2-018: ordinary main tool after budget escalation is covered synthetically", () => {
    const result = runSyntheticStabilityFixture({
      id: "exec.heavy_main_tool_after_escalation",
      kind: "main_tool_guard",
      route: "reply",
      escalationReason: "tool_risk_unknown",
      attemptedToolName: "exec",
      ordinaryToolRanAfterEscalation: true,
      dispatchCalled: false,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("main_tool_after_escalation");
  });

  it("SSV2-018: dispatch after budget escalation passes the synthetic guard", () => {
    const result = runSyntheticStabilityFixture({
      id: "exec.heavy_tool_dispatched_after_escalation",
      kind: "main_tool_guard",
      route: "reply",
      escalationReason: "tool_risk_unknown",
      attemptedToolName: "exec",
      ordinaryToolRanAfterEscalation: false,
      dispatchCalled: true,
    });

    expect(result.gate).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("SSV2-019: native spawn mismatch recovery must not redispatch into ticket_used", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.spawn_mismatch_recovery",
      kind: "native_spawn_recovery",
      mismatchBlocked: true,
      redispatchAfterMismatch: true,
      terminalError: "delegation_ticket_rejected:ticket_used",
      finalSpawnAllowed: false,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toContain("native_spawn_redispatch_after_mismatch");
  });

  it("SSV2-019: retrying sessions_spawn after a mismatch passes the synthetic guard", () => {
    const result = runSyntheticStabilityFixture({
      id: "delegate.spawn_mismatch_recovery",
      kind: "native_spawn_recovery",
      mismatchBlocked: true,
      redispatchAfterMismatch: false,
      terminalError: "",
      finalSpawnAllowed: true,
    });

    expect(result.gate).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("SSV2-014: parent echo after native final is covered synthetically", () => {
    const result = runSyntheticStabilityFixture({
      id: "delivery.duplicate_final_parent_echo",
      kind: "native_final_delivery",
      nativeFinalDelivered: true,
      parentEchoAfterNativeFinalCount: 1,
      duplicateFinalCount: 1,
    });

    expect(result.gate).toBe("fail");
    expect(result.failures.map((item) => item.code)).toEqual(expect.arrayContaining([
      "parent_echo_after_native_final",
      "duplicate_final",
    ]));
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
