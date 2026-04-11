import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MODEL_POLICY_FILE, loadJson, resolveRuntimeFeatureFlags } from "./config.js";
import { resolveModelAndThinking } from "./model.js";

export const POLICY_JUDGE_RESULT_SCHEMA_VERSION = "octoclaw.policy_judge.result/v1";
const OPENCLAW_MAIN_AGENT_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "agent");
const OPENCLAW_AUTH_PROFILES_FILE = path.join(OPENCLAW_MAIN_AGENT_DIR, "auth-profiles.json");
const OPENCLAW_MODELS_FILE = path.join(OPENCLAW_MAIN_AGENT_DIR, "models.json");
const CODEX_NATIVE_PROVIDER = "openai-codex";
const CODEX_NATIVE_BASE_URL = "https://chatgpt.com/backend-api";
const VALID_ROUTES = new Set(["direct", "runner", "spawn_single", "spawn_multi"]);
const VALID_REQUEST_KINDS = new Set([
  "chat_or_explain",
  "execution_followup",
  "surface_query",
  "fresh_external_lookup",
  "work_request",
  "ambiguous",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeChoice(value, allowed = new Set()) {
  const text = normalizeText(value);
  return allowed.has(text) ? text : "";
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

function routerConfig(runtimeCfg = {}) {
  return runtimeCfg?.policy_router && typeof runtimeCfg.policy_router === "object" && !Array.isArray(runtimeCfg.policy_router)
    ? runtimeCfg.policy_router
    : {};
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

function isCodexNativeJudgeCandidate(modelRef) {
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

function resolveCodexAuthProfileId(judge, profiles = {}) {
  const hasUsableAccess = (entry) => Boolean(normalizeText(entry?.access || entry?.oauth?.credentials?.access || ""));
  const explicit = normalizeText(
    judge?.config?.auth_profile
      || process.env.OCTOCLAW_POLICY_JUDGE_AUTH_PROFILE
      || "",
  );
  if (explicit && profiles[explicit]) return explicit;
  if (profiles["openai-codex:default"] && hasUsableAccess(profiles["openai-codex:default"])) return "openai-codex:default";
  const candidates = Object.entries(profiles).filter(([, entry]) => normalizeText(entry?.provider) === CODEX_NATIVE_PROVIDER);
  if (candidates.length === 0) return "";
  const withAccess = candidates.find(([, entry]) => normalizeText(entry?.access || entry?.oauth?.credentials?.access));
  return normalizeText((withAccess || candidates[0])?.[0] || "");
}

function resolveCodexAccessToken(judge) {
  const authProfiles = loadJsonFile(OPENCLAW_AUTH_PROFILES_FILE);
  const profiles = authProfiles?.profiles && typeof authProfiles.profiles === "object" && !Array.isArray(authProfiles.profiles)
    ? authProfiles.profiles
    : {};
  const profileId = resolveCodexAuthProfileId(judge, profiles);
  if (!profileId) {
    return { token: "", profileId: "", state: "codex_native_profile_missing" };
  }
  const profile = profiles[profileId];
  const token = normalizeText(profile?.access || profile?.oauth?.credentials?.access || "");
  if (!token) {
    return { token: "", profileId, state: "codex_native_access_missing" };
  }
  const expiresAt = parseTimestamp(profile?.expires || profile?.oauth?.credentials?.expires_at || profile?.oauth?.credentials?.expiresAt || "");
  if (expiresAt && expiresAt <= Date.now() + 15_000) {
    return { token: "", profileId, state: "codex_native_access_expired" };
  }
  return { token, profileId, state: "ok" };
}

function resolveCodexBaseUrl(judge) {
  const explicit = normalizeText(
    judge?.config?.codex_base_url
      || process.env.OCTOCLAW_POLICY_JUDGE_CODEX_BASE_URL
      || "",
  ).replace(/\/+$/u, "");
  if (explicit) return explicit;
  const models = loadJsonFile(OPENCLAW_MODELS_FILE);
  const providerBaseUrl = normalizeText(models?.providers?.[CODEX_NATIVE_PROVIDER]?.baseUrl || "").replace(/\/+$/u, "");
  return providerBaseUrl || CODEX_NATIVE_BASE_URL;
}

function buildCodexNativeJudgePayload(model, request) {
  const resolvedModel = terminalModelRef(model) || splitModelRef(model).model || normalizeText(model);
  return {
    model: resolvedModel,
    store: false,
    stream: true,
    text: { verbosity: "low" },
    instructions: [
      "You are OctoClaw's stateless routing judge.",
      "Return JSON only.",
      "Do not answer the user task.",
      "Choose route, scope, target, and evidence from semantics, risk, and feasibility.",
    ].join(" "),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(request),
          },
        ],
      },
    ],
  };
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
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, cursor + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function extractCodexEventDelta(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.delta?.text === "string") return event.delta.text;
  if (typeof event.part?.text === "string") return event.part.text;
  return "";
}

function resolveStatelessEphemeralModel(judge, runtimeCfg = {}) {
  const configured = normalizeText(judge?.config?.model || judge?.model || "");
  if (configured && configured !== "inherit_main_grade") return configured;
  const policy = loadJson(MODEL_POLICY_FILE);
  const mainModel = normalizeText(policy?.main_model || "");
  if (mainModel) return mainModel;
  const [resolved] = resolveModelAndThinking("strong", "policy_judge", {
    workerPool: "octoclaw-main",
    phase: "collect",
    route: "direct",
    profile: "research",
  });
  return normalizeText(resolved);
}

export function selectPolicyJudge(runtimeCfg = {}) {
  const cfg = routerConfig(runtimeCfg);
  const candidates = cfg.candidates && typeof cfg.candidates === "object" && !Array.isArray(cfg.candidates)
    ? cfg.candidates
    : {};
  const flags = resolveRuntimeFeatureFlags(runtimeCfg);
  const defaultName = normalizeText(flags.judge_lock || cfg.default_judge || "main_grade_model") || "main_grade_model";
  const names = [
    defaultName,
    ...Object.keys(candidates).filter((name) => name !== defaultName),
  ];
  for (const name of names) {
    const config = candidates[name] && typeof candidates[name] === "object" && !Array.isArray(candidates[name])
      ? candidates[name]
      : {};
    if (config.enabled === false) continue;
    if (name === "cheap_model" && !flags.cheap_judge_live) continue;
    if (name === "local_model" && !flags.local_judge_live) continue;
    return {
      name,
      config,
      provider: normalizeText(config.provider || name),
      model: normalizeText(config.model || ""),
    };
  }
  return {
    name: defaultName,
    config: {},
    provider: defaultName,
    model: "",
  };
}

export function selectPolicyJudgeCandidates(runtimeCfg = {}) {
  const cfg = routerConfig(runtimeCfg);
  const candidates = cfg.candidates && typeof cfg.candidates === "object" && !Array.isArray(cfg.candidates)
    ? cfg.candidates
    : {};
  const flags = resolveRuntimeFeatureFlags(runtimeCfg);
  const preferred = normalizeText(flags.judge_lock || cfg.default_judge || "main_grade_model") || "main_grade_model";
  const ordered = [
    preferred,
    "cheap_model",
    "local_model",
    "main_grade_model",
  ].filter(Boolean);
  const seen = new Set();
  const selected = [];
  for (const name of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    const config = candidates[name] && typeof candidates[name] === "object" && !Array.isArray(candidates[name])
      ? candidates[name]
      : {};
    if (config.enabled === false) continue;
    if (name === "cheap_model" && !flags.cheap_judge_live) continue;
    if (name === "local_model" && !flags.local_judge_live) continue;
    selected.push({
      name,
      config,
      provider: normalizeText(config.provider || name),
      model: normalizeText(config.model || ""),
    });
  }
  if (selected.length > 0) return selected;
  return [{
    name: preferred,
    config: {},
    provider: preferred,
    model: "",
  }];
}

export function buildPolicyJudgeRequest({
  task = "",
  metadata = {},
  intentPacket = {},
} = {}) {
  return {
    schema_version: "octoclaw.policy_judge.request/v1",
    prompt: normalizeText(task),
    normalized_message: normalizeText(task).slice(0, 4000),
    channel: normalizeText(metadata?.channel || ""),
    session: {
      key: normalizeText(metadata?.session_key || ""),
      origin: normalizeText(metadata?.session_origin || ""),
      target: normalizeText(metadata?.session_target || ""),
      thread_key: normalizeText(metadata?.session_thread_key || ""),
    },
    intent_packet: intentPacket && typeof intentPacket === "object" && !Array.isArray(intentPacket) ? intentPacket : {},
    required_output: {
      schema_version: POLICY_JUDGE_RESULT_SCHEMA_VERSION,
      fields: [
        "request_kind",
        "scope",
        "target",
        "route",
        "evidence_required",
        "confidence",
        "reason_codes",
      ],
      allowed_routes: [...VALID_ROUTES],
      allowed_request_kinds: [...VALID_REQUEST_KINDS],
      notes: [
        "Return JSON only.",
        "Do not answer the user task.",
        "Choose route/scope/evidence from semantics, not keywords.",
        "Use runner for bounded read/probe work, spawn_single for deliverable work, direct only for chat/current-session facts.",
      ],
    },
  };
}

export function normalizePolicyJudgeResult(raw = {}, context = {}) {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const route = normalizeText(payload.route || payload.recommended_route || "");
  const requestKind = normalizeText(payload.request_kind || payload.intent || "");
  const scope = normalizeText(payload.scope || "");
  const target = normalizeText(payload.target || "");
  const evidence = Array.isArray(payload.evidence_required)
    ? payload.evidence_required.map((item) => normalizeText(item)).filter(Boolean)
    : (normalizeText(payload.evidence_required) ? [normalizeText(payload.evidence_required)] : []);
  const confidence = Math.max(0, Math.min(1, Number(payload.confidence || 0)));
  const attempts = Array.isArray(context.attempts || payload.attempts)
    ? (context.attempts || payload.attempts).map((item) => {
        const entry = item && typeof item === "object" && !Array.isArray(item) ? item : {};
        return {
          selected: normalizeText(entry.selected),
          provider: normalizeText(entry.provider),
          model: normalizeText(entry.model),
          invocation_state: normalizeText(entry.invocation_state),
          timeout_budget_ms: Math.max(0, Number(entry.timeout_budget_ms || 0)),
          fallback_stage: normalizeChoice(entry.fallback_stage, new Set(["primary", "secondary", "planner_fallback"])),
        };
      }).filter((item) => item.selected || item.provider || item.model || item.invocation_state)
    : [];
  return {
    schema_version: POLICY_JUDGE_RESULT_SCHEMA_VERSION,
    selected: normalizeText(context.selected || payload.selected || ""),
    provider: normalizeText(context.provider || payload.provider || ""),
    model: normalizeText(context.model || payload.model || ""),
    invoked: Boolean(context.invoked ?? payload.invoked),
    invocation_state: normalizeText(context.invocation_state || payload.invocation_state || ""),
    route,
    request_kind: requestKind,
    scope,
    target,
    evidence_required: evidence,
    confidence,
    reason_codes: Array.isArray(payload.reason_codes)
      ? payload.reason_codes.map((item) => normalizeText(item)).filter(Boolean).slice(0, 12)
      : [],
    timeout_budget_ms: Math.max(0, Number(context.timeout_budget_ms || payload.timeout_budget_ms || 0)),
    fallback_stage: normalizeChoice(context.fallback_stage || payload.fallback_stage || "", new Set(["primary", "secondary", "planner_fallback"])),
    final_judge_source: normalizeChoice(
      context.final_judge_source || payload.final_judge_source || "",
      new Set(["main_grade_model", "cheap_model", "local_model", "planner_fallback"]),
    ),
    attempts,
    raw: payload,
  };
}

function judgeFailureEligibleForCascade(invocationState = "") {
  const normalized = normalizeText(invocationState);
  if (!normalized) return false;
  if (["timeout", "error", "http_500", "http_502", "http_503", "http_504"].includes(normalized)) return true;
  if (normalized.startsWith("http_5")) return true;
  return [
    "adapter_unavailable",
    "openai_compatible_adapter_unavailable",
    "codex_native_adapter_unavailable",
    "codex_native_access_missing",
    "codex_native_access_expired",
    "codex_native_profile_missing",
  ].includes(normalized);
}

function timeoutBudgetForJudge(judge, cfg = {}, stage = "primary") {
  const explicit = Number(judge?.config?.timeout_ms || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(100, explicit);
  const provider = normalizeText(judge?.provider || judge?.config?.provider || "");
  const base = Number(cfg.timeout_ms || 1200);
  if (stage === "primary") return Math.max(100, base > 0 ? base : 2000);
  if (provider === "openai_compatible") return 1400;
  return 700;
}

async function invokeSingleJudge(judge, request, context, runtimeCfg = {}) {
  const command = normalizeText(
    judge.config.command
      || process.env.OCTOCLAW_POLICY_JUDGE_COMMAND
      || "",
  );
  if (command) {
    return invokeCommandJudge(command, request, context);
  }
  if (judge.provider === "stateless_ephemeral_judge") {
    return invokeStatelessEphemeralJudge(judge, request, context, runtimeCfg);
  }
  if (judge.provider === "openai_compatible") {
    return invokeOpenAiCompatibleJudge(judge, request, context);
  }
  return normalizePolicyJudgeResult({}, {
    ...context,
    invoked: false,
    invocation_state: "adapter_unavailable",
  });
}

function runJudgeCommand(command, request, { cwd = process.cwd(), timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err), stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function invokeCommandJudge(command, request, context) {
  const result = await runJudgeCommand(command, request, context);
  if (!result.ok) {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: true,
      invocation_state: result.timedOut ? "command_timeout" : "command_failed",
    });
  }
  try {
    return normalizePolicyJudgeResult(JSON.parse(result.stdout || "{}"), {
      ...context,
      invoked: true,
      invocation_state: "completed",
    });
  } catch {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: true,
      invocation_state: "invalid_json",
    });
  }
}

