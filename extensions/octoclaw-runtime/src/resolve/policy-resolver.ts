import type { ScopeMetadata, WorkspaceMode } from "@octoclaw/contracts/schemas";
import type { DelegateAttempt, DelegateTask } from "@octoclaw/contracts/delegate";
import type { ContextCoverageSnapshot, ExecutionCoveragePacket, IntentClass, ReplyContract, WorkDecisionSource } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { createOctoClawRuntimePlugin } from "../plugin.js";
import type { PolicyDecision, PolicyJudgeInput } from "@octoclaw/policy/judge";
import { judgePolicy, decideCoordinationMode } from "@octoclaw/policy/judge";
import { decideRole } from "@octoclaw/policy/roles";
import { decideBackend, decideExecutionProfile, decideModelProfile } from "@octoclaw/policy/model";
import {
  resolveDualJudgeConfig,
  resolveJudgeConfig,
  buildJudgeInput,
  buildLiveJudgeContextPacket,
  callLlmJudge,
  callRemoteJudge,
  isActionableJudgeResult,
  judgeResultToRouteOverride,
  lastJudgeFailureClass,
  shouldEscalate,
} from "./llm-judge.js";
import {
  advanceWorkflowToRunning,
  markWorkflowCheckpointEmitted,
  markWorkflowCompleted,
  markWorkflowFailed,
  markWorkflowTimedOut,
  renewWorkflowHeartbeat,
  startRuntimeWorkflow,
  type RuntimeWorkflowState,
} from "@octoclaw/runtime-core/workflow";
import {
  advanceAttemptStatus,
  projectTaskStatus,
} from "@octoclaw/runtime-core/delegate";
import {
  applyRecoveryHook,
  assessRecoveryNeed,
  type RecoveryAssessment,
} from "@octoclaw/runtime-core/recovery";
import type { RecoveryInfo, TimeoutCategory } from "@octoclaw/contracts/delegate";
import type { PolicyRole } from "@octoclaw/policy/roles";
import type { ExecutionProfileTarget } from "@octoclaw/policy/model";
import type { LiveRoute } from "@octoclaw/policy/route";
import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import type { WorkerPool } from "@octoclaw/policy/caps";
import {
  canonicalizeDecisionForPolicyState,
  LIVE_ROUTE_NAMES,
  isObserveMode,
  normalizeLiveRoute,
} from "./route-helpers.js";
import {
  buildTsRuntimeDispatchPayload as buildRuntimeDispatchPayload,
  buildTsRuntimeSpawnPayload as buildRuntimeSpawnPayload,
} from "../runtime-payloads.js";
import { stableId, truncateText } from "./env.js";
import {
  buildPolicyMetadata,
  enrichConversationControlMetadata,
  isManagedAgentContext,
  normalizeInboundPrompt,
  promptsEquivalent,
  resolvePolicyStateKey,
  unwrapQueuedBusyPrompt,
} from "./session.js";
import { policyState } from "../state/policy-state.js";
import {
  buildPolicyJudgedReplayPayload,
  buildPolicyResolvedReplayPayload,
  buildRouteValidatedReplayPayload,
  buildTurnExecutionReceipt,
  compactPolicyPrompt,
  isDelegatedRoute,
  recordPolicyReplay,
  routeHintRequired,
} from "../replay/replay-logger.js";
import { resolveCurrentRouteSeal, validateRouteSeal } from "./route-seal.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { saveWorkContract } from "../work-contract/store.js";
import { compactWorkContractView } from "@octoclaw/contracts/work-contract";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "./memory-coverage-precheck.js";

type UnknownRecord = Record<string, unknown>;
type LoggerLike = { warn?: (message: string) => void } | null | undefined;
type ManagedContext = Record<string, unknown>;
type PolicyContextState = UnknownRecord & {
  prompt?: string;
  decision?: UnknownRecord;
  sessionBoundary?: { status: string; reason: string };
  canonicalSessionKey?: string;
  createdAt?: number;
  updatedAt?: number;
};

const PHASE_TWO_LIVE_ROUTES = LIVE_ROUTE_NAMES;

interface DispatchLikeInput {
  task: unknown;
  command?: string;
  cwd?: string;
  decision?: UnknownRecord;
  metadata?: UnknownRecord;
  timeoutSeconds?: number;
  helperInvoker?: NativeHelperInvoker | null;
}

interface SpawnLikeInput {
  task: unknown;
  route?: string;
  decision?: UnknownRecord;
  metadata?: UnknownRecord;
  helperInvoker?: NativeHelperInvoker | null;
  execute?: boolean;
}

interface PhaseTwoPolicyInput extends PolicyJudgeInput {
  workType?: "research" | "code" | "review";
}

