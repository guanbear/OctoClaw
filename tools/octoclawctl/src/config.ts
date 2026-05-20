import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteText } from "./atomic-write.js";

export interface OctoclawConfig {
  _version: "1";
  _updatedAt: string;
  enabled: boolean;
  features: {
    delegation: boolean;
    imNotifications: boolean;
    statusPanel: boolean;
  };
  judge: {
    enabled: boolean;
    modelId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    timeoutLocalMs: number;
    minConfidence: number;
    shadowMode: boolean;
    judgeAckEnabled: boolean;
    local: boolean;
  };
  models: {
    mode: "auto" | "custom";
    overrides: Record<string, string>;
  };
  pluginConfig: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

export function defaultConfig(): OctoclawConfig {
  return {
    _version: "1",
    _updatedAt: new Date(0).toISOString(),
    enabled: true,
    features: { delegation: true, imNotifications: true, statusPanel: true },
    judge: { enabled: false, modelId: "", baseUrl: "", apiKey: "", timeoutMs: 3000, timeoutLocalMs: 3000, minConfidence: 0.6, shadowMode: false, judgeAckEnabled: true, local: false },
    models: { mode: "auto", overrides: {} },
    pluginConfig: { enabled: true, delegationEnabled: true },
  };
}

export function configPath(openclawHome = ""): string {
  const explicitHome = openclawHome.trim();
  if (!explicitHome) {
    return path.join(os.homedir(), ".octoclaw", "config.json");
  }
  const configDir = path.basename(explicitHome) === ".octoclaw"
    ? explicitHome
    : path.join(path.dirname(explicitHome), ".octoclaw");
  return path.join(configDir, "config.json");
}

export async function readConfig(openclawHome = ""): Promise<OctoclawConfig> {
  const pathname = configPath(openclawHome);
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return normalizeConfig(JSON.parse(raw) as JsonRecord);
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(openclawHome: string, config: OctoclawConfig): Promise<void> {
  const pathname = configPath(openclawHome);
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const next = { ...config, _version: "1" as const, _updatedAt: new Date().toISOString() };
  await atomicWriteText(pathname, `${JSON.stringify(next, null, 2)}\n`);
}

export async function setConfigField(openclawHome: string, key: string, value: string): Promise<OctoclawConfig> {
  const config = await readConfig(openclawHome);
  setNestedField(config as unknown as JsonRecord, key.split(".").filter(Boolean), parseValue(value));
  await syncToOpenClawPluginConfig(openclawHome, config);
  await writeConfig(openclawHome, config);
  return config;
}

export function getConfigField(config: OctoclawConfig, key: string): unknown {
  return key.split(".").filter(Boolean).reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as JsonRecord)[part];
    }
    return undefined;
  }, config);
}

