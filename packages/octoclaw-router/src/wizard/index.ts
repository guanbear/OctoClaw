import fsSync from "node:fs";
import path from "node:path";

import type { ModelIntelLite } from "../decision/contracts.js";
import type { RouterOverrideConfig } from "../overrides/index.js";
import { createEmptyOverrides } from "../overrides/index.js";

type JsonRecord = Record<string, unknown>;

export type RouterWizardModelState =
  | "discovered"
  | "probed_ok"
  | "proposal_candidate"
  | "shadow_candidate"
  | "live_candidate";

export interface RouterWizardConfig {
  schemaVersion: "octoclaw.router_wizard/v1";
  completedAt: string;
	  models: Record<string, {
	    planType: "subscription" | "pay_as_you_go" | "unknown";
	    configuredAt: string;
	    source?: "configured" | "same_provider_discovery";
	    state?: RouterWizardModelState;
	    stateUpdatedAt?: string;
	    lastProbeOkAt?: string;
	  }>;
  budget?: { monthly: number; currency: "USD" };
  privacy: "standard" | "local_only";
  language: "auto" | "zh" | "en";
  restrictedModels: string[];
  overrides: RouterOverrideConfig;
}

export interface AcceptProposalResult {
  ok: true;
  modelKey: string;
  provider: string;
  openclawConfigPath: string;
  backupPath: string;
}

export interface RecordProbeSuccessResult {
  ok: true;
  modelKey: string;
  wizardPath: string;
}