interface ExtractPromptEvent {
  prompt?: unknown;
  raw?: unknown;
  messages?: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isDelegateTask(value: unknown): value is DelegateTask {
  return isRecord(value)
    && typeof value.delegateTaskId === "string"
    && typeof value.status === "string"
    && typeof value.currentAttemptId !== "undefined";
}

function isDelegateAttempt(value: unknown): value is DelegateAttempt {
  return isRecord(value)
    && typeof value.attemptId === "string"
    && typeof value.delegateTaskId === "string"
    && typeof value.status === "string";
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

function inferObserveMode(metadata: UnknownRecord = {}): boolean {
  return asBoolean(metadata.requiresObservation)
    || isObserveMode(
      asString(metadata.role ?? metadata.judge_role),
      asString(metadata.executionProfile ?? metadata.execution_profile),
    )
    || (asString(metadata.coordinationMode ?? metadata.coordination_mode) === "solo_worker"
      && asString(metadata.role ?? metadata.judge_role) === "observer_probe");
}

function observeFlagsForRoute(route: LiveRoute, role?: string, executionProfile?: string) {
  const observe = route === "delegate" && isObserveMode(role, executionProfile);
  return {
    requiresDelegation: route === "delegate" && !observe,
    requiresObservation: observe,
  };
}

const TRUSTED_ROUTE_REQUEST_SOURCES = new Set([
  "system",
  "runtime",
  "route_seal",
  "work_contract",
  "execution_coverage",
  "trusted_tool",
  "policy",
  "force_route",
]);

function routeRequestSource(metadata: UnknownRecord): string {
  return asString(
    metadata.route_request_source
      ?? metadata.route_hint_source
      ?? asRecord(metadata.route_hint_payload).source,
  );
}

function isTrustedRouteRequest(metadata: UnknownRecord): boolean {
  if (asBoolean(metadata.route_request_trusted)) return true;
  const source = routeRequestSource(metadata);
  if (source) return TRUSTED_ROUTE_REQUEST_SOURCES.has(source);
  return Boolean(metadata.requested_route || metadata.requestedRoute || metadata.route);
}

function coerceDelegateReasonCodes(value: unknown): string[] {
  const allowed = new Set([
    "context_hygiene",
    "fast_first_response",
    "background_execution",
    "cost_tiering",
    "specialized_tools",
    "quality_isolation",
  ]);
  return asStringArray(value).filter((code) => allowed.has(code));
}

function coerceQualityBar(value: unknown): "standard" | "high" | "critical" | undefined {
  const normalized = asString(value);
  return normalized === "standard" || normalized === "high" || normalized === "critical" ? normalized : undefined;
}

function coerceComplexityBand(value: unknown): "simple" | "normal" | "deep" | undefined {
  const normalized = asString(value);
  return normalized === "simple" || normalized === "normal" || normalized === "deep" ? normalized : undefined;
}

function coerceExpectedDurationBand(value: unknown): "instant" | "short" | "medium" | "long" | undefined {
  const normalized = asString(value);
  return normalized === "instant" || normalized === "short" || normalized === "medium" || normalized === "long" ? normalized : undefined;
}

function coerceJudgeRole(value: unknown): PolicyRole | undefined {
  const normalized = asString(value);
  return normalized === "main_reply"
    || normalized === "observer_probe"
    || normalized === "worker_research"
    || normalized === "worker_code"
    || normalized === "worker_review"
    ? normalized
    : undefined;
}

function coerceRouteConfidence(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

function selectContinuationRoute(metadata: UnknownRecord): LiveRoute | null {
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

function normalizeWorkspaceMode(value: unknown, fallback: WorkspaceMode = "shared_workspace"): WorkspaceMode {
  const candidate = asString(value);
  return candidate === "isolated_worktree" || candidate === "shared_workspace" || candidate === "read_only"
    ? candidate
    : fallback;
}

function runtimeRouteDecision(decision?: UnknownRecord): UnknownRecord {
  return asRecord(decision?.route_decision);
}

function authoritativeDecisionRoute(decision: UnknownRecord): LiveRoute {
  return normalizeLiveRoute(asRecord(decision.route_decision).route ?? decision.route, "reply");
}

function workDecisionSourceFromPolicy(value: unknown): WorkDecisionSource {
  const source = asString(value, "local_judge");
  switch (source) {
    case "continuation":
    case "execution_coverage":
    case "memory_coverage":
    case "local_judge":
    case "remote_judge":
    case "validator":
    case "main_agent_route_hint":
    case "policy_rule":
      return source;
    case "remote":
      return "remote_judge";
    case "timeout_fallback":
    case "timeout":
    case "no_judge":
    case "rule":
      return "policy_rule";
    default:
      return "local_judge";
  }
}

function trustedConversationControl(metadata: UnknownRecord): UnknownRecord {
  const conversationControl = asRecord(metadata.conversation_control);
  if (Object.keys(conversationControl).length === 0) return {};
  const source = asString(conversationControl.source);
  const intentSource = asString(asRecord(metadata.intent_packet).source);
  if (!source || source === "session_resolver_fallback" || source.startsWith("deterministic_")) return {};
  if (intentSource.startsWith("deterministic_") && source !== "explicit_conversation_control") return {};
  return conversationControl;
}

function structuredIntentClass(metadata: UnknownRecord): string {
  const control = trustedConversationControl(metadata);
  const intentPacket = asRecord(metadata.intent_packet);
  const intentSource = asString(intentPacket.source);
  if (intentSource && !intentSource.startsWith("deterministic_")) {
    return asString(intentPacket.intent_class || intentPacket.intentClass || control.intent_class);
  }
  return asString(control.intent_class);
}

function intentClassFromPolicy(value: unknown): IntentClass {
  const intentClass = asString(value, "undetermined");
  return intentClass === "plain_chat"
    || intentClass === "runtime_read_model"
    || intentClass === "execution_followup"
    || intentClass === "local_surface_lookup"
    || intentClass === "fresh_live_lookup"
    || intentClass === "delegated_work"
    || intentClass === "undetermined"
    ? intentClass
    : "undetermined";
}

function attachWorkContractToPolicyDecision(input: {
  stateKey: string;
  prompt: string;
  metadata: UnknownRecord;
  decision: UnknownRecord;
  routeSeal?: RouteSeal | null;
}): void {
  const executionLayer = buildExecutionCoverageLayer([input.stateKey]);
  const memoryLayer = buildMemoryCoverageLayer();
  input.metadata._memory_coverage = memoryLayer;
  const hasConflict = Boolean((executionLayer.coverage && executionLayer.coverage !== "none") && (memoryLayer.coverage && memoryLayer.coverage !== "none"));
  const coverageSnapshot: ContextCoverageSnapshot = {
    precheckOrder: ["conversation_grounding", "continuation_route_reuse", "execution_coverage", "memory_coverage", "build_judge_context_packet", "local_judge", "validator_or_remote", "route_seal_commit"],
    execution: executionLayer,
    memory: memoryLayer,
    conflict: hasConflict,
    authority: hasConflict ? "execution_wins" : executionLayer.coverage && executionLayer.coverage !== "none" ? "execution_wins" : memoryLayer.coverage && memoryLayer.coverage !== "none" ? "memory_only" : "none",
  };
  const conversationControl = asRecord(input.metadata.conversation_control);
  const intentClass = intentClassFromPolicy(input.decision.intent_class || conversationControl.intent_class || "undetermined");
  const statusSurfaceControlAllowed = asBoolean(conversationControl.status_followup)
    || asString(conversationControl.surface_id) === "octoclaw_task_status_panel";
  const isExecutionFollowup = intentClass === "execution_followup"
    || asBoolean(conversationControl.provenance_followup)
    || statusSurfaceControlAllowed;
  const executionSupportsReply = asBoolean(executionLayer.supports_provenance_reply)
    || asBoolean(executionLayer.supports_status_reply)
    || asBoolean(executionLayer.requires_control_plane_refresh);
  const executionCoveragePacket: ExecutionCoveragePacket = {
    packetId: stableId("execution-coverage", [input.stateKey, input.prompt, String(Date.now())]),
    turnId: stableId("turn", [input.stateKey, input.prompt]),
    sessionKey: input.stateKey,
    coverage: coverageSnapshot,
    route: isExecutionFollowup && executionSupportsReply ? "reply" : authoritativeDecisionRoute(input.decision) === "delegate" ? "delegate" : "reply",
    replyMode: isExecutionFollowup && executionSupportsReply ? "answer" : undefined,
    dispatchExecuted: asBoolean(executionLayer.dispatch_executed),
    spawnExecuted: asBoolean(executionLayer.spawn_executed),
    resultMaterialized: asBoolean(executionLayer.result_materialized),
    evidenceRefs: asString(executionLayer.evidence_summary) ? [asString(executionLayer.evidence_summary)] : [],
    evidenceSummary: asString(executionLayer.evidence_summary) || undefined,
    createdAt: new Date().toISOString(),
  };
  input.metadata._execution_coverage_packet = executionCoveragePacket;
  input.decision._execution_coverage_packet = executionCoveragePacket;
  const workRoute = executionCoveragePacket.route;
  const decisionSource = isExecutionFollowup && executionSupportsReply
    ? "execution_coverage"
    : workDecisionSourceFromPolicy(input.decision._judge_source || asRecord(input.decision.route_decision).final_judge_source || "local_judge");
  const decisionSeal = buildWorkDecisionSeal(
    decisionSource,
    workRoute,
    asStringArray(asRecord(input.decision.route_decision).reason_codes),
    {
      replyMode: decisionSource === "execution_coverage" ? "answer" : undefined,
      confidence: typeof input.decision.judge_confidence === "number" ? input.decision.judge_confidence : undefined,
      routeSealId: asString(asRecord(input.routeSeal).routeSealId) || undefined,
    },
  );
  const replyContract: ReplyContract | undefined = workRoute === "reply"
    ? {
        replyMode: decisionSource === "execution_coverage" ? "answer" : "answer",
        grounding: (asBoolean(executionLayer.requires_control_plane_refresh) || statusSurfaceControlAllowed) ? "control_plane_status" : executionSupportsReply ? "execution_receipt" : "none",
        allowedTools: (asBoolean(executionLayer.requires_control_plane_refresh) || statusSurfaceControlAllowed) ? ["octoclaw_status", "octoclaw_task_action"] : [],
        forbiddenTools: ["octoclaw_dispatch", "spawn"],
        evidenceRefs: executionCoveragePacket.evidenceRefs,
      }
    : undefined;
  const contract = buildWorkContractFromPolicy(
    input.stateKey,
    input.prompt,
    intentClass,
    coverageSnapshot,
    decisionSeal,
    { reply: replyContract },
  );
  saveWorkContract(contract);
  input.decision.work_contract = compactWorkContractView(contract);
  input.decision.workContractId = contract.workContractId;
  const existingEntry = policyState.get(input.stateKey);
  const completedAt = existingEntry?.updatedAt || existingEntry?.createdAt || Date.now();
  const receipt = buildTurnExecutionReceipt(
    {
      canonicalSessionKey: input.stateKey,
      decision: input.decision,
      delegated: false,
      dispatchExecuted: false,
      workContractId: contract.workContractId,
      toolsUsed: [],
    },
    0,
    typeof completedAt === "number" ? completedAt : Date.now(),
  );
  policyState.update(input.stateKey, (entry) => ({
    ...entry,
    workContractId: contract.workContractId,
    latestStatus: contract.status,
    latestExecutionReceipt: receipt,
  }));
}

function buildDelegateTaskContext(delegateTask: DelegateTask | null | undefined, currentAttempt: DelegateAttempt | null | undefined): UnknownRecord | undefined {
  if (!delegateTask) {
    return undefined;
  }

  return {
    delegateTaskId: delegateTask.delegateTaskId,
    currentAttemptId: currentAttempt?.attemptId ?? delegateTask.currentAttemptId,
    taskStatus: delegateTask.status,
  };
}

function buildWorkflowScope(metadata: UnknownRecord = {}): ScopeMetadata {
  return {
    readScope: Array.isArray(metadata.readScope) ? metadata.readScope as ScopeMetadata["readScope"] : [],
    writeScope: Array.isArray(metadata.writeScope) ? metadata.writeScope as ScopeMetadata["writeScope"] : [],
    workspaceMode: normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode ?? "shared_workspace"),
    writeScopeSummary: asString(metadata.writeScopeSummary ?? metadata.write_scope_summary),
  };
}

function buildRuntimeTruthWorkflowStub(metadata: UnknownRecord = {}): RuntimeWorkflowState {
  const workspaceMode = normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode ?? "shared_workspace");
  const taskId = asString(
    metadata.taskId ?? metadata.task_id ?? metadata.native_task_id ?? metadata.requestId ?? metadata.request_id,
    "runtime-task",
  );
  const flowId = asString(metadata.flowId ?? metadata.flow_id ?? metadata.requestId ?? metadata.request_id, "runtime-flow");
  const requestId = asString(metadata.requestId ?? metadata.request_id ?? taskId, taskId);
  const claimOwner = asString(
    metadata.claimOwner ?? metadata.claim_owner ?? metadata.controllerId ?? metadata.controller_id,
    "runtime-wrapper",
  );
  const leaseDurationMs = 30_000;
  const observeMode = inferObserveMode(metadata);
  const decidedRoute: LiveRoute = observeMode || asBoolean(metadata.requiresDelegation)
    ? "delegate"
    : "reply";
  const decision: PolicyDecision = {
    route: decidedRoute,
    role: observeMode
      ? "observer_probe"
      : asBoolean(metadata.requiresDelegation)
        ? "worker_research"
        : "main_reply",
    coordinationMode: decidedRoute === "delegate" ? "solo_worker" : undefined,
    backend: "openclaw-native",
    executionProfile: observeMode
      ? "observer"
      : asBoolean(metadata.requiresDelegation)
        ? "worker"
        : "main",
    workspaceMode,
    modelProfile: observeMode
      ? "observer_probe"
      : asBoolean(metadata.requiresDelegation)
        ? "worker_research"
        : "direct_main",
    caps: {
      queueBudget: 1,
      maxWorkers: asBoolean(metadata.requiresDelegation) ? 1 : 0,
      latencyTarget: asBoolean(metadata.requiresDelegation) || observeMode ? "background" : "interactive",
      workerPool: observeMode
        ? "octoclaw-observer"
        : asBoolean(metadata.requiresDelegation)
          ? "octoclaw-research"
          : "octoclaw-main",
      capReason: "runtime_truth_stub",
    },
    admission: {
      admission: "allow",
      queueBudget: 1,
      maxWorkers: asBoolean(metadata.requiresDelegation) ? 1 : 0,
      latencyTarget: asBoolean(metadata.requiresDelegation) || observeMode ? "background" : "interactive",
      reason: "runtime_truth_stub",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };

  let workflow = startRuntimeWorkflow({
    requestId,
    taskId,
    flowId,
    decision,
    role: decision.role,
    decisionRef: `${requestId}:${taskId}:runtime_truth_stub`,
    provenanceSource: "runtime_orchestrator",
    claimOwner,
    leaseDurationMs,
    deadlineBudget: {
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 30_000,
      runtimeMs: 60_000,
      deliveryMs: 5_000,
    },
    scope: {
      readScope: Array.isArray(metadata.readScope) ? metadata.readScope as ScopeMetadata["readScope"] : [],
      writeScope: Array.isArray(metadata.writeScope) ? metadata.writeScope as ScopeMetadata["writeScope"] : [],
      workspaceMode,
      writeScopeSummary: asString(metadata.writeScopeSummary ?? metadata.write_scope_summary),
    },
  });

  if (observeMode) {
    return workflow;
  }
  workflow = advanceWorkflowToRunning(workflow, claimOwner);
  workflow = renewWorkflowHeartbeat(workflow);
  if (asBoolean(metadata.requiresDelegation)) {
    workflow = markWorkflowCheckpointEmitted(workflow);
  }
  return asBoolean(metadata.runtimeTimedOut)
    ? markWorkflowTimedOut(workflow)
    : asBoolean(metadata.runtimeFailed)
      ? markWorkflowFailed(workflow)
      : markWorkflowCompleted(workflow);
}

function isTerminalWorkflowPhase(phase: unknown): boolean {
  const value = asString(phase);
  return value === "completed" || value === "failed" || value === "timed_out";
}

function isTerminalDelegateStatus(status: unknown): boolean {
  const value = asString(status);
  return value === "completed"
    || value === "failed"
    || value === "timed_out"
    || value === "cancelled";
}

function timeoutCategoryForTrigger(trigger: RecoveryAssessment["trigger"]): TimeoutCategory | undefined {
  switch (trigger) {
    case "queue_deadline_exceeded":
      return "queue_timeout";
    case "start_deadline_exceeded":
      return "start_timeout";
    case "progress_deadline_exceeded":
      return "progress_timeout";
    case "runtime_deadline_exceeded":
      return "runtime_timeout";
    case "delivery_deadline_exceeded":
      return "delivery_timeout";
    default:
      return undefined;
  }
}

function recoveryInfoFromAssessment(assessment: RecoveryAssessment): RecoveryInfo {
  return {
    category: assessment.timedOut ? "timeout" : assessment.trigger === "lease_expired" ? "stale_claim" : "transient_error",
    reason: assessment.reason,
    retryEligible: !assessment.timedOut,
    maxRetries: assessment.timedOut ? 0 : 1,
    timeoutCategory: timeoutCategoryForTrigger(assessment.trigger),
  };
}

function applyRecoveryAssessmentToRuntimeTruth(
  runtimeTruth: UnknownRecord,
  workflow: RuntimeWorkflowState,
  assessment: RecoveryAssessment,
  binding: ReturnType<ReturnType<typeof createOctoClawRuntimePlugin>["readBinding"]>,
): UnknownRecord {
  const nextRuntimeTruth: UnknownRecord = {
    ...runtimeTruth,
    workflow,
    binding,
    recovery: {
      required: assessment.required,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      deadlineField: assessment.deadlineField,
      reason: assessment.reason,
      checkedAt: new Date().toISOString(),
      status: assessment.required ? "applied" : "healthy",
    },
  };

  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  if (!delegateTask || !delegateAttempt || !assessment.required) {
    return nextRuntimeTruth;
  }

  const recoveryInfo = recoveryInfoFromAssessment(assessment);
  const nextAttemptStatus = assessment.timedOut ? "timed_out" : "recovering";
  const nextAttempt = advanceAttemptStatus(delegateAttempt, nextAttemptStatus, {
    failureReason: assessment.timedOut ? assessment.reason : delegateAttempt.failureReason,
    recoveryInfo,
  });
  const nextTask = {
    ...delegateTask,
    status: projectTaskStatus(nextAttempt.status),
    updatedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    currentAttemptId: nextAttempt.attemptId,
  };

  nextRuntimeTruth.delegateAttempt = nextAttempt;
  nextRuntimeTruth.delegateTask = nextTask;
  nextRuntimeTruth.nativeTaskBinding = delegateAttempt.nativeBinding ?? runtimeTruth.nativeTaskBinding ?? null;
  return nextRuntimeTruth;
}

function buildRecoveredRuntimeTruth(
  workflowOrMetadata: UnknownRecord = {},
  options: { helperInvoker?: NativeHelperInvoker | null; now?: Date } = {},
): { workflow: RuntimeWorkflowState; binding: ReturnType<ReturnType<typeof createOctoClawRuntimePlugin>["readBinding"]>; recovery: UnknownRecord } {
  const helperInvoker = options.helperInvoker ?? (workflowOrMetadata.helperInvoker as NativeHelperInvoker | undefined) ?? undefined;
  const plugin = createOctoClawRuntimePlugin(helperInvoker ? { helperInvoker } : {});
  const workflow = isRecord(workflowOrMetadata.taskMaterialization)
    ? workflowOrMetadata as unknown as RuntimeWorkflowState
    : buildRuntimeTruthWorkflowStub(workflowOrMetadata);
  const now = options.now ?? new Date();
  const assessment = assessRecoveryNeed(workflow, now);
  const recoveredWorkflow = assessment.required ? applyRecoveryHook(workflow, now) : workflow;
  const binding = plugin.readBinding(recoveredWorkflow);
  return {
    workflow: recoveredWorkflow,
    binding,
    recovery: {
      required: assessment.required,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      deadlineField: assessment.deadlineField,
      reason: assessment.reason,
      checkedAt: now.toISOString(),
      status: assessment.required ? "applied" : "healthy",
    },
  };
}

function buildRuntimeTruthMetadata(workflowOrMetadata: UnknownRecord = {}, options: { helperInvoker?: NativeHelperInvoker | null } = {}) {
  const { workflow, binding, recovery } = buildRecoveredRuntimeTruth(workflowOrMetadata, options);
  return {
    authority: "ts-native-adapter",
    pluginName: "octoclaw-runtime-ts",
    workflow,
    binding,
    recovery,
  };
}

function refreshRecoveryForStateEntry(
  key: string,
  state: PolicyContextState,
  now = new Date(),
): { updated: boolean; timedOut: boolean; summary: UnknownRecord | null } {
  const decision = asRecord(state.decision);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const delegateTask = isDelegateTask(runtimeTruth.delegateTask) ? runtimeTruth.delegateTask : null;
  const delegateAttempt = isDelegateAttempt(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : null;
  const workflowCandidate = runtimeTruth.workflow;
  const hasActiveDelegate = Boolean(
    (delegateTask && !isTerminalDelegateStatus(delegateTask.status))
    || (delegateAttempt && !isTerminalDelegateStatus(delegateAttempt.status)),
  );
  if (!isRecord(workflowCandidate)) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (isTerminalWorkflowPhase(asRecord(workflowCandidate.lifecycle).phase) && !hasActiveDelegate) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (delegateTask && isTerminalDelegateStatus(delegateTask.status)) {
    return { updated: false, timedOut: false, summary: null };
  }
  if (delegateAttempt && isTerminalDelegateStatus(delegateAttempt.status)) {
    return { updated: false, timedOut: false, summary: null };
  }

  const baseWorkflow = workflowCandidate as unknown as RuntimeWorkflowState;
  const recoveryPhase: RuntimeWorkflowState["lifecycle"]["phase"] = delegateAttempt?.status === "running"
    ? "running"
    : "checkpoint_pending";
  const workflow = isTerminalWorkflowPhase(asRecord(workflowCandidate.lifecycle).phase) && hasActiveDelegate
    ? {
      ...baseWorkflow,
      lifecycle: {
        ...baseWorkflow.lifecycle,
        phase: recoveryPhase,
        completedAt: undefined,
      },
    }
    : baseWorkflow;
  const assessment = assessRecoveryNeed(workflow, now);
  if (!assessment.required) {
    return { updated: false, timedOut: false, summary: null };
  }

  const helperInvoker = typeof state.helperInvoker === "function" ? state.helperInvoker as NativeHelperInvoker : null;
  const plugin = createOctoClawRuntimePlugin(helperInvoker ? { helperInvoker } : {});
  const recoveredWorkflow = applyRecoveryHook(workflow, now);
  const binding = plugin.readBinding(recoveredWorkflow);
  const nextRuntimeTruth = applyRecoveryAssessmentToRuntimeTruth(runtimeTruth, recoveredWorkflow, assessment, binding);
  const nextDecision: UnknownRecord = {
    ...decision,
    runtime_truth: nextRuntimeTruth,
  };
  const nextDelegateTaskContext = buildDelegateTaskContext(
    isDelegateTask(nextRuntimeTruth.delegateTask) ? nextRuntimeTruth.delegateTask : null,
    isDelegateAttempt(nextRuntimeTruth.delegateAttempt) ? nextRuntimeTruth.delegateAttempt : null,
  );
  if (nextDelegateTaskContext) {
    nextDecision.delegateTaskContext = nextDelegateTaskContext;
  }

  policyState.set(key, {
    ...state,
    decision: nextDecision,
    delegateTaskContext: nextDelegateTaskContext,
    updatedAt: Date.now(),
  });

  return {
    updated: true,
    timedOut: assessment.timedOut,
    summary: {
      stateKey: key,
      taskId: asString(binding.taskId),
      flowId: asString(binding.flowId),
      delegateTaskId: delegateTask?.delegateTaskId ?? null,
      attemptId: delegateAttempt?.attemptId ?? null,
      trigger: assessment.trigger,
      timedOut: assessment.timedOut,
      reason: assessment.reason,
      deadlineField: assessment.deadlineField,
      checkedAt: now.toISOString(),
    },
  };
}

export function checkActiveTaskRecovery(options: { taskId?: string; now?: Date } = {}): {
  checkedAt: string;
  updatedCount: number;
  timedOutCount: number;
  recoveries: UnknownRecord[];
} {
  const now = options.now ?? new Date();
  const targetTaskId = asString(options.taskId);
  const recoveries: UnknownRecord[] = [];
  let updatedCount = 0;
  let timedOutCount = 0;

  for (const { key, state } of policyState.entries()) {
    const decision = asRecord(state.decision);
    const runtimeTruth = asRecord(decision.runtime_truth);
    if (targetTaskId) {
      const binding = asRecord(runtimeTruth.binding);
      const delegateTask = asRecord(runtimeTruth.delegateTask);
      const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
      const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
      const matches = asString(binding.taskId) === targetTaskId
        || asString(binding.flowId) === targetTaskId
        || asString(asRecord(delegateAttempt.nativeBinding).nativeTaskId) === targetTaskId
        || asString(asRecord(delegateAttempt.nativeBinding).nativeFlowId) === targetTaskId
        || asString(nativeTaskBinding.nativeTaskId) === targetTaskId
        || asString(nativeTaskBinding.nativeFlowId) === targetTaskId
        || asString(delegateTask.delegateTaskId) === targetTaskId;
      if (!matches) {
        continue;
      }
    }

    const result = refreshRecoveryForStateEntry(key, state as PolicyContextState, now);
    if (!result.updated || !result.summary) {
      continue;
    }
    updatedCount += 1;
    if (result.timedOut) {
      timedOutCount += 1;
    }
    recoveries.push(result.summary);
  }

  return {
    checkedAt: now.toISOString(),
    updatedCount,
    timedOutCount,
    recoveries,
  };
}

function buildRuntimeExecutionIds(task: unknown, decision?: UnknownRecord, metadata?: UnknownRecord) {
  const routeDecision = runtimeRouteDecision(decision);
  const route = normalizeLiveRoute(routeDecision.route ?? asRecord(metadata).requested_route, "reply");
  const prompt = asString(task);
  return {
    requestId: asString(asRecord(metadata).requestId ?? asRecord(metadata).request_id, stableId("runtime", [prompt, route])),
    taskId: asString(asRecord(metadata).taskId ?? asRecord(metadata).task_id, stableId("task", [prompt, route])),
    flowId: asString(asRecord(metadata).flowId ?? asRecord(metadata).flow_id, stableId("flow", [prompt, route])),
  };
}

function buildPhaseTwoPolicyInput(_prompt: string, metadata: UnknownRecord = {}): PhaseTwoPolicyInput {
  const conversationControl = trustedConversationControl(metadata);
  const conversationLaneHint = asString(conversationControl.lane_hint);
  const conversationRouteHint = asString(conversationControl.route_hint);
  const trustedRouteRequest = isTrustedRouteRequest(metadata);
  const rawMetadataRequestedRoute = asString(metadata.requested_route ?? metadata.route ?? metadata.requestedRoute);
  const rawRequestedRoute = trustedRouteRequest
    ? asString(rawMetadataRequestedRoute || conversationRouteHint)
    : conversationRouteHint;
  const objectionRequestedRoute = normalizeLiveRoute(
    metadata.objection_requested_route,
    normalizeLiveRoute(rawMetadataRequestedRoute || rawRequestedRoute, "reply"),
  );
  const queueBudget = Number(metadata.queueBudget ?? metadata.queue_budget ?? 1);
  const inflightCount = Number(metadata.inflightCount ?? metadata.inflight_count ?? 0);
  const capabilitySatisfied = metadata.capabilitySatisfied ?? metadata.capability_satisfied;
  const writeConflict = metadata.writeConflict ?? metadata.write_conflict;
  const workType = asString(metadata.workType);
  const forcedObserve = conversationLaneHint === "observe" || conversationLaneHint === "control_observer";
  const isExecutionOrStatusFollowup = conversationControl.intent_class === "execution_followup"
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup);
  const forcedDelegate = !isExecutionOrStatusFollowup && (conversationRouteHint === "delegate"
    || asBoolean(conversationControl.require_fresh_lookup)
    || forcedObserve);
  const explicitRouteObjection = asBoolean(metadata.route_objection);
  const explicitReplyObjection = explicitRouteObjection && objectionRequestedRoute === "reply";
  const requestedRoute = explicitRouteObjection
    ? objectionRequestedRoute
    : forcedDelegate
      && normalizeLiveRoute(rawRequestedRoute, "reply") === "reply"
      && !explicitReplyObjection
      ? asString(conversationRouteHint, "delegate")
      : rawRequestedRoute;

  return {
    requestedRoute: requestedRoute || undefined,
    workType: workType === "research" || workType === "code" || workType === "review" ? workType : undefined,
    hardBoundaryControl: Boolean(conversationControl.required || metadata.hardBoundaryControl),
    requiresObservation: Boolean(metadata.requiresObservation || forcedObserve),
    requiresDelegation: Boolean(metadata.requiresDelegation || forcedDelegate),
    workspaceMode: normalizeWorkspaceMode(metadata.workspaceMode ?? metadata.workspace_mode),
    queueBudget: Number.isFinite(queueBudget) ? Math.max(queueBudget, 0) : 1,
    inflightCount: Number.isFinite(inflightCount) ? Math.max(inflightCount, 0) : 0,
    capabilitySatisfied: typeof capabilitySatisfied === "boolean" ? capabilitySatisfied : true,
    writeConflict: typeof writeConflict === "boolean" ? writeConflict : false,
  };
}

function normalizePolicyPrompt(task: unknown): string {
  const rawPrompt = asString(task);
  return normalizeInboundPrompt(rawPrompt) || rawPrompt;
}

export function buildDecision(task: unknown, optionsOrDecision: { metadata?: UnknownRecord } | UnknownRecord = {}, metadataArg?: UnknownRecord): PolicyDecision {
  const options = metadataArg === undefined
    ? (isRecord(optionsOrDecision) && ("metadata" in optionsOrDecision)
        ? optionsOrDecision as { metadata?: UnknownRecord }
        : { metadata: asRecord(optionsOrDecision) })
    : { metadata: metadataArg };
  const prompt = normalizePolicyPrompt(task);
  const metadata = enrichConversationControlMetadata(prompt, asRecord(options.metadata));
  return judgePolicy(buildPhaseTwoPolicyInput(prompt, metadata));
}

function workflowRoleForRoute(route: LiveRoute, taskClass = ""): PolicyRole {
  if (route === "reply") return "main_reply";
  if (taskClass === "control_observer") return "observer_probe";
  if (taskClass === "code") return "worker_code";
  if (taskClass === "review") return "worker_review";
  return "worker_research";
}

function workerPoolForDecision(executionProfile: ExecutionProfileTarget, role: PolicyRole): WorkerPool {
  if (executionProfile === "main") return "octoclaw-main";
  if (executionProfile === "observer") return "octoclaw-observer";
  if (role === "worker_code") return "octoclaw-code";
  if (role === "worker_review") return "octoclaw-review";
  return "octoclaw-research";
}

function hookInterfaceForRoute(liveRoute: LiveRoute, role: PolicyRole, executionProfile: ExecutionProfileTarget, admission = "allow") {
  const delegated = liveRoute === "delegate" && admission === "allow";
  const observe = isObserveMode(role, executionProfile) && admission === "allow";
  return {
    before_model_resolve: {
      enabled: true,
      route: liveRoute,
      mode: delegated ? "delegate_first" : observe ? "observe" : "direct",
    },
    before_prompt_build: {
      enabled: true,
      route: liveRoute,
      include_compact_policy_prompt: delegated || observe,
    },
    before_tool_call: {
      enabled: true,
      route: liveRoute,
      delegate_required: delegated,
      observe_only: observe,
    },
    agent_end: {
      enabled: true,
      route: liveRoute,
      reconcile_delegated_result: delegated || observe,
    },
  };
}

function readStickyStateDecision(metadata: UnknownRecord): UnknownRecord {
  const stateKey = asString(metadata.session_key);
  if (!stateKey) return {};
  return asRecord(policyState.get(stateKey)?.decision);
}

function liveRouteNeedsHint(liveRoute: LiveRoute, metadata: UnknownRecord): boolean {
  return liveRoute === "delegate"
    && !Boolean(metadata.route_hint)
    && !Boolean(metadata.requested_route)
    && !Boolean(metadata.route);
}

function routeSealThreadBindingKey(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.threadBindingKey ?? metadata.thread_binding_key)
    || asString(metadata.session_binding_key)
    || asString(metadata.session_thread_key)
    || asString(metadata.session_key)
    || fallback;
}

function routeSealTurnId(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.turnId ?? metadata.turn_id) || fallback;
}

function isRouteSealCandidate(value: unknown): value is RouteSeal {
  const record = asRecord(value);
  return Object.keys(record).length > 0
    && (record.route === "reply" || record.route === "delegate")
    && typeof record.turnId === "string"
    && typeof record.threadBindingKey === "string"
    && typeof record.createdAt === "string";
}

function validCurrentRouteSeal(decision: UnknownRecord, metadata: UnknownRecord): RouteSeal | null {
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const candidate = isRouteSealCandidate(metadata.routeSeal)
    ? metadata.routeSeal
    : isRouteSealCandidate(requestMetadata.routeSeal)
      ? requestMetadata.routeSeal
      : isRouteSealCandidate(decision.routeSeal)
        ? decision.routeSeal
        : null;
  if (!candidate) return null;
  const turnId = routeSealTurnId(metadata, candidate.turnId);
  const threadBindingKey = routeSealThreadBindingKey(metadata, candidate.threadBindingKey);
  return validateRouteSeal(candidate, turnId, threadBindingKey) ? candidate : null;
}

function savedRouteSeal(value: unknown): RouteSeal | null {
  return isRouteSealCandidate(value) ? value : null;
}

function stampRouteSealForPolicyState(input: {
  prompt: string;
  stateKey: string;
  metadata: UnknownRecord;
  decision: UnknownRecord;
  savedRouteSeal?: RouteSeal | null;
}): RouteSeal {
  const turnId = routeSealTurnId(input.metadata, stableId("turn", [input.stateKey, input.prompt]));
  const threadBindingKey = routeSealThreadBindingKey(input.metadata, input.stateKey);
  const routeSeal = resolveCurrentRouteSeal({
    requestId: asString(input.metadata.requestId ?? input.metadata.request_id ?? input.metadata.message_id, stableId("request", [input.stateKey, input.prompt])),
    turnId,
    threadBindingKey,
    policyJson: input.decision,
    localJudgeOutput: input.decision,
    savedRouteSeal: input.savedRouteSeal ?? null,
    inputHash: stableId("input", [input.stateKey, input.prompt]),
    stateGeneration: Number(input.decision.stateGeneration ?? 0),
  });
  input.decision.routeSeal = routeSeal;
  const request = asRecord(input.decision.request);
  input.decision.request = {
    ...request,
    metadata: {
      ...asRecord(request.metadata),
      routeSeal,
    },
  };
  input.metadata.routeSeal = routeSeal;
  return routeSeal;
}

export function applyPhaseTwoLivePathPolicy(decision: UnknownRecord, metadata: UnknownRecord = {}, prompt = ""): UnknownRecord {
  const tsJudgeInput = buildPhaseTwoPolicyInput(prompt, metadata);
  const tsPolicyDecision = judgePolicy(tsJudgeInput);
  let liveRoute = normalizeLiveRoute(tsPolicyDecision.route, "reply");
  const priorDecision = asRecord(decision);
  const priorRouteDecision = asRecord(priorDecision.route_decision);
  const judgeSucceeded = asBoolean(priorDecision._judge_succeeded, false);
  const deterministicRuleApplied = asBoolean(priorDecision._deterministic_rule_applied, false);
  const judgeRoute = asString(priorDecision._judge_route);
  const stickyDecision = readStickyStateDecision(metadata);
  const stickyRouteDecision = asRecord(stickyDecision.route_decision);
  const routeHint = asString(metadata.route_hint ?? metadata.requested_route ?? metadata.route);
  const routeRequest = asString(metadata.requested_route ?? metadata.route);
  const trustedRouteRequest = isTrustedRouteRequest(metadata);
  const normalizedRequestedLiveRoute = normalizeLiveRoute(routeRequest || (trustedRouteRequest ? routeHint : "") || priorRouteDecision.route || stickyRouteDecision.route, liveRoute);
  const routeHintSubmitted = Boolean(routeHint || routeRequest);
  const routeRequestCanOverride = trustedRouteRequest || asBoolean(metadata.route_objection, false);
  const objectionSubmitted = asBoolean(metadata.route_objection, false);
  const objectionRequestedRoute = normalizeLiveRoute(metadata.objection_requested_route ?? metadata.requested_route ?? routeHint, normalizedRequestedLiveRoute);
  const objectionReason = asString(metadata.objection_reason);
  const mainAgentDisagreesWithJudge = objectionSubmitted && judgeSucceeded
    && normalizeLiveRoute(objectionRequestedRoute, "reply") !== normalizeLiveRoute(judgeRoute, "reply");
  const objectionAccepted = objectionSubmitted && !judgeSucceeded;
  const objectionEscalated = mainAgentDisagreesWithJudge;
  const stickyEligible = !routeHintSubmitted && isDelegatedRoute(stickyDecision) && promptsEquivalent(asString(policyState.get(asString(metadata.session_key))?.prompt), prompt);

  if (stickyEligible) {
    liveRoute = normalizeLiveRoute(stickyRouteDecision.route, liveRoute);
  } else if (objectionAccepted) {
    liveRoute = objectionRequestedRoute;
  } else if (routeHintSubmitted && !judgeSucceeded && routeRequestCanOverride) {
    liveRoute = normalizedRequestedLiveRoute;
  }

  if ((judgeSucceeded || deterministicRuleApplied) && !objectionEscalated && !objectionSubmitted) {
    if (judgeRoute && PHASE_TWO_LIVE_ROUTES.has(normalizeLiveRoute(judgeRoute, "reply"))) {
      liveRoute = normalizeLiveRoute(judgeRoute, liveRoute);
    }
  }

  const currentRouteSeal = validCurrentRouteSeal(priorDecision, metadata);
  if (currentRouteSeal) {
    liveRoute = currentRouteSeal.route;
  }

  if (objectionEscalated) {
    if (!currentRouteSeal) {
      const remoteAdjudicated = asBoolean(priorDecision._remote_judge_overrode_local, false);
      if (remoteAdjudicated) {
        liveRoute = normalizeLiveRoute(judgeRoute, liveRoute);
      } else {
        liveRoute = objectionRequestedRoute;
      }
    }
  }

  const blockedCompound = Boolean(metadata.compound_plan)
    || !PHASE_TWO_LIVE_ROUTES.has(normalizeLiveRoute(metadata.requested_route ?? metadata.route, "reply"));

  metadata.ts_policy_judge = {
    input: tsJudgeInput,
    decision: tsPolicyDecision,
    live_path_phase: "phase2",
    allowed_routes: ["reply", "delegate"],
  };

  try {
    const runtimeTruthFlags = observeFlagsForRoute(liveRoute, tsPolicyDecision.role, tsPolicyDecision.executionProfile);
    metadata.runtime_truth = buildRuntimeTruthMetadata({
      ...metadata,
      requestId: metadata.requestId ?? metadata.request_id ?? stableId("runtime", [prompt, liveRoute]),
      taskId: metadata.taskId ?? metadata.task_id ?? stableId("task", [prompt, liveRoute]),
      flowId: metadata.flowId ?? metadata.flow_id ?? stableId("flow", [prompt, liveRoute]),
      role: tsPolicyDecision.role,
      executionProfile: tsPolicyDecision.executionProfile,
      coordinationMode: tsPolicyDecision.coordinationMode,
      requiresDelegation: runtimeTruthFlags.requiresDelegation,
      requiresObservation: runtimeTruthFlags.requiresObservation,
    });
  } catch (error) {
    metadata.runtime_truth = isRecord(metadata.runtime_truth) ? metadata.runtime_truth : null;
    metadata.runtime_truth_error = {
      source: "buildRuntimeTruthMetadata",
      message: String(error instanceof Error ? error.message : error || "runtime_truth_unavailable"),
    };
  }

  if (blockedCompound) {
    metadata.compound_plan = metadata.compound_plan ?? null;
    metadata.compound_plan_blocked = {
      status: tsPolicyDecision.admission.admission === "allow" ? "blocked" : "deferred",
      reason: tsPolicyDecision.admission.reason || "compound_route_not_available_on_phase2_live_path",
      requestedRoute: asString(metadata.requested_route ?? metadata.route, "delegate.compound"),
      enforcedLiveRoute: liveRoute,
      executed: false,
    };
  }

  let executionLayer = asRecord(metadata.execution_layer ?? metadata._execution_coverage ?? priorDecision.execution_layer ?? priorDecision._execution_coverage);
  if (!asString(executionLayer.coverage)) {
    const sessionKeys = Array.isArray(metadata.judge_session_keys) && metadata.judge_session_keys.length > 0
      ? metadata.judge_session_keys as string[]
      : Array.isArray(metadata.session_keys) && metadata.session_keys.length > 0
        ? metadata.session_keys as string[]
        : [asString(metadata.session_key)].filter(Boolean);
    executionLayer = buildExecutionCoverageLayer(sessionKeys, asString(metadata.current_turn_id) || undefined) as UnknownRecord;
    metadata._execution_coverage = executionLayer;
    metadata.execution_layer = executionLayer;
  }
  const conversationControl = trustedConversationControl(metadata);
  const intentClass = structuredIntentClass(metadata);
  const isExecutionOrStatusFollowup = intentClass === "execution_followup"
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup);
  const executionCoverageSupportsReply = asBoolean(executionLayer.supports_provenance_reply)
    || asBoolean(executionLayer.supports_status_reply);
  if (isExecutionOrStatusFollowup && executionCoverageSupportsReply) {
    liveRoute = "reply";
  }

