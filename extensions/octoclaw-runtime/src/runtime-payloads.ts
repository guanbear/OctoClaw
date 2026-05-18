import type { CoordinationMode, DelegateAttempt, DelegateTask, NativeTaskBinding } from "@octoclaw/contracts/delegate";
import type { ScopeDescriptor, ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { DelegateHandoffPacket } from "@octoclaw/contracts/delegate-context";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { evaluateAdmission, type AdmissionDecision } from "@octoclaw/policy/admission";
import type { PolicyRole } from "@octoclaw/policy/roles";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import { isObserveMode } from "./resolve/route-helpers.js";
import { buildDelegateHandoffPacket } from "./context/delegate-packets.js";
import { invokeNativeHelper, type NativeHelperInvoker } from "./adapter/native-helper.js";
import { asRecord, type UnknownRecord } from "./util/type-coercion.js";

interface RuntimePayloadHelpers {
  runtimeRouteDecision: (decision?: UnknownRecord) => UnknownRecord;
  normalizeLiveRoute: (route: unknown, fallback?: string) => string;
  runtimeExecutionIds: (task: unknown, decision?: UnknownRecord, metadata?: UnknownRecord) => {
    requestId: string;
    taskId: string;
    flowId: string;
  };
  buildWorkflowDecision: (task: unknown, decision?: UnknownRecord, metadata?: UnknownRecord) => PolicyDecision;
  buildWorkflowScope: (metadata?: UnknownRecord) => ScopeMetadata;
  truncateText: (value: unknown, maxLength?: number) => string;
}

interface DispatchPayloadInput {
  task: unknown;
  command?: string;
  cwd?: string;
  decision?: UnknownRecord;
  metadata?: UnknownRecord;
  timeoutSeconds?: number;
  helperInvoker?: NativeHelperInvoker | null;
}

interface SpawnPayloadInput {
  task: unknown;
  route?: string;
  decision?: UnknownRecord;
  metadata?: UnknownRecord;
  helperInvoker?: NativeHelperInvoker | null;
  execute?: boolean;
}

function readString(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

interface FastReplyTiming {
  routeDecisionStartedAt: number;
  ackSentAt?: number;
  replyCompletedAt?: number;
}

interface FastReplyMetrics {
  ack_ms?: number;
  total_latency_ms?: number;
}

interface DirectReplyContextPacket {
  userText: string;
  sessionSummary?: string;
  route?: string;
  requestKind?: string;
  directToolsSeen: string[];
}

interface ConflictDecision {
  workspaceMode: ScopeMetadata["workspaceMode"];
  hasOverlappingWrites: boolean;
  policy: "allow" | "serialize" | "queue";
  reason: string;
}

interface DelegationProfile {
  id: PolicyRole;
  label: string;
  defaultObjective: string;
  modelProfile: "worker_research" | "worker_code_normal" | "worker_review";
  allowedTools: string[];
  outputContract: "worker_result" | "review_result";
}

interface WorkerBriefTemplate {
  goal: string;
  constraints: string[];
  expectedOutput: string;
  relevantArtifactRefs: string[];
  runtimeLimits: {
    maxDurationMs?: number;
    maxTokens?: number;
  };
  deliveryContract: string;
  role?: PolicyRole;
  doneDefinition: string[];
  modelProfile?: string;
  allowedTools: string[];
  outputContract: string;
  objective?: string;
}

interface DelegatedMaterialization {
  requestId: string;
  taskId: string;
  flowId: string;
  delegateTaskId?: string;
  attemptId?: string;
  attemptGeneration?: number;
  role: PolicyRole;
  requestIdempotencyKey: string;
  deliveryId: string;
  deliveryReceiptId: string;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: ScopeMetadata["workspaceMode"];
  writeScopeSummary: string;
  backend: "openclaw-native" | "clawteam";
  modelProfile: string;
  allowedTools: string[];
  outputContract: string;
  admission: AdmissionDecision;
  conflict: ConflictDecision;
  brief: WorkerBriefTemplate;
}

const DELEGATION_PROFILES: Record<"worker_research" | "worker_code" | "worker_review", DelegationProfile> = {
  worker_research: {
    id: "worker_research",
    label: "Research worker",
    defaultObjective: "Gather evidence, summarize options, and avoid write actions beyond declared scope.",
    modelProfile: "worker_research",
    allowedTools: ["search", "read", "webfetch"],
    outputContract: "worker_result",
  },
  worker_code: {
    id: "worker_code",
    label: "Code worker",
    defaultObjective: "Implement targeted changes within declared write scope and report verification results.",
    modelProfile: "worker_code_normal",
    allowedTools: ["read", "edit", "write", "bash", "lsp"],
    outputContract: "worker_result",
  },
  worker_review: {
    id: "worker_review",
    label: "Review worker",
    defaultObjective: "Inspect artifacts, identify risks, and keep the workspace read-only unless explicitly granted write scope.",
    modelProfile: "worker_review",
    allowedTools: ["read", "grep", "lsp"],
    outputContract: "review_result",
  },
};

function computeFastReplyMetrics(timing: FastReplyTiming): FastReplyMetrics {
  const result: FastReplyMetrics = {};
  if (typeof timing.ackSentAt === "number") {
    result.ack_ms = Math.max(0, timing.ackSentAt - timing.routeDecisionStartedAt);
  }
  if (typeof timing.replyCompletedAt === "number") {
    result.total_latency_ms = Math.max(0, timing.replyCompletedAt - timing.routeDecisionStartedAt);
  }
  return result;
}

function buildFastReplyAck(
  mode: "pre_dispatch" | "latency",
  decision: { required: boolean; text: string } | undefined,
  timing: FastReplyTiming,
) {
  const text = readString(decision?.text);
  return {
    mode,
    required: Boolean(decision?.required) && Boolean(text),
    text,
    metrics: computeFastReplyMetrics(timing),
  };
}

function buildDirectReplyContext(input: {
  userText: string;
  sessionSummary?: string;
  route?: string;
  requestKind?: string;
  directToolsSeen?: string[];
}): DirectReplyContextPacket {
  return {
    userText: readString(input.userText),
    sessionSummary: readString(input.sessionSummary) || undefined,
    route: readString(input.route) || undefined,
    requestKind: readString(input.requestKind) || undefined,
    directToolsSeen: Array.isArray(input.directToolsSeen)
      ? input.directToolsSeen.map((item) => readString(item)).filter(Boolean)
      : [],
  };
}

function buildDirectReply(
  context: DirectReplyContextPacket,
  replyText: string,
  timing: FastReplyTiming,
) {
  const normalizedReply = readString(replyText);
  if (!normalizedReply) {
    throw new Error("direct_reply_text_missing");
  }
  const summaryPrefix = context.requestKind ? `[${context.requestKind}] ` : "";
  return {
    replyText: normalizedReply,
    handoff: {
      kind: "reply" as const,
      user_safe: true as const,
      reply_text: normalizedReply,
      summary: `${summaryPrefix}${normalizedReply}`.trim(),
    },
    metrics: computeFastReplyMetrics(timing),
  };
}

function resolveDelegationProfile(role: PolicyRole): DelegationProfile {
  if (role === "worker_research" || role === "worker_code" || role === "worker_review") {
    return DELEGATION_PROFILES[role];
  }
  throw new Error(`unsupported_delegation_role:${role}`);
}

function decideConflictPolicy(workspaceMode: ScopeMetadata["workspaceMode"], hasOverlappingWrites: boolean): ConflictDecision {
  if (workspaceMode === "shared_workspace" && hasOverlappingWrites) {
    return {
      workspaceMode,
      hasOverlappingWrites,
      policy: "serialize",
      reason: "shared_workspace writes serialize by default to avoid concurrent mutation conflicts",
    };
  }
  if (workspaceMode === "shared_workspace") {
    return {
      workspaceMode,
      hasOverlappingWrites,
      policy: "queue",
      reason: "shared_workspace work remains queue-aware even without direct overlap",
    };
  }
  return {
    workspaceMode,
    hasOverlappingWrites,
    policy: "allow",
    reason: "isolated or read-only workspace can proceed without serialization",
  };
}

function buildWorkerBrief(role: PolicyRole, goal: string): WorkerBriefTemplate {
  const profile = resolveDelegationProfile(role);
  return {
    goal,
    constraints: [
      "Respect runtime-managed claim ownership and keep the assigned claim token authoritative for the delegated task.",
      "Preserve the delegated delivery receipt chain so downstream execution stays auditable.",
      "Do not exceed declared workspace scope.",
    ],
    expectedOutput: profile.outputContract,
    relevantArtifactRefs: [],
    runtimeLimits: {},
    deliveryContract: profile.outputContract,
    role,
    doneDefinition: [
      "Return a concise worker result.",
      "Report completion with the delegated delivery receipt and ownership context intact.",
      "Attach artifacts instead of mutating undeclared workspace paths.",
    ],
    modelProfile: profile.modelProfile,
    allowedTools: profile.allowedTools,
    outputContract: profile.outputContract,
    objective: goal,
  };
}

function materializeDelegatedWork(input: {
  requestId: string;
  taskId: string;
  flowId: string;
  delegateTaskId?: string;
  attemptId?: string;
  attemptGeneration?: number;
  role: PolicyRole;
  goal: string;
  requestIdempotencyKey: string;
  deliveryId: string;
  deliveryReceiptId: string;
  claimOwner: string;
  leaseDurationMs: number;
  queueBudget: number;
  inflightCount: number;
  capabilitySatisfied: boolean;
  writeConflict: boolean;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: ScopeMetadata["workspaceMode"];
}): DelegatedMaterialization {
  const now = new Date();
  const claimToken = `${input.taskId}:${input.claimOwner}:${now.getTime()}`;
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
  const profile = resolveDelegationProfile(input.role);
  const conflict = decideConflictPolicy(input.workspaceMode, input.writeConflict);
  const admission = evaluateAdmission({
    route: "delegate",
    queueBudget: input.queueBudget,
    inflightCount: input.inflightCount,
    capabilitySatisfied: input.capabilitySatisfied,
    workspaceMode: input.workspaceMode,
    writeConflict: input.writeConflict,
  });

  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    delegateTaskId: input.delegateTaskId,
    attemptId: input.attemptId,
    attemptGeneration: input.attemptGeneration,
    role: input.role,
    requestIdempotencyKey: input.requestIdempotencyKey,
    deliveryId: input.deliveryId,
    deliveryReceiptId: input.deliveryReceiptId,
    claimOwner: input.claimOwner,
    claimToken,
    leaseExpiresAt,
    readScope: input.readScope,
    writeScope: input.writeScope,
    workspaceMode: input.workspaceMode,
    writeScopeSummary: input.writeScope.map((scope) => scope.resource).join(", ") || "read_only",
    backend: "openclaw-native",
    modelProfile: profile.modelProfile,
    allowedTools: profile.allowedTools,
    outputContract: profile.outputContract,
    admission,
    conflict,
    brief: buildWorkerBrief(input.role, input.goal),
  };
}

function normalizeScopeMetadata(scope: ScopeMetadata): ScopeMetadata {
  return {
    readScope: Array.isArray(scope.readScope) ? scope.readScope.filter(isScopeDescriptor) : [],
    writeScope: Array.isArray(scope.writeScope) ? scope.writeScope.filter(isScopeDescriptor) : [],
    workspaceMode: scope.workspaceMode,
    writeScopeSummary: scope.writeScopeSummary,
  };
}

function isScopeDescriptor(value: unknown): value is ScopeDescriptor {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as ScopeDescriptor).resource === "string"
    && typeof (value as ScopeDescriptor).access === "string",
  );
}

