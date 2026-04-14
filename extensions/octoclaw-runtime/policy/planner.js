import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeCompoundPlan, COMPOUND_PLAN_SCHEMA_VERSION } from "./compound_plan.js";
import { MODEL_POLICY_FILE, loadJson, resolveRuntimeFeatureFlags } from "./config.js";
import { resolveModelAndThinking } from "./model.js";

// ── Constants ──

function resolveOpenClawConfigDir() {
  const configured = String(process.env.OPENCLAW_HOME || "").trim();
  const candidates = configured
    ? [configured, path.join(configured, ".openclaw")]
    : [path.join(os.homedir(), ".openclaw")];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "openclaw.json"))) {
      return candidate;
    }
  }
  return configured || path.join(os.homedir(), ".openclaw");
}

const OPENCLAW_MAIN_AGENT_DIR = path.join(resolveOpenClawConfigDir(), "agents", "main", "agent");
const OPENCLAW_AUTH_PROFILES_FILE = path.join(OPENCLAW_MAIN_AGENT_DIR, "auth-profiles.json");
const OPENCLAW_MODELS_FILE = path.join(OPENCLAW_MAIN_AGENT_DIR, "models.json");
const CODEX_NATIVE_PROVIDER = "openai-codex";
const CODEX_NATIVE_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_PLANNER_TIMEOUT_MS = 2000;
const SIMPLE_ROUTE_RESULT = Object.freeze({ decision_mode: "simple_route" });

const PLANNER_SYSTEM_PROMPT = [
  "You are OctoClaw's stateless compound request planner.",
  "Analyze the user message and decide if it contains a single intent or multiple intents that should be handled as separate work items.",
  "",
  "Return JSON only. Do not answer the user task.",
  "",
  "If the message is a simple single-intent request (one question, one command, or a straightforward conversational turn), return:",
  '{"decision_mode": "simple_route"}',
  "",
  "If the message contains multiple intents, conditional actions, or dependencies between actions, return a compound plan:",
  JSON.stringify({
    decision_mode: "compound_plan",
    work_items: [
      {
        id: "A",
        intent_class: "plain_chat|local_surface_lookup|fresh_live_lookup|execution_followup|delegated_work|undetermined",
        lane: "direct|runner|spawn_single",
        goal: "description",
        depends_on: [],
        guard: null,
        user_visible: true,
        fallback: "notify_user",
      },
    ],
  }),
  "",
  "Rules:",
  "- direct lane for chat, current-session lookups, provenance queries",
  "- runner lane for bounded read-only ops (log checks, health checks, version queries)",
  "- spawn_single lane for delegated work producing artifacts or changes",
  "- depends_on lists item IDs that must complete first",
  '- guard optional: {"type": "ref_eq|ref_gt", "ref_item": "X", "ref_path": "result.field", "expected": value}',
  "- max_depth ≤ 3",
  "- Only mark compound if 2+ distinct intents with different lanes or dependencies",
].join("\n");

// ── Utility helpers (local copies from judge.js patterns) ──

function normalizeText(value) {
  return String(value || "").trim();
}

function envFlagEnabled(name) {
  return ["1", "true", "yes", "on"].includes(normalizeText(process.env[name]).toLowerCase());
}

