import { CASE_PACK_SCHEMA_VERSION, type BuildCatalogOptions, type StabilityCase, type StabilityCasePack, type StabilityRunKind } from "./types.js";

const POST_DEPLOY_CASES: StabilityCase[] = [
  {
    id: "reply_core.simple_chat",
    mode: "live_slack",
    severity: "blocker",
    tags: ["slack", "reply", "footer"],
    prompt: "请用一句话回复：当前 Slack smoke 正常。",
    maxRuntimeMs: 60_000,
    expect: { route: "reply", noSpawn: true },
  },
  {
    id: "streaming_core.long_reply",
    mode: "live_slack",
    severity: "major",
    tags: ["slack", "streaming", "ack"],
    prompt: "写一段 300 字左右的中文说明，用来验证 Slack 流式回复不会出现误导 ACK。",
    maxRuntimeMs: 120_000,
    expect: { noMisleadingAck: true, finalRequired: true },
  },
  {
    id: "delegate_core.native_final",
    mode: "live_slack",
    severity: "blocker",
    tags: ["slack", "delegate", "native-final"],
    prompt: "请委派一个子 agent 独立做只读检查：确认 OpenClaw Gateway 和 OctoClaw readiness 的当前状态，然后等子任务完成后给 3 条中文摘要。不要由主会话直接回答。",
    maxRuntimeMs: 180_000,
    expect: { route: "delegate", footerVia: "native_announce", footerDifficultyRequired: true, spawnEvidence: true },
  },
  {
    id: "footer_truth.current_model",
    mode: "live_slack",
    severity: "major",
    tags: ["slack", "footer", "model"],
    prompt: "你现在用的是什么模型？",
    maxRuntimeMs: 90_000,
    expect: { footerMatchesReplay: true },
  },
  {
    id: "status_core.read_only",
    mode: "live_slack",
    severity: "major",
    tags: ["status", "read-only"],
    prompt: "请只读检查当前 Gateway 是否运行正常，用一句话回答状态，不要委派子任务。",
    maxRuntimeMs: 90_000,
    expect: { command: "openclaw gateway status", readOnly: true },
  },
];

const NIGHTLY_EXTRA_CASES: StabilityCase[] = [
  syntheticCase("ack.thread_anchor", "major", ["ack", "thread"], { fixtureKind: "ack_thread", expectedThreadTs: "thread-ok", observedThreadTs: "thread-ok" }),
  syntheticCase("ack.no_misleading_text", "major", ["ack", "streaming"], { fixtureKind: "late_ack", ackMs: 0, ackDeadlineMs: 90_000, forbiddenText: ["任务已启动。", "还没好，再等等"] }),
  syntheticCase("delegate.spawn_intent_hash_escape", "major", ["delegate", "spawn-intent"], { fixtureKind: "escaped_spawn_json", canonicalSpawnArgs: true }),
  syntheticCase("delegate.spawn_mismatch_recovery", "blocker", ["delegate", "spawn-intent", "ticket"], { fixtureKind: "native_spawn_recovery", mismatchBlocked: true, redispatchAfterMismatch: true, terminalError: "delegation_ticket_rejected:ticket_used", finalSpawnAllowed: false, failureCode: "native_spawn_redispatch_after_mismatch" }),
  syntheticCase("delegate.native_final_footer", "blocker", ["delegate", "footer"], { fixtureKind: "delegate_footer", footerRoute: "delegate", footerDifficulty: "normal", hasSpawnIntent: true, hasChildSession: true, footerVia: "native_announce" }),
  syntheticCase("footer.no_delegate_without_spawn", "blocker", ["footer", "delegate"], { fixtureKind: "delegate_footer", footerRoute: "delegate", hasSpawnIntent: false, hasChildSession: false, failureCode: "delegate_footer_without_spawn" }),
  syntheticCase("exec.heavy_main_tool_after_escalation", "blocker", ["exec", "dispatch", "budgeted-main"], { fixtureKind: "main_tool_guard", route: "reply", escalationReason: "tool_risk_unknown", attemptedToolName: "exec", ordinaryToolRanAfterEscalation: true, dispatchCalled: false, failureCode: "main_tool_after_escalation" }),
  syntheticCase("router.simple_normal_deep_model_matrix", "major", ["router", "model-choice"], { complexityMatrix: ["simple", "normal", "deep"] }),
  wizardCase("wizard.start_resume_idempotent", "major", ["wizard", "idempotency"], { duplicateClickIdempotent: true }),
  providerCase("provider.402_or_429_fallback", "major", ["provider", "fallback"], { fixtureKind: "provider_status", providerProbe: "synthetic", statusCodes: [402, 429], fallbackAvailable: true, failureCode: "provider_bare_error" }),
  syntheticCase("restart.shutting_down_message", "major", ["restart", "gateway"], { fixtureKind: "restart_shutdown", classify: "gateway_restart_drop", failureCode: "gateway_restart_drop" }),
];

const FULL_EXTRA_CASES: StabilityCase[] = [
  wizardCase("wizard.full_slack_flow", "major", ["wizard", "slack"], { fullFlow: true }),
  syntheticCase("router.model_discovery_proposals", "major", ["router", "discovery"], { discoveredUnconfigured: "proposal_only" }),
  syntheticCase("router.health_cooldown_fallback_suggestion", "major", ["router", "health"], { cooldownExcludesExpected: true }),
  syntheticCase("restart.interruption_recovery", "major", ["restart", "recovery"], { restartWindowRecovery: true }),
  syntheticCase("delivery.duplicate_final_parent_echo", "blocker", ["delivery", "delegate"], { fixtureKind: "native_final_delivery", nativeFinalDelivered: true, parentEchoAfterNativeFinalCount: 1, duplicateFinalCount: 1, failureCode: "parent_echo_after_native_final" }),
];

export function buildCatalogCasePack(runKind: StabilityRunKind, options: BuildCatalogOptions = {}): StabilityCasePack {
  const cases = catalogCasesFor(runKind).map((item) => cloneCase(item));

  return {
    schemaVersion: CASE_PACK_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generatedBy: "catalog",
    runKind,
    cases,
  };
}

function catalogCasesFor(runKind: StabilityRunKind): StabilityCase[] {
  if (runKind === "post_deploy") {
    return POST_DEPLOY_CASES;
  }
  if (runKind === "nightly") {
    return [...POST_DEPLOY_CASES, ...NIGHTLY_EXTRA_CASES];
  }
  if (runKind === "full_3d") {
    return [...POST_DEPLOY_CASES, ...NIGHTLY_EXTRA_CASES, ...FULL_EXTRA_CASES];
  }
  return [
    syntheticCase("manual.empty", "observe", ["manual"], {
      note: "manual packs are normally provided by caller",
    }),
  ];
}

function cloneCase(item: StabilityCase): StabilityCase {
  return {
    ...item,
    tags: [...item.tags],
    expect: { ...item.expect },
  };
}

function syntheticCase(id: string, severity: StabilityCase["severity"], tags: string[], expect: Record<string, unknown>): StabilityCase {
  return {
    id,
    mode: "synthetic",
    severity,
    tags,
    expect,
  };
}

function wizardCase(id: string, severity: StabilityCase["severity"], tags: string[], expect: Record<string, unknown>): StabilityCase {
  return {
    id,
    mode: "wizard",
    severity,
    tags,
    expect,
  };
}

function providerCase(id: string, severity: StabilityCase["severity"], tags: string[], expect: Record<string, unknown>): StabilityCase {
  return {
    id,
    mode: "provider",
    severity,
    tags,
    expect,
  };
}