function resolveDelegateCoordinationMode(decision: PolicyDecision): CoordinationMode {
  switch (decision.coordinationMode) {
    case "solo_worker":
      return "solo_worker";
    case "advisor_assisted":
      return "advisor_assisted";
    default:
      return "multi_agent_controlled";
  }
}

function scopeResources(scope: ScopeDescriptor[]): string[] {
  return scope.map((item) => item.resource).filter(Boolean);
}

function handoffWorkspaceMode(mode: ScopeMetadata["workspaceMode"]): DelegateHandoffPacket["workspaceMode"] {
  return mode === "read_only" ? "read_only" : "write_allowed";
}

function handoffRole(role: string): DelegateHandoffPacket["role"] {
  if (role.includes("observer")) return "observer";
  if (role.includes("code")) return "code";
  if (role.includes("research")) return "research";
  if (role.includes("review")) return "review";
  return "default";
}

function canonicalizePolicyDecision(decision: UnknownRecord, route: string): UnknownRecord {
  const nextDecision = { ...decision };
  const routeDecision = asRecord(decision.route_decision);
  const role = readString(routeDecision.role, readString(nextDecision.role));
  const executionProfile = readString(routeDecision.execution_profile, readString(nextDecision.executionProfile));
  const observe = isObserveMode(role, executionProfile);
  nextDecision.route_decision = {
    ...routeDecision,
    route,
    system_preferred_route: readString(routeDecision.system_preferred_route, route),
    task_class: observe ? "control_observer" : route === "delegate" ? "delegated_single" : readString(routeDecision.task_class, "main_direct"),
    protected_lane: observe ? "control_observer" : readString(routeDecision.protected_lane),
    dispatch_required: route !== "reply" && routeDecision.dispatch_required !== false,
  };
  return nextDecision;
}