export async function syncToOpenClawPluginConfig(openclawHome: string, config: OctoclawConfig): Promise<void> {
  // If judge is not yet configured in octoclaw config but a legacy judge-fast.json exists,
  // auto-import it into config.judge so it gets projected into judgeFast plugin config.
  // This is a migration helper: users who previously set up judge-fast.json get it synced
  // automatically without having to re-configure via octoclawctl config set.
  if (!config.judge.enabled) {
    const legacyJudgeFast = await readLegacyJudgeFastConfig(openclawHome);
    if (legacyJudgeFast) {
      const modelId = typeof legacyJudgeFast.modelId === "string" ? legacyJudgeFast.modelId : "";
      const baseUrl = typeof legacyJudgeFast.baseUrl === "string" ? legacyJudgeFast.baseUrl : "";
      const apiKey = typeof legacyJudgeFast.apiKey === "string" ? legacyJudgeFast.apiKey : "";
      const timeoutMs = typeof legacyJudgeFast.timeoutMs === "number" ? legacyJudgeFast.timeoutMs : null;
      const timeoutLocalMs = typeof legacyJudgeFast.timeoutLocalMs === "number" ? legacyJudgeFast.timeoutLocalMs : null;
      const minConfidence = typeof legacyJudgeFast.minConfidence === "number" ? legacyJudgeFast.minConfidence : null;
      const shadowMode = typeof legacyJudgeFast.shadowMode === "boolean" ? legacyJudgeFast.shadowMode : null;
      const judgeAckEnabled = typeof legacyJudgeFast.judgeAckEnabled === "boolean" ? legacyJudgeFast.judgeAckEnabled : null;
      const local = typeof legacyJudgeFast.local === "boolean" ? legacyJudgeFast.local : null;
      if (modelId && baseUrl) {
        config.judge.enabled = true;
        config.judge.modelId = modelId;
        config.judge.baseUrl = baseUrl;
        if (apiKey) config.judge.apiKey = apiKey;
        if (timeoutMs !== null) config.judge.timeoutMs = timeoutMs;
        if (timeoutLocalMs !== null) config.judge.timeoutLocalMs = timeoutLocalMs;
        if (minConfidence !== null) config.judge.minConfidence = minConfidence;
        if (shadowMode !== null) config.judge.shadowMode = shadowMode;
        if (judgeAckEnabled !== null) config.judge.judgeAckEnabled = judgeAckEnabled;
        if (local !== null) config.judge.local = local;
      }
    }
  }

  config.pluginConfig = buildPluginConfig(config);

  const manifestPath = path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json");
  if (fsSync.existsSync(manifestPath)) {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as JsonRecord;
    manifest.pluginConfig = config.pluginConfig;
    await atomicWriteText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  await syncOpenClawEntryConfig(openclawHome, config.pluginConfig);
}

/** Read legacy judge-fast.json from ~/.openclaw/ if it exists. */
async function readLegacyJudgeFastConfig(openclawHome: string): Promise<JsonRecord | null> {
  const legacyPath = path.join(openclawHome, "judge-fast.json");
  try {
    const raw = await fs.readFile(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildPluginConfig(config: OctoclawConfig): JsonRecord {
  const pluginConfig: JsonRecord = {
    ...config.pluginConfig,
    enabled: config.enabled,
    delegationEnabled: config.features.delegation,
  };

  if (!config.judge.enabled) {
    delete pluginConfig.judgeFast;
    return pluginConfig;
  }

  const modelId = config.judge.modelId.trim();
  const baseUrl = config.judge.baseUrl.trim();
  if (!modelId || !baseUrl) {
    throw new Error("judge.enabled requires non-empty judge.modelId and judge.baseUrl before projecting judgeFast");
  }

  pluginConfig.judgeFast = {
    enabled: true,
    shadowMode: config.judge.shadowMode,
    modelId,
    baseUrl,
    ...(config.judge.apiKey.trim() ? { apiKey: config.judge.apiKey.trim() } : {}),
    timeoutMs: config.judge.timeoutMs,
    timeoutLocalMs: config.judge.timeoutLocalMs,
    minConfidence: config.judge.minConfidence,
    judgeAckEnabled: config.judge.judgeAckEnabled,
    local: config.judge.local,
  };
  return pluginConfig;
}

async function syncOpenClawEntryConfig(openclawHome: string, pluginConfig: JsonRecord): Promise<void> {
  const openclawConfigPath = path.join(openclawHome, "openclaw.json");
  if (!fsSync.existsSync(openclawConfigPath)) return;
  const raw = await fs.readFile(openclawConfigPath, "utf8");
  const openclawConfig = JSON.parse(raw) as JsonRecord;
  const plugins = ensureRecord(openclawConfig, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = isRecord(entries["octoclaw-runtime"]) ? entries["octoclaw-runtime"] : {};
  const currentConfig = isRecord(entry.config) ? entry.config : {};
  entry.enabled = true;
  const nextConfig: JsonRecord = {
    ...currentConfig,
    ...pluginConfig,
  };
  if (!("judgeFast" in pluginConfig)) {
    delete nextConfig.judgeFast;
  }
  entry.config = nextConfig;
  entries["octoclaw-runtime"] = entry;
  await atomicWriteText(openclawConfigPath, `${JSON.stringify(openclawConfig, null, 2)}\n`);
}

function normalizeConfig(raw: JsonRecord): OctoclawConfig {
  const fallback = defaultConfig();
  const features = isRecord(raw.features) ? raw.features : {};
  const judge = isRecord(raw.judge) ? raw.judge : {};
  const models = isRecord(raw.models) ? raw.models : {};
  const pluginConfig = isRecord(raw.pluginConfig) ? raw.pluginConfig : {};
  return {
    ...fallback,
    _updatedAt: typeof raw._updatedAt === "string" ? raw._updatedAt : fallback._updatedAt,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    features: {
      delegation: typeof features.delegation === "boolean" ? features.delegation : fallback.features.delegation,
      imNotifications: typeof features.imNotifications === "boolean" ? features.imNotifications : fallback.features.imNotifications,
      statusPanel: typeof features.statusPanel === "boolean" ? features.statusPanel : fallback.features.statusPanel,
    },
    judge: {
      enabled: typeof judge.enabled === "boolean" ? judge.enabled : fallback.judge.enabled,
      modelId: typeof judge.modelId === "string" ? judge.modelId : fallback.judge.modelId,
      baseUrl: typeof judge.baseUrl === "string" ? judge.baseUrl : fallback.judge.baseUrl,
      apiKey: typeof judge.apiKey === "string" ? judge.apiKey : fallback.judge.apiKey,
      timeoutMs: typeof judge.timeoutMs === "number" ? judge.timeoutMs : fallback.judge.timeoutMs,
      timeoutLocalMs: typeof judge.timeoutLocalMs === "number" ? judge.timeoutLocalMs : fallback.judge.timeoutLocalMs,
      minConfidence: typeof judge.minConfidence === "number" ? judge.minConfidence : fallback.judge.minConfidence,
      shadowMode: typeof judge.shadowMode === "boolean" ? judge.shadowMode : fallback.judge.shadowMode,
      judgeAckEnabled: typeof judge.judgeAckEnabled === "boolean" ? judge.judgeAckEnabled : fallback.judge.judgeAckEnabled,
      local: typeof judge.local === "boolean" ? judge.local : fallback.judge.local,
    },
    models: {
      mode: models.mode === "custom" ? "custom" : "auto",
      overrides: isRecord(models.overrides) ? Object.fromEntries(Object.entries(models.overrides).map(([key, val]) => [key, String(val ?? "")])) : {},
    },
    pluginConfig: { ...pluginConfig },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
  const current = parent[key];
  if (isRecord(current)) return current;
  const next: JsonRecord = {};
  parent[key] = next;
  return next;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

function setNestedField(target: JsonRecord, pathParts: string[], value: unknown): void {
  if (pathParts.length === 0) return;
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    const existing = cursor[part];
    if (!isRecord(existing)) cursor[part] = {};
    cursor = cursor[part] as JsonRecord;
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

export function configExists(openclawHome = ""): boolean {
  return fsSync.existsSync(configPath(openclawHome));
}