export function createWizardConfig(modelIds: string[], options: {
  now?: string;
  budgetInput?: string;
  privacy?: RouterWizardConfig["privacy"];
  language?: RouterWizardConfig["language"];
  restrictedModels?: string[];
  modelPlanTypes?: Record<string, RouterWizardConfig["models"][string]["planType"]>;
  sameProviderModels?: string[];
} = {}): RouterWizardConfig {
  const now = options.now ?? new Date().toISOString();
  const configured = Array.from(new Set(modelIds.filter(Boolean)));
  const sameProviderModels = Array.from(new Set((options.sameProviderModels ?? []).filter((model) => model && !configured.includes(model))));
  const models = Object.fromEntries([
    ...configured.map((model) => [model, {
      planType: options.modelPlanTypes?.[model] ?? detectPlanType(model),
      configuredAt: now,
      source: "configured" as const,
    }]),
    ...sameProviderModels.map((model) => [model, {
      planType: options.modelPlanTypes?.[model] ?? detectPlanType(model),
      configuredAt: now,
      source: "same_provider_discovery" as const,
    }]),
  ]);
  return {
    schemaVersion: "octoclaw.router_wizard/v1",
    completedAt: now,
    models,
    budget: options.budgetInput ? parseBudgetInput(options.budgetInput) : undefined,
    privacy: options.privacy ?? "standard",
    language: options.language ?? "auto",
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
    next.models[model] = { planType: detectPlanType(model), configuredAt: now, source: "configured" };
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
}

function wizardPath(openclawHome: string): string {
  return path.join(openclawHome, "octoclaw", "router-wizard.json");
}

async function readWizardFile(openclawHome: string): Promise<RouterWizardConfig> {
  const value = await readJsonFile(wizardPath(openclawHome));
  if (!isRecord(value) || value.schemaVersion !== "octoclaw.router_wizard/v1") {
    throw new Error(`Invalid router wizard config: ${wizardPath(openclawHome)}`);
  }
  return value as unknown as RouterWizardConfig;
}

function emptyWizardConfig(now: string): RouterWizardConfig {
  return {
    schemaVersion: "octoclaw.router_wizard/v1",
    completedAt: now,
    models: {},
    privacy: "standard",
    language: "auto",
    restrictedModels: [],
    overrides: createEmptyOverrides(),
  };
}

async function readWizardFileOrDefault(openclawHome: string, now: string): Promise<RouterWizardConfig> {
  try {
    return await readWizardFile(openclawHome);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
    return emptyWizardConfig(now);
  }
}

function writeWizardFile(openclawHome: string, config: RouterWizardConfig): void {
  const filePath = wizardPath(openclawHome);
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function providerNotConfiguredMessage(provider: string): string {
  return `这个模型属于 \`${provider}\`，但你的 OpenClaw 还没配置这个 provider。请先在 OpenClaw 里加 provider 凭证，再回向导。`;
}

function modelIdFromKey(modelKey: string): { provider: string; modelId: string } {
  const slash = modelKey.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model key: ${modelKey}`);
  return { provider: modelKey.slice(0, slash), modelId: modelKey.slice(slash + 1) };
}

function hasRecentProbe(model: RouterWizardConfig["models"][string] | undefined, now: number): boolean {
  const lastProbeOkAt = Date.parse(model?.lastProbeOkAt ?? "");
  if (Number.isNaN(lastProbeOkAt)) return false;
  return now - lastProbeOkAt <= 7 * 24 * 60 * 60 * 1000;
}

export async function recordProbeSuccess(
  modelKey: string,
  openclawHome: string,
  options: { now?: string } = {},
): Promise<RecordProbeSuccessResult> {
  const nowText = options.now ?? new Date().toISOString();
  modelIdFromKey(modelKey);
  const wizard = await readWizardFileOrDefault(openclawHome, nowText);
  const existing = wizard.models[modelKey];
  wizard.models[modelKey] = {
    planType: existing?.planType ?? detectPlanType(modelKey),
    configuredAt: existing?.configuredAt ?? nowText,
    source: existing?.source ?? "same_provider_discovery",
    state: "probed_ok",
    stateUpdatedAt: nowText,
    lastProbeOkAt: nowText,
  };
  writeWizardFile(openclawHome, wizard);
  return { ok: true, modelKey, wizardPath: wizardPath(openclawHome) };
}

function providerModels(value: JsonRecord): unknown[] {
  const models = value.models;
  return Array.isArray(models) ? models : [];
}

function modelListContains(models: unknown[], modelId: string, modelKey: string): boolean {
  return models.some((entry) => {
    if (typeof entry === "string") return entry === modelId || entry === modelKey;
    const id = asString(asRecord(entry).id);
    return id === modelId || id === modelKey;
  });
}

export async function acceptProposal(
  modelKey: string,
  openclawHome: string,
  options: { now?: string } = {},
): Promise<AcceptProposalResult> {
  const nowText = options.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  const { provider, modelId } = modelIdFromKey(modelKey);
  const openclawConfigPath = path.join(openclawHome, "openclaw.json");
  const openclawConfig = await readJsonFile(openclawConfigPath);
  const originalOpenclawConfigText = `${JSON.stringify(openclawConfig, null, 2)}\n`;
  const providers = asRecord(asRecord(asRecord(openclawConfig).models).providers);
  const rawProviderBlock = providers[provider];
  if (!isRecord(rawProviderBlock)) {
    throw new Error(providerNotConfiguredMessage(provider));
  }
  const providerBlock = rawProviderBlock;

  const wizard = await readWizardFile(openclawHome);
  const wizardModel = wizard.models[modelKey];
  if (!hasRecentProbe(wizardModel, now)) {
    throw new Error(`No successful probe for ${modelKey} within the last 7 days. Run router capability probe first.`);
  }

  const models = providerModels(providerBlock);
  if (!modelListContains(models, modelId, modelKey)) {
    providerBlock.models = [...models, { id: modelId, name: modelId }];
  }
  providers[provider] = providerBlock;

  const backupPath = path.join(openclawHome, `openclaw.json.octoclaw-bak-${nowText}`);
  if (fsSync.existsSync(backupPath)) throw new Error(`Backup already exists: ${backupPath}`);
  fsSync.writeFileSync(backupPath, originalOpenclawConfigText, "utf8");
  fsSync.writeFileSync(openclawConfigPath, `${JSON.stringify(openclawConfig, null, 2)}\n`);

  wizard.models[modelKey] = {
    ...wizardModel,
    planType: wizardModel?.planType ?? detectPlanType(modelKey),
    configuredAt: wizardModel?.configuredAt ?? nowText,
    source: wizardModel?.source ?? "same_provider_discovery",
    state: "shadow_candidate",
    stateUpdatedAt: nowText,
  };
  writeWizardFile(openclawHome, wizard);

  return {
    ok: true,
    modelKey,
    provider,
    openclawConfigPath,
    backupPath,
  };
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