function nativeInvoker(input?: NativeHelperInvoker | null): NativeHelperInvoker {
  return input ?? invokeNativeHelper;
}

function workflowRecord(input: {
  requestId: string;
  taskId: string;
  flowId: string;
  route: string;
  decision: PolicyDecision;
  scope: ScopeMetadata;
  claimOwner: string;
  phase?: string;
}): UnknownRecord {
  return {
    identity: {
      requestId: input.requestId,
      taskId: input.taskId,
      flowId: input.flowId,
      route: input.route,
      authority: "runtime_orchestrator",
      backend: "openclaw-native",
      materializationIntent: input.route === "delegate" ? "spawn_single" : "reply_direct",
    },
    execution: {
      role: input.decision.role,
      modelProfile: input.decision.modelProfile,
      admission: input.decision.admission,
    },
    claim: {
      claimOwner: input.claimOwner,
      leaseDurationMs: 30_000,
    },
    scope: input.scope,
    workflowOrchestration: input.phase ?? "materialization_pending",
    lifecycle: {
      phase: input.phase ?? "materialization_pending",
      deliveryState: "not_started",
      checkpointState: "none",
    },
    taskMaterialization: {
      route: input.route,
      authority: "runtime_orchestrator",
      backend: "openclaw-native",
      materializationIntent: input.route === "delegate" ? "spawn_single" : "reply_direct",
      claimOwner: input.claimOwner,
    },
    reconcileOrRecovery: "native_host_authoritative",
  };
}

