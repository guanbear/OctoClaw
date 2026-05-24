import type { ModelIntelLite } from "@octoclaw/router";
import { OPENROUTER_TOP20_OBSERVED_MODELS, ROUTER_SCORE_SANITY_MODELS } from "../stability/catalog.js";
import type { CapabilitySmokeFinding, CapabilitySmokeResult } from "./types.js";

export const COMPACT_SIBLING_PAIRS: ReadonlyArray<[compact: string, full: string]> = [
  ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  ["openai/gpt-5.4-mini", "openai/gpt-5.4"],
  ["minimax/minimax-m2.5", "minimax/minimax-m2.7"],
  ["qwen/qwen-3.6-plus", "qwen/qwen-3.7-max"],
  ["zhipu/glm-4.7", "zhipu/glm-5"],
];

const OBSERVATION_ONLY_PAIRS: ReadonlyArray<[subject: string, peer: string]> = [
  ["openai/gpt-5.4", "zhipu/glm-5.1"],
];

type SmokeModel = Pick<ModelIntelLite, "modelKey" | "capability">;

export function extractFamilyKey(modelKey: string): string {
  const name = modelKey.toLowerCase().split("/").pop() ?? modelKey.toLowerCase();
  if (name.startsWith("deepseek-v4")) return "deepseek-v4";
  if (name.startsWith("gpt-")) return name.replace(/-(mini|flash|lite|small|air)$/u, "").replace(/\.\d+$/u, "");
  if (name.startsWith("glm-")) return "glm";
  if (name.startsWith("qwen-")) return "qwen";
  if (name.startsWith("kimi-")) return "kimi";
  if (name.startsWith("minimax-m2")) return "minimax-m2";
  if (name.startsWith("claude-")) return name.split("-").slice(0, 2).join("-");
  return name.split(/[-.]/u)[0] ?? name;
}

export function isCompactVariant(modelKey: string): boolean {
  return /(^|[/._-])(mini|flash|lite|haiku|small|air|plus)([/._-]|$)/u.test(modelKey.toLowerCase());
}

export function runCapabilityEvidenceSmoke(
  models: SmokeModel[],
  options: { watchlist?: readonly string[]; openRouterTop20?: readonly string[] } = {},
): CapabilitySmokeResult {
  const watchlist = options.watchlist ?? ROUTER_SCORE_SANITY_MODELS;
  const openRouterTop20 = (options.openRouterTop20 ?? OPENROUTER_TOP20_OBSERVED_MODELS)
    .filter((modelKey) => modelKey !== "openrouter/auto");
  const byKey = new Map(models.map((model) => [canonicalKey(model.modelKey), model]));
  const findings: CapabilitySmokeFinding[] = [];
  const seenFindings = new Set<string>();

  const pushFinding = (finding: CapabilitySmokeFinding): void => {
    const key = `${finding.kind}:${finding.modelKey}:${finding.detail}:${finding.sibling ?? ""}`;
    if (seenFindings.has(key)) return;
    seenFindings.add(key);
    findings.push(finding);
  };

  const checkModel = (modelKey: string, fromOpenRouterTop20 = false): boolean => {
    const canonical = canonicalKey(modelKey);
    const model = byKey.get(canonical);
    if (!model) {
      pushFinding({ kind: "missing_evidence", modelKey: canonical, detail: fromOpenRouterTop20 ? "openrouter top20 model not in snapshot" : "not in snapshot" });
      return false;
    }
    const hasBenchmark = hasBenchmarkEvidence(model);
    if (!hasBenchmark) {
      pushFinding({ kind: "missing_evidence", modelKey: canonical, detail: "no benchmark score for coding_worker scenario" });
    }
    const confidence = model.capability.capabilityScore?.confidence ?? model.capability.scoreByScenario?.coding_worker?.confidence ?? model.capability.confidence;
    if (confidence === "low" || confidence === "unknown") {
      pushFinding({ kind: "low_confidence", modelKey: canonical, detail: `capability confidence is ${confidence}` });
    }
    return hasBenchmark && (confidence === "medium" || confidence === "high");
  };

  const coveredWatchlist = watchlist.filter((modelKey) => checkModel(modelKey)).length;
  const coveredTop20 = openRouterTop20.filter((modelKey) => checkModel(modelKey, true)).length;

  for (const [compact, full] of COMPACT_SIBLING_PAIRS) {
    const compactModel = byKey.get(canonicalKey(compact));
    const fullModel = byKey.get(canonicalKey(full));
    if (!compactModel || !fullModel) continue;
    const compactScore = evidenceScore(compactModel);
    const fullScore = evidenceScore(fullModel);
    if (compactScore === undefined && fullScore !== undefined) {
      pushFinding({
        kind: "missing_evidence",
        modelKey: canonicalKey(compact),
        detail: "compact variant has no benchmark evidence while sibling does",
        family: extractFamilyKey(compact),
        sibling: canonicalKey(full),
      });
      continue;
    }
    if (compactScore === undefined || fullScore === undefined || compactScore <= fullScore) continue;
    if (evidenceConfidence(compactModel) === "high" && evidenceConfidence(fullModel) === "high") continue;
    pushFinding({
      kind: "suspicious_ordering",
      modelKey: canonicalKey(compact),
      detail: "compact variant outranks full sibling without high-confidence evidence",
      family: extractFamilyKey(compact),
      sibling: canonicalKey(full),
    });
  }

  for (const [subject, peer] of OBSERVATION_ONLY_PAIRS) {
    const subjectKey = canonicalKey(subject);
    const peerKey = canonicalKey(peer);
    const subjectModel = byKey.get(subjectKey);
    const peerModel = byKey.get(peerKey);
    if (!subjectModel || !peerModel) continue;
    if (evidenceScore(subjectModel) === undefined || evidenceScore(peerModel) === undefined) continue;
    pushFinding({
      kind: "observation",
      modelKey: subjectKey,
      detail: "cross-family ordering is tracked for review only",
      family: `${extractFamilyKey(subject)}:${extractFamilyKey(peer)}`,
      sibling: peerKey,
    });
  }

  return {
    findings,
    watchlistChecked: watchlist.length,
    watchlistCoverage: ratio(coveredWatchlist, watchlist.length),
    openRouterTop20Checked: openRouterTop20.length,
    openRouterTop20Coverage: ratio(coveredTop20, openRouterTop20.length),
  };
}

function canonicalKey(modelKey: string): string {
  return modelKey.trim().toLowerCase()
    .replace(/^z-ai\/glm-/u, "zhipu/glm-")
    .replace(/^zai\/glm-/u, "zhipu/glm-")
    .replace(/^moonshot\//u, "moonshotai/")
    .replace(/^qwen\/qwen3([-.])/u, "qwen/qwen-3.");
}

function hasBenchmarkEvidence(model: SmokeModel): boolean {
  return evidenceScore(model) !== undefined;
}

function evidenceScore(model: SmokeModel): number | undefined {
  const unified = model.capability.capabilityScore?.score;
  if (typeof unified === "number" && Number.isFinite(unified)) return unified;
  const scenario = model.capability.scoreByScenario?.coding_worker?.score;
  return typeof scenario === "number" && Number.isFinite(scenario) ? scenario : undefined;
}

function evidenceConfidence(model: SmokeModel): string {
  return model.capability.capabilityScore?.confidence ?? model.capability.scoreByScenario?.coding_worker?.confidence ?? model.capability.confidence;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}
