import type { ContextCoverageSnapshot, ExecutionCoveragePacket, IntentClass, ReplyContract, WorkContract, WorkDecisionSource } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import type { PolicyDecision, PolicyJudgeInput } from "@octoclaw/policy/judge";
import { judgePolicy, decideCoordinationMode } from "@octoclaw/policy/judge";
import { decideRole } from "@octoclaw/policy/roles";
import { decideBackend, decideExecutionProfile, decideModelProfile } from "@octoclaw/policy/model";
import {
  resolveJudgeConfig,
  buildJudgeInput,
  buildLiveJudgeContextPacket,
  callLlmJudge,
  isActionableJudgeResult,
  judgeResultToRouteOverride,
  lastJudgeFailureClass,
} from "./llm-judge.js";
import type { PolicyRole } from "@octoclaw/policy/roles";
import type { ExecutionProfileTarget } from "@octoclaw/policy/model";
import type { LiveRoute } from "@octoclaw/policy/route";
import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import type { WorkerPool } from "@octoclaw/policy/caps";
import {
  canonicalizeDecisionForPolicyState,
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
} from "./session.js";
import {
  PHASE_TWO_LIVE_ROUTES,
  applyStartupCostClassification,
  classifyStartupCost,
  coerceComplexityBand,
  coerceDelegateReasonCodes,
  coerceExpectedDurationBand,
  coerceJudgeRole,
  coerceQualityBar,
  coerceRouteConfidence,
  coerceStartupDecisionBucket,
  coerceUnitConfidence,
  extractPromptText,
  hardDelegateReasonsAllowFollowupOverride,
  isDegradedDelegateJudgeResult,
  isDelegateAttempt,
  isDelegateTask,
  isTrustedRouteRequest,
  normalizeWorkspaceMode,
  observeFlagsForRoute,
  routeRequestSource,
  selectContinuationRoute,
  structuredIntentClass,
  TRUSTED_ROUTE_REQUEST_SOURCES,
  trustedConversationControl,
  type ExtractPromptEvent,
} from "./policy-routing-helpers.js";
import {
  buildDelegateTaskContext,
  buildRuntimeTruthMetadata,
  buildWorkflowScope,
} from "./runtime-recovery.js";
export { extractPromptText } from "./policy-routing-helpers.js";
export { checkActiveTaskRecovery } from "./runtime-recovery.js";
import { policyState } from "../state/policy-state.js";
import { buildTurnExecutionReceipt } from "../receipt.js";
import { compactPolicyPrompt, isDelegatedRoute, routeHintRequired } from "../replay/policy-utils.js";
import {
  buildPolicyJudgedReplayPayload,
  buildPolicyResolvedReplayPayload,
  buildRouteValidatedReplayPayload,
  recordPolicyReplay,
} from "../replay/replay.js";
import { resolveCurrentRouteSeal, validateRouteSeal } from "./route-seal.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { compactWorkContractView } from "@octoclaw/contracts/work-contract";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "./memory-coverage-precheck.js";
import { buildConversationIntentPacket } from "../conversation-grounding.js";
import { buildDelegationTicketDryRun } from "../runtime-ledger/ticket-dry-run.js";
import { issueDelegationTicketCandidate } from "../runtime-ledger/ticket-enforcement.js";
import {
  type UnknownRecord,
  isRecord,
  asRecord,
  asString,
  asBoolean,
  asStringArray,
} from "../util/type-coercion.js";
import { emitRouterLiteShadowEvent } from "../router-lite/shadow-bridge.js";

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

function removeWorkContractFromPolicyDecision(decision: UnknownRecord, reason: string, staleWorkContractId = ""): void {
  delete decision.workContractId;
  delete decision.work_contract_id;
  delete decision.work_contract;
  const routeDecision = asRecord(decision.route_decision);
  decision.route_decision = {
    ...routeDecision,
    reason_codes: Array.from(new Set([
      ...asStringArray(routeDecision.reason_codes),
      reason,
    ])),
  };
  decision.work_contract_materialization = {
    ok: false,
    reason,
    staleWorkContractId: staleWorkContractId || undefined,
  };
}

