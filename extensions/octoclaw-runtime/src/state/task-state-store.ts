import fsSync from "node:fs";
import path from "node:path";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { resolveTaskStatePath } from "../resolve/env.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";

export const TASK_STATE_SCHEMA_VERSION = "octoclaw.task_state.v1" as const;

export interface TaskStateDelivery extends Record<string, unknown> {
  status: string;
  messageId?: string;
  deliveredAt?: string;
}

export interface TaskStateRecord extends Record<string, unknown> {
  id?: unknown;
  taskId?: unknown;
  task_id?: unknown;
  flowId?: unknown;
  flow_id?: unknown;
  nativeTaskId?: unknown;
  native_task_id?: unknown;
  nativeFlowId?: unknown;
  native_flow_id?: unknown;
  workContractId?: unknown;
  work_contract_id?: unknown;
  route?: unknown;
  sessionKey?: unknown;
  session_key?: unknown;
  turnId?: unknown;
  turn_id?: unknown;
  status?: unknown;
  workContractStatus?: unknown;
  work_contract_status?: unknown;
  intentClass?: unknown;
  intent_class?: unknown;
  judgeRoute?: unknown;
  judge_route?: unknown;
  judgeConfidence?: unknown;
  judge_confidence?: unknown;
  workerPool?: unknown;
  worker_pool?: unknown;
  modelProfile?: unknown;
  model_profile?: unknown;
  dispatchExecuted?: unknown;
  dispatch_executed?: unknown;
  spawnExecuted?: unknown;
  spawn_executed?: unknown;
  resultMaterialized?: unknown;
  result_materialized?: unknown;
  childSessionKey?: unknown;
  child_session_key?: unknown;
  runId?: unknown;
  run_id?: unknown;
  childRunId?: unknown;
  child_run_id?: unknown;
  completion?: WorkerCompletionResult | null;
  delivery?: TaskStateDelivery;
  delivery_status?: unknown;
  workContract?: WorkContract;
  work_contract?: WorkContract;
  updatedAt?: unknown;
  updated_at?: unknown;
  started_at?: unknown;
  spawned_at?: unknown;
  completedAt?: unknown;
  completed_at?: unknown;
  failedAt?: unknown;
  failed_at?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
}

export interface TaskStateDocument {
  schemaVersion?: typeof TASK_STATE_SCHEMA_VERSION;
  updated_at?: string;
  rebuiltAt?: string;
  source?: string;
  tasks: TaskStateRecord[];
}

