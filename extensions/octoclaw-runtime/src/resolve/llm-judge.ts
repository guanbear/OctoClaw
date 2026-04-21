import {
  ESCALATION_DEFAULTS,
  JUDGE_INPUT_CAPS,
  JUDGE_FAST_DEFAULTS,
  REMOTE_JUDGE_DEFAULTS,
  isActionableJudgeResult,
  isRemoteJudgeOutput,
  isValidJudgeOutput,
  type DualJudgeConfig,
  type EscalationReason,
  type JudgeFastConfig,
  type JudgeInput,
  type JudgeOutput,
  type RemoteJudgeOutput,
} from "@octoclaw/policy/judge-schema";
import type { JudgeContextPacket } from "@octoclaw/policy/judge";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildRemoteJudgeSystemPrompt,
  buildRemoteJudgeUserPrompt,
} from "@octoclaw/policy/judge-prompt";
import { buildExpandedPacket, buildJudgeContextPacket } from "./judge-context-packet.js";

export { isValidJudgeOutput, isActionableJudgeResult };
export type { DualJudgeConfig, EscalationReason, JudgeFastConfig, JudgeInput, JudgeOutput, RemoteJudgeOutput };

type JudgeConfig = JudgeFastConfig;
type RemoteJudgeConfig = DualJudgeConfig["remote"];

export type JudgeFailureClass = "timeout" | "http_error" | "invalid_json" | "unknown";

export let lastJudgeFailureClass: JudgeFailureClass | null = null;

function warnJudgeFailure(error: unknown): void {
  if (process.env.OCTOCLAW_JUDGE_DEBUG) {
    console.warn(`[octoclaw-judge] judge failed: class=${error instanceof Error ? error.constructor.name : "unknown"} message=${error instanceof Error ? error.message : String(error)}`);
  }
}

function classifyJudgeError(error: unknown): JudgeFailureClass {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timeout";
  }
  if (error instanceof Error && /^judge HTTP \d+:/u.test(error.message)) {
    return "http_error";
  }
  return "unknown";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function coerceJudgeOutput(parsed: Record<string, unknown>): JudgeOutput {
  const ackTextRaw = parsed.ackText ?? parsed.ack_text ?? null;
  return {
    route: parsed.route as JudgeOutput["route"],
    confidence: parsed.confidence as number,
    abstainReason: (parsed.abstainReason ?? parsed.abstain_reason ?? null) as string | null,
    ackText: typeof ackTextRaw === "string" ? ackTextRaw : null,
    role: (parsed.role ?? null) as JudgeOutput["role"],
    complexityBand: (parsed.complexityBand ?? parsed.complexity_band) as JudgeOutput["complexityBand"],
    expectedDurationBand: (parsed.expectedDurationBand ?? parsed.expected_duration_band) as JudgeOutput["expectedDurationBand"],
    qualityBar: (parsed.qualityBar ?? parsed.quality_bar) as JudgeOutput["qualityBar"],
    riskFlags: asStringArray(parsed.riskFlags ?? parsed.risk_flags),
    delegateReasonCodes: asStringArray(parsed.delegateReasonCodes ?? parsed.delegate_reason_codes) as JudgeOutput["delegateReasonCodes"],
    routeConfidence: typeof (parsed.routeConfidence ?? parsed.route_confidence) === "number"
      ? (parsed.routeConfidence ?? parsed.route_confidence) as number
      : undefined,
    requestKind: (parsed.requestKind ?? parsed.request_kind) as string | undefined,
    scope: parsed.scope as string | undefined,
    target: parsed.target as string | undefined,
    budgetBand: (parsed.budgetBand ?? parsed.budget_band) as JudgeOutput["budgetBand"],
    reasonCodes: (parsed.reasonCodes ?? parsed.reason_codes) as string[] | undefined,
    evidenceRequired: (parsed.evidenceRequired ?? parsed.evidence_required) as boolean | undefined,
    ackRequired: (parsed.ackRequired ?? parsed.ack_required) as boolean | undefined,
  };
}

