import type { ScopeMetadata, WorkspaceMode } from "@octoclaw/contracts/schemas";
import type { DelegateAttempt, DelegateTask } from "@octoclaw/contracts/delegate";
import type { PolicyRole } from "@octoclaw/policy/roles";
import type { LiveRoute } from "@octoclaw/policy/route";
import {
  LIVE_ROUTE_NAMES,
  isObserveMode,
  normalizeLiveRoute,
} from "./route-helpers.js";
import {
  normalizeInboundPrompt,
  unwrapQueuedBusyPrompt,
} from "./session.js";
import { policyState } from "../state/policy-state.js";
import {
  type UnknownRecord,
  isRecord,
  asRecord,
  asString,
  asBoolean,
  asStringArray,
} from "../util/type-coercion.js";

export const PHASE_TWO_LIVE_ROUTES = LIVE_ROUTE_NAMES;

export interface ExtractPromptEvent {
  prompt?: unknown;
  raw?: unknown;
  messages?: unknown;
}

export type StartupDecisionBucket = "must_reply" | "must_delegate" | "budgeted_main_then_delegate";
export type StartupToolNeedHint = "none" | "maybe" | "required";
export type StartupDurationHint = "short" | "medium" | "long";
export type StartupScopeHint = "local" | "remote" | "both" | "unknown" | "";

export interface StartupCostClassification {
  decisionBucket: StartupDecisionBucket;
  startupCostPolicy: UnknownRecord;
  durationHint: StartupDurationHint;
  toolNeedHint: StartupToolNeedHint;
  reasonCodes: string[];
  hardDelegateSignal: boolean;
  hardDelegateReasons: string[];
}

export function isDelegateTask(value: unknown): value is DelegateTask {
  return isRecord(value)
    && typeof value.delegateTaskId === "string"
    && typeof value.status === "string"
    && typeof value.currentAttemptId !== "undefined";
}

export function isDelegateAttempt(value: unknown): value is DelegateAttempt {
  return isRecord(value)
    && typeof value.attemptId === "string"
    && typeof value.delegateTaskId === "string"
    && typeof value.status === "string";
}

export function isDegradedDelegateJudgeResult(value: unknown): boolean {
  const result = asRecord(value);
  return result.route === "delegate" && result.judge_schema_degraded === true;
}

export function inferObserveMode(metadata: UnknownRecord = {}): boolean {
  return asBoolean(metadata.requiresObservation)
    || isObserveMode(
      asString(metadata.role ?? metadata.judge_role),
      asString(metadata.executionProfile ?? metadata.execution_profile),
    )
    || (asString(metadata.coordinationMode ?? metadata.coordination_mode) === "solo_worker"
      && asString(metadata.role ?? metadata.judge_role) === "observer_probe");
}

export function observeFlagsForRoute(route: LiveRoute, role?: string, executionProfile?: string) {
  const observe = route === "delegate" && isObserveMode(role, executionProfile);
  return {
    requiresDelegation: route === "delegate" && !observe,
    requiresObservation: observe,
  };
}

export const TRUSTED_ROUTE_REQUEST_SOURCES = new Set([
  "system",
  "runtime",
  "route_seal",
  "work_contract",
  "execution_coverage",
  "trusted_tool",
  "policy",
  "force_route",
]);

export function routeRequestSource(metadata: UnknownRecord): string {
  return asString(
    metadata.route_request_source
      ?? metadata.route_hint_source
      ?? asRecord(metadata.route_hint_payload).source,
  );
}

export function isTrustedRouteRequest(metadata: UnknownRecord): boolean {
  if (asBoolean(metadata.route_request_trusted)) return true;
  const source = routeRequestSource(metadata);
  if (source) return TRUSTED_ROUTE_REQUEST_SOURCES.has(source);
  return Boolean(metadata.requested_route || metadata.requestedRoute || metadata.route);
}

export function coerceDelegateReasonCodes(value: unknown): string[] {
  const allowed = new Set([
    "context_hygiene",
    "background_execution",
    "parallelism",
    "cost_tiering",
    "specialized_tools",
    "quality_isolation",
  ]);
  return asStringArray(value).filter((code) => allowed.has(code));
}

export function coerceStartupToolNeedHint(value: unknown, fallback: StartupToolNeedHint): StartupToolNeedHint {
  const normalized = asString(value);
  return normalized === "none" || normalized === "maybe" || normalized === "required"
    ? normalized
    : fallback;
}