function nativeTruthPayload(input: {
  sessionKey: string;
  requestId: string;
  flowId: string;
  taskId: string;
  status: string;
  revision: number;
  claimOwner: string;
  scope: ScopeMetadata;
}): UnknownRecord {
  return {
    ...buildContractEnvelope("truth", new Date().toISOString()),
    kind: "truth",
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    flowId: input.flowId,
    taskId: input.taskId,
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: input.status,
    substrateRevision: input.revision,
    managedDisposition: "managed",
    ownership: {
      claimOwner: input.claimOwner,
      claimToken: "",
      controllerId: input.claimOwner,
    },
    scope: {
      workspaceMode: input.scope.workspaceMode,
      readScopeCount: input.scope.readScope?.length ?? 0,
      writeScopeCount: input.scope.writeScope?.length ?? 0,
      writeScopeSummary: input.scope.writeScopeSummary || "",
    },
  };
}

function projectionPayload(input: {
  flowId: string;
  taskId: string;
  status: string;
  revision: number;
  scope: ScopeMetadata;
}): UnknownRecord {
  return {
    ...buildContractEnvelope("projection", new Date().toISOString()),
    kind: "projection",
    status: input.status,
    runtime: "openclaw-native",
    flowId: input.flowId,
    taskId: input.taskId,
    substrateState: input.status,
    substrateRevision: input.revision,
    workspaceMode: input.scope.workspaceMode,
  };
}

