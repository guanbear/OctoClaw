import type {
  ModelConfigProposal,
  ModelConfigProposalItem,
  ModelIntelLite,
  ModelIntelSnapshot,
  RouterLiteCodingTier,
  ScenarioAbilityLite,
  ScenarioAbilityScore,
} from "./contracts.js";

const TIER_RANK: Record<RouterLiteCodingTier, number> = {
  mini: 1,
  standard: 2,
  strong: 3,
  frontier: 4,
  unknown: 0,
};

const SCENARIO_TIER_RANK: Record<ScenarioAbilityScore["tier"], number> = {
  S: 4,
  A: 3,
  B: 2,
  C: 1,
  unknown: 0,
};

const SCENARIO_KEYS = [
  "codingWorker",
  "agenticToolTask",
  "researchLookup",
  "dataLogAnalysis",
  "mainReasoning",
  "defaultDelegate",
] as const satisfies ReadonlyArray<keyof ScenarioAbilityLite>;

function priceScore(model: ModelIntelLite): number {
  const input = model.marketPrice.inputUsdPerMTok;
  const output = model.marketPrice.outputUsdPerMTok;
  if (input === undefined && output === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(input ?? 0, output ?? 0);
}

function hasReliableCapability(model: ModelIntelLite): boolean {
  return model.capability.evidence.includes("declared")
    || model.capability.evidence.includes("probed")
    || model.capability.evidence.includes("observed")
    || model.capability.evidence.includes("operator_override");
}

function hasStrongScenarioAbility(score: ScenarioAbilityScore | undefined): boolean {
  return score !== undefined
    && (score.tier === "S" || score.tier === "A")
    && (score.confidence === "high" || score.confidence === "medium");
}

function hasSufficientScenarioAbility(score: ScenarioAbilityScore | undefined): boolean {
  return score !== undefined && SCENARIO_TIER_RANK[score.tier] >= SCENARIO_TIER_RANK.B;
}

function scenarioPriorityScore(model: ModelIntelLite): number {
  return SCENARIO_TIER_RANK[model.scenarioAbility?.codingWorker.tier ?? "unknown"];
}

function hasMissingScenarioEvidence(score: ScenarioAbilityScore): boolean {
  return score.tier === "unknown" || score.confidence === "unknown" || score.confidence === "low";
}

function scenarioContext(model: ModelIntelLite): string {
  const codingWorker = model.scenarioAbility?.codingWorker;
  if (codingWorker === undefined) return "";
  return `; codingWorker tier is ${codingWorker.tier} with ${codingWorker.confidence} confidence`;
}

function configuredFalseWhyNotLive(model: ModelIntelLite): string {
  return `configured=false — candidate not in local OpenClaw config; live routing would require explicit operator enable${scenarioContext(model)}`;
}

function scenarioReason(model: ModelIntelLite): string {
  const codingWorker = model.scenarioAbility?.codingWorker;
  if (codingWorker === undefined) return "same_provider_lower_cost_candidate_found";
  return `Same-provider cheaper candidate with codingWorker tier ${codingWorker.tier}`;
}

function candidateScenarioBelowFloor(strongModel: ModelIntelLite | undefined, candidate: ModelIntelLite): boolean {
  return strongModel?.scenarioAbility !== undefined
    && candidate.scenarioAbility !== undefined
    && (candidate.scenarioAbility.codingWorker.tier === "C" || candidate.scenarioAbility.codingWorker.tier === "unknown");
}

function candidatePriority(strongModel: ModelIntelLite | undefined, candidate: ModelIntelLite): ModelConfigProposalItem["priority"] {
  if (hasStrongScenarioAbility(strongModel?.scenarioAbility?.codingWorker)
    && hasSufficientScenarioAbility(candidate.scenarioAbility?.codingWorker)) {
    return "high";
  }
  return "medium";
}

function makeProposalId(provider: string, action: string, modelKey = ""): string {
  return [provider, action, modelKey].filter(Boolean).join(":").replace(/[^a-z0-9_.:/-]+/giu, "-");
}

function providerGroups(models: ModelIntelLite[]): Map<string, ModelIntelLite[]> {
  const groups = new Map<string, ModelIntelLite[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return groups;
}

function analyzeProvider(provider: string, models: ModelIntelLite[]): ModelConfigProposalItem[] {
  const proposals: ModelConfigProposalItem[] = [];
  const configured = models.filter((model) => model.configured);
  const proposalOnly = models.filter((model) => !model.configured);
  const configuredStrongestRank = Math.max(0, ...configured.map((model) => TIER_RANK[model.capability.codingTier]));
  const hasConfiguredCheapLane = configured.some((model) => model.capability.codingTier === "mini" || model.capability.codingTier === "standard");
  const configuredStrongModels = configured.filter((model) => TIER_RANK[model.capability.codingTier] >= TIER_RANK.strong);
  const cheapestConfiguredStrong = configuredStrongModels.slice().sort((a, b) => priceScore(a) - priceScore(b))[0];
  const cheapCandidates = proposalOnly
    .filter((model) => model.capability.codingTier === "mini" || model.capability.codingTier === "standard")
    .filter((model) => cheapestConfiguredStrong ? priceScore(model) < priceScore(cheapestConfiguredStrong) : true)
    .sort((a, b) => scenarioPriorityScore(b) - scenarioPriorityScore(a) || priceScore(a) - priceScore(b));

  if (configured.length > 0 && configuredStrongestRank >= TIER_RANK.strong && !hasConfiguredCheapLane && cheapCandidates.length > 0) {
    const candidate = cheapCandidates[0];
    const reasonParts = [scenarioReason(candidate)];
    if (candidateScenarioBelowFloor(cheapestConfiguredStrong, candidate)) reasonParts.push("candidate_scenario_below_floor");
    proposals.push({
      id: makeProposalId(provider, "add_configured_model", candidate.modelKey),
      provider,
      candidateModel: candidate.modelKey,
      priority: candidatePriority(cheapestConfiguredStrong, candidate),
      action: "add_configured_model",
      reason: reasonParts.join("; "),
      expectedUse: "low-risk delegated work, short replies, or fallback lanes after probes pass",
      risk: hasReliableCapability(candidate) ? "requires auth/config and live gate; current candidate is proposal-only" : "capability is heuristic/catalog-only and requires probes before shadow",
      requiredAuth: `configure ${provider} model credentials/profile if not already available`,
      whyNotLive: configuredFalseWhyNotLive(candidate),
      sources: candidate.sources,
    });
  }

  if (configured.some((model) => model.scenarioAbility !== undefined)) {
    for (const scenario of SCENARIO_KEYS) {
      const hasCoverage = configured.some((model) => hasSufficientScenarioAbility(model.scenarioAbility?.[scenario]));
      if (!hasCoverage) {
        proposals.push({
          id: makeProposalId(provider, "scenario_lane_gap", scenario),
          provider,
          priority: "medium",
          action: "add_compatibility_probe",
          reason: `scenario_lane_gap:${scenario}; No configured model covers ${scenario} with sufficient ability`,
          expectedUse: `${scenario} tasks`,
          risk: "medium — untested model for this scenario",
          requiredAuth: "configured model access for scenario probes or operator-approved model enablement",
          whyNotLive: `scenario_coverage_gap=${scenario} — no configured model has tier B or better; live promotion risks task failure`,
          sources: uniqueSource(configured),
        });
      }
    }
  }

  if (configured.length > 0 && configuredStrongestRank >= TIER_RANK.strong && !hasConfiguredCheapLane && cheapCandidates.length === 0) {
    proposals.push({
      id: makeProposalId(provider, "refresh_catalog"),
      provider,
      priority: "low",
      action: "refresh_catalog",
      reason: "configured_strong_model_without_same_provider_cheap_candidate",
      expectedUse: "discover same-provider mini or standard models for cost-first and balanced modes",
      risk: "no live behavior changes; catalog data may be stale or provider may not expose cheaper capable models",
      requiredAuth: "none for local analysis; provider auth may be needed for probes later",
      whyNotLive: "no eligible configured lower-cost model exists",
      sources: uniqueSource(models),
    });
  }

  for (const model of configured) {
    if (model.plan.quotaPressure === "unknown") {
      proposals.push({
        id: makeProposalId(provider, "add_plan_override", model.modelKey),
        provider,
        candidateModel: model.modelKey,
        priority: "low",
        action: "add_plan_override",
        reason: "quota_pressure_unknown",
        expectedUse: "avoid treating subscriptions or unknown quota as free in cost-first mode",
        risk: "operator override must be kept fresh; unknown remains safest default",
        requiredAuth: "provider usage API or manual plan/quota override",
        whyNotLive: "quota_pressure=unknown — plan/quota evidence missing; cannot estimate cost impact for live promotion",
        sources: model.plan.sources.length > 0 ? model.plan.sources : model.sources,
      });
    }
    if (model.capability.toolUse === "unknown" || model.capability.structuredOutput === "unknown") {
      proposals.push({
        id: makeProposalId(provider, "add_compatibility_probe", model.modelKey),
        provider,
        candidateModel: model.modelKey,
        priority: "medium",
        action: "add_compatibility_probe",
        reason: "tool_or_structured_capability_unknown",
        expectedUse: "decide whether this configured model can safely handle delegated tool-using work",
        risk: "cheap smoke probes only; do not infer from model name alone",
        requiredAuth: "configured model access",
        whyNotLive: "tool_or_structured_capability=unknown — tool_use or structured_output status not confirmed; live promotion risks task failure",
        sources: model.capability.sources,
      });
    }
    if (model.scenarioAbility !== undefined && hasMissingScenarioEvidence(model.scenarioAbility.codingWorker)) {
      proposals.push({
        id: makeProposalId(provider, "add_compatibility_probe", `${model.modelKey}:coding-worker-scenario`),
        provider,
        candidateModel: model.modelKey,
        priority: "low",
        action: "add_compatibility_probe",
        reason: "coding_worker_scenario_evidence_missing",
        expectedUse: "validate whether this configured model can handle coding-worker delegated tasks",
        risk: "scenario probe only; no live routing changes until evidence improves",
        requiredAuth: "configured model access",
        whyNotLive: "scenario evidence is missing for coding_worker",
        sources: model.scenarioAbility.codingWorker.sources.map((source) => source.source),
      });
    }
    if (model.scenarioAbility !== undefined && hasMissingScenarioEvidence(model.scenarioAbility.agenticToolTask)) {
      proposals.push({
        id: makeProposalId(provider, "add_compatibility_probe", `${model.modelKey}:agentic-tool-task-scenario`),
        provider,
        candidateModel: model.modelKey,
        priority: "low",
        action: "add_compatibility_probe",
        reason: "agentic_tool_scenario_evidence_missing",
        expectedUse: "validate whether this configured model can handle agentic tool-task delegation",
        risk: "scenario probe only; no live routing changes until evidence improves",
        requiredAuth: "configured model access",
        whyNotLive: "scenario evidence is missing for agentic_tool_task",
        sources: model.scenarioAbility.agenticToolTask.sources.map((source) => source.source),
      });
    }
  }

  return proposals;
}

function uniqueSource(models: ModelIntelLite[]): string[] {
  return Array.from(new Set(models.flatMap((model) => model.sources))).filter(Boolean);
}

export function analyzeModelConfig(snapshot: ModelIntelSnapshot, generatedAt = new Date().toISOString()): ModelConfigProposal {
  const proposals = Array.from(providerGroups(snapshot.models).entries())
    .flatMap(([provider, models]) => analyzeProvider(provider, models))
    .sort((a, b) => {
      const priority = { high: 0, medium: 1, low: 2 };
      return priority[a.priority] - priority[b.priority] || a.id.localeCompare(b.id);
    });

  return {
    schemaVersion: "octoclaw.router_lite.model_config_proposal/v1",
    generatedAt,
    snapshotId: snapshot.snapshotId,
    proposals,
    summary: {
      configuredModels: snapshot.models.filter((model) => model.configured).length,
      proposalOnlyModels: snapshot.models.filter((model) => !model.configured).length,
      providers: providerGroups(snapshot.models).size,
    },
  };
}