export function coerceStartupDurationHint(value: unknown, fallback: StartupDurationHint): StartupDurationHint {
  const normalized = asString(value);
  return normalized === "short" || normalized === "medium" || normalized === "long"
    ? normalized
    : fallback;
}

export function coerceStartupDecisionBucket(value: unknown): StartupDecisionBucket | "" {
  const normalized = asString(value);
  return normalized === "must_reply"
    || normalized === "must_delegate"
    || normalized === "budgeted_main_then_delegate"
    ? normalized
    : "";
}

export function coerceStartupScopeHint(value: unknown, fallback: StartupScopeHint = ""): StartupScopeHint {
  const normalized = asString(value);
  return normalized === "local"
    || normalized === "remote"
    || normalized === "both"
    || normalized === "unknown"
    ? normalized
    : fallback;
}

export function coerceFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function promptMatches(prompt: string, pattern: RegExp | RegExp[]): boolean {
  return Array.isArray(pattern)
    ? pattern.some((item) => item.test(prompt))
    : pattern.test(prompt);
}

const DELEGATE_EXECUTOR_PATTERN = String.raw`(?:opencode|glm|子\s*agent|子代理|sub\s*-?\s*agent)`;
const DELEGATE_ACTION_PATTERN = String.raw`(?:修|改|写|做|跑|测|执行|构建|测试|处理|完成|实现|排查|审核|验证|调研|查|研究|分析|review|build|test|run|measure|benchmark|implement|fix|edit|debug|lint|refactor|research|summarize|handle|complete|execute|investigate|analyze)`;
const EXPLICIT_DELEGATE_PROMPT_PATTERNS = [
  /\b(delegate this|delegate to|run in background|run in parallel|parallel(?:ize| work| tasks?)|background (?:work|task|job))\b/iu,
  new RegExp(String.raw`\bdelegate\s+(?:a\s+|the\s+)?${DELEGATE_EXECUTOR_PATTERN}\s+(?:to\s+)?[\s\S]{0,20}${DELEGATE_ACTION_PATTERN}\b`, "iu"),
  new RegExp(String.raw`(?:让|叫|请|交(?:给|由)|用|派(?:给)?|委派(?:给)?|分配给|指派给)\s*${DELEGATE_EXECUTOR_PATTERN}\s*[\s\S]{0,20}${DELEGATE_ACTION_PATTERN}`, "iu"),
  new RegExp(String.raw`${DELEGATE_EXECUTOR_PATTERN}\s*[\s\S]{0,16}(?:修代码|跑测试|跑构建|做一下|后台处理|来(?:做|写|改|修|跑|调研|查))`, "iu"),
  new RegExp(String.raw`(?:派(?:个|一个|一次)?|委派)\s*${DELEGATE_EXECUTOR_PATTERN}?\s*(?:来)?[\s\S]{0,20}${DELEGATE_ACTION_PATTERN}`, "iu"),
  new RegExp(String.raw`(?:后台|并行)\s*[\s\S]{0,16}${DELEGATE_ACTION_PATTERN}`, "iu"),
];
const CODE_TEST_BUILD_WORK_PATTERNS = [
  /\b(?:implement|fix|refactor|edit|patch|commit|push|debug|lint)\b/iu,
  /\b(?:run|execute)\s+(?:tests?|build|command|lint|tsc|vitest|pytest)\b/iu,
  /\bbuild\s+(?:the\s+)?(?:app|project|package|extension|plugin|runtime|dist)\b/iu,
  /\b(?:write)\s+(?:code|tests?|script)\b/iu,
  /\b(?:please|can you|could you)\s+(?:review|validate)\b|\b(?:review|validate)\s+(?:code|changes?|patch|pr|pull request|build|tests?|results?|fix|implementation)\b/iu,
  /\b(?:validation|regression)\s+(?:run|check|test|suite)\b/iu,
  /(?:请|帮(?:我)?|给我|直接|现在|继续|先|再|然后|把|将|你来)?[\s\S]{0,12}(?:修改|修复|实现|重构|编辑|改代码|提交|跑(?:一下)?(?:测试|构建|命令|lint|tsc|vitest|pytest)|运行(?:测试|构建|检查|命令|lint|tsc|vitest|pytest)|执行(?:测试|构建|命令|lint|tsc|vitest|pytest)|部署)/iu,
  /(?:请|帮(?:我)?|给我|直接|现在|继续|你来)[\s\S]{0,12}(?:验证|审核|排查|处理)(?:构建|测试|修复|结果|回归|日志|报错|失败|问题|PR|代码|改动|这个|一下)?/iu,
  /(?:验证|审核|排查|处理)(?:构建|测试|修复|结果|回归|日志|报错|失败|问题|PR|代码|改动|这个|一下)[\s\S]{0,16}(?:结果|原因|失败|通过|修复|收口)?/iu,
  /(?:测试|构建|回归|验收)[\s\S]{0,24}(?:跑一下|执行|运行|验证|检查|补齐|修复|通过|收口)/iu,
];
const MULTI_STEP_TOOL_WORK_PATTERNS = [
  /\b(?:first|then|after that)\b[\s\S]{0,120}\b(?:run|build|test|edit|fix|read|inspect|validate|review|execute|debug|deploy)\b/iu,
  /先[\s\S]{0,80}(?:再|然后)[\s\S]{0,80}(?:跑|执行|修|改|实现|验证|构建|测试|提交|部署|排查|查看|读取|检查)/iu,
  /(?:多步|端到端|完整(?:验证|排查|实现|测试)|e2e)[\s\S]{0,80}(?:跑|执行|修|改|实现|验证|构建|测试|提交|部署|排查|检查|工具|命令)/iu,
];

