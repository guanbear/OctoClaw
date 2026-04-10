import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKSPACE = "/workspace";
const RUNTIME_POLICY_MODE_ALIASES = {
  observe: "conservative",
  observation: "conservative",
  monitor: "conservative",
};

const RUNTIME_POLICY_MODE_PRESETS = {
  conservative: {
    switches: {
      hard_runner_only: true,
      route_hint_required: false,
      replay_logging: true,
      direct_model_override: false,
      delegation_enforcement: false,
    },
    route_stickiness: {
      enabled: false,
    },
    hooks: {
      before_model_resolve: false,
      before_prompt_build: true,
      before_tool_call: false,
      agent_end: true,
    },
  },
  guided: {
    switches: {
      hard_runner_only: true,
      route_hint_required: false,
      replay_logging: true,
      direct_model_override: false,
      delegation_enforcement: true,
    },
    route_stickiness: {
      enabled: true,
    },
    hooks: {
      before_model_resolve: false,
      before_prompt_build: true,
      before_tool_call: true,
      agent_end: true,
    },
  },
  enforced: {
    switches: {
      hard_runner_only: true,
      route_hint_required: true,
      replay_logging: true,
      direct_model_override: false,
      delegation_enforcement: true,
    },
    route_stickiness: {
      enabled: true,
    },
    hooks: {
      before_model_resolve: false,
      before_prompt_build: true,
      before_tool_call: true,
      agent_end: true,
    },
  },
};

const FEATURE_FLAG_DEFAULTS = {
  policy_judge_live: true,
  cheap_judge_live: false,
  local_judge_live: false,
  runner_pool_enabled: true,
  delivery_relay_enabled: true,
  legacy_runner_fallback: true,
  patrol_loop_enabled: false,
};

const FEATURE_FLAG_ENV_MAP = {
  policy_judge_live: "OCTOCLAW_POLICY_JUDGE_LIVE",
  cheap_judge_live: "OCTOCLAW_CHEAP_JUDGE_LIVE",
  local_judge_live: "OCTOCLAW_LOCAL_JUDGE_LIVE",
  runner_pool_enabled: "OCTOCLAW_RUNNER_POOL_ENABLED",
  delivery_relay_enabled: "OCTOCLAW_DELIVERY_RELAY_ENABLED",
  legacy_runner_fallback: "OCTOCLAW_LEGACY_RUNNER_FALLBACK",
  patrol_loop_enabled: "OCTOCLAW_PATROL_LOOP_ENABLED",
};

function resolveRuntimePolicyMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = RUNTIME_POLICY_MODE_ALIASES[raw] || raw;
  return RUNTIME_POLICY_MODE_PRESETS[normalized] ? normalized : "guided";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function parseOptionalBool(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

export function resolveRuntimeFeatureFlags(runtimePolicy = {}) {
  const policy = runtimePolicy && typeof runtimePolicy === "object" && !Array.isArray(runtimePolicy)
    ? runtimePolicy
    : {};
  const features = policy.features && typeof policy.features === "object" && !Array.isArray(policy.features)
    ? policy.features
    : {};
  const runnerPool = policy.runner_pool && typeof policy.runner_pool === "object" && !Array.isArray(policy.runner_pool)
    ? policy.runner_pool
    : {};
  const flags = {
    ...FEATURE_FLAG_DEFAULTS,
    policy_judge_live: Boolean("policy_judge_live" in features ? features.policy_judge_live : FEATURE_FLAG_DEFAULTS.policy_judge_live),
    cheap_judge_live: Boolean("cheap_judge_live" in features ? features.cheap_judge_live : FEATURE_FLAG_DEFAULTS.cheap_judge_live),
    local_judge_live: Boolean("local_judge_live" in features ? features.local_judge_live : FEATURE_FLAG_DEFAULTS.local_judge_live),
    runner_pool_enabled: Boolean(
      "runner_pool_enabled" in features
        ? features.runner_pool_enabled
        : ("enabled" in runnerPool ? runnerPool.enabled : FEATURE_FLAG_DEFAULTS.runner_pool_enabled)
    ),
    delivery_relay_enabled: Boolean("delivery_relay_enabled" in features ? features.delivery_relay_enabled : FEATURE_FLAG_DEFAULTS.delivery_relay_enabled),
    legacy_runner_fallback: Boolean("legacy_runner_fallback" in features ? features.legacy_runner_fallback : FEATURE_FLAG_DEFAULTS.legacy_runner_fallback),
    patrol_loop_enabled: Boolean("patrol_loop_enabled" in features ? features.patrol_loop_enabled : FEATURE_FLAG_DEFAULTS.patrol_loop_enabled),
  };
  const overrideSources = [];
  const safeModeEnabled = parseOptionalBool(process.env.OCTOCLAW_RUNTIME_SAFE_MODE) === true;
  if (safeModeEnabled) {
    flags.cheap_judge_live = false;
    flags.local_judge_live = false;
    flags.runner_pool_enabled = false;
    flags.legacy_runner_fallback = true;
    flags.patrol_loop_enabled = false;
    overrideSources.push("env:OCTOCLAW_RUNTIME_SAFE_MODE");
  }
  for (const [key, envName] of Object.entries(FEATURE_FLAG_ENV_MAP)) {
    const parsed = parseOptionalBool(process.env[envName]);
    if (parsed === null) continue;
    flags[key] = parsed;
    overrideSources.push(`env:${envName}`);
  }
  return {
    rollout_contract_version: "octoclaw.runtime_flags/v1",
    ...flags,
    safe_mode_enabled: safeModeEnabled,
    judge_lock: safeModeEnabled ? "main_grade_model" : "",
    override_sources: overrideSources,
  };
}

export function resolveWorkspace() {
  for (const envName of ["WORKSPACE", "OCTOCLAW_WORKSPACE"]) {
    const configured = String(process.env[envName] || "").trim();
    if (configured) return normalizePath(configured);
  }
  const managedWorkspace = path.join(os.homedir(), ".openclaw", "workspace");
  try {
    if (fs.existsSync(path.join(managedWorkspace, "tmp"))) return managedWorkspace;
  } catch {
    // ignore and keep fallback below
  }
  return DEFAULT_WORKSPACE;
}

export const WORKSPACE = resolveWorkspace();
export const CONFIG_FILE = path.join(WORKSPACE, "tmp", "octoclaw-config.json");
export const LEGACY_CONFIG_FILE = path.join(WORKSPACE, "tmp", "octopus-config.json");
export const MODE_FILE = path.join(WORKSPACE, "tmp", "octoclaw-mode.json");
export const LEGACY_MODE_FILE = path.join(WORKSPACE, "tmp", "octopus-mode.json");
export const MODEL_POLICY_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-policy.json");
export const MODEL_ALIASES_FILE = path.join(WORKSPACE, "tmp", "octopus-model-aliases.json");
export const MODEL_HEALTH_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-health.json");
export const MODEL_SPEED_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-speed.json");
export const MODEL_PLAN_STATE_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-plan-state.json");
export const MODEL_CATALOG_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-catalog.json");
export const MODEL_BENCHMARKS_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-benchmarks.json");
export const MODEL_SOURCES_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-sources.json");
export const MODEL_INTEL_SOURCE_STATUS_FILE = path.join(WORKSPACE, "tmp", "octopus", "model-intel-source-status.json");
export const ROUTE_STICKINESS_FILE = path.join(WORKSPACE, "tmp", "octopus", "route-stickiness.json");
export const RUNNER_QUEUE_FILE = path.join(WORKSPACE, "tmp", "octopus", "runner-queue.json");
export const RUNNER_HEALTH_FILE = path.join(WORKSPACE, "tmp", "octopus", "runner-health.json");
export const GLOBAL_DEG_FILE = "/tmp/ironclaw-global-degradation.json";
export const GUARD_FILE = "/tmp/ironclaw-model-guard-override.json";

const DEFAULT_RUNTIME_POLICY = {
  mode: "guided",
  enabled: true,
  switches: {
    hard_runner_only: true,
    route_hint_required: false,
    replay_logging: true,
    direct_model_override: false,
    delegation_enforcement: true,
  },
  route_stickiness: {
    enabled: true,
    ttl_minutes: 180,
    apply_on_followup_only: true,
    ack_followup_enabled: true,
    max_apply_count: 3,
    require_contract_match: true,
  },
  route_language_packs: {
    enabled: ["zh", "en"],
    available: ["zh", "en", "ja", "ko", "es", "pt", "ru"],
  },
  default_reasoning_effort_by_model_band: {
    fast: "low",
    normal: "medium",
    strong: "high",
    heavy: "high",
  },
  hooks: {
    before_model_resolve: false,
    before_prompt_build: true,
    before_tool_call: true,
    agent_end: true,
  },
  model_health_feedback: {
    enabled: false,
    stale_after_seconds: 120,
    lookback_hours: 24,
    max_files: 7,
    log_dir: "",
    log_file: "",
  },
  policy_router: {
    enabled: true,
    mode: "model_first",
    deterministic_first: false,
    judge_on: ["undetermined"],
    default_judge: "main_grade_model",
    timeout_ms: 1200,
    confidence_threshold: 0.78,
    cache_ttl_seconds: 120,
    max_context_chars: 2000,
    fail_closed_route: "runner",
    candidates: {
      main_grade_model: {
        enabled: true,
        provider: "stateless_ephemeral_judge",
        model: "inherit_main_grade",
        cost_band: "main_grade",
        command: "",
        tools: "none",
      },
      cheap_model: {
        enabled: false,
        provider: "openai_compatible",
        model: "",
        cost_band: "low",
        base_url: "",
        api_key_env: "OCTOCLAW_POLICY_JUDGE_API_KEY",
        command: "",
        tools: "none",
      },
      local_model: {
        enabled: false,
        provider: "openai_compatible",
        model: "",
        cost_band: "local",
        base_url: "http://127.0.0.1:11434/v1",
        command: "",
        tools: "none",
      },
    },
  },
  runner_pool: {
    enabled: true,
    size: 2,
    backend: "tmux",
    managed_by: "gateway_extension",
    fresh_context_required: true,
    max_queue_size: 20,
    per_user_concurrency: 1,
    lease_timeout_seconds: 90,
    job_timeout_seconds: 120,
    worker_unhealthy_after_failures: 2,
    busy_strategy: "queue_or_progress",
  },
  delivery_relay: {
    retry_cooldown_seconds: 30,
  },
  features: {
    policy_judge_live: true,
    cheap_judge_live: false,
    local_judge_live: false,
    runner_pool_enabled: true,
    delivery_relay_enabled: true,
    legacy_runner_fallback: true,
    patrol_loop_enabled: false,
  },
  skill_bundles: {
    ops: ["shell", "logs", "status"],
    research: ["web", "docs", "report"],
    code: ["repo", "test", "review"],
    review: ["review", "risk", "regression"],
    writer: ["writer", "feishu", "office", "delivery"],
  },
  profiles: {
    "ops-fast": {
      skill_bundle_keys: ["ops"],
      reasoning_effort: "low",
    },
    research: {
      skill_bundle_keys: ["research"],
      reasoning_effort: "medium",
    },
    code: {
      skill_bundle_keys: ["code"],
      reasoning_effort: "medium",
    },
    review: {
      skill_bundle_keys: ["review"],
      reasoning_effort: "high",
    },
    writer: {
      skill_bundle_keys: ["research", "writer"],
      reasoning_effort: "medium",
    },
  },
};

function applyRuntimePolicyMode(runtimePolicy) {
  const input = runtimePolicy && typeof runtimePolicy === "object" && !Array.isArray(runtimePolicy)
    ? runtimePolicy
    : {};
  const mode = resolveRuntimePolicyMode(input.mode || DEFAULT_RUNTIME_POLICY.mode);
  const preset = RUNTIME_POLICY_MODE_PRESETS[mode] || {};
  return deepMerge(deepMerge(cloneJson(DEFAULT_RUNTIME_POLICY), preset), { ...input, mode });
}

export const DEFAULT_CONFIG = {
  model_auto: {
    enabled: true,
  },
  model_health: {
    cooldown_minutes: 20,
  },
  runtime_policy: DEFAULT_RUNTIME_POLICY,
  patrol: {
    mode: "detect_only",
    auto_redispatch: false,
  },
};

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function legacyAliasPath(filePath) {
  if (filePath === CONFIG_FILE) return LEGACY_CONFIG_FILE;
  if (filePath === MODE_FILE) return LEGACY_MODE_FILE;
  return "";
}

export function loadJson(filePath) {
  const data = loadJsonFile(filePath);
  if (data !== null) return data;
  const alias = legacyAliasPath(filePath);
  if (alias) return loadJsonFile(alias);
  return null;
}

export function saveJson(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && result[key]
      && typeof result[key] === "object"
      && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadOctoClawConfig() {
  const data = loadJson(CONFIG_FILE);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const merged = deepMerge(DEFAULT_CONFIG, data);
    const runtimePolicy = applyRuntimePolicyMode(merged.runtime_policy);
    runtimePolicy.features = resolveRuntimeFeatureFlags(runtimePolicy);
    merged.runtime_policy = runtimePolicy;
    return merged;
  }
  const payload = cloneJson(DEFAULT_CONFIG);
  const runtimePolicy = applyRuntimePolicyMode(payload.runtime_policy);
  runtimePolicy.features = resolveRuntimeFeatureFlags(runtimePolicy);
  payload.runtime_policy = runtimePolicy;
  return payload;
}