function attachWorkContractToPolicyDecision(input: {
  stateKey: string;
  prompt: string;
  metadata: UnknownRecord;
  decision: UnknownRecord;
  routeSeal?: RouteSeal | null;
}): { ok: true; contract: WorkContract } | { ok: false; error: string; staleWorkContractId?: string } {
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
  const intentClass = intentClassFromPolicy(
    structuredIntentClass(input.metadata)
      || input.decision.intent_class
      || conversationControl.intent_class
      || "undetermined",
  );
  const routeDecision = asRecord(input.decision.route_decision);
  const hardDelegateSignal = asBoolean(input.decision._hard_delegate_signal)
    || asBoolean(routeDecision.hard_delegate_signal);
  const hardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(
    asStringArray(input.metadata.hard_delegate_reasons).length > 0
      ? asStringArray(input.metadata.hard_delegate_reasons)
      : asStringArray(routeDecision.hard_delegate_reasons),
  );
  const statusSurfaceControlAllowed = asBoolean(conversationControl.status_followup)
    || asString(conversationControl.surface_id) === "octoclaw_task_status_panel";
  const isExecutionFollowup = !(hardDelegateSignal && hardDelegateCanOverrideFollowup) && (
    intentClass === "execution_followup"
    || asBoolean(conversationControl.provenance_followup)
    || statusSurfaceControlAllowed
  );
  const executionSupportsReply = asBoolean(executionLayer.supports_provenance_reply)
    || asBoolean(executionLayer.supports_status_reply)
    || asBoolean(executionLayer.requires_control_plane_refresh);
  const executionCoverageReplyOverride = asBoolean(input.metadata.execution_coverage_reply_override);
  const executionCoverageReplyApplied = (isExecutionFollowup && executionSupportsReply) || executionCoverageReplyOverride;
  const executionCoveragePacket: ExecutionCoveragePacket = {
    packetId: stableId("execution-coverage", [input.stateKey, input.prompt, String(Date.now())]),
    turnId: stableId("turn", [input.stateKey, input.prompt]),
    sessionKey: input.stateKey,
    coverage: coverageSnapshot,
    route: executionCoverageReplyApplied ? "reply" : authoritativeDecisionRoute(input.decision) === "delegate" ? "delegate" : "reply",
    replyMode: executionCoverageReplyApplied ? "answer" : undefined,
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
  const decisionSource = executionCoverageReplyApplied
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
  if (!saveWorkContract(contract)) {
    const error = "work_contract_save_failed";
    removeWorkContractFromPolicyDecision(input.decision, error);
    return { ok: false, error };
  }
  const delegationTicketCandidate = buildDelegationTicketDryRun({
    contract,
    decision: input.decision,
    metadata: input.metadata,
  });
  if (delegationTicketCandidate.ticket_decision === "ticket_would_issue") {
    issueDelegationTicketCandidate({ contract, candidate: delegationTicketCandidate });
  }
  input.decision.work_contract = compactWorkContractView(contract);
  input.decision.workContractId = contract.workContractId;
  input.decision.delegation_ticket_candidate = delegationTicketCandidate;
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
    decision: input.decision,
    workContractId: contract.workContractId,
    latestStatus: contract.status,
    latestExecutionReceipt: receipt,
  }));
  return { ok: true, contract };
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
  const startupClassification = classifyStartupCost(_prompt, metadata);
  applyStartupCostClassification(metadata, startupClassification);
  const hardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(startupClassification.hardDelegateReasons);
  const isExecutionOrStatusFollowup = !(startupClassification.hardDelegateSignal && hardDelegateCanOverrideFollowup) && (
    asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup)
    || conversationControl.intent_class === "execution_followup"
  );
  const forcedDelegate = !isExecutionOrStatusFollowup && startupClassification.hardDelegateSignal;
  const explicitRouteObjection = asBoolean(metadata.route_objection);
  const explicitReplyObjection = explicitRouteObjection && objectionRequestedRoute === "reply";
  const normalizedRequestedRoute = normalizeLiveRoute(rawRequestedRoute, "reply");
  const delegateRequestAllowed = normalizedRequestedRoute !== "delegate" || startupClassification.hardDelegateSignal;
  const requestedRoute = explicitRouteObjection
    ? objectionRequestedRoute
    : forcedDelegate
      && normalizeLiveRoute(rawRequestedRoute, "reply") === "reply"
      && !explicitReplyObjection
      ? "delegate"
      : delegateRequestAllowed
        ? rawRequestedRoute
        : "";

  return {
    requestedRoute: requestedRoute || undefined,
    workType: workType === "research" || workType === "code" || workType === "review" ? workType : undefined,
    hardBoundaryControl: Boolean(!isExecutionOrStatusFollowup && (conversationControl.required || metadata.hardBoundaryControl)),
    requiresObservation: Boolean(!isExecutionOrStatusFollowup && (metadata.requiresObservation || (forcedDelegate && forcedObserve))),
    requiresDelegation: Boolean(!isExecutionOrStatusFollowup && (metadata.requiresDelegation || forcedDelegate)),
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
  const startupCostPolicy = asRecord(metadata.startup_cost_policy);
  const startupReasonCodes = asStringArray(metadata.startup_reason_codes);
  const decisionBucket = asString(metadata.decision_bucket, "must_reply");
  const startupDurationHint = asString(metadata.duration_hint, "short");
  const startupToolNeedHint = asString(metadata.tool_need_hint, "none");
  const hardDelegateSignal = asBoolean(metadata.hard_delegate_signal);
  const hardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(asStringArray(metadata.hard_delegate_reasons));
  const trustedRouteRequest = isTrustedRouteRequest(metadata);
  const normalizedRequestedLiveRoute = normalizeLiveRoute(routeRequest || (trustedRouteRequest ? routeHint : "") || priorRouteDecision.route || stickyRouteDecision.route, liveRoute);
  const routeHintSubmitted = Boolean(routeHint || routeRequest);
  const objectionSubmitted = asBoolean(metadata.route_objection, false);
  const routeRequestCanOverride = (trustedRouteRequest && (normalizedRequestedLiveRoute !== "delegate" || hardDelegateSignal))
    || objectionSubmitted;
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
      liveRoute = objectionRequestedRoute;
    }
  }

  const blockedCompound = Boolean(metadata.compound_plan)
    || !PHASE_TWO_LIVE_ROUTES.has(normalizeLiveRoute(metadata.requested_route ?? metadata.route, "reply"));

  metadata.ts_policy_judge = {
    input: tsJudgeInput,
    decision: tsPolicyDecision,
    decision_bucket: decisionBucket,
    startup_cost_policy: startupCostPolicy,
    hard_delegate_signal: hardDelegateSignal,
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
  const isExecutionOrStatusFollowup = !(hardDelegateSignal && hardDelegateCanOverrideFollowup) && (
    asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup)
    || intentClass === "execution_followup"
  );
  const executionCoverageSupportsReply = asBoolean(executionLayer.supports_provenance_reply)
    || asBoolean(executionLayer.supports_status_reply);
  if (isExecutionOrStatusFollowup && executionCoverageSupportsReply) {
    liveRoute = "reply";
    metadata.execution_coverage_reply_override = true;
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
  const effectiveControlPlaneRefresh = requiresControlPlaneRefresh && isExecutionOrStatusFollowup;
  const statusSurfaceControlAllowed = asBoolean(conversationControl.status_followup)
    || asString(conversationControl.surface_id) === "octoclaw_task_status_panel";
  const executionControlAllowed = isExecutionOrStatusFollowup || statusSurfaceControlAllowed || effectiveControlPlaneRefresh;
  const routeHintPolicyRequired = asBoolean(priorDecision._route_hint_required, false)
    || (!judgeSucceeded && liveRouteNeedsHint(liveRoute, metadata))
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
    dispatch_required: !effectiveControlPlaneRefresh && liveRoute !== "reply" && tsPolicyDecision.admission.admission === "allow",
    reason: tsPolicyDecision.admission.reason,
    complexity_band: coerceComplexityBand(priorDecision._judge_complexity_band),
    expected_duration_band: coerceExpectedDurationBand(priorDecision._judge_expected_duration_band),
    quality_bar: coerceQualityBar(priorDecision._judge_quality_bar),
    risk_flags: asStringArray(priorDecision._judge_risk_flags),
    delegate_reason_codes: coerceDelegateReasonCodes(priorDecision._delegate_reason_codes),
    route_confidence: coerceRouteConfidence(priorDecision._judge_route_confidence),
    decision_bucket: decisionBucket,
    startup_cost_policy: startupCostPolicy,
    duration_hint: startupDurationHint,
    tool_need_hint: startupToolNeedHint,
    hard_delegate_signal: hardDelegateSignal,
    hard_delegate_reasons: asStringArray(metadata.hard_delegate_reasons),
    reason_codes: Array.from(new Set([
      ...asStringArray(priorRouteDecision.reason_codes),
      ...startupReasonCodes,
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
    required: executionControlAllowed || liveRoute !== "reply",
    source: executionControlAllowed ? "control_plane_status" : liveRoute === "reply" ? "none" : "policy_state",
  };
  nextDecision.latency_ack = {
    required: liveRoute === "reply",
    text: asString(asRecord(nextDecision.latency_ack).text) || "收到，处理中…",
  };
  nextDecision.tool_policy = {
    ...asRecord(nextDecision.tool_policy),
    must_delegate_via: !effectiveControlPlaneRefresh && liveRoute === "delegate" && tsPolicyDecision.admission.admission === "allow" ? "octoclaw_dispatch" : "",
    allow_direct_tools: liveRoute === "reply",
    delegate_first: !effectiveControlPlaneRefresh && liveRoute === "delegate" && tsPolicyDecision.admission.admission === "allow",
    allowed_control_tools: executionControlAllowed
      ? ["octoclaw_status", "octoclaw_task_action"]
      : liveRoute === "reply"
        ? []
      : ["octoclaw_dispatch", "octoclaw_dispatch_confirm", "octoclaw_status", "octoclaw_route_hint", "sessions_yield"],
    block_tool_patterns: executionControlAllowed ? ["octoclaw_dispatch", "spawn"] : asStringArray(asRecord(nextDecision.tool_policy).block_tool_patterns),
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
  nextDecision._decision_bucket = decisionBucket;
  nextDecision._startup_cost_policy = startupCostPolicy;
  nextDecision._duration_hint = startupDurationHint;
  nextDecision._tool_need_hint = startupToolNeedHint;
  nextDecision._hard_delegate_signal = hardDelegateSignal;
  nextDecision._hard_delegate_reasons = asStringArray(metadata.hard_delegate_reasons);
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
      const routeHintSource = asString(routeHint.source, "main_agent");
      const routeHintTrusted = asBoolean(routeHint.trusted) || TRUSTED_ROUTE_REQUEST_SOURCES.has(routeHintSource);
      const objectionRequestedRoute = normalizeLiveRoute(
        routeHint.requested_route,
        normalizedRouteHint,
      );
      const metadataIntentPacket = asRecord(metadata.intent_packet);
      const routeHintIntentPacket = asString(metadataIntentPacket.source)
        ? metadataIntentPacket
        : asRecord(buildConversationIntentPacket({ prompt }));
      const packetIntentClass = asString(routeHintIntentPacket.intent_class || routeHintIntentPacket.intentClass);
      const deterministicDelegateIntent = asString(routeHintIntentPacket.source) === "deterministic_live_lookup_classifier"
        && packetIntentClass === "fresh_live_lookup";
      if (deterministicDelegateIntent && !asString(metadataIntentPacket.source)) {
        metadata.intent_packet = routeHintIntentPacket;
      }
      const explicitObjection = routeHint.route_objection === true;

      metadata.route_hint = normalizedRouteHint;
      metadata.route_hint_source = routeHintSource;
      metadata.route_request_source = routeHintSource;
      metadata.route_request_trusted = routeHintTrusted;
      if (explicitObjection) {
        metadata.requested_route = objectionRequestedRoute;
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
  let judgeComplexityConfidence: number | undefined;
  let delegateReasonCodes: string[] = [];
  let deterministicFallbackApplied = false;
  let degradedFallbackApplied = false;
  let deterministicRuleApplied = false;
  let deterministicRuleReason: string | null = null;

  const judgeConfig = resolveJudgeConfig(asRecord(asRecord(options.metadata)._judgeFastConfig));
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
      const degradedDelegateJudge = isDegradedDelegateJudgeResult(judgeResult);
      const judgeLatencyMs = Date.now() - judgeStart;
      if (process.env.OCTOCLAW_JUDGE_DEBUG) {
        console.log(`[octoclaw-judge] judge done: ${judgeLatencyMs}ms result=${judgeResult ? `route=${judgeResult.route} conf=${judgeResult.confidence} ack="${judgeResult.ackText?.slice(0, 30)}"` : "null(timeout)"}`);
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
        final_judge_route: judgeResult?.route ?? null,
        final_judge_confidence: judgeResult?.confidence ?? null,
        judge_abstain: Boolean(judgeResult?.abstainReason),
        judge_ack_text: judgeAckText,
        rule_route: decision.route,
        judge_override: false,
        judge_mode: judgeConfig.shadowMode ? "shadow" : "active",
        judge_schema_degraded: degradedDelegateJudge,
        degraded_reasons: asStringArray(asRecord(judgeResult).degraded_reasons),
      };

      const actionableJudgeResult = isActionableJudgeResult(judgeResult, judgeConfig.minConfidence);
      if (judgeResult && !judgeResult.abstainReason) {
        metadata._judge_min_confidence = judgeConfig.minConfidence;
        metadata._judge_confidence = judgeResult.confidence;
        metadata._judge_route_confidence = coerceRouteConfidence(judgeResult.routeConfidence ?? judgeResult.confidence);
        const judgeDecisionBucket = coerceStartupDecisionBucket(judgeResult.decisionBucket ?? judgeResult.decision_bucket);
        if (judgeDecisionBucket) metadata._judge_decision_bucket = judgeDecisionBucket;
        if (judgeResult.scope) metadata._judge_scope = judgeResult.scope;
        if (typeof judgeResult.evidenceRequired === "boolean") metadata._judge_evidence_required = judgeResult.evidenceRequired;
        if (judgeResult.route === "reply" || actionableJudgeResult) metadata._judge_route_intent = judgeResult.route;
        metadata._judge_actionable_route = actionableJudgeResult;
        if (actionableJudgeResult && judgeResult.hardDelegateSignal === true) metadata._judge_hard_delegate_signal = true;
        judgeShadowLog.judge_decision_bucket_telemetry = judgeDecisionBucket || null;
      }

      // Deterministic hard-boundary fallback when judge timed out (null).
      // Degraded delegate still uses the judge's route; degradation only blocks
      // downstream dispatch authorization, not the route itself.
      if (judgeResult === null) {
        const conversationControl = trustedConversationControl(metadata);
        const intentClass = structuredIntentClass(metadata);
        const startupClassification = classifyStartupCost(prompt, metadata);
        applyStartupCostClassification(metadata, startupClassification);
        const timeoutExecutionLayer = asRecord(metadata.execution_layer ?? metadata._execution_coverage);
        const timeoutExecutionOverride = asBoolean(timeoutExecutionLayer.supports_provenance_reply)
          || asBoolean(timeoutExecutionLayer.supports_status_reply);
        const timeoutRequiresRefresh = asBoolean(timeoutExecutionLayer.requires_control_plane_refresh);
        const timeoutHardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(startupClassification.hardDelegateReasons);
        const timeoutIsFollowup = !(startupClassification.hardDelegateSignal && timeoutHardDelegateCanOverrideFollowup) && (
          asBoolean(conversationControl.provenance_followup)
          || asBoolean(conversationControl.status_followup)
          || intentClass === "execution_followup"
        );
        const isFollowupNoCoverage = timeoutIsFollowup
          && !timeoutExecutionOverride
          && !timeoutRequiresRefresh;
        if ((timeoutExecutionOverride || timeoutRequiresRefresh) && timeoutIsFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          metadata.execution_coverage_reply_override = timeoutExecutionOverride;
          deterministicFallbackApplied = !degradedDelegateJudge;
          degradedFallbackApplied = degradedDelegateJudge;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = `${degradedDelegateJudge ? "degraded" : "timeout"}_execution_coverage_override:${timeoutExecutionOverride ? "provenance/status_reply" : "control_plane_refresh"}`;
          judgeShadowLog.final_judge_route = "reply";
        } else if (isFollowupNoCoverage) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          deterministicFallbackApplied = !degradedDelegateJudge;
          degradedFallbackApplied = degradedDelegateJudge;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = `${degradedDelegateJudge ? "degraded" : "timeout"}_execution_followup_no_coverage→reply(no_verifiable_record)`;
          judgeShadowLog.final_judge_route = "reply";
        } else if (startupClassification.hardDelegateSignal) {
          // Deterministic hard-boundary: high-risk task must not default to reply
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          deterministicFallbackApplied = !degradedDelegateJudge;
          degradedFallbackApplied = degradedDelegateJudge;
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = `${degradedDelegateJudge ? "judge_degraded_fallback" : "deterministic_hard_boundary"}:${startupClassification.hardDelegateReasons.join("+")}`;
          judgeShadowLog.final_judge_route = "delegate";
        } else if (startupClassification.decisionBucket === "budgeted_main_then_delegate") {
          judgeShadowLog = judgeShadowLog ?? {};
          judgeShadowLog.fallback_reason = null;
          judgeShadowLog.final_judge_route = "reply";
          judgeShadowLog.startup_cost_fallback = "budgeted_main_then_delegate";
        }
      }

      if (actionableJudgeResult) {
        const routeStr = judgeResultToRouteOverride(judgeResult);
        if (routeStr) {
          judgeShadowLog.judge_override = decision.route !== routeStr;
          if (!judgeConfig.shadowMode) {
            judgeRouteOverride = routeStr;
            judgeSucceeded = true;
          }
        }
        judgeBudgetBand = judgeResult.budgetBand ?? null;
        judgeRole = undefined;
        judgeComplexityBand = coerceComplexityBand(judgeResult.complexity ?? judgeResult.complexityBand);
        judgeComplexityConfidence = coerceUnitConfidence(judgeResult.complexityConfidence ?? judgeResult.complexity_confidence);
        judgeExpectedDurationBand = coerceExpectedDurationBand(judgeResult.expectedDurationBand);
        judgeQualityBar = coerceQualityBar(judgeResult.qualityBar);
        judgeRiskFlags = asStringArray(judgeResult.riskFlags);
        judgeRouteConfidence = coerceRouteConfidence(judgeResult.routeConfidence ?? judgeResult.confidence);
        delegateReasonCodes = coerceDelegateReasonCodes(judgeResult.delegateReasonCodes);

        // ── Validator default rules (spec §11) ──
        // Legacy judge metadata is telemetry only; route correction stays deterministic.
        const validatorOverrideReasons: string[] = [];
        const conversationControl = trustedConversationControl(metadata);
        const intentClass = structuredIntentClass(metadata);
        const conversationRouteHint = asString(conversationControl.route_hint);
        const startupClassification = classifyStartupCost(prompt, metadata);
        applyStartupCostClassification(metadata, startupClassification);

        const executionCoverage = asRecord(metadata.execution_layer ?? metadata._execution_coverage);
        const executionCoverageOverride = asBoolean(executionCoverage.supports_provenance_reply)
          || asBoolean(executionCoverage.supports_status_reply);
        const requiresControlPlaneRefresh = asBoolean(executionCoverage.requires_control_plane_refresh);

        const isProvenanceOrStatusFollowup = asBoolean(conversationControl.provenance_followup)
          || asBoolean(conversationControl.status_followup);
        const hardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(startupClassification.hardDelegateReasons);
        const isExecutionOrStatusFollowup = !(startupClassification.hardDelegateSignal && hardDelegateCanOverrideFollowup)
          && (isProvenanceOrStatusFollowup || intentClass === "execution_followup");
        const delegateHintAgreesWithJudge = !isProvenanceOrStatusFollowup
          && judgeRouteOverride === "delegate"
          && asString(metadata.route_hint) === "delegate";

        let executionOverrideApplied = false;

        if (delegateHintAgreesWithJudge) {
          validatorOverrideReasons.push("validator:delegate_hint_and_judge_preserved");
        } else if (executionCoverageOverride && isExecutionOrStatusFollowup) {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          metadata.execution_coverage_reply_override = true;
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

        if (!executionOverrideApplied && intentClass === "plain_chat" && judgeRouteOverride === "delegate") {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          executionOverrideApplied = true;
          metadata.route_correction = {
            from: "delegate",
            to: "reply",
            source: "validator",
            reason: "plain_chat_pre_dispatch",
            dispatchExecuted: false,
            spawnExecuted: false,
          };
          validatorOverrideReasons.push("validator:plain_chat→reply(pre_dispatch_correction)");
        }

        if (!executionOverrideApplied && startupClassification.hardDelegateSignal && judgeRouteOverride === "reply") {
          judgeRouteOverride = "delegate";
          judgeSucceeded = true;
          validatorOverrideReasons.push(`validator:hard_delegate_signal→delegate(${startupClassification.hardDelegateReasons.join("+")})`);
        } else if (!executionOverrideApplied
          && judgeRouteOverride === "delegate"
          && startupClassification.decisionBucket !== "must_delegate") {
          judgeRouteOverride = "reply";
          judgeSucceeded = true;
          validatorOverrideReasons.push(`validator:startup_cost_${startupClassification.decisionBucket}→reply`);
        } else if (!executionOverrideApplied && conversationRouteHint === "delegate" && judgeRouteOverride === "reply") {
          validatorOverrideReasons.push("validator:conversation_control_route_hint_delegate_advisory_only");
        } else if (!executionOverrideApplied && intentClass === "fresh_live_lookup" && judgeRouteOverride === "reply") {
          validatorOverrideReasons.push("validator:fresh_live_lookup_budgeted_main_first");
        }
        // tool_need_hint==none && duration_hint==short → reply remains eligible (no override needed)

        if (validatorOverrideReasons.length > 0 && !judgeConfig.shadowMode) {
          judgeShadowLog.validator_override = true;
          judgeShadowLog.validator_override_reasons = validatorOverrideReasons;
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
  const startupClassification = classifyStartupCost(prompt, metadata);
  applyStartupCostClassification(metadata, startupClassification);

  if (finalDecision.route === "delegate") {
    metadata._taskflow_preflight_required = true;
  }

  const finalIntentClass = structuredIntentClass(metadata);
  const finalConversationControl = trustedConversationControl(metadata);
  const finalHardDelegateCanOverrideFollowup = hardDelegateReasonsAllowFollowupOverride(startupClassification.hardDelegateReasons);
  const finalIsExecutionOrStatusFollowup = !(startupClassification.hardDelegateSignal && finalHardDelegateCanOverrideFollowup) && (
    asBoolean(finalConversationControl.provenance_followup)
    || asBoolean(finalConversationControl.status_followup)
    || finalIntentClass === "execution_followup"
  );
  const deterministicNewWorkDelegate = finalDecision.route === "delegate"
    && !finalIsExecutionOrStatusFollowup
    && (
      finalIntentClass === "fresh_live_lookup"
      || finalIntentClass === "delegated_work"
      || asBoolean(finalConversationControl.require_fresh_lookup)
      || asBoolean(finalConversationControl.require_state_grounding)
      || startupClassification.hardDelegateSignal
    );
  const seededIsNewWork = deterministicNewWorkDelegate ? true : undefined;
  const seededExpectedDeliverable = deterministicNewWorkDelegate ? prompt.slice(0, 200) : null;

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
      route_source: degradedFallbackApplied ? "judge_degraded_fallback" : (deterministicFallbackApplied ? "fallback" : (deterministicRuleApplied ? "rule" : (judgeSucceeded ? "judge" : (judgeShadowLog?.fallback_reason ? "fallback" : "rule")))),
      judge_timeout: judgeShadowLog?.judge_timeout ?? false,
      fallback_reason: judgeShadowLog?.fallback_reason ?? null,
      final_judge_source: deterministicRuleApplied ? "policy_rule" : (degradedFallbackApplied ? "judge_degraded_fallback" : (deterministicFallbackApplied ? "timeout_fallback" : (judgeSucceeded ? "local" : (judgeShadowLog?.judge_timeout ? "timeout" : "no_judge")))),
      complexity_band: judgeComplexityBand,
      complexity_confidence: judgeComplexityConfidence,
      expected_duration_band: judgeExpectedDurationBand,
      quality_bar: judgeQualityBar,
      risk_flags: judgeRiskFlags,
      delegate_reason_codes: delegateReasonCodes,
      route_confidence: judgeRouteConfidence,
      is_new_work: seededIsNewWork,
      expected_deliverable: seededExpectedDeliverable,
      decision_bucket: startupClassification.decisionBucket,
      startup_cost_policy: startupClassification.startupCostPolicy,
      duration_hint: startupClassification.durationHint,
      tool_need_hint: startupClassification.toolNeedHint,
      hard_delegate_signal: startupClassification.hardDelegateSignal,
      hard_delegate_reasons: startupClassification.hardDelegateReasons,
      reason_codes: startupClassification.reasonCodes,
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
    _deterministic_rule_applied: deterministicRuleApplied,
    _deterministic_rule_reason: deterministicRuleReason,
    _judge_role: judgeRole,
    _judge_budget_band: judgeBudgetBand,
    _judge_complexity_band: judgeComplexityBand,
    _judge_complexity_confidence: judgeComplexityConfidence,
    _judge_expected_duration_band: judgeExpectedDurationBand,
    _judge_quality_bar: judgeQualityBar,
    _judge_risk_flags: judgeRiskFlags,
    _judge_route_confidence: judgeRouteConfidence,
    is_new_work: seededIsNewWork,
    expected_deliverable: seededExpectedDeliverable,
    _delegate_reason_codes: delegateReasonCodes,
    _decision_bucket: startupClassification.decisionBucket,
    _startup_cost_policy: startupClassification.startupCostPolicy,
    _duration_hint: startupClassification.durationHint,
    _tool_need_hint: startupClassification.toolNeedHint,
    _hard_delegate_signal: startupClassification.hardDelegateSignal,
    _hard_delegate_reasons: startupClassification.hardDelegateReasons,
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
): Promise<{ decision: UnknownRecord; stateKey: string; state: PolicyContextState; usedCachedPolicy?: boolean; resolveElapsedMs?: number } | null> {
  const resolveStartedAt = Date.now();
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
  if (process.env.OCTOCLAW_DELEGATION_ENABLED !== undefined && !metadata._delegationEnabled) {
    metadata._delegationEnabled = process.env.OCTOCLAW_DELEGATION_ENABLED !== "false";
  }

  if (existing?.decision && promptsEquivalent(asString(existing.prompt), prompt)) {
    const cached = { ...asRecord(existing.decision) };
    let cachedWorkContractId = asString(
      cached.workContractId
        || asRecord(cached.work_contract).workContractId
        || asRecord(cached.work_contract).work_contract_id
        || existing.workContractId,
    );
    let staleCachedWorkContractId = "";
    let workContractRematerialized = false;
    let workContractMaterializationError = "";
    if (cachedWorkContractId) {
      const storedContract = loadWorkContract(cachedWorkContractId);
      if (storedContract) {
        cached.workContractId = storedContract.workContractId;
        cached.work_contract_id = storedContract.workContractId;
        cached.work_contract = {
          ...asRecord(cached.work_contract),
          ...compactWorkContractView(storedContract),
          workContractId: storedContract.workContractId,
          work_contract_id: storedContract.workContractId,
        };
      } else {
        staleCachedWorkContractId = cachedWorkContractId;
        removeWorkContractFromPolicyDecision(cached, "work_contract_cache_missing", cachedWorkContractId);
        cachedWorkContractId = "";
      }
    }
    const routeSeal = stampRouteSealForPolicyState({
      prompt,
      stateKey,
      metadata,
      decision: cached,
      savedRouteSeal: savedRouteSeal(existing.routeSeal),
    });
    if (!asString(cached.workContractId || asRecord(cached.work_contract).workContractId || asRecord(cached.work_contract).work_contract_id)) {
      const attached = attachWorkContractToPolicyDecision({ stateKey, prompt, metadata, decision: cached, routeSeal });
      if (attached.ok) {
        cachedWorkContractId = attached.contract.workContractId;
        workContractRematerialized = Boolean(staleCachedWorkContractId);
      } else {
        workContractMaterializationError = attached.error;
      }
    }
    const nextCachedWorkContractId = asString(
      cached.workContractId
        || asRecord(cached.work_contract).workContractId
        || asRecord(cached.work_contract).work_contract_id
        || (staleCachedWorkContractId ? "" : existing.workContractId),
    );
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
      workContractId: nextCachedWorkContractId,
      workContractMaterializationError: workContractMaterializationError || undefined,
      routeSeal,
    });
    const resolveElapsedMs = Date.now() - resolveStartedAt;
    await recordPolicyReplay(
      "policy_resolve_cache_hit",
      {
        sessionKey: stateKey,
        sessionId: asString(ctx.sessionId),
        stateKey,
        route: asString(asRecord(cached.route_decision).route),
        decision_bucket: asString(asRecord(cached.route_decision).decision_bucket || asRecord(cached.route_decision).decisionBucket),
        workContractId: asString(cached.workContractId || asRecord(cached.work_contract).workContractId || asRecord(cached.work_contract).work_contract_id),
        staleWorkContractId: staleCachedWorkContractId,
        workContractRematerialized,
        workContractMaterializationError,
        usedCachedPolicy: true,
        elapsedMs: resolveElapsedMs,
      },
      logger,
      null,
    ).catch(() => undefined);
    if (staleCachedWorkContractId && workContractRematerialized) {
      await recordPolicyReplay(
        "work_contract_cache_rematerialized",
        {
          sessionKey: stateKey,
          sessionId: asString(ctx.sessionId),
          stateKey,
          staleWorkContractId: staleCachedWorkContractId,
          workContractId: asString(cached.workContractId),
          usedCachedPolicy: true,
          elapsedMs: resolveElapsedMs,
        },
        logger,
        cached,
      ).catch(() => undefined);
    } else if (workContractMaterializationError) {
      await recordPolicyReplay(
        "work_contract_materialization_failed",
        {
          sessionKey: stateKey,
          sessionId: asString(ctx.sessionId),
          stateKey,
          staleWorkContractId: staleCachedWorkContractId,
          route: asString(asRecord(cached.route_decision).route),
          error: workContractMaterializationError,
          usedCachedPolicy: true,
          elapsedMs: resolveElapsedMs,
        },
        logger,
        cached,
      ).catch(() => undefined);
    }
    return {
      decision: cached,
      stateKey,
      state: {
        ...existing,
        decision: cached,
        workContractId: nextCachedWorkContractId,
        workContractMaterializationError: workContractMaterializationError || undefined,
        routeSeal,
        updatedAt: Date.now(),
      },
      usedCachedPolicy: true,
      resolveElapsedMs,
    };
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

    // Build WorkContract from this policy decision. The decision may only
    // expose a dispatchable workContractId after the backing store write succeeds.
    const workContractAttach = attachWorkContractToPolicyDecision({ stateKey, prompt, metadata, decision, routeSeal });
    if (workContractAttach.ok) {
      nextState.workContractId = workContractAttach.contract.workContractId;
      nextState.latestStatus = "sealed";
    } else {
      nextState.workContractId = "";
      nextState.workContractMaterializationError = workContractAttach.error;
    }

    const resolveElapsedMs = Date.now() - resolveStartedAt;
    await recordPolicyReplay(
      "policy_resolved",
      buildPolicyResolvedReplayPayload({
        decision,
        ...buildPolicyResolvedExecutionTelemetry(decision),
        workContractId: decision.workContractId,
        workContractRoute: asRecord(decision.work_contract).route,
        decisionSource: asRecord(decision.work_contract).decisionSource,
        delegationTicketCandidate: decision.delegation_ticket_candidate,
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
        resolveElapsedMs,
      }),
      logger,
      decision,
    );
    if (!workContractAttach.ok) {
      await recordPolicyReplay(
        "work_contract_materialization_failed",
        {
          sessionKey: stateKey,
          sessionId: asString(ctx.sessionId),
          stateKey,
          route: asString(asRecord(decision.route_decision).route),
          error: workContractAttach.error,
          usedCachedPolicy: false,
          resolveElapsedMs,
        },
        logger,
        decision,
      ).catch(() => undefined);
    }
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
    // Router-lite shadow emission: compare actual vs recommended model.
    // Fail-open: any error here must not affect the live policy return.
    try {
      emitRouterLiteShadowEvent({
        sessionKey: stateKey,
        turnId: `turn-${stateKey}-${Date.now()}`,
        decision,
        metadata,
        logger,
      });
    } catch { /* shadow must never block live path */ }

    return { decision, stateKey, state: nextState, usedCachedPolicy: false, resolveElapsedMs };
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