  const role = workflowRoleForRoute(liveRoute, tsJudgeInput.workType || asString(priorRouteDecision.work_type, "research"));
  const authoritativeRole = judgeSucceeded && liveRoute !== "reply" ? coerceJudgeRole(priorDecision._judge_role) ?? role : role;
  const authoritativeExecutionProfile = judgeSucceeded && liveRoute !== "reply"
    ? decideExecutionProfile(authoritativeRole).executionProfile
    : liveRoute === "reply"
      ? "main"
      : tsPolicyDecision.executionProfile;
  const authoritativeModelProfile = judgeSucceeded && liveRoute !== "reply"
    ? decideModelProfile(authoritativeRole, tsPolicyDecision.workspaceMode).modelProfile
    : liveRoute === "reply"
      ? "direct_main"
      : tsPolicyDecision.modelProfile;
  const workerPool = workerPoolForDecision(authoritativeExecutionProfile, authoritativeRole);
  const observeMode = isObserveMode(authoritativeRole, authoritativeExecutionProfile);
  try {
    const runtimeTruthFlags = observeFlagsForRoute(liveRoute, authoritativeRole, authoritativeExecutionProfile);
    metadata.runtime_truth = buildRuntimeTruthMetadata({
      ...metadata,
      requestId: metadata.requestId ?? metadata.request_id ?? stableId("runtime", [prompt, liveRoute]),
      taskId: metadata.taskId ?? metadata.task_id ?? stableId("task", [prompt, liveRoute]),
      flowId: metadata.flowId ?? metadata.flow_id ?? stableId("flow", [prompt, liveRoute]),
      role: authoritativeRole,
      executionProfile: authoritativeExecutionProfile,
      coordinationMode: liveRoute === "delegate" ? tsPolicyDecision.coordinationMode : undefined,
      requiresDelegation: runtimeTruthFlags.requiresDelegation,
      requiresObservation: runtimeTruthFlags.requiresObservation,
    });
  } catch {
  }
  const requiresControlPlaneRefresh = asBoolean(executionLayer.requires_control_plane_refresh);
  const statusSurfaceControlAllowed = asBoolean(conversationControl.status_followup)
    || asString(conversationControl.surface_id) === "octoclaw_task_status_panel";
  const routeHintPolicyRequired = (!judgeSucceeded && liveRouteNeedsHint(liveRoute, metadata))
    || (judgeSucceeded && liveRoute !== "reply");

