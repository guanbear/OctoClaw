import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { openRuntimeLedger } from "./index.js";
import { resolveRuntimeLedgerMode } from "./shadow.js";
import type { DatabaseSync, RuntimeLedgerEnvMode, SqliteProvider } from "./types.js";
import type { DelegationTicketDryRunResult } from "./ticket-dry-run.js";

type UnknownRecord = Record<string, unknown>;

export type DelegationTicketRejectionReason =
  | "not_enforced"
  | "ticket_admitted"
  | "ledger_unavailable"
  | "not_new_work"
  | "missing_expected_deliverable"
  | "no_ticket"
  | "ticket_used"
  | "ticket_revoked"
  | "ticket_expired"
  | "scope_mismatch"
  | "missing_attempt_identity"
  | "duplicate_attempt";

export interface DelegationTicketAdmissionInput {
  contract?: WorkContract | null;
  candidate?: DelegationTicketDryRunResult | UnknownRecord | null;
  delegateTaskId?: string;
  attemptId?: string;
  workerPool?: string;
  modelProfile?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  mode?: RuntimeLedgerEnvMode;
  now?: Date;
}

export interface DelegationTicketAdmissionResult {
  allowed: boolean;
  enforced: boolean;
  reason: DelegationTicketRejectionReason;
  dbPath?: string;
  ticket_id?: string;
  work_contract_id?: string;
  delegate_task_id?: string;
  attempt_id?: string;
  queue_id?: string;
  attempts_created?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function ticketIdFor(workContractId: string): string {
  return `candidate:${workContractId}`;
}

function delegateTaskIdFor(workContractId: string, input: DelegationTicketAdmissionInput): string {
  const candidate = asRecord(input.candidate);
  return asString(input.delegateTaskId)
    || asString(candidate.delegate_task_id)
    || asString(input.contract?.delegate?.delegateTaskId)
    || `delegate-task:${workContractId}`;
}

function attemptIdFor(delegateTaskId: string, input: DelegationTicketAdmissionInput): string {
  const candidate = asRecord(input.candidate);
  return asString(input.attemptId)
    || asString(candidate.attempt_id)
    || asString(input.contract?.delegate?.currentAttemptId)
    || `${delegateTaskId}:attempt:1`;
}

function reject(
  reason: DelegationTicketRejectionReason,
  extra: Partial<DelegationTicketAdmissionResult> = {},
): DelegationTicketAdmissionResult {
  return { allowed: false, enforced: true, reason, ...extra };
}

function appendRuntimeEvent(
  db: DatabaseSync,
  eventType: string,
  workContractId: string,
  attemptId: string | null,
  payload: Record<string, unknown>,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventType, workContractId, attemptId, JSON.stringify(payload), nowIso);
}