function readJsonEnv(name) {
  const raw = normalizeText(process.env[name]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function splitModelRef(modelRef) {
  const normalized = normalizeText(modelRef);
  if (!normalized.includes("/")) return { provider: "", model: normalized };
  const [provider, ...rest] = normalized.split("/");
  return {
    provider: normalizeText(provider),
    model: normalizeText(rest.join("/")),
  };
}

function terminalModelRef(modelRef) {
  const normalized = normalizeText(modelRef);
  if (!normalized) return "";
  const parts = normalized.split("/").map((part) => normalizeText(part)).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function parseLooseJson(text) {
  const raw = normalizeText(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.replace(/^```(?:json)?/u, "").replace(/```$/u, "").trim();
  if (fenced && fenced !== raw) {
    try {
      return JSON.parse(fenced);
    } catch {}
  }
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < raw.length; cursor += 1) {
      const char = raw[cursor];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") { inString = true; continue; }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, cursor + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// ── Codex native helpers ──

function isCodexNativeCandidate(modelRef) {
  const { provider, model } = splitModelRef(modelRef);
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = terminalModelRef(model || modelRef).toLowerCase();
  if (!/^gpt-5([.-]|$)/u.test(normalizedModel)) return false;
  if (!normalizedProvider) return true;
  return ["openai", "openai-codex", "omniroute", "cx"].includes(normalizedProvider);
}

function parseTimestamp(value) {
  const raw = normalizeText(value);
  if (!raw) return 0;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveCodexAuthProfileId(profiles = {}) {
  const hasUsableAccess = (entry) => Boolean(normalizeText(entry?.access || entry?.oauth?.credentials?.access || ""));
  const explicit = normalizeText(process.env.OCTOCLAW_POLICY_JUDGE_AUTH_PROFILE || "");
  if (explicit && profiles[explicit]) return explicit;
  if (profiles["openai-codex:default"] && hasUsableAccess(profiles["openai-codex:default"])) return "openai-codex:default";
  const candidates = Object.entries(profiles).filter(([, entry]) => normalizeText(entry?.provider) === CODEX_NATIVE_PROVIDER);
  if (candidates.length === 0) return "";
  const withAccess = candidates.find(([, entry]) => normalizeText(entry?.access || entry?.oauth?.credentials?.access));
  return normalizeText((withAccess || candidates[0])?.[0] || "");
}

function resolveCodexAccessToken() {
  const authProfiles = loadJsonFile(OPENCLAW_AUTH_PROFILES_FILE);
  const profiles = authProfiles?.profiles && typeof authProfiles.profiles === "object" && !Array.isArray(authProfiles.profiles)
    ? authProfiles.profiles : {};
  const profileId = resolveCodexAuthProfileId(profiles);
  if (!profileId) return { token: "", profileId: "", state: "codex_native_profile_missing" };
  const profile = profiles[profileId];
  const token = normalizeText(profile?.access || profile?.oauth?.credentials?.access || "");
  if (!token) return { token: "", profileId, state: "codex_native_access_missing" };
  const expiresAt = parseTimestamp(profile?.expires || profile?.oauth?.credentials?.expires_at || profile?.oauth?.credentials?.expiresAt || "");
  if (expiresAt && expiresAt <= Date.now() + 15_000) return { token: "", profileId, state: "codex_native_access_expired" };
  return { token, profileId, state: "ok" };
}

function resolveCodexBaseUrl() {
  const explicit = normalizeText(process.env.OCTOCLAW_POLICY_JUDGE_CODEX_BASE_URL || "").replace(/\/+$/u, "");
  if (explicit) return explicit;
  const models = loadJsonFile(OPENCLAW_MODELS_FILE);
  const providerBaseUrl = normalizeText(models?.providers?.[CODEX_NATIVE_PROVIDER]?.baseUrl || "").replace(/\/+$/u, "");
  return providerBaseUrl || CODEX_NATIVE_BASE_URL;
}

function extractCodexEventDelta(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.delta?.text === "string") return event.delta.text;
  if (typeof event.part?.text === "string") return event.part.text;
  return "";
}

function extractOutputTextParts(payload) {
  const root = payload?.response && typeof payload.response === "object" ? payload.response : payload;
  const output = Array.isArray(root?.output) ? root.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && normalizeText(part?.text)) {
        parts.push(String(part.text));
      }
    }
  }
  return parts.join("");
}

async function readSseJsonStream(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return { text: "", payload: null, state: "no_stream_reader" };
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let terminalPayload = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, "\n");
    let marker = buffer.indexOf("\n\n");
    while (marker >= 0) {
      const frame = buffer.slice(0, marker);
      buffer = buffer.slice(marker + 2);
      marker = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let payload = null;
      try { payload = JSON.parse(data); } catch { continue; }
      const eventType = normalizeText(payload?.type || "");
      if (eventType === "response.output_text.delta" || eventType === "response.output_text.done") {
        accumulated += extractCodexEventDelta(payload);
      }
      if (["response.completed", "response.done", "response.incomplete"].includes(eventType)) {
        terminalPayload = payload?.response || payload;
      }
    }
  }
  return { text: accumulated, payload: terminalPayload, state: terminalPayload ? "completed" : "stream_exhausted" };
}

// ── Model resolution ──