export function classifyStartupCost(prompt: string, metadata: UnknownRecord = {}): StartupCostClassification {
  const conversationControl = trustedConversationControl(metadata);
  const intentClass = structuredIntentClass(metadata);
  const routeHint = asString(metadata.route_hint || conversationControl.route_hint);
  const routeRequest = normalizeLiveRoute(metadata.requested_route ?? metadata.route ?? metadata.requestedRoute, "reply");
  const requestSource = routeRequestSource(metadata);
  const workType = asString(metadata.workType ?? metadata.work_type);
  const relationToRecentExecution = asString(metadata.relation_to_recent_execution ?? metadata.relationToRecentExecution);
  const rawPrompt = asString(prompt);
  const provenanceOrStatusPrompt = promptMatches(
    rawPrompt,
    /(刚才|之前|上次|那个任务|任务判定|谁[\s\S]{0,12}(查|做|写)|怎么查|自己[\s\S]{0,20}子\s*agent|是不是[\s\S]{0,12}(子\s*agent|委派)|(?:为啥|为什么|为何)[\s\S]{0,18}(派发|委派|dispatch|spawn)|没[\s\S]{0,12}(派发|委派|dispatch|spawn)[\s\S]{0,12}成功|was[\s\S]{0,20}delegated|who[\s\S]{0,20}(did|handled))/iu,
  );
  const isStatusOrProvenanceFollowup = provenanceOrStatusPrompt
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup)
    || relationToRecentExecution === "existing_execution_followup"
    || relationToRecentExecution === "existing_execution_provenance_query";
  const isExecutionFollowup = intentClass === "execution_followup";
  const requiresFreshLookup = asBoolean(conversationControl.require_fresh_lookup)
    || asBoolean(asRecord(metadata.intent_packet).require_fresh_lookup)
    || intentClass === "fresh_live_lookup";
  const requiresStateGrounding = asBoolean(conversationControl.require_state_grounding)
    || asBoolean(asRecord(metadata.intent_packet).require_state_grounding);

  const negatedDelegatePrompt = promptMatches(
    rawPrompt,
    /不要[\s\S]{0,12}(委派|派|子\s*agent|sub\s*-?\s*agent)|不(?:要|用)?[\s\S]{0,8}(委派|派|子\s*agent|sub\s*-?\s*agent)/iu,
  );
  const explicitDelegatePrompt = !negatedDelegatePrompt && promptMatches(
    rawPrompt,
    EXPLICIT_DELEGATE_PROMPT_PATTERNS,
  );
  const codeOrMutationPrompt = promptMatches(
    rawPrompt,
    CODE_TEST_BUILD_WORK_PATTERNS,
  );
  const multiStepPrompt = promptMatches(
    rawPrompt,
    MULTI_STEP_TOOL_WORK_PATTERNS,
  );

  const metadataToolNeed = coerceStartupToolNeedHint(metadata.tool_need_hint ?? metadata.toolNeedHint, "none");
  const metadataDuration = coerceStartupDurationHint(metadata.duration_hint ?? metadata.durationHint, "short");
  const judgeDecisionBucket = coerceStartupDecisionBucket(metadata._judge_decision_bucket);
  const rawJudgeRouteIntent = asString(metadata._judge_route_intent ?? metadata._judge_route);
  const judgeRouteIntent = rawJudgeRouteIntent ? normalizeLiveRoute(rawJudgeRouteIntent, "reply") : "";
  const judgeScope = coerceStartupScopeHint(metadata._judge_scope ?? metadata.scope);
  const judgeEvidenceRequired = asBoolean(metadata._judge_evidence_required ?? metadata.evidence_required ?? metadata.evidenceRequired);
  const judgeConfidence = coerceFiniteNumber(metadata._judge_confidence);
  const judgeRouteConfidence = coerceFiniteNumber(metadata._judge_route_confidence);
  const judgeMinConfidence = coerceFiniteNumber(metadata._judge_min_confidence) ?? 0.6;
  const effectiveJudgeConfidence = judgeRouteConfidence ?? judgeConfidence;
  const judgeConfidenceKnown = typeof effectiveJudgeConfidence === "number";
  const judgeLowConfidenceReply = judgeRouteIntent === "reply" && judgeConfidenceKnown && effectiveJudgeConfidence < judgeMinConfidence;
  const judgeActionableDelegate = judgeRouteIntent === "delegate" && asBoolean(metadata._judge_actionable_route);
  const remoteOrMixedScope = judgeScope === "remote" || judgeScope === "both";
  const judgeCostSignalsPresent = judgeRouteIntent !== ""
    || metadata._judge_tool_need_hint !== undefined
    || metadata._judge_duration_hint !== undefined
    || metadata._judge_scope !== undefined
    || metadata._judge_evidence_required !== undefined
    || judgeConfidenceKnown;
  const budgetCostSignal = requiresFreshLookup
    || requiresStateGrounding
    || routeHint === "delegate"
    || metadataToolNeed === "maybe"
    || metadataToolNeed === "required"
    || metadataDuration === "medium"
    || metadataDuration === "long"
    || remoteOrMixedScope
    || judgeEvidenceRequired
    || judgeLowConfidenceReply;
  const hardDelegateReasons = isStatusOrProvenanceFollowup ? [] : [
    asBoolean(metadata.requiresDelegation) ? "metadata_requires_delegation" : "",
    asBoolean(metadata.requiresObservation) ? "metadata_requires_observation" : "",
    asBoolean(metadata.hardBoundaryControl) || asBoolean(conversationControl.required) ? "hard_boundary_control" : "",
    asBoolean(conversationControl.explicit_delegate_request) || intentClass === "delegated_work" ? "explicit_delegate_control" : "",
    requestSource === "force_route" && routeRequest === "delegate" ? "force_route_delegate" : "",
    judgeActionableDelegate ? "judge_actionable_delegate" : "",
    asBoolean(metadata._judge_hard_delegate_signal) && judgeActionableDelegate ? "judge_hard_delegate_signal" : "",
    metadataToolNeed === "required" ? "tool_need_required" : "",
    metadataDuration === "long" ? "duration_long" : "",
    workType === "code" ? "work_type_code" : "",
    workType === "review" ? "work_type_review" : "",
    explicitDelegatePrompt ? "prompt_explicit_delegate" : "",
    codeOrMutationPrompt ? "prompt_code_test_build_review_validation" : "",
    multiStepPrompt ? "prompt_multistep_tool_work" : "",
  ].filter(Boolean);

  const hardDelegateSignal = hardDelegateReasons.length > 0;
  const decisionBucket: StartupDecisionBucket = isStatusOrProvenanceFollowup || (isExecutionFollowup && !hardDelegateSignal) || intentClass === "plain_chat"
    ? "must_reply"
    : hardDelegateSignal
      ? "must_delegate"
      : budgetCostSignal
        ? "budgeted_main_then_delegate"
        : "must_reply";

  const toolNeedHint = hardDelegateSignal
    ? "required"
    : requiresFreshLookup || requiresStateGrounding || routeHint === "delegate" || remoteOrMixedScope || judgeEvidenceRequired || judgeLowConfidenceReply
      ? "maybe"
      : metadataToolNeed;
  const durationHint = metadataDuration === "long" || hardDelegateReasons.includes("duration_long")
    ? "long"
    : hardDelegateSignal
      ? "medium"
      : metadataDuration === "medium"
        ? "medium"
        : "short";

  const fastFirstResponse = asBoolean(metadata.fast_first_response ?? metadata.fastFirstResponse);
  const reasonCodes = Array.from(new Set([
    `decision_bucket:${decisionBucket}`,
    hardDelegateSignal ? "hard_delegate_signal" : "no_hard_delegate_signal",
    isStatusOrProvenanceFollowup ? "startup_status_or_provenance_followup_reply" : "",
    isExecutionFollowup && !hardDelegateSignal && !isStatusOrProvenanceFollowup ? "startup_execution_followup_without_new_work_reply" : "",
    judgeDecisionBucket ? `judge_decision_bucket_telemetry:${judgeDecisionBucket}` : "",
    judgeRouteIntent ? `judge_route_intent:${judgeRouteIntent}` : "",
    judgeCostSignalsPresent ? "startup_cost_derived_from_route_cost_signals" : "",
    judgeScope ? `judge_cost_scope:${judgeScope}` : "",
    judgeEvidenceRequired ? "judge_evidence_required" : "",
    judgeLowConfidenceReply ? "judge_low_confidence_budgeted" : "",
    intentClass ? `intent:${intentClass}` : "",
    requiresFreshLookup ? "fresh_lookup_budgeted_main_first" : "",
    requiresStateGrounding ? "state_grounding_budgeted_main_first" : "",
    routeHint === "delegate" && !hardDelegateSignal ? "route_hint_delegate_advisory_only" : "",
    ...hardDelegateReasons.map((reason) => `hard_delegate:${reason}`),
    fastFirstResponse ? "advisory:fast_first_response" : "",
  ].filter(Boolean)));

  const startupCostPolicy: UnknownRecord = {
    decision_bucket: decisionBucket,
    main_fast_path_allowed: decisionBucket !== "must_delegate",
    max_wall_ms: decisionBucket === "budgeted_main_then_delegate" ? 30_000 : 20_000,
    max_tool_calls: decisionBucket === "budgeted_main_then_delegate" ? 2 : 1,
    allow_read_only_native_status: true,
    allow_one_fresh_lookup: decisionBucket !== "must_delegate",
    allow_workspace_probe: decisionBucket === "must_delegate" ? "delegate_only" : "read_only_only",
    forbid_mutation: decisionBucket !== "must_delegate",
    derivation: "runtime_route_cost_signals",
    judge_bucket_telemetry: judgeDecisionBucket || undefined,
    escalation_triggers: [
      "wall_time_over_budget",
      "second_real_tool_round",
      "write_or_mutation_needed",
      "long_running_command_needed",
    ],
  };

  return {
    decisionBucket,
    startupCostPolicy,
    durationHint,
    toolNeedHint,
    reasonCodes,
    hardDelegateSignal,
    hardDelegateReasons,
  };
}

