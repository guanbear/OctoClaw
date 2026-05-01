import fsSync from "node:fs";
import path from "node:path";
import { resolveTaskStatePath } from "../resolve/env.js";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import type { TaskStateRecord } from "../state/task-state-store.js";
import { TASK_STATE_SCHEMA_VERSION, readTaskStateDocument } from "../state/task-state-store.js";
import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";

type UnknownRecord = Record<string, unknown>;

interface WorkContractRow extends UnknownRecord {
  work_contract_id: string;
  route: string;
  intent_class: string | null;
  expected_deliverable: string | null;
  complexity_final: string | null;
  delivery_target_json: string;
  work_contract_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TaskAttemptRow extends UnknownRecord {
  attempt_id: string;
  work_contract_id: string;
  delegate_task_id: string;
  attempt_no: number;
  attempt_kind: string;
  status: string;
  native_flow_id: string | null;
  native_task_id: string | null;
  child_session_key: string | null;
  child_run_id: string | null;
  model_profile: string | null;
  worker_pool: string | null;
  started_at: string | null;
  updated_at: string;
  ended_at: string | null;
  terminal_outcome: string | null;
  terminal_summary: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface CompletionBindingRow extends UnknownRecord {
  completion_id: string;
  work_contract_id: string;
  attempt_id: string;
  expected_path: string;
  verdict: string;
  observed_at: string | null;
  completed_at: string | null;
}

export interface RebuildTaskStateProjectionInput {
  dbPath?: string;
  sqlite?: SqliteProvider;
}

export interface RebuiltTaskStateProjection {
  tasks: TaskStateRecord[];
  rebuiltAt: string;
  source: "ledger";
}

export interface WriteRebuiltTaskStateInput extends RebuildTaskStateProjectionInput {
  taskStatePath?: string;
}

export interface WriteRebuiltTaskStateResult {
  written: boolean;
  path: string;
  taskCount: number;
  error?: string;
}

export interface IsTaskStateRebuildableResult {
  rebuildable: boolean;
  workContractCount: number;
  attemptCount: number;
}

interface ProjectionFsLike {
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(pathname: string): void;
}

const fs = fsSync as unknown as ProjectionFsLike;

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(raw: unknown): UnknownRecord {
  try {
    const parsed = JSON.parse(asString(raw));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function valueFrom(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && asString(value) !== "") return value;
  }
  return undefined;
}

function openDb(input: RebuildTaskStateProjectionInput): { db: DatabaseSync | null; error?: string } {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) return { db: null, error: openResult.error ?? "ledger_unavailable" };
  return { db: openResult.db };
}

function normalizeWorkContractRow(row: UnknownRecord): WorkContractRow {
  return {
    ...row,
    work_contract_id: asString(row.work_contract_id),
    route: asString(row.route),
    intent_class: row.intent_class == null ? null : asString(row.intent_class),
    expected_deliverable: row.expected_deliverable == null ? null : asString(row.expected_deliverable),
    complexity_final: row.complexity_final == null ? null : asString(row.complexity_final),
    delivery_target_json: asString(row.delivery_target_json) || "{}",
    work_contract_json: asString(row.work_contract_json) || "{}",
    status: asString(row.status),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    completed_at: row.completed_at == null ? null : asString(row.completed_at),
  };
}

function normalizeAttemptRow(row: UnknownRecord | undefined): TaskAttemptRow | null {
  if (!row) return null;
  return {
    ...row,
    attempt_id: asString(row.attempt_id),
    work_contract_id: asString(row.work_contract_id),
    delegate_task_id: asString(row.delegate_task_id),
    attempt_no: Number(row.attempt_no ?? 0),
    attempt_kind: asString(row.attempt_kind),
    status: asString(row.status),
    native_flow_id: row.native_flow_id == null ? null : asString(row.native_flow_id),
    native_task_id: row.native_task_id == null ? null : asString(row.native_task_id),
    child_session_key: row.child_session_key == null ? null : asString(row.child_session_key),
    child_run_id: row.child_run_id == null ? null : asString(row.child_run_id),
    model_profile: row.model_profile == null ? null : asString(row.model_profile),
    worker_pool: row.worker_pool == null ? null : asString(row.worker_pool),
    started_at: row.started_at == null ? null : asString(row.started_at),
    updated_at: asString(row.updated_at),
    ended_at: row.ended_at == null ? null : asString(row.ended_at),
    terminal_outcome: row.terminal_outcome == null ? null : asString(row.terminal_outcome),
    terminal_summary: row.terminal_summary == null ? null : asString(row.terminal_summary),
    error_code: row.error_code == null ? null : asString(row.error_code),
    error_message: row.error_message == null ? null : asString(row.error_message),
  };
}

function normalizeCompletionBindingRow(row: UnknownRecord | undefined): CompletionBindingRow | null {
  if (!row) return null;
  return {
    ...row,
    completion_id: asString(row.completion_id),
    work_contract_id: asString(row.work_contract_id),
    attempt_id: asString(row.attempt_id),
    expected_path: asString(row.expected_path),
    verdict: asString(row.verdict),
    observed_at: row.observed_at == null ? null : asString(row.observed_at),
    completed_at: row.completed_at == null ? null : asString(row.completed_at),
  };
}

function recordIdentity(record: TaskStateRecord): string {
  return asString(record.workContractId || record.work_contract_id || record.id || record.taskId || record.task_id);
}

function taskStatePathFromInput(pathOverride?: string): string {
  return asString(pathOverride) || resolveTaskStatePath();
}

function tempPathFor(targetPath: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${targetPath}.tmp.${ts}.${rand}`;
}

function atomicWriteJson(targetPath: string, value: unknown): boolean {
  const tmpPath = tempPathFor(targetPath);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function buildRecord(contract: WorkContractRow, attempt: TaskAttemptRow | null, binding: CompletionBindingRow | null): TaskStateRecord {
  const workContract = parseJsonRecord(contract.work_contract_json) as unknown as WorkContract;
  const workContractRecord = workContract as unknown as UnknownRecord;
  const deliveryTarget = parseJsonRecord(contract.delivery_target_json);
  const sessionKey = asString(valueFrom(workContractRecord, "sessionKey", "session_key"));
  const turnId = asString(valueFrom(workContractRecord, "turnId", "turn_id"));
  const nativeTaskId = attempt?.native_task_id || undefined;
  const nativeFlowId = attempt?.native_flow_id || undefined;
  const childSessionKey = attempt?.child_session_key || undefined;
  const updatedAt = attempt?.updated_at || contract.updated_at;
  const record: TaskStateRecord = {
    id: contract.work_contract_id,
    taskId: contract.work_contract_id,
    task_id: contract.work_contract_id,
    nativeTaskId: nativeTaskId,
    native_task_id: nativeTaskId,
    nativeFlowId: nativeFlowId,
    native_flow_id: nativeFlowId,
    workContractId: contract.work_contract_id,
    work_contract_id: contract.work_contract_id,
    route: contract.route,
    sessionKey: sessionKey || undefined,
    session_key: sessionKey || undefined,
    turnId: turnId || undefined,
    turn_id: turnId || undefined,
    status: attempt?.status || contract.status,
    workContractStatus: contract.status,
    work_contract_status: contract.status,
    intentClass: contract.intent_class ?? valueFrom(workContractRecord, "intentClass", "intent_class"),
    intent_class: contract.intent_class ?? valueFrom(workContractRecord, "intentClass", "intent_class"),
    complexityFinal: contract.complexity_final,
    complexity_final: contract.complexity_final,
    deliveryTarget,
    delivery_target: deliveryTarget,
    expectedDeliverable: contract.expected_deliverable,
    expected_deliverable: contract.expected_deliverable,
    delegateTaskId: attempt?.delegate_task_id,
    delegate_task_id: attempt?.delegate_task_id,
    attemptId: attempt?.attempt_id,
    attempt_id: attempt?.attempt_id,
    attemptNo: attempt?.attempt_no,
    attempt_no: attempt?.attempt_no,
    attemptKind: attempt?.attempt_kind,
    attempt_kind: attempt?.attempt_kind,
    childSessionKey,
    child_session_key: childSessionKey,
    childRunId: attempt?.child_run_id || undefined,
    child_run_id: attempt?.child_run_id || undefined,
    modelProfile: attempt?.model_profile || valueFrom(workContractRecord, "modelProfile", "model_profile"),
    model_profile: attempt?.model_profile || valueFrom(workContractRecord, "modelProfile", "model_profile"),
    workerPool: attempt?.worker_pool || valueFrom(workContractRecord, "workerPool", "worker_pool"),
    worker_pool: attempt?.worker_pool || valueFrom(workContractRecord, "workerPool", "worker_pool"),
    workContract,
    work_contract: workContract,
    createdAt: contract.created_at,
    created_at: contract.created_at,
    updatedAt,
    updated_at: updatedAt,
    started_at: attempt?.started_at || undefined,
    completedAt: contract.completed_at || attempt?.ended_at || undefined,
    completed_at: contract.completed_at || attempt?.ended_at || undefined,
  };
  if (binding) {
    record.completionVerdict = binding.verdict;
    record.completion_verdict = binding.verdict;
    record.completionBinding = {
      completionId: binding.completion_id,
      completion_id: binding.completion_id,
      verdict: binding.verdict,
      expectedPath: binding.expected_path,
      expected_path: binding.expected_path,
      observedAt: binding.observed_at,
      observed_at: binding.observed_at,
      completedAt: binding.completed_at,
      completed_at: binding.completed_at,
    };
    record.completion_binding = record.completionBinding;
  }
  return record;
}

export function rebuildTaskStateProjection(input: RebuildTaskStateProjectionInput = {}): RebuiltTaskStateProjection {
  const rebuiltAt = new Date().toISOString();
  const opened = openDb(input);
  if (!opened.db) return { tasks: [], rebuiltAt, source: "ledger" };

  const db = opened.db;
  try {
    const contracts = db.prepare(
      `SELECT * FROM work_contracts
       WHERE status NOT IN ('completed', 'canceled', 'failed')
       ORDER BY updated_at DESC, work_contract_id`,
    ).all().map(normalizeWorkContractRow);

    const tasks = contracts.map((contract) => {
      const attempt = normalizeAttemptRow(db.prepare(
        `SELECT * FROM task_attempts
         WHERE work_contract_id = ?
         ORDER BY attempt_no DESC, updated_at DESC
         LIMIT 1`,
      ).get(contract.work_contract_id));
      const binding = attempt
        ? normalizeCompletionBindingRow(db.prepare(
          `SELECT * FROM completion_bindings
           WHERE attempt_id = ?
           ORDER BY updated_at DESC, completion_id
           LIMIT 1`,
        ).get(attempt.attempt_id))
        : null;
      return buildRecord(contract, attempt, binding);
    });
    return { tasks, rebuiltAt, source: "ledger" };
  } finally {
    db.close();
  }
}

export function writeRebuiltTaskState(input: WriteRebuiltTaskStateInput = {}): WriteRebuiltTaskStateResult {
  const targetPath = taskStatePathFromInput(input.taskStatePath);
  try {
    const projection = rebuildTaskStateProjection(input);
    const existing = readTaskStateDocument(targetPath).tasks;
    const ledgerIds = new Set(projection.tasks.map(recordIdentity).filter(Boolean));
    const merged = [
      ...projection.tasks,
      ...existing.filter((record) => !ledgerIds.has(recordIdentity(record))),
    ];
    const written = atomicWriteJson(targetPath, {
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      updated_at: projection.rebuiltAt,
      rebuiltAt: projection.rebuiltAt,
      source: projection.source,
      tasks: merged,
    });
    return { written, path: targetPath, taskCount: merged.length, error: written ? undefined : "write_failed" };
  } catch (err) {
    return { written: false, path: targetPath, taskCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isTaskStateRebuildable(input: RebuildTaskStateProjectionInput = {}): IsTaskStateRebuildableResult {
  const opened = openDb(input);
  if (!opened.db) return { rebuildable: false, workContractCount: 0, attemptCount: 0 };
  const db = opened.db;
  try {
    const workContractCount = Number(db.prepare("SELECT COUNT(*) AS count FROM work_contracts").get()?.count ?? 0);
    const attemptCount = Number(db.prepare("SELECT COUNT(*) AS count FROM task_attempts").get()?.count ?? 0);
    return { rebuildable: workContractCount > 0, workContractCount, attemptCount };
  } finally {
    db.close();
  }
}