function resolvePlannerModel(runtimeCfg = {}) {
  const compoundCfg = runtimeCfg.compound_planner && typeof runtimeCfg.compound_planner === "object"
    ? runtimeCfg.compound_planner : {};
  const configured = normalizeText(compoundCfg.model || "");
  if (configured && configured !== "inherit_main_grade") return configured;

  const routerCfg = runtimeCfg.policy_router && typeof runtimeCfg.policy_router === "object"
    ? runtimeCfg.policy_router : {};
  const candidates = routerCfg.candidates && typeof routerCfg.candidates === "object"
    ? routerCfg.candidates : {};
  const defaultJudge = normalizeText(routerCfg.default_judge || "main_grade_model");
  const judgeConfig = candidates[defaultJudge] && typeof candidates[defaultJudge] === "object"
    ? candidates[defaultJudge] : {};
  const judgeModel = normalizeText(judgeConfig.model || "");
  if (judgeModel) return judgeModel;

  const policy = loadJson(MODEL_POLICY_FILE);
  const mainModel = normalizeText(policy?.main_model || "");
  if (mainModel) return mainModel;

  const [resolved] = resolveModelAndThinking("strong", "compound_planner", {
    workerPool: "octoclaw-main",
    phase: "collect",
    route: "direct",
    profile: "research",
  });
  return normalizeText(resolved);
}

function resolvePlannerBaseUrl(runtimeCfg = {}) {
  const compoundCfg = runtimeCfg.compound_planner && typeof runtimeCfg.compound_planner === "object"
    ? runtimeCfg.compound_planner : {};
  const explicit = normalizeText(
    compoundCfg.base_url
      || compoundCfg.baseUrl
      || process.env.OCTOCLAW_COMPOUND_PLANNER_BASE_URL
      || "",
  ).replace(/\/+$/u, "");
  if (explicit) return explicit;
  return "";
}

function resolvePlannerApiKey(runtimeCfg = {}) {
  const compoundCfg = runtimeCfg.compound_planner && typeof runtimeCfg.compound_planner === "object"
    ? runtimeCfg.compound_planner : {};
  return normalizeText(
    compoundCfg.api_key
      || process.env.OCTOCLAW_COMPOUND_PLANNER_API_KEY
      || (compoundCfg.api_key_env ? process.env[normalizeText(compoundCfg.api_key_env)] : "")
      || "",
  );
}

function resolveTimeout(runtimeCfg = {}) {
  const compoundCfg = runtimeCfg.compound_planner && typeof runtimeCfg.compound_planner === "object"
    ? runtimeCfg.compound_planner : {};
  const explicit = Number(compoundCfg.timeout_ms || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(100, explicit);
  return DEFAULT_PLANNER_TIMEOUT_MS;
}

function isCompoundPlannerEnabled(runtimeCfg = {}) {
  const features = runtimeCfg.features && typeof runtimeCfg.features === "object"
    ? runtimeCfg.features : {};
  if ("compound_planner_enabled" in features) return Boolean(features.compound_planner_enabled);
  const envVal = normalizeText(process.env.OCTOCLAW_COMPOUND_PLANNER_ENABLED || "").toLowerCase();
  if (["0", "false", "no", "off"].includes(envVal)) return false;
  if (["1", "true", "yes", "on"].includes(envVal)) return true;
  return true;
}

// ── Request building ──

function buildPlannerRequestPayload({ prompt = "", intentPacket = {} } = {}) {
  return {
    user_prompt: normalizeText(prompt).slice(0, 8000),
    intent_class: normalizeText(intentPacket?.intent_class || "undetermined"),
    signals: intentPacket?.signals && typeof intentPacket.signals === "object" ? intentPacket.signals : {},
  };
}

function buildCodexNativePayload(model, requestPayload) {
  const resolvedModel = terminalModelRef(model) || splitModelRef(model).model || normalizeText(model);
  return {
    model: resolvedModel,
    store: false,
    stream: true,
    text: { verbosity: "low" },
    instructions: PLANNER_SYSTEM_PROMPT,
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify(requestPayload),
      }],
    }],
  };
}

function buildOpenAiCompatiblePayload(model, requestPayload) {
  return {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(requestPayload) },
    ],
  };
}

// ── Model invocation ──

async function invokeCodexNativePlanner(model, requestPayload, timeoutMs) {
  if (envFlagEnabled("OCTOCLAW_COMPOUND_PLANNER_DISABLE_NETWORK")) {
    return { ok: false, state: "network_disabled_for_tests" };
  }
  const baseUrl = resolveCodexBaseUrl();
  const { token, state } = resolveCodexAccessToken();
  if (!baseUrl || !token || typeof fetch !== "function") {
    return { ok: false, state: state === "ok" ? "codex_native_adapter_unavailable" : state };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/codex/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildCodexNativePayload(model, requestPayload)),
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, state: `http_${response.status}` };
    const streamed = await readSseJsonStream(response);
    const payload = parseLooseJson(streamed.text || extractOutputTextParts(streamed.payload));
    if (!payload) return { ok: false, state: "invalid_json" };
    return { ok: true, payload };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, state: err?.name === "AbortError" ? "timeout" : "error" };
  }
}