export function applyStartupCostClassification(metadata: UnknownRecord, classification: StartupCostClassification): void {
  metadata.decision_bucket = classification.decisionBucket;
  metadata.startup_cost_policy = classification.startupCostPolicy;
  metadata.duration_hint = classification.durationHint;
  metadata.tool_need_hint = classification.toolNeedHint;
  metadata.hard_delegate_signal = classification.hardDelegateSignal;
  metadata.hard_delegate_reasons = classification.hardDelegateReasons;
  metadata.startup_reason_codes = classification.reasonCodes;
}

export function coerceQualityBar(value: unknown): "standard" | "high" | "critical" | undefined {
  const normalized = asString(value);
  return normalized === "standard" || normalized === "high" || normalized === "critical" ? normalized : undefined;
}

export function coerceComplexityBand(value: unknown): "simple" | "normal" | "deep" | undefined {
  const normalized = asString(value);
  return normalized === "simple" || normalized === "normal" || normalized === "deep" ? normalized : undefined;
}

export function coerceExpectedDurationBand(value: unknown): "instant" | "short" | "medium" | "long" | undefined {
  const normalized = asString(value);
  return normalized === "instant" || normalized === "short" || normalized === "medium" || normalized === "long" ? normalized : undefined;
}

export function coerceJudgeRole(value: unknown): PolicyRole | undefined {
  const normalized = asString(value);
  return normalized === "main_reply"
    || normalized === "observer_probe"
    || normalized === "worker_research"
    || normalized === "worker_code"
    || normalized === "worker_review"
    ? normalized
    : undefined;
}

