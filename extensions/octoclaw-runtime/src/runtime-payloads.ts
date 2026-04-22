import {
  advanceWorkflowToRunning,
  buildWorkflowFinalDelivery,
  buildWorkflowProgressDelivery,
  emitWorkflowTelemetry,
  enqueueWorkflowDelivery,
  markWorkflowCheckpointEmitted,
  markWorkflowCompleted,
  markWorkflowFailed,
  renewWorkflowHeartbeat,
  startRuntimeWorkflow,
} from "@octoclaw/runtime-core/workflow";
import {
  createDelegateTask,
  startDelegateAttempt,
} from "@octoclaw/runtime-core/delegate";
import { normalizeRuntimeRequest } from "@octoclaw/runtime-core/requests";
import type { CoordinationMode as DelegateCoordinationMode } from "@octoclaw/contracts/delegate";
import type { ScopeDescriptor, ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { createOctoClawRuntimePlugin } from "./plugin.js";
import type { NativeHelperInvoker } from "./adapter/native-helper.js";
import { buildCompoundDelegationPlaceholder, materializeDelegatedWork } from "@octoclaw/delegation";
import { buildFastReplyAck, buildDirectReply, buildDirectReplyContext } from "@octoclaw/fast-reply";
import { isObserveMode } from "./resolve/route-helpers.js";

type UnknownRecord = Record<string, unknown>;

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

function isScopeDescriptor(value: unknown): value is ScopeDescriptor {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as ScopeDescriptor).resource === "string"
    && typeof (value as ScopeDescriptor).access === "string",
  );
}

function normalizeScopeMetadata(scope: ScopeMetadata): ScopeMetadata {
  return {
    readScope: Array.isArray(scope.readScope) ? scope.readScope.filter(isScopeDescriptor) : [],
    writeScope: Array.isArray(scope.writeScope) ? scope.writeScope.filter(isScopeDescriptor) : [],
    workspaceMode: scope.workspaceMode,
    writeScopeSummary: scope.writeScopeSummary,
  };
}

function buildPluginOptions(helperInvoker?: NativeHelperInvoker | null) {
  return helperInvoker ? { helperInvoker } : {};
}

