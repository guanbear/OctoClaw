import {
  GLOBAL_DEG_FILE,
  GUARD_FILE,
  MODE_FILE,
  MODEL_ALIASES_FILE,
  MODEL_POLICY_FILE,
  loadJson,
  loadOctoClawConfig,
} from "./config.js";
import { modelBandForSelectorBand } from "./taxonomy.js";

export const BUILTIN_MAP = {
  glm: "lixiang-glm-5/kivy-glm-5",
  sonnet: "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6",
  claudeopus: "vendor-claude-opus-4-6/aws-claude-opus-4-6",
  gpt54: "openai/gpt-5.4",
  glm5: "lixiang-glm-5/kivy-glm-5",
  minimax: "minimax/minimax-m2.7",
};

function modelAutoEnabled(config = null) {
  const cfg = config && typeof config === "object" ? config : loadOctoClawConfig();
  const section = cfg?.model_auto && typeof cfg.model_auto === "object" ? cfg.model_auto : {};
  return !("enabled" in section) || Boolean(section.enabled);
}

function hasAutoPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  for (const key of ["profiles", "worker_pools", "worker_pool_phases", "main_model"]) {
    const value = policy[key];
    if (key === "main_model" && String(value || "").trim()) return true;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) return true;
  }
  return false;
}

export function modelHealthMarker(state = null) {
  const payload = state && typeof state === "object" ? state : {};
  return String(payload.generated_at || "").trim();
}

export function modelInCooldown(entry) {
  return String(entry?.state || "healthy").trim().toLowerCase() === "cooldown";
}

export function resolveAutoPolicyModel(policy, { workerPool = "", phase = "", route = "", profile = "" } = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const profiles = policy.profiles;
  const workerPoolPhases = policy.worker_pool_phases;
  const workerPools = policy.worker_pools;

  if (profile && profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    const profileModel = profiles[profile];
    if (typeof profileModel === "string" && profileModel) return profileModel;
  }
  if (workerPool && phase && workerPoolPhases && typeof workerPoolPhases === "object" && !Array.isArray(workerPoolPhases)) {
    const poolEntry = workerPoolPhases[workerPool];
    if (poolEntry && typeof poolEntry === "object" && !Array.isArray(poolEntry)) {
      const phaseModel = poolEntry[phase];
      if (typeof phaseModel === "string" && phaseModel) return phaseModel;
    }
  }
  if (workerPool && workerPools && typeof workerPools === "object" && !Array.isArray(workerPools)) {
    const poolModel = workerPools[workerPool];
    if (typeof poolModel === "string" && poolModel) return poolModel;
  }
  const mainModel = String(policy.main_model || "").trim();
  if ((route === "direct" || workerPool === "octoclaw-main") && mainModel) return mainModel;
  return mainModel || null;
}

function resolveCustomModeModel(customModels, { workerPool = "", route = "", profile = "" } = {}) {
  if (!customModels || typeof customModels !== "object" || Array.isArray(customModels)) return null;
  if (profile) {
    const profileModel = customModels[`profile:${profile}`];
    if (typeof profileModel === "string" && profileModel.trim()) return profileModel.trim();
  }
  if (workerPool) {
    const poolModel = customModels[workerPool];
    if (typeof poolModel === "string" && poolModel.trim()) return poolModel.trim();
  }
  if (route === "direct") {
    const directModel = customModels.main;
    if (typeof directModel === "string" && directModel.trim()) return directModel.trim();
  }
  const mainModel = customModels.main;
  if (typeof mainModel === "string" && mainModel.trim()) return mainModel.trim();
  return null;
}

function buildShortNameMap(aliases) {
  const mapping = {};
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return mapping;
  for (const [aliasKey, fullPath] of Object.entries(aliases)) {
    if (aliasKey === "updated_at" || aliasKey === "_note") continue;
    if (typeof fullPath !== "string" || !fullPath.includes("/")) continue;
    const lower = fullPath.toLowerCase();
    if (lower.includes("glm")) mapping.glm ||= fullPath;
    else if (lower.includes("sonnet")) mapping.sonnet ||= fullPath;
    else if (lower.includes("opus")) mapping.claudeopus ||= fullPath;
    else if (lower.includes("gpt-5.4")) mapping.gpt54 ||= fullPath;
    else if (lower.includes("minimax") || lower.includes("m2.7")) mapping.minimax ||= fullPath;
  }
  return mapping;
}