export function coerceUnitConfidence(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

export function coerceRouteConfidence(value: unknown): number | undefined {
  return coerceUnitConfidence(value);
}

export function selectContinuationRoute(metadata: UnknownRecord): LiveRoute | null {
  const packet = asRecord(metadata.judge_context_packet);
  const continuation = asRecord(packet.continuation);
  if (!asString(continuation.active_intent) || asString(continuation.intent_status) === "idle") {
    return null;
  }

  for (const key of asStringArray(metadata.judge_session_keys ?? metadata.session_keys)) {
    const route = normalizeLiveRoute(asRecord(asRecord(policyState.get(key)?.decision).route_decision).route, "reply");
    if (PHASE_TWO_LIVE_ROUTES.has(route)) {
      return route;
    }
  }

  return null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return String(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(content) && typeof content.text === "string") {
    return String(content.text).trim();
  }
  return "";
}

function unwrapCodexHarnessPrompt(raw: string): string {
  const text = asString(raw);
  if (!text.startsWith("[codex-slack-e2e")) return "";
  const match = text.match(/当前用户问题：([\s\S]+)$/u);
  return asString(match?.[1]);
}

export function extractPromptText(event: ExtractPromptEvent): string {
  const prompt = asString(event.prompt ?? event.raw);
  const harnessPrompt = unwrapCodexHarnessPrompt(prompt);
  if (harnessPrompt) return harnessPrompt;
  const normalizedPrompt = normalizeInboundPrompt(prompt);
  if (normalizedPrompt && normalizedPrompt !== prompt) return normalizedPrompt;
  const unwrappedPrompt = unwrapQueuedBusyPrompt(prompt);
  if (unwrappedPrompt && unwrappedPrompt !== prompt) return unwrappedPrompt;
  if (prompt) return prompt;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || asString(message.role).toLowerCase() !== "user") continue;
    const text = extractMessageText(message.content);
    const harnessText = unwrapCodexHarnessPrompt(text);
    if (harnessText) return harnessText;
    const normalizedText = normalizeInboundPrompt(text);
    if (normalizedText && normalizedText !== text) return normalizedText;
    const unwrapped = unwrapQueuedBusyPrompt(text);
    if (unwrapped && unwrapped !== text) return unwrapped;
    if (text) return text;
  }
  return "";
}