function readHelperInvoker(value: unknown): NativeHelperInvoker | null {
  return typeof value === "function" ? (value as NativeHelperInvoker) : null;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function readString(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function resolveDelegateCoordinationMode(decision: PolicyDecision): DelegateCoordinationMode {
  switch (decision.coordinationMode) {
    case "solo_worker":
      return "solo_worker";
    case "advisor_assisted":
      return "advisor_assisted";
    default:
      return "multi_agent_controlled";
  }
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
    task_class: observe
      ? "control_observer"
      : route === "delegate"
        ? "delegated_single"
        : readString(routeDecision.task_class, "main_direct"),
    protected_lane: observe ? "control_observer" : readString(routeDecision.protected_lane),
    dispatch_required: route !== "reply" && routeDecision.dispatch_required !== false,
  };
  return nextDecision;
}

export function buildTsRuntimeDispatchPayload(
  input: DispatchPayloadInput,
  helpers: RuntimePayloadHelpers,
) {
  const decision = asRecord(input.decision);
  const metadata = asRecord(input.metadata);
  const routeDecision = helpers.runtimeRouteDecision(decision);
  const route = helpers.normalizeLiveRoute(metadata.requested_route ?? routeDecision.route, "reply");
  if (!["reply", "delegate"].includes(route)) {
    throw new Error(`unsupported_runtime_route:${route}`);
  }

  const canonicalDecision = canonicalizePolicyDecision(decision, route);
  const nativeHelperInvoker = input.helperInvoker ?? readHelperInvoker(metadata.helperInvoker);
  const workflowDecision = helpers.buildWorkflowDecision(input.task, canonicalDecision, metadata);
  if (workflowDecision.admission?.admission === "reject") {
    throw new Error(`dispatch_blocked:${workflowDecision.admission?.reason || "admission_denied"}`);
  }

  const executionIds = helpers.runtimeExecutionIds(input.task, decision, metadata);
  const plugin = createOctoClawRuntimePlugin(buildPluginOptions(nativeHelperInvoker));
  let workflow = startRuntimeWorkflow({
    ...executionIds,
    decision: workflowDecision,
    role: workflowDecision.role,
    decisionRef: readString(metadata.decisionRef ?? metadata.decision_ref, `${executionIds.requestId}:${route}`),
    provenanceSource: "runtime_orchestrator",
    claimOwner: readString(
      metadata.claimOwner ?? metadata.claim_owner ?? metadata.controllerId ?? metadata.controller_id,
      "octoclaw-runtime",
    ),
    leaseDurationMs: readNumber(metadata.leaseDurationMs ?? metadata.lease_duration_ms, 30_000),
    deadlineBudget: {
      queueMs: readNumber(metadata.queueMs ?? metadata.queue_ms, 1_000),
      startMs: readNumber(metadata.startMs ?? metadata.start_ms, 2_000),
      progressMs: readNumber(
        metadata.progressMs ?? metadata.progress_ms,
        Math.max(5_000, (Number(input.timeoutSeconds || 0) * 1_000) || 30_000),
      ),
      runtimeMs: readNumber(
        metadata.runtimeMs ?? metadata.runtime_ms,
        Math.max(10_000, (Number(input.timeoutSeconds || 0) * 1_000) || 60_000),
      ),
      deliveryMs: readNumber(metadata.deliveryMs ?? metadata.delivery_ms, 5_000),
    },
    scope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)),
  });

  const modelPolicy = asRecord(decision.model_policy);
  const normalizedRequest = normalizeRuntimeRequest({
    prompt: readString(input.task),
    sessionKey: readString(metadata.session_key ?? metadata.sessionKey, executionIds.requestId),
    channel: readString(metadata.channel, "direct"),
    requestId: executionIds.requestId,
    taskId: executionIds.taskId,
    flowId: executionIds.flowId,
    idempotencyKey: readString(metadata.idempotencyKey ?? metadata.idempotency_key, executionIds.requestId),
    workspaceMode: metadata.workspaceMode as ScopeMetadata["workspaceMode"] | undefined,
    readScope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).readScope,
    writeScope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).writeScope,
    writeScopeSummary: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).writeScopeSummary,
    metadata,
  });
  const basePayload = {
    route,
    system_preferred_route: route,
    worker_pool: readString(routeDecision.worker_pool ?? modelPolicy.worker_pool, "octoclaw-worker"),
    model: readString(modelPolicy.selected_model ?? modelPolicy.profile ?? workflowDecision.modelProfile),
    policy_decision: canonicalDecision,
    task_id: workflow.identity.taskId,
    flow_id: workflow.identity.flowId,
    runtime_truth: {
      authority: "ts-runtime-core",
      workflow,
    },
    orchestration: {
      authority: "ts-runtime-core",
      route,
      provenance: workflow.execution,
      lifecycle: workflow.lifecycle,
      taskMaterialization: workflow.taskMaterialization,
    },
    telemetry: emitWorkflowTelemetry(normalizedRequest, workflow),
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
    const ackPayload = buildFastReplyAck(
      "latency",
      {
        required: Boolean(metadata.latency_ack_required ?? metadata.latencyAckRequired),
        text: readString(metadata.latency_ack_text ?? metadata.latencyAckText),
      },
      {
        routeDecisionStartedAt,
        ackSentAt: typeof metadata.ackSentAt === "number"
          ? metadata.ackSentAt as number
          : readString(metadata.latency_ack_text ?? metadata.latencyAckText) ? routeDecisionStartedAt : undefined,
      },
    );
    workflow = advanceWorkflowToRunning(workflow, workflow.claim?.claimOwner || "octoclaw-runtime");
    workflow = markWorkflowCompleted(workflow);
    const directReply = buildDirectReply(
      directContext,
      `Direct route selected; keep execution in the main session for: ${helpers.truncateText(input.task, 80)}`,
      {
        routeDecisionStartedAt,
        ackSentAt: ackPayload.metrics.ack_ms !== undefined ? routeDecisionStartedAt + ackPayload.metrics.ack_ms : undefined,
        replyCompletedAt: Date.now(),
      },
    );
    return {
      ...basePayload,
      executed: true,
      status: "executed",
      summary: `OctoClaw dispatch: reply (${workflow.execution.role})`,
      handoff: directReply.handoff,
      materialization: {
        authority: "ts-runtime-core",
        type: "direct_response",
        task_id: workflow.identity.taskId,
        flow_id: workflow.identity.flowId,
      },
      fast_reply: {
        context: directContext,
        ack: ackPayload,
        direct: directReply,
      },
      runtime_truth: {
        authority: "ts-runtime-core",
        workflow,
      },
      orchestration: {
        ...basePayload.orchestration,
        lifecycle: workflow.lifecycle,
        taskMaterialization: workflow.taskMaterialization,
      },
    };
  }

  workflow = advanceWorkflowToRunning(workflow, workflow.claim?.claimOwner || "octoclaw-runtime");
  workflow = renewWorkflowHeartbeat(workflow);
  workflow = markWorkflowCheckpointEmitted(workflow);
  const progressDelivery = buildWorkflowProgressDelivery(workflow, {
    channel: readString(metadata.channel, "direct"),
    summary: `Workflow checkpoint emitted for ${workflow.identity.taskId}`,
    artifactRefs: [workflow.taskMaterialization.taskPacketRef],
  });
  workflow = enqueueWorkflowDelivery(workflow, progressDelivery);

  try {
    const binding = plugin.bindWorkflow(workflow);
    const delegateAttemptBinding = route === "delegate"
      ? startDelegateAttempt(createDelegateTask({
        sessionId: normalizedRequest.sessionKey,
        role: workflow.execution.role,
        coordinationMode: resolveDelegateCoordinationMode(workflowDecision),
        goal: readString(input.task),
        scope: workflow.scope,
      }), {
        nativeFlowId: binding.flowId,
        nativeTaskId: binding.taskId,
        claimOwner: workflow.claim?.claimOwner || workflow.taskMaterialization.claimOwner,
        modelProfile: workflow.execution.modelProfile as PolicyDecision["modelProfile"],
        backend: workflow.identity.backend,
        workspaceMode: workflow.scope.workspaceMode,
      })
      : null;
    const observe = isObserveMode(workflow.execution.role, workflowDecision.executionProfile);
    const finalDelivery = observe
      ? buildWorkflowFinalDelivery(workflow, {
        channel: readString(metadata.channel, "direct"),
        summary: `Observe workflow materialized natively as ${binding.taskId}`,
        artifactRefs: [binding.taskId, binding.flowId],
      })
      : null;
    if (finalDelivery) {
      workflow = markWorkflowCompleted(workflow);
      workflow = enqueueWorkflowDelivery(workflow, finalDelivery);
    }
    return {
      ...basePayload,
      executed: observe,
      status: observe ? "executed" : "planned",
      summary: `OctoClaw dispatch: ${route}${observe ? " (executed)" : " (planned)"}`,
      handoff: {
        kind: observe ? "observe" : "delegate",
        summary: observe
          ? `Observe workflow materialized natively as ${binding.taskId}`
          : `Delegated task materialized natively as ${binding.taskId}`,
        user_safe: true,
        reply_text: observe
          ? `Observe workflow started natively: ${binding.taskId}`
          : `Delegated task registered natively: ${binding.taskId}`,
      },
      materialization: {
        authority: "ts-native-plugin",
        type: route,
        task_id: binding.taskId,
        flow_id: binding.flowId,
        delegateTaskId: delegateAttemptBinding?.task.delegateTaskId,
        attemptId: delegateAttemptBinding?.attempt.attemptId,
        attemptGeneration: delegateAttemptBinding?.attempt.attemptGeneration,
        runtime: binding.runtime,
        sync_mode: binding.syncMode,
        substrate_state: binding.substrateState,
        substrate_revision: binding.substrateRevision,
        truth: binding.truth,
        projection: binding.projection,
      },
      runtime_truth: {
        authority: "ts-runtime-core",
        workflow,
        binding,
        delegateTask: delegateAttemptBinding?.task,
        delegateAttempt: delegateAttemptBinding?.attempt,
        nativeTaskBinding: delegateAttemptBinding?.binding,
      },
      orchestration: {
        ...basePayload.orchestration,
        lifecycle: workflow.lifecycle,
        taskMaterialization: workflow.taskMaterialization,
      },
      telemetry: emitWorkflowTelemetry(normalizedRequest, workflow),
      deliveries: {
        progress: progressDelivery,
        final: finalDelivery ?? undefined,
      },
      job: observe
        ? {
          id: binding.taskId,
          session_key: readString(metadata.session_key ?? metadata.sessionKey),
        }
        : undefined,
      delegateTaskId: delegateAttemptBinding?.task.delegateTaskId,
      attemptId: delegateAttemptBinding?.attempt.attemptId,
    };
  } catch (error) {
    const failedWorkflow = markWorkflowFailed(workflow);
    const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
    throw Object.assign(new Error(`ts_runtime_materialization_failed:${message}`), {
      payload: {
        ...basePayload,
        executed: false,
        status: "failed",
        capability_failure: {
          authority: "ts-runtime-core",
          route,
          reason: message || "native_materialization_failed",
        },
        runtime_truth: {
          authority: "ts-runtime-core",
          workflow: failedWorkflow,
        },
        orchestration: {
          ...basePayload.orchestration,
          lifecycle: failedWorkflow.lifecycle,
          taskMaterialization: failedWorkflow.taskMaterialization,
        },
      },
    });
  }
}