function buildDelegateTask(input: {
  sessionKey: string;
  role: string;
  coordinationMode: CoordinationMode;
  goal: string;
  scope: ScopeMetadata;
  delegateTaskId?: string;
  attemptId?: string;
}): DelegateTask {
  const now = new Date().toISOString();
  const delegateTaskId = input.delegateTaskId || `delegate-task:${input.sessionKey}:${Date.now()}`;
  return {
    ...buildContractEnvelope("projection", now),
    kind: "projection",
    delegateTaskId,
    sessionId: input.sessionKey,
    route: "delegate",
    role: input.role,
    coordinationMode: input.coordinationMode,
    goal: input.goal,
    status: "active",
    currentAttemptId: input.attemptId || `${delegateTaskId}:attempt:1`,
    totalAttempts: 1,
    createdAt: now,
    updatedAt: now,
    readScope: input.scope.readScope,
    writeScope: input.scope.writeScope,
    workspaceMode: input.scope.workspaceMode,
    writeScopeSummary: input.scope.writeScopeSummary,
  };
}

function buildDelegateAttempt(input: {
  delegateTaskId: string;
  attemptId?: string;
  nativeBinding: NativeTaskBinding;
  decision: PolicyDecision;
  scope: ScopeMetadata;
  claimOwner: string;
}): DelegateAttempt {
  const now = new Date().toISOString();
  return {
    ...buildContractEnvelope("truth", now),
    kind: "truth",
    attemptId: input.attemptId || `${input.delegateTaskId}:attempt:1`,
    delegateTaskId: input.delegateTaskId,
    attemptGeneration: 1,
    nativeBinding: input.nativeBinding,
    status: "running",
    claimOwner: input.claimOwner,
    modelProfile: input.decision.modelProfile,
    backend: input.decision.backend,
    workspaceMode: input.scope.workspaceMode,
    queuedAt: now,
    startedAt: now,
  };
}

function threadBindingKey(sessionKey: string, delegateTaskId: string): string {
  return `${sessionKey}:${delegateTaskId}`;
}

function buildTelemetry(route: string, requestId: string, taskId: string, flowId: string): UnknownRecord {
  return {
    route,
    requestId,
    taskId,
    flowId,
    runtime: "openclaw-native",
    authority: "native_taskflow",
  };
}

