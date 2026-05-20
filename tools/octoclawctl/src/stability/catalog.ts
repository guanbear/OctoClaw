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
    prompt: "请委派一个子任务查询当前运行状态，然后汇总结论。",
    maxRuntimeMs: 180_000,
    expect: { route: "delegate", footerVia: "native_announce", spawnEvidence: true },
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
    mode: "synthetic",
    severity: "major",
    tags: ["status", "read-only"],
    expect: { command: "openclaw gateway status", readOnly: true },
  },
];

const NIGHTLY_EXTRA_CASES: StabilityCase[] = [
  syntheticCase("ack.thread_anchor", "major", ["ack", "thread"], { sameThread: true }),
  syntheticCase("ack.no_misleading_text", "major", ["ack", "streaming"], { forbiddenText: ["任务已启动。", "还没好，再等等"] }),
  syntheticCase("delegate.spawn_intent_hash_escape", "major", ["delegate", "spawn-intent"], { canonicalSpawnArgs: true }),
  syntheticCase("delegate.native_final_footer", "blocker", ["delegate", "footer"], { footerVia: "native_announce" }),
  syntheticCase("footer.no_delegate_without_spawn", "blocker", ["footer", "delegate"], { delegateRequiresSpawn: true }),
  syntheticCase("router.simple_normal_deep_model_matrix", "major", ["router", "model-choice"], { complexityMatrix: ["simple", "normal", "deep"] }),
  wizardCase("wizard.start_resume_idempotent", "major", ["wizard", "idempotency"], { duplicateClickIdempotent: true }),
  providerCase("provider.402_or_429_fallback", "major", ["provider", "fallback"], { providerProbe: "synthetic", statusCodes: [402, 429] }),
  syntheticCase("restart.shutting_down_message", "major", ["restart", "gateway"], { classify: "gateway_restart_drop" }),
];

const FULL_EXTRA_CASES: StabilityCase[] = [
  wizardCase("wizard.full_slack_flow", "major", ["wizard", "slack"], { fullFlow: true }),
  syntheticCase("router.model_discovery_proposals", "major", ["router", "discovery"], { discoveredUnconfigured: "proposal_only" }),
  syntheticCase("router.health_cooldown_fallback_suggestion", "major", ["router", "health"], { cooldownExcludesExpected: true }),
  syntheticCase("restart.interruption_recovery", "major", ["restart", "recovery"], { restartWindowRecovery: true }),
  syntheticCase("delivery.duplicate_final_parent_echo", "blocker", ["delivery", "delegate"], { failureCode: "parent_echo_after_native_final" }),
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