export function resolveJudgeConfig(raw: Record<string, unknown>): JudgeConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const enabled = raw.enabled !== false;
  if (!enabled) return null;

  const modelId = String(raw.modelId ?? "");
  const baseUrl = String(raw.baseUrl ?? "");
  const apiKey = String(raw.apiKey ?? "");
  if (!modelId || !baseUrl) return null;

  const isLocal = Boolean(raw.local);

  return {
    enabled: true,
    shadowMode: Boolean(raw.shadowMode ?? JUDGE_FAST_DEFAULTS.shadowMode),
    modelId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    timeoutMs: Math.max(500, Number(raw.timeoutMs ?? JUDGE_FAST_DEFAULTS.timeoutMs)),
    timeoutLocalMs: Math.max(300, Number(raw.timeoutLocalMs ?? JUDGE_FAST_DEFAULTS.timeoutLocalMs)),
    minConfidence: Math.min(1, Math.max(0, Number(raw.minConfidence ?? JUDGE_FAST_DEFAULTS.minConfidence))),
    local: isLocal,
    judgeAckEnabled: raw.judgeAckEnabled !== undefined ? Boolean(raw.judgeAckEnabled) : isLocal,
  };
}

function resolveRemoteJudgeConfig(raw: Record<string, unknown>): RemoteJudgeConfig {
  const modelId = String(raw.modelId ?? REMOTE_JUDGE_DEFAULTS.modelId);
  const baseUrl = String(raw.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = String(raw.apiKey ?? "");

  return {
    enabled: raw.enabled === true && Boolean(modelId) && Boolean(baseUrl),
    modelId,
    baseUrl,
    apiKey,
    timeoutMs: Math.max(500, Number(raw.timeoutMs ?? REMOTE_JUDGE_DEFAULTS.timeoutMs)),
    shadowMode: Boolean(raw.shadowMode ?? REMOTE_JUDGE_DEFAULTS.shadowMode),
  };
}

export function resolveDualJudgeConfig(raw: Record<string, unknown>): DualJudgeConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const dualRaw = asObject(raw._dualJudgeConfig);
  if (Object.keys(dualRaw).length > 0) {
    const local = resolveJudgeConfig(asObject(dualRaw.local));
    if (!local) return null;
    return {
      local,
      remote: resolveRemoteJudgeConfig(asObject(dualRaw.remote)),
      escalation: {
        minConfidence: Math.min(1, Math.max(0, Number(asObject(dualRaw.escalation).minConfidence ?? ESCALATION_DEFAULTS.minConfidence))),
        alwaysEscalateRiskFlags: asStringArray(asObject(dualRaw.escalation).alwaysEscalateRiskFlags) ?? [...ESCALATION_DEFAULTS.alwaysEscalateRiskFlags],
        maxLatencyMs: Math.max(500, Number(asObject(dualRaw.escalation).maxLatencyMs ?? ESCALATION_DEFAULTS.maxLatencyMs)),
      },
    };
  }

  const local = resolveJudgeConfig(asObject(raw._judgeFastConfig));
  if (!local) return null;

  const remoteRaw = asObject(raw._remoteJudgeConfig);
  return {
    local,
    remote: resolveRemoteJudgeConfig(remoteRaw),
    escalation: {
      minConfidence: Math.min(1, Math.max(0, Number(remoteRaw.minConfidence ?? local.minConfidence ?? ESCALATION_DEFAULTS.minConfidence))),
      alwaysEscalateRiskFlags: asStringArray(remoteRaw.alwaysEscalateRiskFlags) ?? [...ESCALATION_DEFAULTS.alwaysEscalateRiskFlags],
      maxLatencyMs: Math.max(500, Number(remoteRaw.maxLatencyMs ?? ESCALATION_DEFAULTS.maxLatencyMs)),
    },
  };
}