export function buildTsRuntimeDispatchPayload(
  input: DispatchPayloadInput,
  helpers: RuntimePayloadHelpers,
) {
  const decision = asRecord(input.decision);
  const metadata = asRecord(input.metadata);
  const routeDecision = helpers.runtimeRouteDecision(decision);
  const route = helpers.normalizeLiveRoute(metadata.requested_route ?? routeDecision.route, "reply");
  if (!["reply", "delegate"].includes(route)) throw new Error(`unsupported_runtime_route:${route}`);

  const canonicalDecision = canonicalizePolicyDecision(decision, route);
  const workflowDecision = helpers.buildWorkflowDecision(input.task, canonicalDecision, metadata);
  if (workflowDecision.admission?.admission === "reject") {
    throw new Error(`dispatch_blocked:${workflowDecision.admission?.reason || "admission_denied"}`);
  }

  const executionIds = helpers.runtimeExecutionIds(input.task, decision, metadata);
  const scope = normalizeScopeMetadata(helpers.buildWorkflowScope(metadata));
  const sessionKey = readString(metadata.session_key ?? metadata.sessionKey, executionIds.requestId);
  const claimOwner = readString(metadata.claimOwner ?? metadata.claim_owner ?? metadata.controllerId ?? metadata.controller_id, "octoclaw-runtime");
  const modelPolicy = asRecord(decision.model_policy);
  const workflow = workflowRecord({ ...executionIds, route, decision: workflowDecision, scope, claimOwner });
  const basePayload = {
    route,
    system_preferred_route: route,
    worker_pool: readString(routeDecision.worker_pool ?? modelPolicy.worker_pool, "octoclaw-worker"),
    model: readString(modelPolicy.selected_model ?? modelPolicy.profile ?? workflowDecision.modelProfile),
    policy_decision: canonicalDecision,
    task_id: executionIds.taskId,
    flow_id: executionIds.flowId,
    runtime_truth: { authority: "native_taskflow", workflow },
    orchestration: { authority: "native_taskflow", route, lifecycle: asRecord(workflow.lifecycle) },
    telemetry: buildTelemetry(route, executionIds.requestId, executionIds.taskId, executionIds.flowId),
  };

  if (route === "reply") {
    const routeDecisionStartedAt = Date.now();
    const directContext = buildDirectReplyContext({
      userText: readString(input.task),
      sessionSummary: readString(metadata.sessionSummary ?? metadata.session_summary),
      route,
      requestKind: readString(metadata.requestKind ?? metadata.request_kind),
      directToolsSeen: Array.isArray(metadata.directToolsSeen) ? metadata.directToolsSeen as string[] : [],
    });
    const ackPayload = buildFastReplyAck("latency", {
      required: Boolean(metadata.latency_ack_required ?? metadata.latencyAckRequired),
      text: readString(metadata.latency_ack_text ?? metadata.latencyAckText),
    }, { routeDecisionStartedAt });
    const directReply = buildDirectReply(
      directContext,
      `Direct route selected; keep execution in the main session for: ${helpers.truncateText(input.task, 80)}`,
      { routeDecisionStartedAt, replyCompletedAt: Date.now() },
    );
    const replyWorkflow = workflowRecord({ ...executionIds, route, decision: workflowDecision, scope, claimOwner, phase: "completed" });
    return {
      ...basePayload,
      executed: true,
      status: "materialized",
      summary: `OctoClaw reply decision materialized (${workflowDecision.role})`,
      handoff: directReply.handoff,
      materialization: { authority: "native_taskflow", type: "direct_response", task_id: executionIds.taskId, flow_id: executionIds.flowId },
      fast_reply: { context: directContext, ack: ackPayload, direct: directReply },
      runtime_truth: { authority: "native_taskflow", workflow: replyWorkflow },
      telemetry: buildTelemetry(route, executionIds.requestId, executionIds.taskId, executionIds.flowId),
    };
  }

  const invoker = nativeInvoker(input.helperInvoker ?? (metadata.helperInvoker as NativeHelperInvoker | undefined));
  let managed;
  let run;
  try {
    managed = invoker({
      action: "create-managed-flow",
      args: {
        session_key: sessionKey,
        controller_id: claimOwner,
        goal: readString(input.task),
        notify_policy: "silent",
        state_json: JSON.stringify({ requestId: executionIds.requestId, taskId: executionIds.taskId, flowId: executionIds.flowId, route }),
      },
    });
    run = invoker({
      action: "run-task",
      args: {
        session_key: sessionKey,
        flow_id: managed.flow.flowId,
        task: readString(input.task),
        status: "running",
        notify_policy: "silent",
        progress_summary: "running",
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const wrappedMessage = `ts_runtime_materialization_failed:${errorMessage}`;
    const failurePayload = {
      ...basePayload,
      executed: false,
      status: "materialization_failed",
      error: wrappedMessage,
      materialization: {
        authority: "native_taskflow",
        type: "delegate",
        task_id: executionIds.taskId,
        flow_id: executionIds.flowId,
        runtime: "openclaw-native",
        failure_reason: wrappedMessage,
      },
      telemetry: {
        ...buildTelemetry(route, executionIds.requestId, executionIds.taskId, executionIds.flowId),
        materialization_failed: true,
      },
    };
    throw Object.assign(new Error(wrappedMessage), { payload: failurePayload });
  }
  const delegateTaskId = readString(metadata.delegateTaskId ?? metadata.delegate_task_id, `delegate-task:${sessionKey}:${Date.now()}`);
  const attemptId = readString(metadata.attemptId ?? metadata.attempt_id, `${delegateTaskId}:attempt:1`);
  const nativeBinding: NativeTaskBinding = {
    delegateTaskId,
    attemptId,
    nativeFlowId: run.flow_id,
    nativeTaskId: run.task.taskId,
    claimOwner,
    resumeGeneration: 0,
    boundAt: new Date().toISOString(),
  };
  const delegateTask = buildDelegateTask({
    sessionKey,
    role: workflowDecision.role,
    coordinationMode: resolveDelegateCoordinationMode(workflowDecision),
    goal: readString(input.task),
    scope,
    delegateTaskId,
    attemptId,
  });
  const delegateAttempt = buildDelegateAttempt({ delegateTaskId, attemptId, nativeBinding, decision: workflowDecision, scope, claimOwner });
  const handoffPacket = buildDelegateHandoffPacket({
    delegateTaskId,
    attemptId,
    threadBindingKey: threadBindingKey(sessionKey, delegateTaskId),
    currentUserAsk: readString(input.task),
    taskBrief: readString(input.task),
    acceptanceCriteria: [],
    readScope: scopeResources(scope.readScope),
    writeScope: scopeResources(scope.writeScope),
    workspaceMode: handoffWorkspaceMode(scope.workspaceMode),
    role: handoffRole(workflowDecision.role),
    modelProfile: workflowDecision.modelProfile,
    maxInputTokens: 1800,
    maxSummaryTokens: 500,
    artifactRefs: [],
    forbiddenContent: [],
  });
  const delegatedMaterialization = materializeDelegatedWork({
    requestId: executionIds.requestId,
    taskId: executionIds.taskId,
    flowId: executionIds.flowId,
    role: workflowDecision.role,
    goal: readString(input.task),
    requestIdempotencyKey: readString(metadata.idempotencyKey ?? metadata.idempotency_key, executionIds.requestId),
    deliveryId: `delivery:${executionIds.flowId}:${executionIds.taskId}`,
    deliveryReceiptId: `receipt:${executionIds.flowId}:${executionIds.taskId}`,
    claimOwner,
    leaseDurationMs: readNumber(metadata.leaseDurationMs ?? metadata.lease_duration_ms, 30_000),
    queueBudget: workflowDecision.admission.queueBudget,
    inflightCount: Number(metadata.inflightCount ?? metadata.inflight_count ?? 0),
    capabilitySatisfied: workflowDecision.admission.reason !== "capability_guard_failed",
    writeConflict: Boolean(metadata.writeConflict ?? metadata.write_conflict),
    readScope: scope.readScope,
    writeScope: scope.writeScope,
    workspaceMode: scope.workspaceMode,
  });
  const truth = nativeTruthPayload({
    sessionKey,
    requestId: executionIds.requestId,
    flowId: run.flow_id,
    taskId: run.task.taskId,
    status: run.task.state || run.task.status,
    revision: run.task.revision,
    claimOwner,
    scope,
  });
  const projection = projectionPayload({
    flowId: run.flow_id,
    taskId: run.task.taskId,
    status: run.task.state || run.task.status,
    revision: run.task.revision,
    scope,
  });

  return {
    ...basePayload,
    executed: true,
    status: "materialized",
    task_id: run.task.taskId,
    flow_id: run.flow_id,
    summary: `OctoClaw delegate registered: ${run.task.taskId}`,
    delegateTaskId,
    attemptId,
    handoff: {
      kind: "spawn",
      summary: `Delegated task materialized natively as ${run.task.taskId}`,
      user_safe: true,
      reply_text: `Delegated task registered natively: ${run.task.taskId}`,
    },
    materialization: {
      authority: "native_taskflow",
      type: "delegate",
      task_id: run.task.taskId,
      flow_id: run.flow_id,
      delegateTaskId,
      attemptId,
      attemptGeneration: 1,
      runtime: "openclaw-native",
      sync_mode: "managed",
      substrate_state: run.task.state || run.task.status,
      substrate_revision: run.task.revision,
      truth,
      projection,
      delegation: { ...delegatedMaterialization, delegateTaskId, attemptId, attemptGeneration: 1, handoff: handoffPacket },
    },
    runtime_truth: {
      authority: "native_taskflow",
      workflow,
      binding: {
        taskId: run.task.taskId,
        flowId: run.flow_id,
        status: run.task.state || run.task.status,
        runtime: "openclaw-native",
        syncMode: "managed",
        substrateState: run.task.state || run.task.status,
        substrateRevision: run.task.revision,
        truth,
        projection,
        runId: run.task.runId,
        childRunId: run.task.childRunId,
        childSessionKey: run.task.childSessionKey,
        childSessionId: run.task.childSessionId,
      },
      delegateTask,
      delegateAttempt,
      nativeTaskBinding: nativeBinding,
    },
    telemetry: buildTelemetry(route, executionIds.requestId, run.task.taskId, run.flow_id),
  };
}

export function buildTsRuntimeSpawnPayload(
  input: SpawnPayloadInput,
  helpers: RuntimePayloadHelpers,
) {
  return buildTsRuntimeDispatchPayload({
    ...input,
    metadata: {
      ...asRecord(input.metadata),
      requested_route: "delegate",
      requiresDelegation: true,
    },
  }, helpers);
}
