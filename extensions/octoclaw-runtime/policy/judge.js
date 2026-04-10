import { spawn } from "node:child_process";

export const POLICY_JUDGE_RESULT_SCHEMA_VERSION = "octoclaw.policy_judge.result/v1";
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

export function selectPolicyJudge(runtimeCfg = {}) {
  const cfg = routerConfig(runtimeCfg);
  const candidates = cfg.candidates && typeof cfg.candidates === "object" && !Array.isArray(cfg.candidates)
    ? cfg.candidates
    : {};
  const defaultName = normalizeText(cfg.default_judge || "main_grade_model") || "main_grade_model";
  const names = [
    defaultName,
    ...Object.keys(candidates).filter((name) => name !== defaultName),
  ];
  for (const name of names) {
    const config = candidates[name] && typeof candidates[name] === "object" && !Array.isArray(candidates[name])
      ? candidates[name]
      : {};
    if (config.enabled === false) continue;
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
    : [];
  const confidence = Math.max(0, Math.min(1, Number(payload.confidence || 0)));
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
    raw: payload,
  };
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

export async function invokePolicyJudge({
  task = "",
  metadata = {},
  intentPacket = {},
  runtimeCfg = {},
  cwd = process.cwd(),
} = {}) {
  const cfg = routerConfig(runtimeCfg);
  const features = runtimeCfg?.features && typeof runtimeCfg.features === "object" && !Array.isArray(runtimeCfg.features)
    ? runtimeCfg.features
    : {};
  const liveEnabled = Boolean("policy_judge_live" in features ? features.policy_judge_live : true);
  const judge = selectPolicyJudge(runtimeCfg);
  const context = {
    selected: judge.name,
    provider: judge.provider,
    model: judge.model,
    cwd,
    timeoutMs: Math.max(100, Number(cfg.timeout_ms || judge.config.timeout_ms || 1200)),
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
    });
  }

  const request = buildPolicyJudgeRequest({ task, metadata, intentPacket });
  const command = normalizeText(
    judge.config.command
      || process.env.OCTOCLAW_POLICY_JUDGE_COMMAND
      || "",
  );
  if (command) {
    return invokeCommandJudge(command, request, context);
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
