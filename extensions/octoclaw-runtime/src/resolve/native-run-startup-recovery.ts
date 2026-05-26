import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sendIMMessage, type SendIMParams, type SendIMResult } from "../im/send.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { type UnknownRecord, asRecord, asString } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { createFileDeliveryOutbox, resolveDeliveryOutboxPath, type DeliveryOutbox } from "./delivery-outbox.js";
import { resolveOpenClawConfigDir, resolveWorkspaceRoot } from "./env.js";

const nodeRequire = createRequire(import.meta.url);

export interface NativeTaskRunRecoveryRow {
  taskId: string;
  runId: string;
  status: string;
  deliveryStatus: string;
  childSessionKey: string;
  requesterSessionKey: string;
  resultText: string;
  error: string;
}

export interface NativeRunStartupRecoveryResult {
  checkedAt: string;
  scannedCount: number;
  deliveredCount: number;
  failedCount: number;
  skippedCount: number;
}

export type NativeRunStartupSendMessage = (params: SendIMParams) => Promise<SendIMResult>;

export function resolveNativeTaskRunsSqlitePath(): string {
  const explicit = asString(process.env.OCTOCLAW_NATIVE_RUNS_SQLITE_PATH).trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveOpenClawConfigDir(), "tasks", "runs.sqlite");
}

export function readPendingNativeTaskRuns(options: {
  dbPath?: string;
  db?: DatabaseSync;
  limit?: number;
} = {}): NativeTaskRunRecoveryRow[] {
  const db = options.db ?? openNativeTaskRunsDb(options.dbPath ?? resolveNativeTaskRunsSqlitePath());
  if (!db) return [];
  const shouldClose = !options.db;
  try {
    const rows = db.prepare(`
      SELECT
        task_id,
        run_id,
        status,
        delivery_status,
        child_session_key,
        requester_session_key,
        terminal_summary,
        terminal_outcome,
        error
      FROM task_runs
      WHERE status = 'succeeded'
        AND delivery_status = 'pending'
      ORDER BY COALESCE(ended_at, last_event_at, created_at) ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(options.limit ?? 50))));
    return rows.map(rowToRecoveryRun).filter((row): row is NativeTaskRunRecoveryRow => Boolean(row));
  } catch (_) {
    return [];
  } finally {
    if (shouldClose) {
      try { db.close(); } catch {}
    }
  }
}

export async function recoverNativeRunsOnGatewayStart(options: {
  dbPath?: string;
  db?: DatabaseSync;
  outbox?: DeliveryOutbox;
  sendMessage?: NativeRunStartupSendMessage;
  now?: Date;
  limit?: number;
  logger?: unknown;
} = {}): Promise<NativeRunStartupRecoveryResult> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  const db = options.db ?? openNativeTaskRunsDb(options.dbPath ?? resolveNativeTaskRunsSqlitePath());
  if (!db) {
    return { checkedAt, scannedCount: 0, deliveredCount: 0, failedCount: 0, skippedCount: 0 };
  }
  const shouldClose = !options.db;
  const outbox = options.outbox ?? createFileDeliveryOutbox(resolveDeliveryOutboxPath());
  const sendMessage = options.sendMessage ?? ((params: SendIMParams) => sendIMMessage(params));
  const rows = readPendingNativeTaskRuns({ db, limit: options.limit });
  let deliveredCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    if (!row.requesterSessionKey || !row.resultText) {
      skippedCount += 1;
      continue;
    }
    const item = outbox.upsertPendingResult({
      taskId: row.taskId,
      runId: row.runId,
      childSessionKey: row.childSessionKey,
      requesterSessionKey: row.requesterSessionKey,
      requesterOrigin: { sessionKey: row.requesterSessionKey },
      workContractId: row.taskId,
      delegateTaskId: row.taskId,
      attemptId: row.runId || row.taskId,
      resultText: row.resultText,
      now: checkedAt,
    });
    const sent = await sendMessage({
      sessionKey: row.requesterSessionKey,
      message: row.resultText,
      cwd: resolveWorkspaceRoot(),
      deliveryKind: "native_child_final",
      deliveryTargetSource: "session_fallback",
      deliveryProvenance: {
        route: "delegate",
        via: "gateway_start_recovery",
        runId: row.runId,
        childSessionKey: row.childSessionKey,
      },
      dedupeKey: item.resultHash,
    });
    if (sent.sent) {
      outbox.markDelivered(item.outboxId, checkedAt);
      markNativeRunDelivered(db, row.taskId);
      deliveredCount += 1;
      void recordPolicyReplay("restart_recovery_result_delivered", {
        taskId: row.taskId,
        runId: row.runId,
        resultHash: item.resultHash,
        messageId: sent.messageId || "",
      }, options.logger, null).catch(() => {});
      continue;
    }
    failedCount += 1;
    void recordPolicyReplay("delivery_outbox_delivery_failed", {
      taskId: row.taskId,
      runId: row.runId,
      resultHash: item.resultHash,
      error: sent.error || "send_failed",
    }, options.logger, null).catch(() => {});
  }

  if (rows.length > 0) {
    void recordPolicyReplay("restart_recovery_gateway_start", {
      scannedCount: rows.length,
      deliveredCount,
      failedCount,
      skippedCount,
    }, options.logger, null).catch(() => {});
  }

  if (shouldClose) {
    try { db.close(); } catch {}
  }
  return { checkedAt, scannedCount: rows.length, deliveredCount, failedCount, skippedCount };
}

function openNativeTaskRunsDb(dbPath: string): DatabaseSync | null {
  try {
    const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    return new sqlite.DatabaseSync(dbPath, { open: true });
  } catch (_) {
    return null;
  }
}

function rowToRecoveryRun(row: UnknownRecord): NativeTaskRunRecoveryRow | null {
  const record = asRecord(row);
  const taskId = stringValue(record.task_id);
  const runId = stringValue(record.run_id);
  const resultText = recoveryResultText(record);
  if (!taskId || !resultText) return null;
  return {
    taskId,
    runId,
    status: stringValue(record.status),
    deliveryStatus: stringValue(record.delivery_status),
    childSessionKey: stringValue(record.child_session_key),
    requesterSessionKey: stringValue(record.requester_session_key),
    resultText,
    error: stringValue(record.error),
  };
}

function recoveryResultText(record: UnknownRecord): string {
  const terminalOutcome = stringValue(record.terminal_outcome);
  if (terminalOutcome && !isGenericTerminalText(terminalOutcome)) return terminalOutcome;
  const terminalSummary = stringValue(record.terminal_summary);
  if (terminalSummary && !isGenericTerminalText(terminalSummary)) return terminalSummary;
  return "";
}

function isGenericTerminalText(text: string): boolean {
  return /^(completed|succeeded|success|ok)$/iu.test(text.trim());
}

function markNativeRunDelivered(db: DatabaseSync, taskId: string): void {
  db.prepare("UPDATE task_runs SET delivery_status = 'delivered' WHERE task_id = ?").run(taskId);
}