  const ackFollowupCandidate = stickyEligible && liveRoute === "delegate";
  const nextDecision: UnknownRecord = { ...priorDecision };
  delete nextDecision.pre_dispatch_ack;

  nextDecision.summary = nextDecision.summary || `policy=${liveRoute} -> ${workerPool}`;
  nextDecision.request = {
    ...asRecord(nextDecision.request),
    task: asString(asRecord(nextDecision.request).task, prompt),
    session_key: asString(asRecord(nextDecision.request).session_key, asString(metadata.session_key)),
    metadata: {
      ...asRecord(asRecord(nextDecision.request).metadata),
      ...metadata,
    },
  };
  nextDecision.route_decision = {
    ...priorRouteDecision,
    route: liveRoute,
    system_preferred_route: liveRoute,
    judge_route: judgeRoute || null,
    judge_role: judgeSucceeded ? authoritativeRole : undefined,
    worker_pool: workerPool,
    work_type: tsJudgeInput.workType || asString(priorRouteDecision.work_type, "research"),
    phase: asString(priorRouteDecision.phase, "execute"),
    protocol: asString(priorRouteDecision.protocol, "normal"),
    task_class: observeMode
      ? "control_observer"
      : liveRoute === "delegate"
        ? "delegated_single"
        : asString(priorRouteDecision.task_class, "main_direct"),
    protected_lane: observeMode ? "control_observer" : "",
    dispatch_required: !requiresControlPlaneRefresh && liveRoute !== "reply" && tsPolicyDecision.admission.admission === "allow",
    reason: tsPolicyDecision.admission.reason,
    complexity_band: coerceComplexityBand(priorDecision._judge_complexity_band),
    expected_duration_band: coerceExpectedDurationBand(priorDecision._judge_expected_duration_band),
    quality_bar: coerceQualityBar(priorDecision._judge_quality_bar),
    risk_flags: asStringArray(priorDecision._judge_risk_flags),
    delegate_reason_codes: coerceDelegateReasonCodes(priorDecision._delegate_reason_codes),
    route_confidence: coerceRouteConfidence(priorDecision._judge_route_confidence),
    reason_codes: Array.from(new Set([
      ...asStringArray(priorRouteDecision.reason_codes),
      `ts_policy_route:${liveRoute}`,
      `ts_policy_backend:${tsPolicyDecision.backend}`,
      `ts_policy_execution_profile:${tsPolicyDecision.executionProfile}`,
      `ts_policy_profile:${tsPolicyDecision.modelProfile}`,
      `ts_policy_admission:${tsPolicyDecision.admission.admission}`,
      blockedCompound ? "compound_plan_blocked_phase2_live_path" : "",
      stickyEligible ? "sticky_route_applied" : "",
      routeHintSubmitted ? "route_hint_applied" : "",
      objectionAccepted ? "route_objection_accepted" : "",
      objectionEscalated ? "route_objection_escalated" : "",
      currentRouteSeal ? "route_seal_applied" : "",
    ].filter(Boolean))),
  };
  nextDecision.model_policy = {
    ...asRecord(nextDecision.model_policy),
    worker_pool: workerPool,
    profile: authoritativeModelProfile,
    selected_model: asString(asRecord(nextDecision.model_policy).selected_model, authoritativeModelProfile),
  };
  nextDecision.hook_interface = hookInterfaceForRoute(
    liveRoute,
    authoritativeRole,
    authoritativeExecutionProfile,
    tsPolicyDecision.admission.admission,
  );
  nextDecision.route_hint_policy = {
    required: routeHintPolicyRequired,
    submitted: routeHintSubmitted,
    sticky_applied: stickyEligible,
    ack_followup_candidate: ackFollowupCandidate,
    ack_followup_applied: false,
    source: routeRequestSource(metadata) || (routeHintSubmitted ? "advisory" : ""),
    trusted: trustedRouteRequest,
    advisory_only: routeHintSubmitted && !trustedRouteRequest && !objectionSubmitted,
    objection_submitted: objectionSubmitted,
    objection_reason: objectionReason,
    objection_requested_route: objectionSubmitted ? objectionRequestedRoute : "",
    objection_accepted: objectionAccepted,
    objection_escalated: objectionEscalated,
    judge_route: judgeRoute,
  };
  if (currentRouteSeal) {
    nextDecision.routeSeal = currentRouteSeal;
    nextDecision.request = {
      ...asRecord(nextDecision.request),
      metadata: {
        ...asRecord(asRecord(nextDecision.request).metadata),
        routeSeal: currentRouteSeal,
      },
    };
  }
  nextDecision.review_policy = {
    ...asRecord(nextDecision.review_policy),
    required: liveRoute === "delegate",
  };
  nextDecision.state_grounding = {
    required: statusSurfaceControlAllowed || liveRoute !== "reply",
    source: statusSurfaceControlAllowed ? "control_plane_status" : liveRoute === "reply" ? "none" : "policy_state",
  };
  nextDecision.latency_ack = {
    required: liveRoute === "reply",
    text: asString(asRecord(nextDecision.latency_ack).text) || "收到，处理中…",
  };
  nextDecision.tool_policy = {
    ...asRecord(nextDecision.tool_policy),
    must_delegate_via: !requiresControlPlaneRefresh && liveRoute === "delegate" && tsPolicyDecision.admission.admission === "allow" ? "octoclaw_dispatch" : "",
    allow_direct_tools: liveRoute === "reply",
    delegate_first: !requiresControlPlaneRefresh && liveRoute === "delegate" && tsPolicyDecision.admission.admission === "allow",
    allowed_control_tools: (requiresControlPlaneRefresh || statusSurfaceControlAllowed)
      ? ["octoclaw_status", "octoclaw_task_action"]
      : liveRoute === "reply"
        ? []
      : ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"],
    block_tool_patterns: (requiresControlPlaneRefresh || statusSurfaceControlAllowed) ? ["octoclaw_dispatch", "spawn"] : asStringArray(asRecord(nextDecision.tool_policy).block_tool_patterns),
  };
  nextDecision.router_decision_v2 = {
    ...asRecord(nextDecision.router_decision_v2),
    compatibility_view: true,
    request_kind: liveRoute === "reply" ? "reply" : "delegated_task",
  };
  nextDecision.ts_policy_judge = metadata.ts_policy_judge;
  nextDecision._delegation_enabled = asBoolean(priorDecision._delegation_enabled, true);
  nextDecision._judge_succeeded = judgeSucceeded;
  nextDecision._judge_route = judgeRoute || null;
  nextDecision._judge_role = judgeSucceeded ? authoritativeRole : undefined;
  nextDecision._judge_complexity_band = coerceComplexityBand(priorDecision._judge_complexity_band);
  nextDecision._judge_expected_duration_band = coerceExpectedDurationBand(priorDecision._judge_expected_duration_band);
  nextDecision._judge_quality_bar = coerceQualityBar(priorDecision._judge_quality_bar);
  nextDecision._judge_risk_flags = asStringArray(priorDecision._judge_risk_flags);
  nextDecision._judge_route_confidence = coerceRouteConfidence(priorDecision._judge_route_confidence);
  nextDecision._delegate_reason_codes = coerceDelegateReasonCodes(priorDecision._delegate_reason_codes);
  nextDecision._route_hint_required = routeHintPolicyRequired;
  if (metadata.runtime_truth) {
    nextDecision.runtime_truth = metadata.runtime_truth;
    const delegateRuntimeTruth = asRecord(metadata.runtime_truth);
    const delegateTaskContext = buildDelegateTaskContext(
      isDelegateTask(delegateRuntimeTruth.delegateTask) ? delegateRuntimeTruth.delegateTask : null,
      isDelegateAttempt(delegateRuntimeTruth.delegateAttempt) ? delegateRuntimeTruth.delegateAttempt : null,
    );
    if (delegateTaskContext) {
      nextDecision.delegateTaskContext = delegateTaskContext;
    }
  }
  if (blockedCompound) {
    nextDecision.compound_plan_blocked = metadata.compound_plan_blocked;
  }
  return nextDecision;
}

