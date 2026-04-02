export const VALID_WORKER_POOLS = new Set([
  "octoclaw-main",
  "octoclaw-runner",
  "octoclaw-research",
  "octoclaw-code",
  "octoclaw-review",
]);

export const VALID_MODEL_BANDS = new Set(["fast", "normal", "strong", "heavy"]);

export const WORKER_POOL_TO_WORK_TYPE = {
  "octoclaw-main": "",
  "octoclaw-runner": "ops",
  "octoclaw-research": "research",
  "octoclaw-code": "code",
  "octoclaw-review": "review",
};

export const DEFAULT_PHASE_BY_WORK_TYPE = {
  ops: "inspect",
  research: "collect",
  code: "implement",
  review: "verify",
};

export const MODEL_BAND_TO_SELECTOR_BAND = {
  fast: "quick",
  normal: "standard",
  strong: "strong",
  heavy: "heavy",
};

export const SELECTOR_BAND_TO_MODEL_BAND = {
  quick: "fast",
  standard: "normal",
  strong: "strong",
  heavy: "heavy",
};

export const DEFAULT_MODEL_BAND_BY_WORKER_POOL = {
  "octoclaw-main": "normal",
  "octoclaw-runner": "fast",
  "octoclaw-research": "normal",
  "octoclaw-code": "strong",
  "octoclaw-review": "strong",
};

export const WORKER_POOL_DISPLAY = {
  "octoclaw-main": { emoji: "🤖", name: "Main" },
  "octoclaw-runner": { emoji: "🏃", name: "Runner" },
  "octoclaw-research": { emoji: "🔍", name: "Research" },
  "octoclaw-code": { emoji: "🔧", name: "Code" },
  "octoclaw-review": { emoji: "🧪", name: "Review" },
};

export function normalizeWorkerPool(value, defaultValue = "") {
  const text = String(value || "").trim();
  return VALID_WORKER_POOLS.has(text) ? text : defaultValue;
}

export function normalizeModelBand(value, defaultValue = "") {
  const text = String(value || "").trim().toLowerCase();
  return VALID_MODEL_BANDS.has(text) ? text : defaultValue;
}

export function selectorBandForModelBand(modelBand, { route = "" } = {}) {
  const normalized = normalizeModelBand(modelBand, "normal");
  if (String(route || "").trim().toLowerCase() === "runner") return "quick";
  return MODEL_BAND_TO_SELECTOR_BAND[normalized] || "standard";
}

export function modelBandForSelectorBand(selectorBand, defaultValue = "normal") {
  const text = String(selectorBand || "").trim().toLowerCase();
  return SELECTOR_BAND_TO_MODEL_BAND[text] || defaultValue;
}

export function inferWorkerPool(route, workType) {
  if (route === "direct") return "octoclaw-main";
  if (route === "runner") return "octoclaw-runner";
  if (workType === "review") return "octoclaw-review";
  if (workType === "code") return "octoclaw-code";
  return "octoclaw-research";
}

export function inferModelBand({ route = "", workerPool = "", workType = "", protocol = "" } = {}) {
  const currentRoute = String(route || "").trim().toLowerCase();
  const currentPool = normalizeWorkerPool(workerPool, "");
  const currentWorkType = String(workType || "").trim().toLowerCase();
  const currentProtocol = String(protocol || "").trim().toLowerCase();

  if (currentProtocol === "heavy") return "heavy";
  if (currentRoute === "runner" || currentPool === "octoclaw-runner") return "fast";
  if (currentRoute === "spawn_multi") return "heavy";
  if (currentWorkType === "code" || currentWorkType === "review" || ["octoclaw-code", "octoclaw-review"].includes(currentPool)) {
    return "strong";
  }
  if (currentRoute === "direct") return "fast";
  return DEFAULT_MODEL_BAND_BY_WORKER_POOL[currentPool] || "normal";
}

export function resolveWorkerPool(task, defaultValue = "") {
  if (typeof task === "string") return normalizeWorkerPool(task, defaultValue);
  if (!task || typeof task !== "object" || Array.isArray(task)) return defaultValue;

  const explicit = normalizeWorkerPool(String(task.worker_pool || "").trim(), "");
  if (explicit) return explicit;

  const route = String(task.route || "").trim().toLowerCase();
  const runtime = String(task.runtime || "").trim().toLowerCase();
  const executor = String(task.executor || task.executor_type || "").trim().toLowerCase();
  const workType = String(task.work_type || "").trim().toLowerCase();

  if (route === "direct") return "octoclaw-main";
  if (route === "runner" || runtime === "runner" || executor === "runner" || workType === "ops") {
    return "octoclaw-runner";
  }
  if (workType === "code") return "octoclaw-code";
  if (workType === "review") return "octoclaw-review";
  if (workType === "research") return "octoclaw-research";
  if (route === "spawn_single" || route === "spawn_multi") return "octoclaw-research";
  return defaultValue;
}