export function resolveDualJudgeConfigFromEnv(): DualJudgeConfig | null {
  const localJson = process.env.OCTOCLAW_JUDGE_FAST?.trim();
  const remoteJson = process.env.OCTOCLAW_JUDGE_REMOTE?.trim();
  const payload: Record<string, unknown> = {};

  if (localJson) {
    try {
      payload._judgeFastConfig = JSON.parse(localJson);
    } catch {
      return null;
    }
  }
  if (remoteJson) {
    try {
      payload._remoteJudgeConfig = JSON.parse(remoteJson);
    } catch {
      return null;
    }
  }

  return resolveDualJudgeConfig(payload);
}

export function buildJudgeInput(
  userMessage: string,
  metadata: Record<string, unknown>,
  contextPacket?: JudgeContextPacket,
): JudgeInput {
  const recentLedger = String(
    metadata.recent_ledger_summary ?? metadata.recentLedgerSummary ?? ""
  );

  const metadataContextPacket = metadata.judge_context_packet as JudgeContextPacket | undefined;

  return {
    userMessage: userMessage.slice(0, JUDGE_INPUT_CAPS.userMessage),
    sessionBinding: String(metadata.session_key ?? ""),
    recentLedgerSummary: recentLedger.slice(0, JUDGE_INPUT_CAPS.recentLedgerSummary),
    availableTargets: ["current_session", "local_probe", "spawn_work"],
    availableActions: ["answer_direct", "local_probe", "spawn_work"],
    contextPacket: contextPacket ?? metadataContextPacket,
  };
}

export function buildLiveJudgeContextPacket(options: {
  prompt: string;
  metadata: Record<string, unknown>;
}): JudgeContextPacket | undefined {
  const metadata = options.metadata ?? {};
  const existingPacket = metadata.judge_context_packet;
  if (existingPacket && typeof existingPacket === "object") {
    return existingPacket as JudgeContextPacket;
  }

  const rawSessionKeys = Array.isArray(metadata.judge_session_keys)
    ? metadata.judge_session_keys
    : Array.isArray(metadata.session_keys)
      ? metadata.session_keys
      : [];

  const sessionKeys = rawSessionKeys
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const judgeConfig = metadata._judgeFastConfig as Record<string, unknown> | undefined;
  const isLocal = Boolean(judgeConfig?.local);

  return buildJudgeContextPacket({
    prompt: options.prompt,
    metadata,
    replayLogPath: String(metadata.judge_replay_log_path ?? metadata.replay_log_path ?? ""),
    taskStatePath: String(metadata.judge_task_state_path ?? metadata.task_state_path ?? ""),
    sessionKeys,
    local: isLocal,
  });
}

interface OpenAICompatOptions {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  includeResponseFormat: boolean;
  useOllamaNative?: boolean;
}

function isOllamaEndpoint(baseUrl: string): boolean {
  return baseUrl.includes(":11434") || baseUrl.includes("localhost:11434") || baseUrl.includes("127.0.0.1:11434");
}

async function postOllamaNative(
  options: OpenAICompatOptions,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({
    model: options.modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    think: false,
    format: "json",
  });

  const url = options.baseUrl.replace(/\/v1$/, "").replace(/\/+$/, "") + "/api/chat";

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`judge HTTP ${response.status}: ${errorText}`);
  }

  const json = await response.json() as Record<string, unknown>;
  if (process.env.OCTOCLAW_JUDGE_DEBUG) {
    const evalCount = json.eval_count as number | undefined;
    const promptEvalCount = json.prompt_eval_count as number | undefined;
    console.log(`[octoclaw-judge] Ollama native response tokens: prompt=${promptEvalCount ?? "?"} completion=${evalCount ?? "?"}`);
  }
  const message = json.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" && content.trim() ? content : "";
}