function attachRuntimeTruthMetadata(decision: UnknownRecord, metadata: UnknownRecord = {}, prompt = ""): UnknownRecord {
  const nextDecision = { ...asRecord(decision) };
  try {
    const route = normalizeLiveRoute(asRecord(nextDecision.route_decision).route, "reply");
    const role = asString(asRecord(nextDecision.route_decision).judge_role, asString(asRecord(nextDecision).role));
    const executionProfile = role === "observer_probe" ? "observer" : route === "reply" ? "main" : "worker";
    const runtimeTruthFlags = observeFlagsForRoute(route, role, executionProfile);
    metadata.runtime_truth = buildRuntimeTruthMetadata({
      ...metadata,
      requestId: metadata.requestId ?? metadata.request_id ?? stableId("runtime", [prompt, asString(asRecord(nextDecision.route_decision).route, "reply")]),
      taskId: metadata.taskId ?? metadata.task_id ?? stableId("task", [prompt, asString(asRecord(nextDecision.route_decision).route, "reply")]),
      flowId: metadata.flowId ?? metadata.flow_id ?? stableId("flow", [prompt, asString(asRecord(nextDecision.route_decision).route, "reply")]),
      role,
      executionProfile,
      coordinationMode: runtimeTruthFlags.requiresObservation || runtimeTruthFlags.requiresDelegation ? "solo_worker" : undefined,
      requiresDelegation: runtimeTruthFlags.requiresDelegation,
      requiresObservation: runtimeTruthFlags.requiresObservation,
    });
  } catch (error) {
    metadata.runtime_truth = isRecord(metadata.runtime_truth) ? metadata.runtime_truth : null;
    metadata.runtime_truth_error = {
      source: "buildRuntimeTruthMetadata",
      message: String(error instanceof Error ? error.message : error || "runtime_truth_unavailable"),
    };
  }

  if (metadata.runtime_truth) {
    nextDecision.runtime_truth = metadata.runtime_truth;
    const delegateRuntimeTruth = asRecord(metadata.runtime_truth);
    const delegateTaskContext = buildDelegateTaskContext(
      isDelegateTask(delegateRuntimeTruth.delegateTask) ? delegateRuntimeTruth.delegateTask : null,
      isDelegateAttempt(delegateRuntimeTruth.delegateAttempt) ? delegateRuntimeTruth.delegateAttempt : null,
    );
    if (delegateTaskContext) {
      nextDecision.delegateTaskContext = delegateTaskContext;
    }
  }
  if (metadata.runtime_truth_error) {
    nextDecision.request = isRecord(nextDecision.request)
      ? {
          ...nextDecision.request,
          metadata: {
            ...asRecord(asRecord(nextDecision.request).metadata),
            runtime_truth_error: metadata.runtime_truth_error,
          },
        }
      : nextDecision.request;
  }
  return nextDecision;
}