export function buildTsRuntimeSpawnPayload(
  input: SpawnPayloadInput,
  helpers: RuntimePayloadHelpers,
) {
  const decision = asRecord(input.decision);
  const metadata = asRecord(input.metadata);
  const normalizedRoute = helpers.normalizeLiveRoute(
    input.route ?? helpers.runtimeRouteDecision(decision).route,
    "delegate",
  );
  if (normalizedRoute !== "delegate") {
    throw new Error(`unsupported_spawn_route:${normalizedRoute}`);
  }

  const canonicalDecision = canonicalizePolicyDecision(decision, normalizedRoute);

  const nativeHelperInvoker = input.helperInvoker ?? readHelperInvoker(metadata.helperInvoker);
  const plugin = createOctoClawRuntimePlugin(buildPluginOptions(nativeHelperInvoker));
  const executionIds = helpers.runtimeExecutionIds(
    input.task,
    {
      route_decision: {
        ...helpers.runtimeRouteDecision(decision),
        route: normalizedRoute,
      },
    },
    metadata,
  );
  const workflowDecision = helpers.buildWorkflowDecision(
    input.task,
    {
      ...canonicalDecision,
      route_decision: {
        ...helpers.runtimeRouteDecision(canonicalDecision),
        route: normalizedRoute,
      },
    },
    {
      ...metadata,
      requiresDelegation: true,
      requested_route: "delegate",
    },
  );

  let workflow = startRuntimeWorkflow({
    ...executionIds,
    decision: workflowDecision,
    role: workflowDecision.role,
    decisionRef: readString(metadata.decisionRef ?? metadata.decision_ref, `${executionIds.requestId}:${normalizedRoute}`),
    provenanceSource: "runtime_orchestrator",
    claimOwner: readString(
      metadata.claimOwner ?? metadata.claim_owner ?? metadata.controllerId ?? metadata.controller_id,
      "octoclaw-runtime",
    ),
    leaseDurationMs: readNumber(metadata.leaseDurationMs ?? metadata.lease_duration_ms, 30_000),
    deadlineBudget: {
      queueMs: readNumber(metadata.queueMs ?? metadata.queue_ms, 1_000),
      startMs: readNumber(metadata.startMs ?? metadata.start_ms, 2_000),
      progressMs: readNumber(metadata.progressMs ?? metadata.progress_ms, 30_000),
      runtimeMs: readNumber(metadata.runtimeMs ?? metadata.runtime_ms, 60_000),
      deliveryMs: readNumber(metadata.deliveryMs ?? metadata.delivery_ms, 5_000),
    },
    scope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)),
  });

  workflow = advanceWorkflowToRunning(workflow, workflow.claim?.claimOwner || "octoclaw-runtime");
  workflow = renewWorkflowHeartbeat(workflow);

  const modelPolicy = asRecord(decision.model_policy);
  const normalizedRequest = normalizeRuntimeRequest({
    prompt: readString(input.task),
    sessionKey: readString(metadata.session_key ?? metadata.sessionKey, executionIds.requestId),
    channel: readString(metadata.channel, "direct"),
    requestId: executionIds.requestId,
    taskId: executionIds.taskId,
    flowId: executionIds.flowId,
    idempotencyKey: readString(metadata.idempotencyKey ?? metadata.idempotency_key, executionIds.requestId),
    workspaceMode: metadata.workspaceMode as ScopeMetadata["workspaceMode"] | undefined,
    readScope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).readScope,
    writeScope: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).writeScope,
    writeScopeSummary: normalizeScopeMetadata(helpers.buildWorkflowScope(metadata)).writeScopeSummary,
    metadata,
  });
  const basePayload = {
    route: normalizedRoute,
    worker_pool: readString(helpers.runtimeRouteDecision(decision).worker_pool ?? modelPolicy.worker_pool, "octoclaw-worker"),
    model: readString(modelPolicy.selected_model ?? modelPolicy.profile ?? workflowDecision.modelProfile),
    policy_decision: canonicalDecision,
    telemetry: emitWorkflowTelemetry(normalizedRequest, workflow),
  };
  const delegatedMaterialization = materializeDelegatedWork({
    requestId: workflow.identity.requestId,
    taskId: workflow.identity.taskId,
    flowId: workflow.identity.flowId,
    role: workflowDecision.role,
    goal: readString(input.task),
    requestIdempotencyKey: normalizedRequest.idempotencyKey,
    deliveryId: `delivery:${workflow.identity.flowId}:${workflow.identity.taskId}`,
    deliveryReceiptId: `receipt:${workflow.identity.flowId}:${workflow.identity.taskId}`,
    claimOwner: workflow.claim?.claimOwner || workflow.taskMaterialization.claimOwner,
    leaseDurationMs: workflow.claim?.leaseDurationMs || 30_000,
    queueBudget: workflow.execution.admission.queueBudget,
    inflightCount: Number(metadata.inflightCount ?? metadata.inflight_count ?? 0),
    capabilitySatisfied: workflow.execution.admission.reason !== "capability_guard_failed",
    writeConflict: Boolean(metadata.writeConflict ?? metadata.write_conflict),
    readScope: workflow.scope.readScope,
    writeScope: workflow.scope.writeScope,
    workspaceMode: workflow.scope.workspaceMode,
  });
  const compoundPlaceholder = buildCompoundDelegationPlaceholder();

  try {
    workflow = markWorkflowCheckpointEmitted(workflow);
    const progressDelivery = buildWorkflowProgressDelivery(workflow, {
      channel: readString(metadata.channel, "direct"),
      summary: `Spawn task checkpoint emitted for ${workflow.identity.taskId}`,
      artifactRefs: [workflow.taskMaterialization.taskPacketRef],
    });
    workflow = enqueueWorkflowDelivery(workflow, progressDelivery);
    const binding = plugin.bindWorkflow(workflow);
    const delegateAttemptBinding = startDelegateAttempt(createDelegateTask({
      sessionId: normalizedRequest.sessionKey,
      role: workflow.execution.role,
      coordinationMode: resolveDelegateCoordinationMode(workflowDecision),
      goal: readString(input.task),
      scope: workflow.scope,
    }), {
      nativeFlowId: binding.flowId,
      nativeTaskId: binding.taskId,
      claimOwner: workflow.claim?.claimOwner || workflow.taskMaterialization.claimOwner,
      modelProfile: workflow.execution.modelProfile as PolicyDecision["modelProfile"],
      backend: workflow.identity.backend,
      workspaceMode: workflow.scope.workspaceMode,
    });
    if (input.execute) {
      workflow = markWorkflowCompleted(workflow);
    }
    const finalDelivery = buildWorkflowFinalDelivery(workflow, {
      channel: readString(metadata.channel, "direct"),
      summary: `Delegated task materialized natively as ${binding.taskId}`,
      artifactRefs: [binding.taskId, binding.flowId],
    });
    workflow = enqueueWorkflowDelivery(workflow, finalDelivery);
    return {
      ...basePayload,
      executed: Boolean(input.execute),
      status: input.execute ? "executed" : "planned",
      task_id: binding.taskId,
      flow_id: binding.flowId,
      summary: `OctoClaw spawn registered: ${binding.taskId}`,
      delegateTaskId: delegateAttemptBinding.task.delegateTaskId,
      attemptId: delegateAttemptBinding.attempt.attemptId,
      handoff: {
        kind: "spawn",
        summary: `Delegated task materialized natively as ${binding.taskId}`,
        user_safe: true,
        reply_text: `Delegated task registered natively: ${binding.taskId}`,
      },
      materialization: {
        authority: "ts-native-plugin",
        type: "delegate",
        task_id: binding.taskId,
        flow_id: binding.flowId,
        delegateTaskId: delegateAttemptBinding.task.delegateTaskId,
        attemptId: delegateAttemptBinding.attempt.attemptId,
        attemptGeneration: delegateAttemptBinding.attempt.attemptGeneration,
        runtime: binding.runtime,
        sync_mode: binding.syncMode,
        substrate_state: binding.substrateState,
        substrate_revision: binding.substrateRevision,
        truth: binding.truth,
        projection: binding.projection,
        delegation: {
          ...delegatedMaterialization,
          delegateTaskId: delegateAttemptBinding.task.delegateTaskId,
          attemptId: delegateAttemptBinding.attempt.attemptId,
          attemptGeneration: delegateAttemptBinding.attempt.attemptGeneration,
        },
        compound: compoundPlaceholder,
      },
      runtime_truth: {
        authority: "ts-runtime-core",
        workflow,
        binding,
        delegateTask: delegateAttemptBinding.task,
        delegateAttempt: delegateAttemptBinding.attempt,
        nativeTaskBinding: delegateAttemptBinding.binding,
      },
      telemetry: emitWorkflowTelemetry(normalizedRequest, workflow),
      deliveries: {
        progress: progressDelivery,
        final: finalDelivery,
      },
    };
  } catch (error) {
    const failedWorkflow = markWorkflowFailed(workflow);
    const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
    throw Object.assign(new Error(`ts_runtime_spawn_failed:${message}`), {
      payload: {
        ...basePayload,
        executed: false,
        status: "failed",
        task_id: failedWorkflow.identity.taskId,
        flow_id: failedWorkflow.identity.flowId,
        capability_failure: {
          authority: "ts-runtime-core",
          route: normalizedRoute,
          reason: message || "native_spawn_failed",
        },
        runtime_truth: {
          authority: "ts-runtime-core",
          workflow: failedWorkflow,
        },
      },
    });
  }
}
