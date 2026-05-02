import { emitExecutionTransitionNotification } from "../ack/execution-transition-notifier.js";
import { updateWorkContract } from "../work-contract/store.js";
import type { NativeBindingRef, WorkContract } from "@octoclaw/contracts/work-contract";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";
import type { NativeSpawnIntent } from "./native-spawn-intent.js";

type UnknownRecord = Record<string, unknown>;

export interface ConfirmNativeSpawnInput {
  spawnIntentId: string;
  workContractId: string;
  sessionKey?: string;
  stateKey?: string;
  sessionsSpawnStatus: string;
  runId?: string;
  childRunId?: string;
  childSessionKey?: string;
  error?: string;
  modelId?: string;
  replyToMessageId?: string;
  cwd?: string;
  decision?: UnknownRecord;
  notify?: boolean;
  now?: Date;
}

export interface ConfirmNativeSpawnOutput {
  ok: boolean;
  status: "accepted" | "idempotent" | "failed" | "conflict" | "error";
  error?: string;
  spawnIntentId: string;
  workContractId: string;
  runId?: string | null;
  childRunId?: string | null;
  childSessionKey?: string | null;
  ackSent?: boolean;
  ackSkipped?: boolean;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function ensureDelegate(contract: WorkContract, nativeBinding: NativeBindingRef, intent: NativeSpawnIntent): NonNullable<WorkContract["delegate"]> {
  const previous = contract.delegate;
  return {
    delegateTaskId: asString(intent.delegateTaskId || previous?.delegateTaskId || `delegate-task:${contract.workContractId}`),
    currentAttemptId: asString(intent.attemptId || previous?.currentAttemptId) || null,
    role: previous?.role ?? contract.decision.delegateRole ?? "default",
    coordinationMode: previous?.coordinationMode ?? "solo_worker",
    acceptanceCriteria: previous?.acceptanceCriteria ?? [],
    scope: previous?.scope ?? { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
    modelProfile: previous?.modelProfile ?? "",
    nativeBinding,
    childSessions: previous?.childSessions ?? [],
    artifactRefs: previous?.artifactRefs ?? [],
    nextAction: previous?.nextAction ?? "wait",
    blocker: previous?.blocker,
  };
}

function buildNativeBinding(input: {
  contract: WorkContract;
  intent: NativeSpawnIntent;
  runId: string;
  childRunId: string;
  childSessionKey: string;
}): NativeBindingRef {
  const previous = input.contract.delegate?.nativeBinding;
  return {
    ...(previous ?? {}),
    flowId: previous?.flowId || `sessions_spawn:${input.runId}`,
    nativeFlowId: previous?.nativeFlowId,
    ownerKey: previous?.ownerKey || input.intent.delegateTaskId || input.contract.workContractId,
    controllerId: previous?.controllerId || "octoclaw.delegate",
    revision: previous?.revision ?? 1,
    expectedRevision: previous?.expectedRevision ?? 1,
    taskId: previous?.taskId,
    nativeTaskId: previous?.nativeTaskId,
    runId: input.runId,
    childRunId: input.childRunId,
    childSessionKey: input.childSessionKey || previous?.childSessionKey,
    syncMode: "managed",
    status: previous?.status ?? "running",
    lastMutation: previous?.lastMutation ?? "runTask",
    lastMutationApplied: true,
  };
}

function recordNativeRefs(input: {
  intent: NativeSpawnIntent;
  runId: string;
  childRunId: string;
  childSessionKey: string;
  nowIso: string;
}): void {
  updateWorkContract(input.intent.workContractId, (contract) => {
    const nativeBinding = buildNativeBinding({ contract, ...input });
    const delegate = ensureDelegate(contract, nativeBinding, input.intent);
    const spawnMode = input.intent.sessionsSpawnArgs?.mode;
    return {
      ...contract,
      delegate,
      nativeSpawnRefs: {
        ...contract.nativeSpawnRefs,
        openclawRunId: input.runId,
        childSessionKey: input.childSessionKey || undefined,
        requesterSessionKey: contract.sessionKey,
        spawnIntentId: input.intent.spawnIntentId,
        spawnBackend: "sessions_spawn_planner" as const,
        ...(spawnMode ? { spawnMode } : {}),
      },
      continuity: {
        ...contract.continuity,
        delegateTaskId: delegate.delegateTaskId,
        preferredChildSessionKey: input.childSessionKey || contract.continuity.preferredChildSessionKey,
        preferredRunId: input.runId || contract.continuity.preferredRunId,
      },
      telemetry: {
        ...contract.telemetry,
        dispatchExecuted: true,
        spawnExecuted: true,
        childSessionKey: input.childSessionKey || contract.telemetry.childSessionKey,
        childRunId: input.childRunId || contract.telemetry.childRunId,
      },
      mainContext: {
        ...contract.mainContext,
        visibleIds: {
          ...contract.mainContext.visibleIds,
          delegateTaskId: delegate.delegateTaskId,
          attemptId: delegate.currentAttemptId ?? contract.mainContext.visibleIds.attemptId,
          childSessionKey: input.childSessionKey || contract.mainContext.visibleIds.childSessionKey,
          openclawRunId: input.runId,
          spawnIntentId: input.intent.spawnIntentId,
          spawnBackend: "sessions_spawn_planner" as const,
          ...(spawnMode ? { spawnMode } : {}),
        },
        nextAction: "wait",
      },
      updatedAt: input.nowIso,
    };
  });
}

function minimalProjection(input: {
  taskId: string;
  workContractId: string;
  modelId: string;
  childSessionKey: string;
  runId: string;
  childRunId: string;
  nowIso: string;
}): UnknownRecord {
  return {
    schemaVersion: "octoclaw.task_status_projection/v1",
    projectionId: `native_spawn_confirm_${input.workContractId}_${Date.now()}`,
    generatedAt: input.nowIso,
    requestId: "",
    flowId: "",
    taskId: input.taskId,
    workContractId: input.workContractId,
    title: "",
    summary: "",
    taskSummary: "",
    route: "delegate",
    role: "",
    backend: "openclaw.sessions_spawn",
    modelProfile: "",
    modelId: input.modelId,
    status: "running",
    success: false,
    createdAt: input.nowIso,
    startedAt: input.nowIso,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: false,
    elapsedMs: 0,
    artifactRefs: [],
    artifactRefIds: [],
    childSessionKey: input.childSessionKey,
    runId: input.runId,
    childRunId: input.childRunId,
    actions: [],
  };
}

export async function confirmNativeSpawn(input: ConfirmNativeSpawnInput): Promise<ConfirmNativeSpawnOutput> {
  const spawnIntentId = asString(input.spawnIntentId);
  const workContractId = asString(input.workContractId);
  if (!spawnIntentId || !workContractId) {
    return { ok: false, status: "error", error: "spawn_intent_id_and_work_contract_id_required", spawnIntentId, workContractId };
  }

  const status = asString(input.sessionsSpawnStatus).toLowerCase();
  if (status !== "accepted") {
    const failure = nativeSpawnIntentStore.markFailed({
      spawnIntentId,
      workContractId,
      sessionKey: asString(input.sessionKey) || undefined,
      error: asString(input.error) || `sessions_spawn_${status || "not_accepted"}`,
      now: input.now,
    });
    return {
      ok: false,
      status: failure.ok ? "failed" : "error",
      error: failure.ok ? asString(input.error) || `sessions_spawn_${status || "not_accepted"}` : failure.error,
      spawnIntentId,
      workContractId,
      runId: null,
      childRunId: null,
      childSessionKey: null,
    };
  }

  const runId = asString(input.runId);
  if (!runId) {
    return { ok: false, status: "error", error: "run_id_required", spawnIntentId, workContractId, runId: null };
  }

  const confirm = nativeSpawnIntentStore.confirmAccepted({
    spawnIntentId,
    workContractId,
    sessionKey: asString(input.sessionKey) || undefined,
    runId,
    childRunId: asString(input.childRunId) || runId,
    childSessionKey: asString(input.childSessionKey),
    now: input.now,
  });
  if (!confirm.ok) {
    return {
      ok: false,
      status: confirm.status === "conflict" ? "conflict" : "error",
      error: confirm.error || "confirm_failed",
      spawnIntentId,
      workContractId,
      runId,
    };
  }

  const intent = confirm.intent;
  const childRunId = asString(intent.childRunId) || runId;
  const childSessionKey = asString(intent.childSessionKey);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  if (confirm.status === "accepted") {
    recordNativeRefs({ intent, runId, childRunId, childSessionKey, nowIso });
  }

  let ackSent = false;
  let ackSkipped = true;
  if (confirm.status === "accepted" && input.notify !== false && !intent.ackSentAt) {
    nativeSpawnIntentStore.markAckSent(spawnIntentId, { now });
    const taskId = asString(intent.delegateTaskId) || workContractId;
    const notification = await emitExecutionTransitionNotification({
      transitionKind: "spawn_started",
      projection: minimalProjection({
        taskId,
        workContractId,
        modelId: asString(input.modelId),
        childSessionKey,
        runId,
        childRunId,
        nowIso,
      }) as unknown as Parameters<typeof emitExecutionTransitionNotification>[0]["projection"],
      attemptId: asString(intent.attemptId) || `${taskId}:attempt:1`,
      workContractId,
      sessionKey: asString(input.sessionKey || intent.sessionKey),
      stateKey: asString(input.stateKey || input.sessionKey || intent.sessionKey),
      decision: input.decision,
      replyToMessageId: asString(input.replyToMessageId) || undefined,
      cwd: asString(input.cwd) || undefined,
      occurredAt: nowIso,
    });
    ackSent = notification.sent;
    ackSkipped = notification.skipped;
  }

  return {
    ok: true,
    status: confirm.status,
    spawnIntentId,
    workContractId,
    runId,
    childRunId,
    childSessionKey: childSessionKey || null,
    ackSent,
    ackSkipped,
  };
}