function buildPolicyResolvedExecutionTelemetry(decision: UnknownRecord): UnknownRecord {
  const executionLayer = asRecord(decision.execution_layer ?? decision._execution_coverage);
  const routeDecision = asRecord(decision.route_decision);
  const route = normalizeLiveRoute(routeDecision.route ?? decision.route, "reply");
  const executionSupportsProvenanceReply = asBoolean(executionLayer.supports_provenance_reply);
  const executionSupportsStatusReply = asBoolean(executionLayer.supports_status_reply);
  const executionRequiresControlPlaneRefresh = asBoolean(executionLayer.requires_control_plane_refresh);

  return {
    executionCoverage: executionLayer,
    executionFreshness: asString(executionLayer.freshness),
    executionSupportsProvenanceReply,
    executionSupportsStatusReply,
    executionRequiresControlPlaneRefresh,
    lastRoute: asString(executionLayer.last_route),
    lastToolsUsed: asStringArray(executionLayer.tools_used),
    dispatchExecuted: asBoolean(executionLayer.dispatch_executed),
    spawnExecuted: asBoolean(executionLayer.spawn_executed),
    nativeTaskId: asString(executionLayer.native_task_id) || null,
    nativeFlowId: asString(executionLayer.native_flow_id) || null,
    resultMaterialized: asBoolean(executionLayer.result_materialized),
    deliveryStatus: asString(executionLayer.delivery_status) || null,
    executionCoverageConflict: route === "delegate" && (
      executionSupportsProvenanceReply
      || executionSupportsStatusReply
      || executionRequiresControlPlaneRefresh
    ),
  };
}

