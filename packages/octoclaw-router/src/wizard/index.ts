import type { ModelIntelLite } from "../decision/contracts.js";
import type { RouterOverrideConfig } from "../overrides/index.js";
import { createEmptyOverrides } from "../overrides/index.js";

export interface RouterWizardConfig {
  schemaVersion: "octoclaw.router_wizard/v1";
  completedAt: string;
  models: Record<string, { planType: "subscription" | "pay_as_you_go" | "unknown"; configuredAt: string }>;
  budget?: { monthly: number; currency: "USD" };
  privacy: "standard" | "local_only";
  restrictedModels: string[];
  overrides: RouterOverrideConfig;
}

export function createWizardConfig(modelIds: string[], options: {
  now?: string;
  budgetInput?: string;
  privacy?: RouterWizardConfig["privacy"];
  restrictedModels?: string[];
} = {}): RouterWizardConfig {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: "octoclaw.router_wizard/v1",
    completedAt: now,
    models: Object.fromEntries(modelIds.map((model) => [model, { planType: detectPlanType(model), configuredAt: now }])),
    budget: options.budgetInput ? parseBudgetInput(options.budgetInput) : undefined,
    privacy: options.privacy ?? "standard",
    restrictedModels: options.restrictedModels ?? [],
    overrides: createEmptyOverrides(),
  };
}

export function mergeIncrementalWizardConfig(
  existing: RouterWizardConfig,
  configuredModels: string[],
  now = new Date().toISOString(),
): { config: RouterWizardConfig; newModels: string[] } {
  const next: RouterWizardConfig = {
    ...existing,
    models: Object.fromEntries(Object.entries(existing.models).map(([model, value]) => [model, { ...value }])),
    restrictedModels: [...existing.restrictedModels],
    overrides: {
      scoreOverrides: Object.fromEntries(Object.entries(existing.overrides.scoreOverrides).map(([model, tiers]) => [model, { ...tiers }])),
      userBans: Object.fromEntries(Object.entries(existing.overrides.userBans).map(([model, tiers]) => [model, [...tiers]])),
      userDispreferred: Object.fromEntries(Object.entries(existing.overrides.userDispreferred).map(([model, tiers]) => [model, [...tiers]])),
      entries: existing.overrides.entries.map((entry) => ({ ...entry })),
    },
  };
  const newModels = configuredModels.filter((model) => next.models[model] === undefined);
  for (const model of newModels) {
    next.models[model] = { planType: detectPlanType(model), configuredAt: now };
  }
  return { config: next, newModels };
}

export function detectPlanType(model: string): RouterWizardConfig["models"][string]["planType"] {
  const lower = model.toLowerCase();
  if (lower.includes("codex") || lower.includes("chatgpt") || lower.includes("claude") || lower.includes("glm")) {
    return "subscription";
  }
  return "pay_as_you_go";
}

export function parseBudgetInput(input: string): { monthly: number; currency: "USD" } {
  const normalized = input.trim().replace(/^\$/u, "").replace(/\s*usd$/iu, "");
  const monthly = Number(normalized);
  if (!Number.isFinite(monthly) || monthly < 0) throw new Error(`Invalid budget: ${input}`);
  return { monthly, currency: "USD" };
}

export function applyWizardModelFilters<T extends Pick<ModelIntelLite, "modelKey" | "provider">>(
  models: T[],
  config: Pick<RouterWizardConfig, "restrictedModels" | "privacy">,
): { models: T[]; rejectedModels: Array<{ model: string; reason: "user_restricted" | "privacy_local_only" }> } {
  const rejectedModels: Array<{ model: string; reason: "user_restricted" | "privacy_local_only" }> = [];
  const filtered = models.filter((model) => {
    if (config.restrictedModels.includes(model.modelKey)) {
      rejectedModels.push({ model: model.modelKey, reason: "user_restricted" });
      return false;
    }
    if (config.privacy === "local_only" && !isLocalModel(model.modelKey, model.provider)) {
      rejectedModels.push({ model: model.modelKey, reason: "privacy_local_only" });
      return false;
    }
    return true;
  });
  return { models: filtered, rejectedModels };
}

function isLocalModel(modelKey: string, provider: string): boolean {
  const lower = `${provider}/${modelKey}`.toLowerCase();
  return lower.includes("ollama/") || lower.includes("local") || lower.includes("on-prem") || lower.includes("onprem");
}