interface FsSyncLike {
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  readFileSync(pathname: string, encoding: string): string;
  renameSync(oldPath: string, newPath: string): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

const fs = fsSync as unknown as FsSyncLike;
const RECOVERY_SIGNAL_SUFFIX = ".recovery-needed";

function writeRecoverySignal(quarantinePath: string, readResult: TaskStateReadResult): void {
  const message = [
    "task-state recovery needed",
    `status=${readResult.status}`,
    `source=${readResult.originalPath}`,
    `quarantine=${quarantinePath}`,
    readResult.errorMessage ? `error=${readResult.errorMessage}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
  try {
    fs.writeFileSync(`${quarantinePath}${RECOVERY_SIGNAL_SUFFIX}`, `${message}\n`, "utf-8");
  } catch {
    // Best-effort signal only; do not mask the primary quarantine/write result.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

function taskStatePathFromOverride(pathOverride?: string): string {
  const explicit = asString(pathOverride);
  if (!explicit) return resolveTaskStatePath();
  if (explicit.endsWith("/task-state.json") || explicit.endsWith("\\task-state.json")) return explicit;
  return path.join(path.dirname(explicit), "task-state.json");
}

export function resolveTaskStateStorePath(pathOverride?: string): string {
  return taskStatePathFromOverride(pathOverride);
}

export type TaskStateReadStatus = "ok" | "missing" | "parse_error" | "schema_mismatch" | "io_error";

export interface TaskStateReadResult {
  document: TaskStateDocument;
  status: TaskStateReadStatus;
  originalPath: string;
  errorMessage?: string;
}

export function readTaskStateDocument(taskStatePath?: string): TaskStateDocument {
  return readTaskStateDocumentDetailed(taskStatePath).document;
}

export function readTaskStateDocumentDetailed(taskStatePath?: string): TaskStateReadResult {
  const targetPath = taskStatePathFromOverride(taskStatePath);
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, "utf-8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: string }).code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "ENOENT" || /ENOENT|no such file|missing file/iu.test(message)) {
      return {
        document: { schemaVersion: TASK_STATE_SCHEMA_VERSION, tasks: [] },
        status: "missing",
        originalPath: targetPath,
      };
    }
    return {
      document: { schemaVersion: TASK_STATE_SCHEMA_VERSION, tasks: [] },
      status: "io_error",
      originalPath: targetPath,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: { tasks?: unknown; schemaVersion?: unknown; updated_at?: unknown };
  try {
    parsed = JSON.parse(raw) as { tasks?: unknown; schemaVersion?: unknown; updated_at?: unknown };
  } catch (error) {
    return {
      document: { schemaVersion: TASK_STATE_SCHEMA_VERSION, tasks: [] },
      status: "parse_error",
      originalPath: targetPath,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  if (!isRecord(parsed)) {
    return {
      document: { schemaVersion: TASK_STATE_SCHEMA_VERSION, tasks: [] },
      status: "schema_mismatch",
      originalPath: targetPath,
      errorMessage: "parsed content is not a record",
    };
  }

  return {
    document: {
      schemaVersion: parsed.schemaVersion === TASK_STATE_SCHEMA_VERSION ? TASK_STATE_SCHEMA_VERSION : undefined,
      updated_at: asString(parsed.updated_at) || undefined,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isRecord) as TaskStateRecord[] : [],
    },
    status: "ok",
    originalPath: targetPath,
  };
}

export function writeTaskStateDocument(document: TaskStateDocument, taskStatePath?: string): boolean {
  return writeTaskStateDocumentSafe(document, taskStatePath).ok;
}

export interface WriteTaskStateResult {
  ok: boolean;
  reason?: string;
  quarantined?: boolean;
  quarantinePath?: string;
}

export function writeTaskStateDocumentSafe(document: TaskStateDocument, taskStatePath?: string): WriteTaskStateResult {
  const targetPath = taskStatePathFromOverride(taskStatePath);
  const readResult = readTaskStateDocumentDetailed(taskStatePath);

  if (readResult.status === "io_error") {
    return { ok: false, reason: `read_failed_closed:${readResult.errorMessage ?? readResult.status}` };
  }

  if (readResult.status === "parse_error" || readResult.status === "schema_mismatch") {
    const quarantinePath = `${targetPath}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(targetPath, quarantinePath);
    } catch {
      // If rename fails, try copy + truncate
      try {
        const existing = fs.readFileSync(targetPath, "utf-8");
        fs.writeFileSync(quarantinePath, existing, "utf-8");
      } catch {
        // quarantine failed — still block the write
        return { ok: false, reason: `corrupt_file_quarantine_failed:${readResult.status}`, quarantined: false };
      }
    }
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const wrote = atomicWriteJsonSync(targetPath, {
        ...document,
        schemaVersion: TASK_STATE_SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
        tasks: document.tasks,
      });
      if (readResult.status === "parse_error" && !wrote) writeRecoverySignal(quarantinePath, readResult);
      return { ok: wrote, reason: wrote ? undefined : "atomic_write_failed", quarantined: true, quarantinePath };
    } catch (error) {
      if (readResult.status === "parse_error") writeRecoverySignal(quarantinePath, readResult);
      return { ok: false, reason: `write_after_quarantine_failed:${error instanceof Error ? error.message : String(error)}`, quarantined: true, quarantinePath };
    }
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const ok = atomicWriteJsonSync(targetPath, {
      ...document,
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      tasks: document.tasks,
    });
    return { ok, reason: ok ? undefined : "atomic_write_failed" };
  } catch (error) {
    console.warn?.(`octoclaw task-state write failed: ${String(error)}`);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function recordIdentityValues(record: TaskStateRecord): string[] {
  return [
    record.id,
    record.workContractId,
    record.work_contract_id,
    record.taskId,
    record.task_id,
    record.nativeTaskId,
    record.native_task_id,
    record.flowId,
    record.flow_id,
    record.nativeFlowId,
    record.native_flow_id,
  ].map((value) => asString(value)).filter(Boolean);
}

function recordsReferToSameTask(left: TaskStateRecord, right: TaskStateRecord): boolean {
  const leftWorkContractId = asString(left.workContractId || left.work_contract_id);
  const rightWorkContractId = asString(right.workContractId || right.work_contract_id);
  if (leftWorkContractId && rightWorkContractId) return leftWorkContractId === rightWorkContractId;
  const rightIds = new Set(recordIdentityValues(right));
  return recordIdentityValues(left).some((value) => rightIds.has(value));
}

function mergeTaskStateRecord(previous: TaskStateRecord | undefined, patch: TaskStateRecord): TaskStateRecord {
  const now = new Date().toISOString();
  const merged: TaskStateRecord = {
    ...(previous ?? {}),
    ...patch,
  };
  const workContractId = optionalString(merged.workContractId, merged.work_contract_id, asRecord(merged.workContract).workContractId, asRecord(merged.work_contract).workContractId);
  if (workContractId) {
    merged.id = workContractId;
    merged.workContractId = workContractId;
    merged.work_contract_id = workContractId;
  } else if (!asString(merged.id)) {
    merged.id = optionalString(merged.taskId, merged.task_id, merged.nativeTaskId, merged.native_task_id, merged.flowId, merged.flow_id) ?? "";
  }

  const taskId = optionalString(merged.taskId, merged.task_id, merged.nativeTaskId, merged.native_task_id);
  if (taskId) {
    merged.taskId = taskId;
    merged.task_id = taskId;
  }
  const flowId = optionalString(merged.flowId, merged.flow_id, merged.nativeFlowId, merged.native_flow_id);
  if (flowId) {
    merged.flowId = flowId;
    merged.flow_id = flowId;
  }
  const sessionKey = optionalString(merged.sessionKey, merged.session_key);
  if (sessionKey) {
    merged.sessionKey = sessionKey;
    merged.session_key = sessionKey;
  }
  const dispatchExecuted = asBoolean(merged.dispatchExecuted) || asBoolean(merged.dispatch_executed);
  merged.dispatchExecuted = dispatchExecuted;
  merged.dispatch_executed = dispatchExecuted;
  const spawnExecuted = asBoolean(merged.spawnExecuted) || asBoolean(merged.spawn_executed);
  merged.spawnExecuted = spawnExecuted;
  merged.spawn_executed = spawnExecuted;
  const resultMaterialized = asBoolean(merged.resultMaterialized) || asBoolean(merged.result_materialized);
  merged.resultMaterialized = resultMaterialized;
  merged.result_materialized = resultMaterialized;
  if (merged.workContract && !merged.work_contract) merged.work_contract = merged.workContract;
  if (merged.work_contract && !merged.workContract) merged.workContract = merged.work_contract;
  const createdAt = patch.created_at || patch.createdAt || previous?.created_at || previous?.createdAt || now;
  merged.created_at = createdAt;
  merged.createdAt = createdAt;
  const updatedAt = patch.updated_at || patch.updatedAt || previous?.updated_at || previous?.updatedAt || now;
  merged.updated_at = updatedAt;
  merged.updatedAt = updatedAt;
  return merged;
}

export function upsertTaskStateRecord(record: TaskStateRecord, taskStatePath?: string): boolean {
  const readResult = readTaskStateDocumentDetailed(taskStatePath);
  if (readResult.status === "io_error") {
    return false;
  }
  const document = readResult.document;
  const idx = document.tasks.findIndex((task) => recordsReferToSameTask(task, record));
  const merged = mergeTaskStateRecord(idx >= 0 ? document.tasks[idx] : undefined, record);
  if (idx >= 0) {
    document.tasks[idx] = merged;
  } else {
    document.tasks.unshift(merged);
  }
  return writeTaskStateDocument(document, taskStatePath);
}

export function readTaskStateRecords(taskStatePath?: string): TaskStateRecord[] {
  return readTaskStateDocument(taskStatePath).tasks;
}

export function loadTaskStateRecordByWorkContract(workContractId: string, taskStatePath?: string): TaskStateRecord | null {
  const targetId = asString(workContractId);
  if (!targetId) return null;
  return readTaskStateRecords(taskStatePath).find((record) => {
    return asString(record.workContractId || record.work_contract_id || record.id) === targetId
      || asString(asRecord(record.workContract).workContractId || asRecord(record.work_contract).workContractId) === targetId;
  }) ?? null;
}

export function taskStateRecordFromWorkContract(contract: WorkContract, previous: TaskStateRecord = {}): TaskStateRecord {
  const delegate = contract.delegate;
  const nativeBinding = delegate?.nativeBinding ?? undefined;
  const telemetry = contract.telemetry ?? {};
  const now = new Date().toISOString();
  const nativeTaskId = optionalString(telemetry.nativeTaskId, nativeBinding?.nativeTaskId, nativeBinding?.taskId, previous.nativeTaskId, previous.native_task_id, previous.taskId, previous.task_id);
  const nativeFlowId = optionalString(telemetry.nativeFlowId, nativeBinding?.nativeFlowId, nativeBinding?.flowId, previous.nativeFlowId, previous.native_flow_id, previous.flowId, previous.flow_id);
  const childSessionKey = optionalString(telemetry.childSessionKey, nativeBinding?.childSessionKey, contract.continuity.preferredChildSessionKey, previous.childSessionKey, previous.child_session_key);
  const runId = optionalString(nativeBinding?.runId, contract.continuity.preferredRunId, previous.runId, previous.run_id);
  const deliveryStatus = optionalString(telemetry.deliveryStatus, asRecord(previous.delivery).status, previous.delivery_status) ?? "none";
  const modelProfile = optionalString(delegate?.modelProfile, previous.modelProfile, previous.model_profile, previous.model);
  const workerPool = optionalString(previous.workerPool, previous.worker_pool, delegate?.role);
  const terminalContractStatus = ["completed", "failed", "cancelled", "canceled", "blocked"].includes(contract.status);
  const hasNativeProjection = Boolean(nativeTaskId || nativeFlowId || previous.dispatchExecuted || previous.dispatch_executed);
  const projectionStatus = hasNativeProjection && !terminalContractStatus
    ? previous.status || contract.status
    : contract.status;
  const record: TaskStateRecord = {
    ...previous,
    id: contract.workContractId,
    taskId: nativeTaskId ?? previous.taskId,
    task_id: nativeTaskId ?? previous.task_id,
    flowId: nativeFlowId ?? previous.flowId,
    flow_id: nativeFlowId ?? previous.flow_id,
    nativeTaskId: nativeTaskId ?? previous.nativeTaskId,
    native_task_id: nativeTaskId ?? previous.native_task_id,
    nativeFlowId: nativeFlowId ?? previous.nativeFlowId,
    native_flow_id: nativeFlowId ?? previous.native_flow_id,
    workContractId: contract.workContractId,
    work_contract_id: contract.workContractId,
    route: contract.route,
    sessionKey: contract.sessionKey,
    session_key: contract.sessionKey,
    turnId: contract.turnId,
    turn_id: contract.turnId,
    status: projectionStatus,
    workContractStatus: contract.status,
    work_contract_status: contract.status,
    intentClass: contract.intentClass,
    intent_class: contract.intentClass,
    judgeRoute: contract.decision.route,
    judge_route: contract.decision.route,
    judgeConfidence: contract.decision.confidence ?? previous.judgeConfidence,
    judge_confidence: contract.decision.confidence ?? previous.judge_confidence,
    workerPool: workerPool ?? previous.workerPool,
    worker_pool: workerPool ?? previous.worker_pool,
    modelProfile: modelProfile ?? previous.modelProfile,
    model_profile: modelProfile ?? previous.model_profile,
    dispatchExecuted: asBoolean(telemetry.dispatchExecuted) || asBoolean(previous.dispatchExecuted) || asBoolean(previous.dispatch_executed),
    dispatch_executed: asBoolean(telemetry.dispatchExecuted) || asBoolean(previous.dispatchExecuted) || asBoolean(previous.dispatch_executed),
    spawnExecuted: asBoolean(telemetry.spawnExecuted) || asBoolean(previous.spawnExecuted) || asBoolean(previous.spawn_executed),
    spawn_executed: asBoolean(telemetry.spawnExecuted) || asBoolean(previous.spawnExecuted) || asBoolean(previous.spawn_executed),
    resultMaterialized: asBoolean(telemetry.resultMaterialized) || asBoolean(previous.resultMaterialized) || asBoolean(previous.result_materialized),
    result_materialized: asBoolean(telemetry.resultMaterialized) || asBoolean(previous.resultMaterialized) || asBoolean(previous.result_materialized),
    childSessionKey: childSessionKey ?? previous.childSessionKey,
    child_session_key: childSessionKey ?? previous.child_session_key,
    runId: runId ?? previous.runId,
    run_id: runId ?? previous.run_id,
    delivery: { ...asRecord(previous.delivery), status: deliveryStatus },
    delivery_status: deliveryStatus,
    workContract: contract,
    work_contract: contract,
    createdAt: previous.createdAt || previous.created_at || contract.createdAt || now,
    created_at: previous.created_at || previous.createdAt || contract.createdAt || now,
    updatedAt: contract.updatedAt || now,
    updated_at: contract.updatedAt || now,
  };
  return mergeTaskStateRecord(previous, record);
}

function recordToWorkContract(record: TaskStateRecord): WorkContract | null {
  const candidate = asRecord(record.workContract || record.work_contract) as Partial<WorkContract>;
  if (!asString(candidate.workContractId)) return null;
  const workContractId = asString(record.workContractId || record.work_contract_id || record.id, candidate.workContractId);
  return {
    ...candidate,
    workContractId,
    route: record.route === "reply" || record.route === "delegate" ? record.route : candidate.route,
    status: asString(record.workContractStatus || record.work_contract_status || candidate.status, candidate.status) as WorkContract["status"],
    sessionKey: asString(record.sessionKey || record.session_key, candidate.sessionKey),
    updatedAt: asString(record.updatedAt || record.updated_at, candidate.updatedAt),
  } as WorkContract;
}

export function saveWorkContractToTaskState(contract: WorkContract, taskStatePath?: string): boolean {
  const previous = loadTaskStateRecordByWorkContract(contract.workContractId, taskStatePath) ?? {};
  return upsertTaskStateRecord(taskStateRecordFromWorkContract(contract, previous), taskStatePath);
}

export function loadWorkContractFromTaskState(workContractId: string, taskStatePath?: string): WorkContract | null {
  const record = loadTaskStateRecordByWorkContract(workContractId, taskStatePath);
  return record ? recordToWorkContract(record) : null;
}

export function updateWorkContractInTaskState(
  workContractId: string,
  mutator: (contract: WorkContract) => WorkContract,
  taskStatePath?: string,
): WorkContract | null {
  const contract = loadWorkContractFromTaskState(workContractId, taskStatePath);
  if (!contract) return null;
  const mutated = mutator(contract);
  return saveWorkContractToTaskState(mutated, taskStatePath) ? mutated : null;
}

export function listWorkContractsBySessionFromTaskState(sessionKey: string, taskStatePath?: string): WorkContract[] {
  const targetSession = asString(sessionKey);
  if (!targetSession) return [];
  return readTaskStateRecords(taskStatePath)
    .filter((record) => asString(record.sessionKey || record.session_key) === targetSession)
    .map(recordToWorkContract)
    .filter((contract): contract is WorkContract => Boolean(contract))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