async function invokeOpenAiCompatibleJudge(judge, request, context) {
  const baseUrl = normalizeText(
    judge.config.base_url
      || judge.config.baseUrl
      || process.env.OCTOCLAW_POLICY_JUDGE_BASE_URL
      || "",
  ).replace(/\/+$/u, "");
  const apiKey = normalizeText(
    judge.config.api_key
      || process.env.OCTOCLAW_POLICY_JUDGE_API_KEY
      || (judge.config.api_key_env ? process.env[normalizeText(judge.config.api_key_env)] : "")
      || "",
  );
  const model = normalizeText(judge.model || process.env.OCTOCLAW_POLICY_JUDGE_MODEL || "");
  if (!baseUrl || !apiKey || !model || typeof fetch !== "function") {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: false,
      invocation_state: "openai_compatible_adapter_unavailable",
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs || 1200);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are OctoClaw's stateless routing judge.",
              "Return JSON only.",
              "Do not solve the user task.",
              "Select route/scope/evidence by semantics and risk.",
            ].join(" "),
          },
          { role: "user", content: JSON.stringify(request) },
        ],
      }),
    });
    clearTimeout(timer);
    if (!response.ok) {
      return normalizePolicyJudgeResult({}, {
        ...context,
        invoked: true,
        invocation_state: `http_${response.status}`,
      });
    }
    const payload = await response.json();
    const content = normalizeText(payload?.choices?.[0]?.message?.content || "");
    return normalizePolicyJudgeResult(JSON.parse(content || "{}"), {
      ...context,
      invoked: true,
      invocation_state: "completed",
    });
  } catch (err) {
    clearTimeout(timer);
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: true,
      invocation_state: err?.name === "AbortError" ? "timeout" : "error",
    });
  }
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
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
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

