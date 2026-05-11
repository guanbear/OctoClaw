import { emitExecutionTransitionNotification } from "../ack/execution-transition-notifier.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { updateWorkContract } from "../work-contract/store.js";
import type { NativeBindingRef, WorkContract } from "@octoclaw/contracts/work-contract";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";
import type { NativeSpawnIntent } from "./native-spawn-intent.js";
import { asString } from "../util/type-coercion.js";

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
  ackError?: string;
  spawnIntentId: string;
  workContractId: string;
  runId?: string | null;
  childRunId?: string | null;
  childSessionKey?: string | null;
  ackSent?: boolean;
  ackSkipped?: boolean;
}

function parseTime(value: unknown): number {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureDelegate(contract: WorkContract, nativeBinding: NativeBindingRef, intent: NativeSpawnIntent): NonNullable<WorkContract["delegate"]> {
  const previous = contract.delegate;
  const selectedModel = asString(intent.sessionsSpawnArgs?.model);
  return {
    delegateTaskId: asString(intent.delegateTaskId || previous?.delegateTaskId || `delegate-task:${contract.workContractId}`),
    currentAttemptId: asString(intent.attemptId || previous?.currentAttemptId) || null,
    role: previous?.role ?? contract.decision.delegateRole ?? "default",
    coordinationMode: previous?.coordinationMode ?? "solo_worker",
    acceptanceCriteria: previous?.acceptanceCriteria ?? [],
    scope: previous?.scope ?? { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
    modelProfile: selectedModel || previous?.modelProfile || "",
    nativeBinding,
    childSessions: previous?.childSessions ?? [],
    artifactRefs: previous?.artifactRefs ?? [],
    nextAction: previous?.nextAction ?? "wait",
    blocker: previous?.blocker,
  };
}

function intentModelProfile(intent: NativeSpawnIntent): string {
  return asString(intent.sessionsSpawnArgs?.model);
}

function cloneWorkContract(contract: WorkContract): WorkContract {
  return JSON.parse(JSON.stringify(contract)) as WorkContract;
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
}): { ok: true; previous: WorkContract } | { ok: false } {
  let previous: WorkContract | null = null;
  const updated = updateWorkContract(input.intent.workContractId, (contract) => {
    previous = cloneWorkContract(contract);
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
  return updated && previous ? { ok: true, previous } : { ok: false };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown_error");
}

function errorCode(error: unknown): string {
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  return asString(record.code || record.name).toUpperCase();
}

function nativeIntentStoreError(error: unknown): string {
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  if (
    code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || message.includes("sqlite_busy")
    || message.includes("sqlite_locked")
    || message.includes("database is locked")
    || message.includes("database is busy")
  ) {
    return "sqlite_busy";
  }
  if (code === "SQLITE_UNAVAILABLE" || message.includes("sqlite_unavailable") || message.includes("sqlite unavailable")) {
    return "sqlite_unavailable";
  }
  return `native_spawn_intent_store_error:${errorMessage(error)}`;
}

function markPlannerAttemptInLedger(input: {
  intent: NativeSpawnIntent;
  status: "running" | "failed";
  nowIso: string;
  runId?: string;
  childRunId?: string;
  childSessionKey?: string;
  errorMessage?: string;
}): void {
  const attemptId = asString(input.intent.attemptId);
  const workContractId = asString(input.intent.workContractId);
  const delegateTaskId = asString(input.intent.delegateTaskId) || (workContractId ? `delegate-task:${workContractId}` : "");
  if (!attemptId || !workContractId || !delegateTaskId) return;

  const opened = openRuntimeLedger({ mode: "best_effort" });
  if (opened.status !== "ok" || !opened.db) return;

  const db = opened.db;
  const flowId = input.runId ? `sessions_spawn:${input.runId}` : "";
  const queueId = `queue:${attemptId}`;
  const attemptJson = {
    work_contract_id: workContractId,
    delegate_task_id: delegateTaskId,
    spawn_intent_id: input.intent.spawnIntentId,
    dispatch_mode: input.intent.dispatchMode,
    model: intentModelProfile(input.intent),
    planner_confirm: true,
  };
  const modelProfile = intentModelProfile(input.intent);
  try {
    db.exec("BEGIN");
    const existing = db.prepare("SELECT attempt_id FROM task_attempts WHERE attempt_id = ?").get(attemptId);
    if (!existing) {
      const maxRow = db.prepare("SELECT MAX(attempt_no) AS max_no FROM task_attempts WHERE work_contract_id = ?").get(workContractId);
      const attemptNo = maxRow && maxRow.max_no != null ? Number(maxRow.max_no) + 1 : 1;
      db.prepare(
        `INSERT INTO task_attempts (
           attempt_id, work_contract_id, delegate_task_id, attempt_no,
           attempt_kind, status, native_flow_id, child_session_key, child_run_id,
           model_profile, started_at, updated_at, ended_at, terminal_outcome, error_message,
           attempt_json, revision
         ) VALUES (?, ?, ?, ?, 'initial', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        attemptId,
        workContractId,
        delegateTaskId,
        attemptNo,
        input.status,
        flowId || null,
        asString(input.childSessionKey) || null,
        asString(input.childRunId) || null,
        modelProfile || null,
        input.status === "running" ? input.nowIso : null,
        input.nowIso,
        input.status === "failed" ? input.nowIso : null,
        input.status === "failed" ? "failed" : null,
        input.status === "failed" ? asString(input.errorMessage) : null,
        JSON.stringify(attemptJson),
      );
    }

    if (input.status === "running") {
      db.prepare(
        `UPDATE task_attempts
         SET status = 'running',
             native_flow_id = COALESCE(NULLIF(native_flow_id, ''), ?),
             child_session_key = COALESCE(NULLIF(?, ''), child_session_key),
             child_run_id = COALESCE(NULLIF(?, ''), child_run_id),
             model_profile = COALESCE(NULLIF(?, ''), model_profile),
             started_at = COALESCE(started_at, ?),
             updated_at = ?,
             revision = revision + 1
         WHERE attempt_id = ?`,
      ).run(
        flowId,
        asString(input.childSessionKey),
        asString(input.childRunId),
        modelProfile,
        input.nowIso,
        input.nowIso,
        attemptId,
      );
      db.prepare(
        `INSERT OR IGNORE INTO scheduler_queue (
           queue_id, work_contract_id, attempt_id, queue_status, priority,
           dependency_ids_json, resource_keys_json, created_at, updated_at, revision
         ) VALUES (?, ?, ?, 'running', 0, '[]', '[]', ?, ?, 0)`,
      ).run(queueId, workContractId, attemptId, input.nowIso, input.nowIso);
      db.prepare(
        `UPDATE scheduler_queue
         SET queue_status = 'running', updated_at = ?, revision = revision + 1
         WHERE attempt_id = ? AND queue_status <> 'terminal'`,
      ).run(input.nowIso, attemptId);
      db.prepare(
        `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
         VALUES ('task_attempt_spawn_confirmed', ?, ?, ?, ?)`,
      ).run(workContractId, attemptId, JSON.stringify({
        spawnIntentId: input.intent.spawnIntentId,
        runId: input.runId ?? null,
        childRunId: input.childRunId ?? null,
        childSessionKey: input.childSessionKey ?? null,
      }), input.nowIso);
    } else {
      db.prepare(
        `UPDATE task_attempts
         SET status = 'failed',
             ended_at = COALESCE(ended_at, ?),
             terminal_outcome = COALESCE(terminal_outcome, 'failed'),
             error_message = COALESCE(NULLIF(?, ''), error_message),
             updated_at = ?,
             revision = revision + 1
         WHERE attempt_id = ?`,
      ).run(input.nowIso, asString(input.errorMessage), input.nowIso, attemptId);
      db.prepare(
        `INSERT OR IGNORE INTO scheduler_queue (
           queue_id, work_contract_id, attempt_id, queue_status, priority,
           dependency_ids_json, resource_keys_json, created_at, updated_at, revision
         ) VALUES (?, ?, ?, 'terminal', 0, '[]', '[]', ?, ?, 0)`,
      ).run(queueId, workContractId, attemptId, input.nowIso, input.nowIso);
      db.prepare(
        `UPDATE scheduler_queue
         SET queue_status = 'terminal', updated_at = ?, revision = revision + 1
         WHERE attempt_id = ?`,
      ).run(input.nowIso, attemptId);
      db.prepare(
        `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
         VALUES ('task_attempt_spawn_failed', ?, ?, ?, ?)`,
      ).run(workContractId, attemptId, JSON.stringify({
        spawnIntentId: input.intent.spawnIntentId,
        error: input.errorMessage ?? "",
      }), input.nowIso);
    }
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch {}
  } finally {
    try { db.close(); } catch {}
  }
}

function contractStillHasNativeRefs(input: {
  contract: WorkContract;
  intent: NativeSpawnIntent;
  runId: string;
  childRunId: string;
  childSessionKey: string;
}): boolean {
  const refs = input.contract.nativeSpawnRefs;
  const binding = input.contract.delegate?.nativeBinding;
  const telemetry = input.contract.telemetry;
  if (refs?.spawnIntentId !== input.intent.spawnIntentId) return false;
  if (refs.openclawRunId !== input.runId) return false;
  if (input.childSessionKey && refs.childSessionKey !== input.childSessionKey) return false;
  if (binding?.runId && binding.runId !== input.runId) return false;
  if (binding?.childRunId && binding.childRunId !== input.childRunId) return false;
  if (input.childSessionKey && binding?.childSessionKey && binding.childSessionKey !== input.childSessionKey) return false;
  if (telemetry.childRunId && telemetry.childRunId !== input.childRunId) return false;
  if (input.childSessionKey && telemetry.childSessionKey && telemetry.childSessionKey !== input.childSessionKey) return false;
  return true;
}

function assignOptionalString<T extends Record<string, unknown>>(target: T, key: keyof T, value: string | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value as T[keyof T];
}

function restoreNativeRefFields(current: WorkContract, previous: WorkContract): WorkContract {
  const delegate = current.delegate
    ? {
        ...current.delegate,
        nativeBinding: previous.delegate?.nativeBinding ?? null,
      }
    : current.delegate;
  const continuity = { ...current.continuity };
  assignOptionalString(continuity as unknown as Record<string, unknown>, "delegateTaskId", previous.continuity.delegateTaskId);
  assignOptionalString(continuity as unknown as Record<string, unknown>, "preferredChildSessionKey", previous.continuity.preferredChildSessionKey);
  assignOptionalString(continuity as unknown as Record<string, unknown>, "preferredRunId", previous.continuity.preferredRunId);

  const telemetry = { ...current.telemetry };
  for (const key of ["dispatchExecuted", "spawnExecuted", "childSessionKey", "childRunId"] as const) {
    if (previous.telemetry[key] === undefined) delete telemetry[key];
    else telemetry[key] = previous.telemetry[key] as never;
  }

  const visibleIds = { ...current.mainContext.visibleIds };
  for (const key of ["delegateTaskId", "attemptId", "childSessionKey", "openclawRunId", "spawnIntentId", "spawnBackend", "spawnMode"] as const) {
    if (previous.mainContext.visibleIds[key] === undefined) delete visibleIds[key];
    else visibleIds[key] = previous.mainContext.visibleIds[key] as never;
  }

  const restored: WorkContract = {
    ...current,
    delegate,
    continuity,
    telemetry,
    mainContext: {
      ...current.mainContext,
      visibleIds,
      nextAction: previous.mainContext.nextAction,
    },
    updatedAt: current.updatedAt,
  };
  if (previous.nativeSpawnRefs === undefined) delete restored.nativeSpawnRefs;
  else restored.nativeSpawnRefs = previous.nativeSpawnRefs;
  return restored;
}

function rollbackNativeRefsIfStillCurrent(input: {
  previous: WorkContract;
  intent: NativeSpawnIntent;
  runId: string;
  childRunId: string;
  childSessionKey: string;
}): "rolled_back" | "skipped" | "failed" {
  let shouldRollback = false;
  const updated = updateWorkContract(input.intent.workContractId, (current) => {
    shouldRollback = contractStillHasNativeRefs({
      contract: current,
      intent: input.intent,
      runId: input.runId,
      childRunId: input.childRunId,
      childSessionKey: input.childSessionKey,
    });
    return shouldRollback ? restoreNativeRefFields(current, input.previous) : current;
  });
  if (!updated) return "failed";
  return shouldRollback ? "rolled_back" : "skipped";
}

async function maybeSendAcceptedAck(input: {
  confirmInput: ConfirmNativeSpawnInput;
  intent: NativeSpawnIntent;
  spawnIntentId: string;
  workContractId: string;
  runId: string;
  childRunId: string;
  childSessionKey: string;
  now: Date;
  nowIso: string;
}): Promise<Pick<ConfirmNativeSpawnOutput, "ackSent" | "ackSkipped" | "ackError">> {
  if (input.confirmInput.notify === false || input.intent.ackSentAt) {
    return { ackSent: false, ackSkipped: true };
  }

  try {
    const taskId = asString(input.intent.delegateTaskId) || input.workContractId;
    const modelId = asString(input.confirmInput.modelId) || intentModelProfile(input.intent);
    const notification = await emitExecutionTransitionNotification({
      transitionKind: "spawn_started",
      projection: minimalProjection({
        taskId,
        workContractId: input.workContractId,
        modelId,
        childSessionKey: input.childSessionKey,
        runId: input.runId,
        childRunId: input.childRunId,
        nowIso: input.nowIso,
      }) as unknown as Parameters<typeof emitExecutionTransitionNotification>[0]["projection"],
      attemptId: asString(input.intent.attemptId) || `${taskId}:attempt:1`,
      workContractId: input.workContractId,
      sessionKey: asString(input.confirmInput.sessionKey || input.intent.sessionKey),
      stateKey: asString(input.confirmInput.stateKey || input.confirmInput.sessionKey || input.intent.sessionKey),
      decision: input.confirmInput.decision,
      replyToMessageId: asString(input.confirmInput.replyToMessageId) || undefined,
      cwd: asString(input.confirmInput.cwd) || undefined,
      occurredAt: input.nowIso,
    });

    if (notification.sent) {
      const marked = nativeSpawnIntentStore.markAckSent(input.spawnIntentId, { now: input.now });
      if (!marked.ok) {
        return {
          ackSent: notification.sent,
          ackSkipped: notification.skipped,
          ackError: marked.error || "ack_mark_failed",
        };
      }
    }

    return {
      ackSent: notification.sent,
      ackSkipped: notification.skipped,
    };
  } catch (error) {
    return {
      ackSent: false,
      ackSkipped: false,
      ackError: errorMessage(error),
    };
  }
}

export async function confirmNativeSpawn(input: ConfirmNativeSpawnInput): Promise<ConfirmNativeSpawnOutput> {
  const spawnIntentId = asString(input.spawnIntentId);
  const workContractId = asString(input.workContractId);
  if (!spawnIntentId || !workContractId) {
    return { ok: false, status: "error", error: "spawn_intent_id_and_work_contract_id_required", spawnIntentId, workContractId };
  }

  const status = asString(input.sessionsSpawnStatus).toLowerCase();
  if (status !== "accepted") {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const failure = nativeSpawnIntentStore.markFailed({
      spawnIntentId,
      workContractId,
      sessionKey: asString(input.sessionKey) || undefined,
      error: asString(input.error) || `sessions_spawn_${status || "not_accepted"}`,
      now,
    });
    if (failure.ok && failure.intent) {
      markPlannerAttemptInLedger({
        intent: failure.intent,
        status: "failed",
        nowIso,
        errorMessage: asString(input.error) || `sessions_spawn_${status || "not_accepted"}`,
      });
    }
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

  const sessionKey = asString(input.sessionKey);
  let existingIntent: NativeSpawnIntent | null;
  try {
    existingIntent = nativeSpawnIntentStore.get(spawnIntentId);
  } catch (error) {
    return {
      ok: false,
      status: "error",
      error: nativeIntentStoreError(error),
      spawnIntentId,
      workContractId,
      runId,
    };
  }
  if (!existingIntent) {
    return {
      ok: false,
      status: "error",
      error: "intent_not_found",
      spawnIntentId,
      workContractId,
      runId,
    };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  if (existingIntent.workContractId !== workContractId) {
    return { ok: false, status: "error", error: "work_contract_mismatch", spawnIntentId, workContractId, runId };
  }
  if (sessionKey && existingIntent.sessionKey !== sessionKey) {
    return { ok: false, status: "error", error: "session_mismatch", spawnIntentId, workContractId, runId };
  }
  if (existingIntent.status === "accepted" && existingIntent.runId !== runId) {
    return {
      ok: false,
      status: "conflict",
      error: "run_id_conflict",
      spawnIntentId,
      workContractId,
      runId,
    };
  }
  if (existingIntent.status !== "spawn_call_started" && existingIntent.status !== "accepted") {
    return { ok: false, status: "error", error: `invalid_status:${existingIntent.status}`, spawnIntentId, workContractId, runId };
  }
  if (existingIntent.status === "accepted") {
    const childRunId = asString(existingIntent.childRunId) || runId;
    const childSessionKey = asString(existingIntent.childSessionKey);
    markPlannerAttemptInLedger({
      intent: existingIntent,
      status: "running",
      nowIso,
      runId,
      childRunId,
      childSessionKey,
    });
    const ack = await maybeSendAcceptedAck({
      confirmInput: input,
      intent: existingIntent,
      spawnIntentId,
      workContractId,
      runId,
      childRunId,
      childSessionKey,
      now,
      nowIso,
    });
    return {
      ok: true,
      status: "idempotent",
      spawnIntentId,
      workContractId,
      runId,
      childRunId,
      childSessionKey: childSessionKey || null,
      ...ack,
    };
  }
  if (existingIntent.status === "spawn_call_started" && parseTime(existingIntent.expiresAt) <= now.getTime()) {
    try {
      nativeSpawnIntentStore.expire(spawnIntentId, { now });
    } catch (error) {
      return { ok: false, status: "error", error: nativeIntentStoreError(error), spawnIntentId, workContractId, runId };
    }
    return { ok: false, status: "error", error: "intent_expired", spawnIntentId, workContractId, runId };
  }

  const childRunId = asString(input.childRunId) || asString(existingIntent.childRunId) || runId;
  const childSessionKey = asString(input.childSessionKey) || asString(existingIntent.childSessionKey);
  const refsRecorded = recordNativeRefs({ intent: existingIntent, runId, childRunId, childSessionKey, nowIso });
  if (!refsRecorded.ok) {
    return {
      ok: false,
      status: "error",
      error: "work_contract_native_refs_write_failed",
      spawnIntentId,
      workContractId,
      runId,
      childRunId,
      childSessionKey: childSessionKey || null,
    };
  }

  const confirm = nativeSpawnIntentStore.confirmAccepted({
    spawnIntentId,
    workContractId,
    sessionKey: sessionKey || undefined,
    runId,
    childRunId,
    childSessionKey,
    now,
  });
  if (!confirm.ok) {
    const rollback = rollbackNativeRefsIfStillCurrent({
      previous: refsRecorded.previous,
      intent: existingIntent,
      runId,
      childRunId,
      childSessionKey,
    });
    return {
      ok: false,
      status: confirm.status === "conflict" ? "conflict" : "error",
      error: rollback !== "failed"
        ? confirm.error || "confirm_failed"
        : `${confirm.error || "confirm_failed"};native_refs_rollback_failed`,
      spawnIntentId,
      workContractId,
      runId,
    };
  }

  const intent = confirm.intent;
  const confirmedChildRunId = asString(intent.childRunId) || childRunId;
  const confirmedChildSessionKey = asString(intent.childSessionKey) || childSessionKey;
  markPlannerAttemptInLedger({
    intent,
    status: "running",
    nowIso,
    runId,
    childRunId: confirmedChildRunId,
    childSessionKey: confirmedChildSessionKey,
  });

  const ack = await maybeSendAcceptedAck({
    confirmInput: input,
    intent,
    spawnIntentId,
    workContractId,
    runId,
    childRunId: confirmedChildRunId,
    childSessionKey: confirmedChildSessionKey,
    now,
    nowIso,
  });

  return {
    ok: true,
    status: confirm.status,
    spawnIntentId,
    workContractId,
    runId,
    childRunId: confirmedChildRunId,
    childSessionKey: confirmedChildSessionKey || null,
    ...ack,
  };
}