function resolveShortName(shortName, aliasesData) {
  if (String(shortName || "").includes("/")) return shortName;
  const inferred = buildShortNameMap(aliasesData);
  if (shortName in inferred) return inferred[shortName];
  if (shortName in BUILTIN_MAP) return BUILTIN_MAP[shortName];
  return BUILTIN_MAP.sonnet;
}

function fallbackShortNameForSelectorBand(selectorBand) {
  const band = String(selectorBand || "").trim().toLowerCase();
  if (band === "quick") return "minimax";
  if (band === "standard") return "glm";
  if (band === "strong") return "gpt54";
  return "claudeopus";
}

export function resolvePolicyHealthFallback(selectedModel, { policy = null } = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return selectedModel;
  const healthModels = policy?.health?.models;
  const selectedHealth = healthModels && typeof healthModels === "object" ? healthModels[selectedModel] : null;
  if (!selectedHealth || typeof selectedHealth !== "object" || !modelInCooldown(selectedHealth)) return selectedModel;
  const familyEntry = policy?.family_routing?.[selectedModel];
  const fallbackPath = Array.isArray(familyEntry?.fallback_path) ? familyEntry.fallback_path : [];
  for (const candidate of fallbackPath) {
    const modelId = String(candidate || "").trim();
    if (!modelId) continue;
    const candidateHealth = healthModels && typeof healthModels === "object" ? healthModels[modelId] : null;
    if (!candidateHealth || typeof candidateHealth !== "object" || !modelInCooldown(candidateHealth)) {
      return modelId;
    }
  }
  return selectedModel;
}

function getCurrentMode() {
  const degData = loadJson(GLOBAL_DEG_FILE);
  if (degData && typeof degData === "object" && degData.active === true && degData.override_mode) {
    return String(degData.override_mode).trim();
  }
  const modeData = loadJson(MODE_FILE);
  if (modeData && typeof modeData === "object") return String(modeData.mode || "auto");
  return "auto";
}

export function resolveModelAndThinking(
  selectorBand,
  description,
  { workerPool = "", phase = "", route = "", profile = "" } = {},
) {
  const runtimeConfig = loadOctoClawConfig();
  const policyData = loadJson(MODEL_POLICY_FILE);
  const autoPolicyActive = modelAutoEnabled(runtimeConfig) && hasAutoPolicy(policyData);
  let selectedModel = "";

  if (autoPolicyActive) {
    selectedModel = resolveAutoPolicyModel(policyData, { workerPool, phase, route, profile }) || "";
  } else {
    const modeData = loadJson(MODE_FILE) || { mode: "auto", customModels: {} };
    const currentMode = getCurrentMode();
    const mode = ["auto", "custom"].includes(String(currentMode || modeData.mode || "auto")) ? String(currentMode || modeData.mode || "auto") : "auto";
    const customModels = modeData && typeof modeData === "object" && modeData.customModels && typeof modeData.customModels === "object"
      ? modeData.customModels
      : {};
    const aliasesData = loadJson(MODEL_ALIASES_FILE);
    const shortName = mode === "custom"
      ? resolveCustomModeModel(customModels, { workerPool, route, profile })
      : null;
    if (shortName) {
      selectedModel = resolveShortName(shortName, aliasesData);
    }
    if (!selectedModel && aliasesData && typeof aliasesData === "object" && !Array.isArray(aliasesData)) {
      const modelBand = modelBandForSelectorBand(selectorBand, "normal");
      const candidate = String(aliasesData[selectorBand] || aliasesData[modelBand] || "").trim();
      if (candidate.includes("/")) selectedModel = candidate;
    }
    if (!selectedModel) {
      selectedModel = resolveShortName(fallbackShortNameForSelectorBand(selectorBand), aliasesData);
    }
  }

  if (autoPolicyActive && selectedModel) {
    selectedModel = resolvePolicyHealthFallback(selectedModel, { policy: policyData });
  }

  const guardData = loadJson(GUARD_FILE);
  if (guardData && typeof guardData === "object" && guardData.guarded === true) {
    const status = String(guardData.status || "").trim();
    if (status === "all_fail") {
      return ["", ""];
    }
    if (status === "ratelimit") {
      selectedModel = BUILTIN_MAP.glm;
    } else {
      const originalModel = String(guardData.original_model || "").trim();
      const currentModel = String(guardData.current_model || "").trim();
      if (originalModel && currentModel && selectedModel === originalModel) {
        selectedModel = currentModel;
      }
    }
  }

  return [selectedModel, ""];
}