async function invokeCodexNativeJudge(judge, request, context) {
  if (envFlagEnabled("OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK")) {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: false,
      invocation_state: "network_disabled_for_tests",
    });
  }
  const model = normalizeText(judge.model || "");
  const baseUrl = resolveCodexBaseUrl(judge);
  const { token, state } = resolveCodexAccessToken(judge);
  if (!model || !baseUrl || !token || typeof fetch !== "function") {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: false,
      invocation_state: state === "ok" ? "codex_native_adapter_unavailable" : state,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs || 1200);
  try {
    const response = await fetch(`${baseUrl}/codex/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildCodexNativeJudgePayload(model, request)),
    });
    clearTimeout(timer);
    if (!response.ok) {
      return normalizePolicyJudgeResult({}, {
        ...context,
        invoked: true,
        invocation_state: `http_${response.status}`,
      });
    }
    const streamed = await readSseJsonStream(response);
    const payload = parseLooseJson(streamed.text || extractOutputTextParts(streamed.payload));
    if (!payload) {
      return normalizePolicyJudgeResult({}, {
        ...context,
        invoked: true,
        invocation_state: "invalid_json",
      });
    }
    return normalizePolicyJudgeResult(payload, {
      ...context,
      invoked: true,
      invocation_state: "completed",
      model,
    });
  } catch (err) {
    clearTimeout(timer);
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: true,
      invocation_state: err?.name === "AbortError" ? "timeout" : "error",
    });
  }
}

async function invokeStatelessEphemeralJudge(judge, request, context, runtimeCfg = {}) {
  const resolvedModel = resolveStatelessEphemeralModel(judge, runtimeCfg);
  const bridgedJudge = {
    ...judge,
    config: {
      ...(judge?.config && typeof judge.config === "object" ? judge.config : {}),
      base_url: normalizeText(
        judge?.config?.base_url
          || judge?.config?.baseUrl
          || process.env.OCTOCLAW_POLICY_JUDGE_BASE_URL
          || process.env.OPENAI_BASE_URL
          || "",
      ),
      api_key: normalizeText(
        judge?.config?.api_key
          || process.env.OCTOCLAW_POLICY_JUDGE_API_KEY
          || (judge?.config?.api_key_env ? process.env[normalizeText(judge.config.api_key_env)] : "")
          || process.env.OPENAI_API_KEY
          || "",
      ),
    },
    model: resolvedModel,
  };
  if (!bridgedJudge.config.base_url || !bridgedJudge.config.api_key) {
    if (isCodexNativeJudgeCandidate(resolvedModel)) {
      return invokeCodexNativeJudge(bridgedJudge, request, context);
    }
  }
  return invokeOpenAiCompatibleJudge(bridgedJudge, request, context);
}

export async function invokePolicyJudge({
  task = "",
  metadata = {},
  intentPacket = {},
  runtimeCfg = {},
  cwd = process.cwd(),
} = {}) {
  const cfg = routerConfig(runtimeCfg);
  const flags = resolveRuntimeFeatureFlags(runtimeCfg);
  const liveEnabled = Boolean(flags.policy_judge_live);
  const judges = selectPolicyJudgeCandidates(runtimeCfg);
  const primaryJudge = judges[0];
  const context = {
    selected: primaryJudge.name,
    provider: primaryJudge.provider,
    model: resolveStatelessEphemeralModel(primaryJudge, runtimeCfg),
    cwd,
    timeoutMs: timeoutBudgetForJudge(primaryJudge, cfg, "primary"),
  };
  if (!liveEnabled || String(cfg.mode || "model_first") === "legacy_only") {
    return normalizePolicyJudgeResult({}, {
      ...context,
      invoked: false,
      invocation_state: "disabled",
    });
  }

  const fixture = readJsonEnv("OCTOCLAW_POLICY_JUDGE_RESULT_JSON");
  if (fixture) {
    return normalizePolicyJudgeResult(fixture, {
      ...context,
      invoked: true,
      invocation_state: "completed_fixture",
      timeout_budget_ms: context.timeoutMs,
      fallback_stage: "primary",
      final_judge_source: primaryJudge.name || "main_grade_model",
      attempts: [{
        selected: primaryJudge.name,
        provider: primaryJudge.provider,
        model: context.model,
        invocation_state: "completed_fixture",
        timeout_budget_ms: context.timeoutMs,
        fallback_stage: "primary",
      }],
    });
  }

  const request = buildPolicyJudgeRequest({ task, metadata, intentPacket });
  const attempts = [];
  let finalResult = null;
  for (let index = 0; index < judges.length; index += 1) {
    const judge = judges[index];
    const fallbackStage = index === 0 ? "primary" : "secondary";
    const timeoutMs = timeoutBudgetForJudge(judge, cfg, fallbackStage);
    const attemptContext = {
      selected: judge.name,
      provider: judge.provider,
      model: resolveStatelessEphemeralModel(judge, runtimeCfg),
      cwd,
      timeoutMs,
      timeout_budget_ms: timeoutMs,
      fallback_stage: fallbackStage,
    };
    const result = await invokeSingleJudge(judge, request, attemptContext, runtimeCfg);
    attempts.push({
      selected: attemptContext.selected,
      provider: attemptContext.provider,
      model: attemptContext.model,
      invocation_state: String(result.invocation_state || ""),
      timeout_budget_ms: timeoutMs,
      fallback_stage: fallbackStage,
    });
    if (normalizeText(result.invocation_state) === "completed") {
      finalResult = normalizePolicyJudgeResult(result.raw || {}, {
        ...attemptContext,
        invoked: result.invoked,
        invocation_state: result.invocation_state,
        timeout_budget_ms: timeoutMs,
        fallback_stage: fallbackStage,
        final_judge_source: judge.name || (index === 0 ? "main_grade_model" : "cheap_model"),
        attempts,
      });
      break;
    }
    finalResult = normalizePolicyJudgeResult(result.raw || {}, {
      ...attemptContext,
      invoked: result.invoked,
      invocation_state: result.invocation_state,
      timeout_budget_ms: timeoutMs,
      fallback_stage: fallbackStage,
      final_judge_source: judge.name || "",
      attempts,
    });
    if (!judgeFailureEligibleForCascade(result.invocation_state) || index === judges.length - 1) {
      break;
    }
  }
  return finalResult || normalizePolicyJudgeResult({}, {
    ...context,
    invoked: false,
    invocation_state: "adapter_unavailable",
    timeout_budget_ms: context.timeoutMs,
    fallback_stage: "planner_fallback",
    final_judge_source: "planner_fallback",
    attempts,
  });
}