export async function resolveStatelessPolicyDecision(task: string, options: UnknownRecord = {}): Promise<UnknownRecord> {
  const prompt = normalizePolicyPrompt(task);
  const metadata = enrichConversationControlMetadata(prompt, asRecord(options.metadata));
  const routeHint = asRecord(options.routeHint);
  if (Object.keys(routeHint).length > 0) {
    const routeHintRoute = asString(routeHint.route_hint ?? routeHint.routeHint);
    if (routeHintRoute) {
      const normalizedRouteHint = normalizeLiveRoute(routeHintRoute, "reply");
      const conversationControl = trustedConversationControl(metadata);
      const routeHintSource = asString(routeHint.source, "main_agent");
      const routeHintTrusted = asBoolean(routeHint.trusted) || TRUSTED_ROUTE_REQUEST_SOURCES.has(routeHintSource);
      const objectionRequestedRoute = normalizeLiveRoute(
        routeHint.requested_route,
        normalizedRouteHint,
      );
      const isExecutionOrStatusFollowup = asString(conversationControl.intent_class) === "execution_followup"
        || asBoolean(conversationControl.provenance_followup)
        || asBoolean(conversationControl.status_followup);
      const guardedDelegate = !isExecutionOrStatusFollowup && (asString(conversationControl.route_hint) === "delegate"
        || asBoolean(conversationControl.require_fresh_lookup)
        || asBoolean(conversationControl.require_state_grounding)
        || asString(conversationControl.intent_class) === "fresh_live_lookup");
      const explicitObjection = routeHint.route_objection === true;
      const explicitReplyObjection = explicitObjection && objectionRequestedRoute === "reply";

      metadata.route_hint = normalizedRouteHint;
      metadata.route_hint_source = routeHintSource;
      metadata.route_request_source = routeHintSource;
      metadata.route_request_trusted = routeHintTrusted;
      if (explicitObjection) {
        metadata.requested_route = objectionRequestedRoute;
      } else if (guardedDelegate && normalizedRouteHint === "reply" && !explicitReplyObjection) {
        metadata.requested_route = asString(conversationControl.route_hint, "delegate");
        metadata.route_request_source = "system";
        metadata.route_request_trusted = true;
      } else if (routeHintTrusted) {
        metadata.requested_route = normalizedRouteHint;
      } else {
        delete metadata.requested_route;
      }
    }
    if (typeof routeHint.route_objection === "boolean") {
      metadata.route_objection = routeHint.route_objection;
    }
    if (routeHint.route_objection === true) {
      metadata.objection_reason = asString(routeHint.objection_reason);
      metadata.objection_requested_route = normalizeLiveRoute(
        routeHint.requested_route,
        normalizeLiveRoute(metadata.requested_route, "reply"),
      );
    }
    if (asString(routeHint.work_type)) metadata.workType = asString(routeHint.work_type);
    if (asString(routeHint.phase)) metadata.phase = asString(routeHint.phase);
    if (typeof routeHint.review_required === "boolean") metadata.review_required = routeHint.review_required;
    if (typeof routeHint.confidence === "number") metadata.route_hint_confidence = routeHint.confidence;
    if (asString(routeHint.reason)) metadata.route_hint_reason = asString(routeHint.reason);
    metadata.route_hint_payload = routeHint;
  }
  const forcedRoute = asString(options.forceRoute);
  if (forcedRoute) {
    metadata.requested_route = normalizeLiveRoute(forcedRoute, "reply");
    metadata.route_request_source = "force_route";
    metadata.route_request_trusted = true;
  }
  const decision = buildDecision(prompt, { metadata });

  const delegationEnabled = asBoolean(asRecord(options.metadata)._delegationEnabled, true);

  if (!delegationEnabled) {
    const forcedDecision = rebuildDecisionWithRoute(decision, "reply");
    const seeded: UnknownRecord = {
      summary: `policy=reply -> octoclaw-main`,
      request: {
        task: prompt,
        session_key: asString(metadata.session_key),
        metadata,
      },
      route_decision: {
        route: "reply",
        system_preferred_route: "reply",
        worker_pool: "octoclaw-main",
        task_class: "main_direct",
        work_type: asString(metadata.workType, "research"),
        phase: "execute",
        protocol: "normal",
      },
      model_policy: {
        profile: forcedDecision.modelProfile,
        selected_model: asString(metadata.model, forcedDecision.modelProfile),
        worker_pool: "octoclaw-main",
      },
      review_policy: { required: false },
      router_decision_v2: { compatibility_view: true, request_kind: "reply" },
      _delegation_enabled: false,
      _judge_succeeded: false,
      _judge_route: null,
      _judge_role: undefined,
      _delegate_reason_codes: [],
      _route_hint_required: false,
    };
    return applyPhaseTwoLivePathPolicy(seeded, metadata, prompt);
  }

  let judgeRouteOverride: string | null = null;
  let judgeSucceeded = false;
  let judgeAckText: string | null = null;
  let judgeShadowLog: UnknownRecord | null = null;
  let judgeBudgetBand: string | null = null;
  let judgeRole: PolicyRole | undefined;
  let judgeComplexityBand: "simple" | "normal" | "deep" | undefined;
  let judgeExpectedDurationBand: "instant" | "short" | "medium" | "long" | undefined;
  let judgeQualityBar: "standard" | "high" | "critical" | undefined;
  let judgeRiskFlags: string[] = [];
  let judgeRouteConfidence: number | undefined;
  let delegateReasonCodes: string[] = [];
  let remoteJudgeOverrideApplied = false;
  let deterministicFallbackApplied = false;
  let deterministicRuleApplied = false;
  let deterministicRuleReason: string | null = null;

  let dualJudgeConfig = resolveDualJudgeConfig(asRecord(options.metadata));
  if (!dualJudgeConfig) {
    const fallbackLocal = resolveJudgeConfig(asRecord(asRecord(options.metadata)._judgeFastConfig));
    if (fallbackLocal) {
      dualJudgeConfig = {
        local: fallbackLocal,
        remote: {
          enabled: false,
          modelId: "",
          baseUrl: "",
          apiKey: "",
          timeoutMs: 8000,
          shadowMode: true,
        },
        escalation: {
          minConfidence: fallbackLocal.minConfidence,
          alwaysEscalateRiskFlags: [],
          maxLatencyMs: 4000,
        },
      };
    }
  }
  const judgeConfig = dualJudgeConfig?.local ?? resolveJudgeConfig(asRecord(asRecord(options.metadata)._judgeFastConfig));
  if (process.env.OCTOCLAW_JUDGE_DEBUG) {
    console.log(`[octoclaw-judge] resolveStateless: judgeConfig=${judgeConfig ? "present" : "null"} enabled=${judgeConfig?.enabled} delegation=${asBoolean(asRecord(options.metadata)._delegationEnabled, true)}`);
  }
  if (judgeConfig) {
    // Build execution coverage layer (design §4b)
    const sessionKeys = Array.isArray(metadata.judge_session_keys) && metadata.judge_session_keys.length > 0
      ? metadata.judge_session_keys as string[]
      : Array.isArray(metadata.session_keys) && metadata.session_keys.length > 0
        ? metadata.session_keys as string[]
        : [asString(metadata.session_key)].filter(Boolean);
    const excludeTurnId = asString(metadata.current_turn_id);
    const executionLayer = buildExecutionCoverageLayer(sessionKeys, excludeTurnId || undefined);
    metadata._execution_coverage = executionLayer;
    metadata.execution_layer = executionLayer;

    if (!Array.isArray(metadata.judge_session_keys) && !Array.isArray(metadata.session_keys)) {
      const sessionKey = asString(metadata.session_key);
      if (sessionKey) {
        metadata.judge_session_keys = [sessionKey];
      }
    }

    const contextPacket = buildLiveJudgeContextPacket({ prompt, metadata });
    if (contextPacket) {
      metadata.judge_context_packet = contextPacket;
    }

    const continuationRoute = selectContinuationRoute(metadata);
    if (continuationRoute) {
      judgeRouteOverride = continuationRoute;
      judgeSucceeded = true;
      judgeShadowLog = {
        judge_skipped: true,
        judge_skip_reason: "continuation_route_reused",
        judge_route: continuationRoute,
        rule_route: decision.route,
        judge_mode: judgeConfig.shadowMode ? "shadow" : "active",
      };
    } else {
      const judgeInput = buildJudgeInput(prompt, metadata, contextPacket);
      const judgeStart = Date.now();
      if (process.env.OCTOCLAW_JUDGE_DEBUG) {
        console.log(`[octoclaw-judge] calling LLM judge... model=${judgeConfig.modelId} timeout=${judgeConfig.local ? judgeConfig.timeoutLocalMs : judgeConfig.timeoutMs}ms`);
      }
      let judgeResult = await callLlmJudge(judgeInput, judgeConfig);
      if (judgeResult === null && lastJudgeFailureClass) {
        metadata._judge_failure_class = lastJudgeFailureClass;
      }
      const judgeLatencyMs = Date.now() - judgeStart;
      if (process.env.OCTOCLAW_JUDGE_DEBUG) {
        console.log(`[octoclaw-judge] judge done: ${judgeLatencyMs}ms result=${judgeResult ? `route=${judgeResult.route} conf=${judgeResult.confidence} ack="${judgeResult.ackText?.slice(0, 30)}"` : "null(timeout)"}`);
      }

      let remoteJudgeResult = null;
      let escalationReason = null;
      const localJudgeRoute = judgeResult?.route ?? null;
      const localJudgeConfidence = judgeResult?.confidence ?? null;
      if (judgeResult && dualJudgeConfig) {
        escalationReason = shouldEscalate(judgeResult, dualJudgeConfig.escalation, {
          ...metadata,
          task: prompt,
        });
        if (escalationReason && dualJudgeConfig.remote.enabled) {
          remoteJudgeResult = await callRemoteJudge(judgeInput, judgeResult, escalationReason, dualJudgeConfig);
          if (remoteJudgeResult && !dualJudgeConfig.remote.shadowMode && remoteJudgeResult.override_recommendation === "override_local") {
            judgeResult = remoteJudgeResult;
            remoteJudgeOverrideApplied = true;
          }
        }
      }

      judgeAckText = judgeConfig.judgeAckEnabled
        ? (isActionableJudgeResult(judgeResult, judgeConfig.minConfidence) ? (judgeResult?.ackText ?? null) : null)
        : null;
      judgeShadowLog = {
        judge_latency_ms: judgeLatencyMs,
        judge_timeout: judgeResult === null,
        judge_parse_failure: false,
        judge_route: judgeResult?.route ?? null,
        judge_confidence: judgeResult?.confidence ?? null,
        local_judge_route: localJudgeRoute,
        local_judge_confidence: localJudgeConfidence,
        final_judge_route: judgeResult?.route ?? null,
        final_judge_confidence: judgeResult?.confidence ?? null,
        judge_abstain: Boolean(judgeResult?.abstainReason),
        judge_ack_text: judgeAckText,
        rule_route: decision.route,
        judge_override: false,
        judge_mode: judgeConfig.shadowMode ? "shadow" : "active",
        remote_override_applied: remoteJudgeResult !== null && !Boolean(dualJudgeConfig?.remote.shadowMode) && remoteJudgeResult.override_recommendation === "override_local",
        judge_escalation_reason: escalationReason,
        remote_judge_enabled: Boolean(dualJudgeConfig?.remote.enabled),
        remote_judge_shadow_mode: Boolean(dualJudgeConfig?.remote.shadowMode),
        remote_judge_result: remoteJudgeResult,
      };

      // Deterministic hard-boundary fallback when judge timed out
      if (judgeResult === null) {
        const conversationControl = trustedConversationControl(metadata);
        const intentClass = structuredIntentClass(metadata);
        const intentRequiresDelegation = intentClass === "fresh_live_lookup"
          || intentClass === "delegated_work"
          || asBoolean(conversationControl.require_fresh_lookup)
          || asBoolean(conversationControl.require_state_grounding);
        const explicitDelegateRequest = asBoolean(conversationControl.explicit_delegate_request)
          || intentClass === "delegated_work";
        const toolNeedHint = asString(metadata.tool_need_hint);
        const durationHint = asString(metadata.duration_hint);
        const hardBoundarySignals = [
          intentRequiresDelegation,
          toolNeedHint === "required",
          durationHint === "long",
          asString(conversationControl.route_hint) === "delegate",
          explicitDelegateRequest,
        ];
        const timeoutExecutionLayer = asRecord(metadata.execution_layer ?? metadata._execution_coverage);
        const timeoutExecutionOverride = asBoolean(timeoutExecutionLayer.supports_provenance_reply)
          || asBoolean(timeoutExecutionLayer.supports_status_reply);
        const timeoutRequiresRefresh = asBoolean(timeoutExecutionLayer.requires_control_plane_refresh);
        const timeoutIsFollowup = intentClass === "execution_followup"
          || asBoolean(conversationControl.provenance_followup)
          || asBoolean(conversationControl.status_followup);
        const isFollowupNoCoverage = intentClass === "execution_followup"
          && !timeoutExecutionOverride
          && !timeoutRequiresRefresh;
        if ((timeoutExecutionOverride || timeoutRequiresRefresh) && timeoutIsFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          deterministicFallbackApplied = true;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = `timeout_execution_coverage_override:${timeoutExecutionOverride ? "provenance/status_reply" : "control_plane_refresh"}`;
          judgeShadowLog.final_judge_route = "reply";
        } else if (isFollowupNoCoverage) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          deterministicFallbackApplied = true;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = "timeout_execution_followup_no_coverage→reply(no_verifiable_record)";
          judgeShadowLog.final_judge_route = "reply";
        } else if (hardBoundarySignals.some(Boolean)) {
          // Deterministic hard-boundary: high-risk task must not default to reply
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          deterministicFallbackApplied = true;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = `deterministic_hard_boundary:${hardBoundarySignals.map((v, i) => v ? ["intent", "tool_need", "duration", "conv_route", "explicit_delegate"][i] : null).filter(Boolean).join("+")}`;
          judgeShadowLog.final_judge_route = "delegate";
        }
      }

      if (isActionableJudgeResult(judgeResult, judgeConfig.minConfidence)) {
        const routeStr = judgeResultToRouteOverride(judgeResult);
        if (routeStr) {
          judgeShadowLog.judge_override = decision.route !== routeStr;
          if (!judgeConfig.shadowMode) {
            judgeRouteOverride = routeStr;
            judgeSucceeded = true;
          }
        }
        judgeBudgetBand = judgeResult.budgetBand ?? null;
        judgeRole = coerceJudgeRole(judgeResult.role);
        judgeComplexityBand = coerceComplexityBand(judgeResult.complexityBand);
        judgeExpectedDurationBand = coerceExpectedDurationBand(judgeResult.expectedDurationBand);
        judgeQualityBar = coerceQualityBar(judgeResult.qualityBar);
        judgeRiskFlags = asStringArray(judgeResult.riskFlags);
        judgeRouteConfidence = coerceRouteConfidence(judgeResult.routeConfidence);
        delegateReasonCodes = coerceDelegateReasonCodes(judgeResult.delegateReasonCodes);

        // ── Validator default rules (spec §11) ──
        // tool_need_hint / duration_hint must influence route, not just be telemetry.
        const toolNeedHint = judgeResult.toolNeedHint ?? judgeResult.tool_need_hint;
        const durationHint = judgeResult.durationHint ?? judgeResult.duration_hint;
        const judgeScope = judgeResult.scope;
        const validatorOverrideReasons: string[] = [];
        const conversationControl = trustedConversationControl(metadata);
        const intentClass = structuredIntentClass(metadata);
        const conversationRouteHint = asString(conversationControl.route_hint);

        const executionCoverage = asRecord(metadata.execution_layer ?? metadata._execution_coverage);
        const executionCoverageOverride = asBoolean(executionCoverage.supports_provenance_reply)
          || asBoolean(executionCoverage.supports_status_reply);
        const requiresControlPlaneRefresh = asBoolean(executionCoverage.requires_control_plane_refresh);

        const isExecutionOrStatusFollowup = intentClass === "execution_followup"
          || asBoolean(conversationControl.provenance_followup)
          || asBoolean(conversationControl.status_followup);

        let executionOverrideApplied = false;

        if (executionCoverageOverride && isExecutionOrStatusFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          executionOverrideApplied = true;
          validatorOverrideReasons.push("validator:execution_coverage_override→reply(intent_guard)");
          if (process.env.OCTOCLAW_JUDGE_DEBUG) {
            console.log(`[octoclaw-judge] execution coverage override: supports_provenance_reply=${asBoolean(executionCoverage.supports_provenance_reply)} supports_status_reply=${asBoolean(executionCoverage.supports_status_reply)} intent=${intentClass}, forcing reply`);
          }
        } else if (requiresControlPlaneRefresh && isExecutionOrStatusFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          executionOverrideApplied = true;
          validatorOverrideReasons.push("validator:execution_requires_control_plane_refresh→reply(intent_guard)");
          if (process.env.OCTOCLAW_JUDGE_DEBUG) {
            console.log(`[octoclaw-judge] execution coverage override: requires_control_plane_refresh=true intent=${intentClass}, forcing reply/control-plane refresh`);
          }
        } else if (isExecutionOrStatusFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          executionOverrideApplied = true;
          validatorOverrideReasons.push("validator:execution_followup_no_coverage→reply(no_verifiable_record)");
          if (process.env.OCTOCLAW_JUDGE_DEBUG) {
            console.log(`[octoclaw-judge] execution followup no coverage: intent=${intentClass}, forcing reply (no_verifiable_record)`);
          }
        }

        if (!executionOverrideApplied && toolNeedHint === "required" && judgeRouteOverride === "reply") {
          if (judgeScope === "unknown") {
            judgeRouteOverride = "delegate";
            judgeSucceeded = true;
            validatorOverrideReasons.push("validator:tool_need_required+scope_unknown→delegate(reply_mode=clarify)");
          } else {
            judgeRouteOverride = "delegate";
            judgeSucceeded = true;
            validatorOverrideReasons.push("validator:tool_need_required→delegate");
          }
        } else if (!executionOverrideApplied && durationHint === "long" && judgeRouteOverride === "reply") {
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          validatorOverrideReasons.push("validator:duration_long→delegate");
        } else if (!executionOverrideApplied && conversationRouteHint === "delegate" && judgeRouteOverride === "reply") {
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          validatorOverrideReasons.push("validator:conversation_control_route_hint_delegate→delegate");
        } else if (!executionOverrideApplied && intentClass === "fresh_live_lookup" && judgeRouteOverride === "reply") {
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          validatorOverrideReasons.push(`validator:intent_${intentClass}→delegate`);
        }
        // tool_need_hint==none && duration_hint==short → reply remains eligible (no override needed)

        if (validatorOverrideReasons.length > 0 && !judgeConfig.shadowMode) {
          judgeShadowLog.validator_override = true;
          judgeShadowLog.validator_override_reasons = validatorOverrideReasons;
          judgeShadowLog.validator_tool_need_hint = toolNeedHint ?? null;
          judgeShadowLog.validator_duration_hint = durationHint ?? null;
          judgeShadowLog.validator_scope = judgeScope ?? null;
          judgeShadowLog.final_judge_route = judgeRouteOverride;
          if (process.env.OCTOCLAW_JUDGE_DEBUG) {
            console.log(`[octoclaw-judge] validator override: ${validatorOverrideReasons.join(", ")}`);
          }
        }
      }
    }
  }

  const routeHintRequired = !(judgeSucceeded || deterministicRuleApplied);

  const finalDecision = judgeRouteOverride
    ? rebuildDecisionWithRoute(decision, judgeRouteOverride, judgeRole)
    : decision;

  if (finalDecision.route === "delegate") {
    metadata._taskflow_preflight_required = true;
  }

  const seeded: UnknownRecord = {
    summary: `policy=${finalDecision.route} -> ${workerPoolForDecision(finalDecision.executionProfile, finalDecision.role)}`,
    request: {
      task: prompt,
      session_key: asString(metadata.session_key),
      metadata,
    },
    route_decision: {
      route: finalDecision.route,
      system_preferred_route: (judgeSucceeded || deterministicRuleApplied) ? finalDecision.route : decision.route,
      judge_route: judgeRouteOverride ? normalizeLiveRoute(judgeRouteOverride, finalDecision.route) : undefined,
      judge_role: judgeRole,
      worker_pool: workerPoolForDecision(finalDecision.executionProfile, finalDecision.role),
      task_class: isObserveMode(finalDecision.role, finalDecision.executionProfile)
        ? "control_observer"
        : finalDecision.route === "delegate"
          ? "delegated_single"
          : "main_direct",
      work_type: asString(metadata.workType, "research"),
      phase: "execute",
      protocol: finalDecision.route === "reply" ? "normal" : "delegated",
      route_source: deterministicFallbackApplied ? "fallback" : (deterministicRuleApplied ? "rule" : (judgeSucceeded ? "judge" : (judgeShadowLog?.fallback_reason ? "fallback" : "rule"))),
      judge_timeout: judgeShadowLog?.judge_timeout ?? false,
      fallback_reason: judgeShadowLog?.fallback_reason ?? null,
      final_judge_source: deterministicRuleApplied ? "policy_rule" : (deterministicFallbackApplied ? "timeout_fallback" : (judgeSucceeded ? (remoteJudgeOverrideApplied ? "remote" : "local") : (judgeShadowLog?.judge_timeout ? "timeout" : "no_judge"))),
      complexity_band: judgeComplexityBand,
      expected_duration_band: judgeExpectedDurationBand,
      quality_bar: judgeQualityBar,
      risk_flags: judgeRiskFlags,
      delegate_reason_codes: delegateReasonCodes,
      route_confidence: judgeRouteConfidence,
    },
    model_policy: {
      profile: finalDecision.modelProfile,
      selected_model: asString(metadata.model, finalDecision.modelProfile),
      worker_pool: workerPoolForDecision(finalDecision.executionProfile, finalDecision.role),
    },
    review_policy: {
      required: finalDecision.route === "delegate",
    },
    router_decision_v2: {
      compatibility_view: true,
      request_kind: finalDecision.route === "reply" ? "reply" : "delegated_task",
    },
    _delegation_enabled: true,
    _judge_succeeded: judgeSucceeded,
    _judge_route: judgeRouteOverride ?? null,
    _remote_judge_overrode_local: remoteJudgeOverrideApplied,
    _deterministic_rule_applied: deterministicRuleApplied,
    _deterministic_rule_reason: deterministicRuleReason,
    _judge_role: judgeRole,
    _judge_budget_band: judgeBudgetBand,
    _judge_complexity_band: judgeComplexityBand,
    _judge_expected_duration_band: judgeExpectedDurationBand,
    _judge_quality_bar: judgeQualityBar,
    _judge_risk_flags: judgeRiskFlags,
    _judge_route_confidence: judgeRouteConfidence,
    _delegate_reason_codes: delegateReasonCodes,
    _route_hint_required: routeHintRequired,
    _judge_ack_text: judgeAckText,
    _judge_shadow_log: judgeShadowLog,
    _execution_coverage: asRecord(metadata.execution_layer ?? metadata._execution_coverage),
    _execution_supports_provenance_reply: asBoolean(asRecord(metadata.execution_layer ?? metadata._execution_coverage)?.supports_provenance_reply),
    _execution_supports_status_reply: asBoolean(asRecord(metadata.execution_layer ?? metadata._execution_coverage)?.supports_status_reply),
    _execution_coverage_level: asString(asRecord(metadata.execution_layer ?? metadata._execution_coverage)?.coverage),
    _judge_failure_class: asString(metadata._judge_failure_class) || undefined,
  };

  const resolvedDecision = applyPhaseTwoLivePathPolicy(seeded, metadata, prompt);
  const stateKey = asString(metadata.session_key);
  if (stateKey) {
    attachWorkContractToPolicyDecision({
      stateKey,
      prompt,
      metadata,
      decision: resolvedDecision,
      routeSeal: savedRouteSeal(resolvedDecision.routeSeal),
    });
  }
  return resolvedDecision;
}