async function invokeOpenAiCompatiblePlanner(model, baseUrl, apiKey, requestPayload, timeoutMs) {
  if (!baseUrl || !apiKey || !model || typeof fetch !== "function") {
    return { ok: false, state: "openai_compatible_adapter_unavailable" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAiCompatiblePayload(model, requestPayload)),
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, state: `http_${response.status}` };
    const payload = await response.json();
    const content = normalizeText(payload?.choices?.[0]?.message?.content || "");
    const parsed = parseLooseJson(content);
    if (!parsed) return { ok: false, state: "invalid_json" };
    return { ok: true, payload: parsed };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, state: err?.name === "AbortError" ? "timeout" : "error" };
  }
}

// ── Result parsing ──

function parsePlannerResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const decisionMode = normalizeText(raw.decision_mode);
  if (decisionMode === "simple_route") return { decision_mode: "simple_route" };
  if (decisionMode === "compound_plan") {
    if (Array.isArray(raw.work_items) && raw.work_items.length > 0) {
      return { decision_mode: "compound_plan", work_items: raw.work_items, max_depth: raw.max_depth };
    }
  }
  return null;
}

// ── Main export ──

export async function invokeCompoundPlanner({
  prompt = "",
  intentPacket = {},
  sessionContext = {},
  runtimeCfg = {},
} = {}) {
  // 1. Feature flag gate
  if (!isCompoundPlannerEnabled(runtimeCfg)) {
    return { ...SIMPLE_ROUTE_RESULT };
  }

  // 2. Test fixture support
  const fixture = readJsonEnv("OCTOCLAW_COMPOUND_PLANNER_RESULT_JSON");
  if (fixture) {
    const parsed = parsePlannerResult(fixture);
    if (parsed) {
      if (parsed.decision_mode === "compound_plan") {
        const normalized = normalizeCompoundPlan(parsed);
        if (normalized.valid) return { decision_mode: "compound_plan", plan: normalized };
        return { ...SIMPLE_ROUTE_RESULT };
      }
      return parsed;
    }
    return { ...SIMPLE_ROUTE_RESULT };
  }

  // 3. Resolve model and config
  const model = resolvePlannerModel(runtimeCfg);
  if (!model) return { ...SIMPLE_ROUTE_RESULT };

  const timeoutMs = resolveTimeout(runtimeCfg);
  const requestPayload = buildPlannerRequestPayload({ prompt, intentPacket });

  // 4. Try Codex native first (for GPT-5.x models)
  if (isCodexNativeCandidate(model)) {
    const result = await invokeCodexNativePlanner(model, requestPayload, timeoutMs);
    if (result.ok) {
      const parsed = parsePlannerResult(result.payload);
      if (parsed) {
        if (parsed.decision_mode === "compound_plan") {
          const normalized = normalizeCompoundPlan(parsed);
          if (normalized.valid) return { decision_mode: "compound_plan", plan: normalized };
          return { ...SIMPLE_ROUTE_RESULT };
        }
        return parsed;
      }
    }
    // Fall through to OpenAI-compatible
  }

  // 5. Try OpenAI-compatible adapter
  const baseUrl = resolvePlannerBaseUrl(runtimeCfg);
  const apiKey = resolvePlannerApiKey(runtimeCfg);
  if (baseUrl && apiKey) {
    const result = await invokeOpenAiCompatiblePlanner(model, baseUrl, apiKey, requestPayload, timeoutMs);
    if (result.ok) {
      const parsed = parsePlannerResult(result.payload);
      if (parsed) {
        if (parsed.decision_mode === "compound_plan") {
          const normalized = normalizeCompoundPlan(parsed);
          if (normalized.valid) return { decision_mode: "compound_plan", plan: normalized };
          return { ...SIMPLE_ROUTE_RESULT };
        }
        return parsed;
      }
    }
  }

  // 6. No adapter succeeded — fail open to simple_route
  return { ...SIMPLE_ROUTE_RESULT };
}