export function normalizeWorkspaceMode(value: unknown, fallback: WorkspaceMode = "shared_workspace"): WorkspaceMode {
  const candidate = asString(value);
  return candidate === "isolated_worktree" || candidate === "shared_workspace" || candidate === "read_only"
    ? candidate
    : fallback;
}

export function buildWorkflowScopeFromMetadata(metadata: UnknownRecord = {}): ScopeMetadata {
  return {
    readScope: Array.isArray(metadata.readScope) ? metadata.readScope as ScopeMetadata["readScope"] : [],
    writeScope: Array.isArray(metadata.writeScope) ? metadata.writeScope as ScopeMetadata["writeScope"] : [],
    workspaceMode: normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode ?? "shared_workspace"),
    writeScopeSummary: asString(metadata.writeScopeSummary ?? metadata.write_scope_summary),
  };
}

export function trustedConversationControl(metadata: UnknownRecord): UnknownRecord {
  const conversationControl = asRecord(metadata.conversation_control);
  if (Object.keys(conversationControl).length === 0) return {};
  const source = asString(conversationControl.source);
  const intentSource = asString(asRecord(metadata.intent_packet).source);
  if (!source || source === "session_resolver_fallback" || source.startsWith("deterministic_")) return {};
  if (intentSource.startsWith("deterministic_") && source !== "explicit_conversation_control") return {};
  return conversationControl;
}

export function structuredIntentClass(metadata: UnknownRecord): string {
  const control = trustedConversationControl(metadata);
  const intentPacket = asRecord(metadata.intent_packet);
  const intentSource = asString(intentPacket.source);
  const packetIntentClass = asString(intentPacket.intent_class || intentPacket.intentClass);
  if (intentSource === "deterministic_plain_chat_classifier" && packetIntentClass === "plain_chat") {
    return "plain_chat";
  }
  if (
    (intentSource === "deterministic_followup_grounding" || intentSource === "deterministic_provenance_no_history")
    && packetIntentClass === "execution_followup"
  ) {
    return "execution_followup";
  }
  if (intentSource === "deterministic_live_lookup_classifier" && packetIntentClass === "fresh_live_lookup") {
    return "fresh_live_lookup";
  }
  if (intentSource === "deterministic_surface_registry" && packetIntentClass === "local_surface_lookup") {
    return "local_surface_lookup";
  }
  if (intentSource && !intentSource.startsWith("deterministic_")) {
    return asString(packetIntentClass || control.intent_class);
  }
  return asString(control.intent_class);
}