function rebuildDecisionWithRoute(base: PolicyDecision, liveRoute: string, roleOverride?: PolicyRole): PolicyDecision {
  const route = normalizeLiveRoute(liveRoute, base.route);
  const resolvedRole = roleOverride ?? decideRole(route, base.role === "worker_code" ? "code" : base.role === "worker_review" ? "review" : "research").role;
  const coordinationMode = decideCoordinationMode(route, resolvedRole);
  const backend = decideBackend(resolvedRole);
  const executionProfile = decideExecutionProfile(resolvedRole);
  const model = decideModelProfile(resolvedRole, base.workspaceMode);

  return {
    route,
    role: resolvedRole,
    coordinationMode,
    backend: backend.backend,
    executionProfile: executionProfile.executionProfile,
    workspaceMode: model.workspaceMode,
    modelProfile: model.modelProfile,
    caps: base.caps,
    admission: base.admission,
    decisionStack: base.decisionStack,
  };
}



export async function resolvePolicyDecisionForContext(
  promptOrEvent: unknown,
  ctx: ManagedContext,
  _cwd: string,
  logger?: LoggerLike,
): Promise<{ decision: UnknownRecord; stateKey: string; state: PolicyContextState } | null> {
  const prompt = typeof promptOrEvent === "string"
    ? normalizePolicyPrompt(promptOrEvent)
    : extractPromptText(asRecord(promptOrEvent) as ExtractPromptEvent);
  if (!prompt || !isManagedAgentContext(ctx)) {
    return null;
  }

  policyState.prune();
  const stateKey = resolvePolicyStateKey(ctx);
  const existing = policyState.resolveForContext(ctx).state as PolicyContextState | null;
  const metadata = buildPolicyMetadata(ctx, { stateKey });
  const existingDelegateTaskContext = asRecord(existing?.delegateTaskContext);

  // Inject judge/delegation config from env vars (bypasses plugin config schema validation)
  const judgeEnvJson = process.env.OCTOCLAW_JUDGE_FAST?.trim();
  if (judgeEnvJson && !metadata._judgeFastConfig) {
    try {
      const parsed = JSON.parse(judgeEnvJson);
      if (typeof parsed === "object" && parsed && !Array.isArray(parsed)) {
        metadata._judgeFastConfig = parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
  }
  const remoteJudgeEnvJson = process.env.OCTOCLAW_JUDGE_REMOTE?.trim();
  if (remoteJudgeEnvJson && !metadata._remoteJudgeConfig) {
    try {
      const parsed = JSON.parse(remoteJudgeEnvJson);
      if (typeof parsed === "object" && parsed && !Array.isArray(parsed)) {
        metadata._remoteJudgeConfig = parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
  }
  if (process.env.OCTOCLAW_DELEGATION_ENABLED !== undefined && !metadata._delegationEnabled) {
    metadata._delegationEnabled = process.env.OCTOCLAW_DELEGATION_ENABLED !== "false";
  }

  if (existing?.decision && promptsEquivalent(asString(existing.prompt), prompt)) {
    const cached = { ...asRecord(existing.decision) };
    const routeSeal = stampRouteSealForPolicyState({
      prompt,
      stateKey,
      metadata,
      decision: cached,
      savedRouteSeal: savedRouteSeal(existing.routeSeal),
    });
    policyState.set(stateKey, {
      ...existing,
      sessionBoundary: existing.sessionBoundary
        ? {
            status: asString(existing.sessionBoundary.status),
            reason: asString(existing.sessionBoundary.reason),
          }
        : undefined,
      updatedAt: Date.now(),
      decision: cached,
      routeSeal,
    });
    return { decision: cached, stateKey, state: { ...existing, decision: cached, routeSeal, updatedAt: Date.now() } };
  }

  try {
    const rawDecision = await resolveStatelessPolicyDecision(prompt, { metadata });
    const decision = canonicalizeDecisionForPolicyState(
      attachRuntimeTruthMetadata(rawDecision, metadata, prompt),
    );
    const nextState: PolicyContextState = {
      prompt,
      decision,
      createdAt: Number(existing?.createdAt ?? Date.now()),
      updatedAt: Date.now(),
      canonicalSessionKey: asString(stateKey),
      sessionBoundary: {
        status: asString(metadata.session_boundary_status),
        reason: asString(metadata.session_boundary_reason),
      },
      routeHintSubmitted: Boolean(asRecord(decision.route_hint_policy).submitted),
      routeHintPayload: null,
      blockedTools: asStringArray(asRecord(decision.tool_policy).blocked_patterns),
      latencyAckSent: false,
      latencyAckText: asString(asRecord(decision.latency_ack).text),
      delegated: false,
      delegationTool: asString(asRecord(decision.tool_policy).must_delegate_via),
      delegateTaskContext: Object.keys(asRecord(decision.delegateTaskContext)).length > 0
        ? asRecord(decision.delegateTaskContext)
        : Object.keys(existingDelegateTaskContext).length > 0
          ? existingDelegateTaskContext
          : undefined,
    };

    const routeSeal = stampRouteSealForPolicyState({
      prompt,
      stateKey,
      metadata,
      decision,
      savedRouteSeal: savedRouteSeal(existing?.routeSeal),
    });
    nextState.routeSeal = routeSeal;

    if (nextState.delegateTaskContext && Object.keys(asRecord(decision.delegateTaskContext)).length === 0) {
      decision.delegateTaskContext = nextState.delegateTaskContext;
    }

    policyState.set(stateKey, nextState);

    // Build WorkContract from this policy decision
    attachWorkContractToPolicyDecision({ stateKey, prompt, metadata, decision, routeSeal });
    nextState.workContractId = asString(decision.workContractId);
    nextState.latestStatus = "sealed";

    await recordPolicyReplay(
      "policy_resolved",
      buildPolicyResolvedReplayPayload({
        decision,
        ...buildPolicyResolvedExecutionTelemetry(decision),
        workContractId: decision.workContractId,
        workContractRoute: asRecord(decision.work_contract).route,
        decisionSource: asRecord(decision.work_contract).decisionSource,
        memoryCoverage: asRecord(metadata._memory_coverage).coverage,
        memoryFreshnessRisk: asRecord(metadata._memory_coverage).freshness_risk,
        parentContextTokensAdded: 0,
        stateKey,
        ctx,
        boundary: { canonicalSessionKey: stateKey, status: asString(metadata.session_boundary_status), reason: asString(metadata.session_boundary_reason) },
        metadata,
        prompt,
        routeHintSubmitted: Boolean(nextState.routeHintSubmitted),
        usedCachedPolicy: false,
      }),
      logger,
      decision,
    );
    await recordPolicyReplay(
      "policy_judged",
      {
        sessionKey: stateKey,
        sessionId: asString(ctx.sessionId),
        ...buildPolicyJudgedReplayPayload(decision),
      },
      logger,
      decision,
    );
    await recordPolicyReplay(
      "route_validated",
      {
        sessionKey: stateKey,
        sessionId: asString(ctx.sessionId),
        ...buildRouteValidatedReplayPayload(decision),
      },
      logger,
      decision,
    );
    return { decision, stateKey, state: nextState };
  } catch (error) {
    logger?.warn?.(`octoclaw runtime policy resolve failed: ${String(error instanceof Error ? error.message : error)}`);
    return null;
  }
}

export function buildTsRuntimeDispatchPayload(input: DispatchLikeInput): UnknownRecord {
  return buildRuntimeDispatchPayload(input, {
    runtimeRouteDecision,
    normalizeLiveRoute: (route, fallback = "reply") => normalizeLiveRoute(route, normalizeLiveRoute(fallback, "reply")),
    runtimeExecutionIds: buildRuntimeExecutionIds,
    buildWorkflowDecision: (_task, decision, _metadata) => {
      const prior = asRecord(decision);
      const judgeSucceeded = asBoolean(prior._judge_succeeded, false);
      const judgeRoute = asString(prior._judge_route);
      const routeDecisionRoute = asString(asRecord(prior.route_decision).route);

      const fallback: LiveRoute = routeDecisionRoute === "reply" || routeDecisionRoute === "delegate" ? routeDecisionRoute : "delegate";
      const authoritativeRoute: LiveRoute = judgeSucceeded && judgeRoute
        ? normalizeLiveRoute(judgeRoute, fallback)
        : normalizeLiveRoute(routeDecisionRoute, "delegate");

      const observeFlags = observeFlagsForRoute(
        authoritativeRoute,
        asString(prior._judge_role),
        asString(prior.executionProfile),
      );

      const taskSignal = asString(prior._judge_task_text || _task || "");
      return rebuildDecisionWithRoute(
        buildDecision(taskSignal, {
          metadata: {
            requested_route: authoritativeRoute,
            ...observeFlags,
          },
        }),
        authoritativeRoute,
        coerceJudgeRole(prior._judge_role) ?? undefined,
      );
    },
    buildWorkflowScope,
    truncateText,
  }) as UnknownRecord;
}

export function buildTsRuntimeSpawnPayload(input: SpawnLikeInput): UnknownRecord {
  return buildRuntimeSpawnPayload(input, {
    runtimeRouteDecision,
    normalizeLiveRoute: (route, fallback = "reply") => normalizeLiveRoute(route, normalizeLiveRoute(fallback, "reply")),
    runtimeExecutionIds: buildRuntimeExecutionIds,
    buildWorkflowDecision: (_task, decision, _metadata) => {
      const prior = asRecord(decision);
      const judgeSucceeded = asBoolean(prior._judge_succeeded, false);
      const judgeRoute = asString(prior._judge_route);
      const routeDecisionRoute = asString(asRecord(prior.route_decision).route);

      const fallback: LiveRoute = routeDecisionRoute === "reply" || routeDecisionRoute === "delegate" ? routeDecisionRoute : "delegate";
      const authoritativeRoute: LiveRoute = judgeSucceeded && judgeRoute
        ? normalizeLiveRoute(judgeRoute, fallback)
        : normalizeLiveRoute(routeDecisionRoute, "delegate");

      const observeFlags = observeFlagsForRoute(
        authoritativeRoute,
        asString(prior._judge_role),
        asString(prior.executionProfile),
      );

      const taskSignal = asString(prior._judge_task_text || _task || "");
      return rebuildDecisionWithRoute(
        buildDecision(taskSignal, {
          metadata: {
            requested_route: authoritativeRoute,
            ...observeFlags,
          },
        }),
        authoritativeRoute,
        coerceJudgeRole(prior._judge_role) ?? undefined,
      );
    },
    buildWorkflowScope,
    truncateText,
  }) as UnknownRecord;
}

export function routeDecisionSummary(decision: UnknownRecord): string {
  const routeDecision = runtimeRouteDecision(canonicalizeDecisionForPolicyState(decision));
  return [
    `route=${asString(routeDecision.route, "reply")}`,
    `worker_pool=${asString(routeDecision.worker_pool, "octoclaw-main")}`,
    `phase=${asString(routeDecision.phase)}`,
    `task=${truncateText(asString(asRecord(decision.request).task), 80)}`,
    compactPolicyPrompt(decision),
    routeHintRequired(decision) ? "route_hint=required" : "route_hint=optional",
  ].filter(Boolean).join(" | ");
}

export function supportedPolicyRoutes(): string[] {
  return ["reply", "delegate"];
}