export function admitDelegationTicketForDispatch(
  input: DelegationTicketAdmissionInput = {},
): DelegationTicketAdmissionResult {
  const mode = input.mode ?? resolveRuntimeLedgerMode();
  if (mode !== "enforce") {
    return { allowed: true, enforced: false, reason: "not_enforced" };
  }

  const candidate = asRecord(input.candidate);
  const ticketDecision = asString(candidate.ticket_decision);

  if (ticketDecision === "ticket_not_issued") {
    const denialReason = asString(candidate.ticket_denial_reason);
    return reject(
      denialReason === "missing_expected_deliverable"
        ? "missing_expected_deliverable"
        : "not_new_work",
    );
  }

  const workContractId = asString(
    input.contract?.workContractId
      ?? candidate.work_contract_id,
  );
  if (!workContractId) {
    return reject("no_ticket");
  }

  const delegateTaskId = delegateTaskIdFor(workContractId, input);
  const attemptId = attemptIdFor(delegateTaskId, input);
  if (!delegateTaskId || !attemptId) {
    return reject("missing_attempt_identity", { work_contract_id: workContractId });
  }

  const openResult = openRuntimeLedger({
    dbPath: input.dbPath,
    mode: "enforce",
    sqlite: input.sqlite,
  });
  if (openResult.status !== "ok" || !openResult.db) {
    return reject("ledger_unavailable", {
      dbPath: openResult.dbPath,
      work_contract_id: workContractId,
    });
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expectedTicketId = asString(candidate.ticket_id) || ticketIdFor(workContractId);
  try {
    db.exec("BEGIN");
    const ticket = db.prepare(
      `SELECT * FROM delegation_tickets
       WHERE ticket_id = ? OR work_contract_id = ?
       ORDER BY CASE WHEN ticket_id = ? THEN 0 ELSE 1 END, issued_at DESC
       LIMIT 1`,
    ).get(expectedTicketId, workContractId, expectedTicketId);

    if (!ticket) {
      db.exec("ROLLBACK");
      return reject("no_ticket", { dbPath: openResult.dbPath, work_contract_id: workContractId });
    }

    const ticketId = asString(ticket.ticket_id);
    const rowWorkContractId = asString(ticket.work_contract_id);
    if (rowWorkContractId !== workContractId) {
      db.exec("ROLLBACK");
      return reject("scope_mismatch", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }

    const expectedDeliverable = asString(candidate.expected_deliverable);
    if (expectedDeliverable && asString(ticket.expected_deliverable) !== expectedDeliverable) {
      db.exec("ROLLBACK");
      return reject("scope_mismatch", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }

    if (input.contract?.sessionKey && asString(ticket.session_key) !== input.contract.sessionKey) {
      db.exec("ROLLBACK");
      return reject("scope_mismatch", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }

    const status = asString(ticket.status);
    const expiresAt = Date.parse(asString(ticket.expires_at));
    if (status === "used") {
      db.exec("ROLLBACK");
      return reject("ticket_used", { ticket_id: ticketId, work_contract_id: workContractId, attempt_id: attemptId, dbPath: openResult.dbPath });
    }
    if (status === "revoked") {
      db.exec("ROLLBACK");
      return reject("ticket_revoked", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }
    if (status === "expired" || (Number.isFinite(expiresAt) && expiresAt <= now.getTime())) {
      db.prepare("UPDATE delegation_tickets SET status = 'expired', revision = revision + 1 WHERE ticket_id = ? AND status = 'issued'").run(ticketId);
      db.exec("COMMIT");
      return reject("ticket_expired", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }
    if (status !== "issued") {
      db.exec("ROLLBACK");
      return reject("no_ticket", { ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath });
    }

    const existingAttempt = db.prepare("SELECT attempt_id FROM task_attempts WHERE attempt_id = ?").get(attemptId);
    if (existingAttempt) {
      db.exec("ROLLBACK");
      return reject("duplicate_attempt", { ticket_id: ticketId, work_contract_id: workContractId, attempt_id: attemptId, dbPath: openResult.dbPath });
    }

    const maxRow = db.prepare("SELECT MAX(attempt_no) AS max_no FROM task_attempts WHERE work_contract_id = ?").get(workContractId);
    const attemptNo = maxRow && maxRow.max_no != null ? Number(maxRow.max_no) + 1 : 1;
    const queueId = `queue:${attemptId}`;
    const attemptJson = {
      ticket_id: ticketId,
      work_contract_id: workContractId,
      delegate_task_id: delegateTaskId,
      pre_materialization: true,
    };

    db.prepare(
      `INSERT INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no,
         attempt_kind, status, model_profile, worker_pool,
         updated_at, attempt_json, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      attemptId,
      workContractId,
      delegateTaskId,
      attemptNo,
      "initial",
      "admitted",
      asString(input.modelProfile) || null,
      asString(input.workerPool) || null,
      nowIso,
      JSON.stringify(attemptJson),
    );

    db.prepare(
      `INSERT INTO scheduler_queue (
         queue_id, work_contract_id, attempt_id, queue_status, priority,
         dependency_ids_json, resource_keys_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, 0, '[]', '[]', ?, ?, 0)`,
    ).run(queueId, workContractId, attemptId, "admitted", nowIso, nowIso);

    db.prepare(
      `UPDATE delegation_tickets
       SET status = 'used', used_at = ?, revision = revision + 1
       WHERE ticket_id = ? AND status = 'issued'`,
    ).run(nowIso, ticketId);

    appendRuntimeEvent(db, "delegation_ticket_used", workContractId, attemptId, {
      ticketId,
      delegateTaskId,
      queueId,
    }, nowIso);

    db.exec("COMMIT");
    return {
      allowed: true,
      enforced: true,
      reason: "ticket_admitted",
      dbPath: openResult.dbPath,
      ticket_id: ticketId,
      work_contract_id: workContractId,
      delegate_task_id: delegateTaskId,
      attempt_id: attemptId,
      queue_id: queueId,
      attempts_created: 1,
    };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return reject("ledger_unavailable", {
      dbPath: openResult.dbPath,
      work_contract_id: workContractId,
    });
  } finally {
    try { db.close(); } catch {}
  }
}