export function resolveWorkType(task, defaultValue = "") {
  if (typeof task === "string") {
    const workerPool = resolveWorkerPool(task, "");
    return WORKER_POOL_TO_WORK_TYPE[workerPool] || defaultValue;
  }
  if (!task || typeof task !== "object" || Array.isArray(task)) return defaultValue;

  const explicit = String(task.work_type || "").trim().toLowerCase();
  if (explicit) return explicit;
  const route = String(task.route || "").trim().toLowerCase();
  if (route === "runner") return "ops";
  const workerPool = resolveWorkerPool(task, "");
  return WORKER_POOL_TO_WORK_TYPE[workerPool] || defaultValue;
}

export function resolvePhase(task, defaultValue = "") {
  if (typeof task === "string") {
    const workerPool = resolveWorkerPool(task, "");
    const workType = WORKER_POOL_TO_WORK_TYPE[workerPool] || "";
    return DEFAULT_PHASE_BY_WORK_TYPE[workType] || defaultValue;
  }
  if (!task || typeof task !== "object" || Array.isArray(task)) return defaultValue;

  const explicit = String(task.phase || "").trim().toLowerCase();
  if (explicit) return explicit;
  const route = String(task.route || "").trim().toLowerCase();
  if (route === "runner") return "inspect";
  const profile = String(task.profile || "").trim().toLowerCase();
  if (profile === "writer") return "report";
  const workType = resolveWorkType(task, "");
  return DEFAULT_PHASE_BY_WORK_TYPE[workType] || defaultValue;
}

export function resolveModelBand(task, defaultValue = "") {
  if (typeof task === "string") return normalizeModelBand(task, defaultValue);
  if (!task || typeof task !== "object" || Array.isArray(task)) return defaultValue;

  const explicit = normalizeModelBand(String(task.model_band || "").trim(), "");
  if (explicit) return explicit;
  return inferModelBand({
    route: String(task.route || ""),
    workerPool: resolveWorkerPool(task, ""),
    workType: resolveWorkType(task, ""),
    protocol: String(task.protocol || ""),
  }) || defaultValue;
}

export function modelRoleForWorkerPool(workerPool, { phase = "", route = "", profile = "" } = {}) {
  const pool = normalizeWorkerPool(workerPool, "octoclaw-research");
  const currentPhase = String(phase || "").trim();
  const currentRoute = String(route || "").trim();
  const currentProfile = String(profile || "").trim();

  if (pool === "octoclaw-main") return "main";
  if (pool === "octoclaw-runner") return "runner";
  if (currentRoute === "spawn_multi") return "team";
  if (pool === "octoclaw-review") return "review";
  if (pool === "octoclaw-code") return currentPhase === "verify" ? "review" : "code";
  if (currentProfile === "writer" || currentPhase === "report") return "writer";
  if (currentPhase === "inspect") return "inspect";
  return "research";
}

export function resolveExecutor(task, defaultValue = "subagent") {
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const explicit = String(task.executor || task.executor_type || "").trim().toLowerCase();
    if (["runner", "subagent", "team", "main"].includes(explicit)) return explicit;

    const taskKind = String(task.task_kind || "").trim().toLowerCase();
    const route = String(task.route || "").trim().toLowerCase();
    const workerPool = resolveWorkerPool(task, "");
    if (taskKind === "team_parent" || route === "spawn_multi") return "team";
    if (workerPool === "octoclaw-main" || route === "direct") return "main";
    if (workerPool === "octoclaw-runner" || route === "runner") return "runner";
    return defaultValue;
  }

  const pool = resolveWorkerPool(task, "");
  if (pool === "octoclaw-main") return "main";
  if (pool === "octoclaw-runner") return "runner";
  return defaultValue;
}

export function isRunnerTask(task) {
  return resolveWorkerPool(task, "") === "octoclaw-runner" || resolveExecutor(task) === "runner";
}

export function roleDisplay(task) {
  const workerPool = resolveWorkerPool(task, "");
  if (workerPool && WORKER_POOL_DISPLAY[workerPool]) return { ...WORKER_POOL_DISPLAY[workerPool] };
  if (typeof task === "string") {
    const clean = String(task).trim().replace("octoclaw-", "").replace("octopus-", "") || "任务";
    return { emoji: "🤖", name: clean };
  }
  return { emoji: "🤖", name: "任务" };
}
