import type {
  ModelConfigProposal,
  ModelConfigProposalItem,
  ModelIntelLite,
  ModelIntelSnapshot,
  RouterLiteCodingTier,
} from "./contracts.js";

const TIER_RANK: Record<RouterLiteCodingTier, number> = {
  mini: 1,
  standard: 2,
  strong: 3,
  frontier: 4,
  unknown: 0,
};

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
    .sort((a, b) => priceScore(a) - priceScore(b));

  if (configured.length > 0 && configuredStrongestRank >= TIER_RANK.strong && !hasConfiguredCheapLane && cheapCandidates.length > 0) {
    const candidate = cheapCandidates[0];
    proposals.push({
      id: makeProposalId(provider, "add_configured_model", candidate.modelKey),
      provider,
      candidateModel: candidate.modelKey,
      priority: "medium",
      action: "add_configured_model",
      reason: "same_provider_lower_cost_candidate_found",
      expectedUse: "low-risk delegated work, short replies, or fallback lanes after probes pass",
      risk: hasReliableCapability(candidate) ? "requires auth/config and live gate; current candidate is proposal-only" : "capability is heuristic/catalog-only and requires probes before shadow",
      requiredAuth: `configure ${provider} model credentials/profile if not already available`,
      whyNotLive: "configured=false candidates are proposal-only; no live routing change is allowed",
      sources: candidate.sources,
    });
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
        whyNotLive: "unknown quota is not a free signal",
        sources: model.plan.sources.length > 0 ? model.plan.sources : model.sources,
      });
    }
    if (model.capability.toolUse === "unknown" || model.capability.structuredOutput === "unknown") {
      proposals.push({
        id: makeProposalId(provider, "add_capability_probe", model.modelKey),
        provider,
        candidateModel: model.modelKey,
        priority: "medium",
        action: "add_capability_probe",
        reason: "tool_or_structured_capability_unknown",
        expectedUse: "decide whether this configured model can safely handle delegated tool-using work",
        risk: "cheap smoke probes only; do not infer from model name alone",
        requiredAuth: "configured model access",
        whyNotLive: "unknown tool/structured support cannot satisfy tool-required tasks",
        sources: model.capability.sources,
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