async function postOpenAICompat(
  options: OpenAICompatOptions,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const payload: Record<string, unknown> = {
    model: options.modelId,
    messages,
    temperature: 0,
    max_tokens: options.maxTokens,
    reasoning_effort: "none",
  };

  if (options.includeResponseFormat) {
    payload.response_format = { type: "json_object" };
  }

  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${options.apiKey}`,
      "x-octoclaw-internal": "judge",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`judge HTTP ${response.status}: ${errorText}`);
  }

  const json = await response.json() as Record<string, unknown>;
  if (process.env.OCTOCLAW_JUDGE_DEBUG) {
    const usage = json.usage as Record<string, number> | undefined;
    console.log(`[octoclaw-judge] API response usage: prompt=${usage?.prompt_tokens ?? "?"} completion=${usage?.completion_tokens ?? "?"} total=${usage?.total_tokens ?? "?"}`);
  }
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" && content.trim() ? content : "";
}

async function callOpenAICompat(
  config: Pick<JudgeFastConfig, "modelId" | "baseUrl" | "apiKey">,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  if (isOllamaEndpoint(config.baseUrl)) {
    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log(`[octoclaw-judge] using Ollama native API (think:false)`);
    }
    return postOllamaNative({
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      maxTokens,
      includeResponseFormat: false,
      useOllamaNative: true,
    }, systemPrompt, userPrompt, signal);
  }

  try {
    return await postOpenAICompat({
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      maxTokens,
      includeResponseFormat: true,
    }, systemPrompt, userPrompt, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const isResponseFormatError =
      message.includes("response_format")
      || message.includes("json_object")
      || message.includes("parse error")
      || message.includes("unsupported")
      || message.includes("unknown field")
      || message.includes("invalid request")
      || message.includes("unmarshal")
      || message.includes("json schema")
      || message.includes("'response_format'")
      || (message.includes("400") && message.includes("format"));
    if (!isResponseFormatError) {
      throw error;
    }
    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log("[octoclaw-judge] response_format not supported, retrying without");
    }
    return postOpenAICompat({
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      maxTokens,
      includeResponseFormat: false,
    }, systemPrompt, userPrompt, signal);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const cleaned = trimmed.replace(/[\x00-\x1f\x7f]/g, " ");
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
      return null;
    }
  }
}

export async function callLlmJudge(
  input: JudgeInput,
  config: JudgeConfig,
): Promise<JudgeOutput | null> {
  lastJudgeFailureClass = null;
  const effectiveTimeout = config.local ? config.timeoutLocalMs : config.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const raw = await callOpenAICompat(
      config,
      buildJudgeSystemPrompt(),
      buildJudgeUserPrompt(input),
      controller.signal,
      128,
    );
    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log(`[octoclaw-judge] raw response length=${raw.length} preview="${raw.slice(0, 200)}"`);
    }
    const parsed = extractJson(raw) as Record<string, unknown> | null;

    // Normalize route aliases from small models that may output action names instead of canonical routes
    if (parsed && typeof parsed.route === "string") {
      const r = parsed.route as string;
      if (r === "spawn_work" || r === "spawn_single" || r === "spawn_multi" || r === "delegate.single") {
        parsed.route = "delegate";
      }
    }

    if (!parsed || !isValidJudgeOutput(parsed)) {
      lastJudgeFailureClass = "invalid_json";
      warnJudgeFailure(new Error("judge returned invalid JSON"));
      return null;
    }

    return coerceJudgeOutput(parsed);
  } catch (error) {
    lastJudgeFailureClass = classifyJudgeError(error);
    warnJudgeFailure(error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function shouldEscalate(
  localResult: JudgeOutput,
  escalation: DualJudgeConfig["escalation"],
  metadata: Record<string, unknown>,
): EscalationReason | null {
  if (localResult.confidence < escalation.minConfidence) return "low_confidence";
  if ((localResult.riskFlags ?? []).some((flag) => escalation.alwaysEscalateRiskFlags.includes(flag))) return "high_risk_write";

  const turnLength = String(metadata.task ?? metadata.prompt ?? metadata.current_turn ?? "").trim().length;
  if (turnLength <= 6 && localResult.route === "delegate") return "short_turn_context_dependent";

  const activeIntents = Array.isArray(metadata.active_intents) ? metadata.active_intents.filter(Boolean) : [];
  const bindingConflicts = Array.isArray(metadata.binding_conflicts) ? metadata.binding_conflicts.filter(Boolean) : [];
  if (activeIntents.length > 1 || bindingConflicts.length > 0) return "multiple_active_intents";

  if (String(localResult.scope ?? "").trim().toLowerCase() === "unknown" && metadata.canSafelyClarify !== true) {
    return "scope_unknown";
  }

  if (localResult.role === "observer_probe" && localResult.complexityBand === "deep") return "unstable_classification";

  if (metadata.validator_conflict === true || metadata.validator_hard_conflict === true) return "validator_conflict";

  const routeHint = String(metadata.route_hint ?? metadata.requested_route ?? "").trim();
  if (routeHint && (routeHint === "reply" || routeHint === "delegate") && routeHint !== localResult.route) {
    return "main_agent_judge_disagreement";
  }

  return null;
}

export async function callRemoteJudge(
  input: JudgeInput,
  localResult: JudgeOutput,
  escalationReason: EscalationReason,
  config: DualJudgeConfig,
): Promise<RemoteJudgeOutput | null> {
  if (!config.remote.enabled) return null;

  lastJudgeFailureClass = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.remote.timeoutMs, config.escalation.maxLatencyMs));

  try {
    const basePacket = input.contextPacket;
    const expandedPacket = basePacket
      ? buildExpandedPacket(basePacket, localResult, escalationReason)
      : undefined;
    const remoteInput: JudgeInput = {
      ...input,
      contextPacket: input.contextPacket,
    };

    const raw = await callOpenAICompat(
      {
        modelId: config.remote.modelId,
        baseUrl: config.remote.baseUrl,
        apiKey: config.remote.apiKey,
      },
      buildRemoteJudgeSystemPrompt(),
      buildRemoteJudgeUserPrompt(remoteInput, localResult, escalationReason, expandedPacket),
      controller.signal,
      128,
    );

    const parsed = extractJson(raw) as Record<string, unknown> | null;

    if (parsed && typeof parsed.route === "string") {
      const r = parsed.route as string;
      if (r === "spawn_work" || r === "spawn_single" || r === "spawn_multi" || r === "delegate.single") {
        parsed.route = "delegate";
      }
    }

    if (!parsed || !isRemoteJudgeOutput(parsed)) {
      lastJudgeFailureClass = "invalid_json";
      warnJudgeFailure(new Error("remote judge returned invalid JSON"));
      return null;
    }

    const result = coerceJudgeOutput(parsed) as RemoteJudgeOutput;
    result.adjudication_reason = typeof parsed.adjudication_reason === "string"
      ? parsed.adjudication_reason
      : typeof parsed.adjudicationReason === "string"
        ? parsed.adjudicationReason
        : undefined;
    result.override_recommendation = parsed.override_recommendation === "accept_local" || parsed.override_recommendation === "override_local"
      ? parsed.override_recommendation
      : parsed.overrideRecommendation === "accept_local" || parsed.overrideRecommendation === "override_local"
        ? parsed.overrideRecommendation as RemoteJudgeOutput["override_recommendation"]
        : undefined;
    result.confidence_delta = typeof parsed.confidence_delta === "number"
      ? parsed.confidence_delta
      : typeof parsed.confidenceDelta === "number"
        ? parsed.confidenceDelta
        : result.confidence - localResult.confidence;
    return result;
  } catch (error) {
    lastJudgeFailureClass = classifyJudgeError(error);
    warnJudgeFailure(error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function judgeResultToRouteOverride(result: JudgeOutput): "reply" | "delegate" | null {
  const route = result.route;
  if (route === "reply" || route === "delegate") {
    return route;
  }
  return null;
}
