import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { openRuntimeLedger } from "./index.js";
import { resolveRuntimeLedgerMode } from "./shadow.js";
import type { DatabaseSync, RuntimeLedgerEnvMode, SqliteProvider } from "./types.js";
import type { DelegationTicketDryRunResult } from "./ticket-dry-run.js";
import { type UnknownRecord, asRecord, asString } from "../util/type-coercion.js";

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
  attempts_created?: number;
}

export interface IssueDelegationTicketCandidateInput {
  contract: WorkContract;
  candidate?: DelegationTicketDryRunResult | UnknownRecord | null;
  dbPath?: string;
  sqlite?: SqliteProvider;
  mode?: RuntimeLedgerEnvMode;
  now?: Date;
}

export interface IssueDelegationTicketCandidateResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  ticket_id?: string;
  work_contract_id?: string;
  dbPath?: string;
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

export function issueDelegationTicketCandidate(
  input: IssueDelegationTicketCandidateInput,
): IssueDelegationTicketCandidateResult {
  const mode = input.mode ?? resolveRuntimeLedgerMode();
  if (mode !== "enforce") return { ok: false, skipped: true, reason: "not_enforced" };

  const candidate = asRecord(input.candidate);
  if (asString(candidate.ticket_decision) !== "ticket_would_issue") {
    return { ok: false, skipped: true, reason: asString(candidate.ticket_denial_reason) || "ticket_not_issued" };
  }

  const workContractId = input.contract.workContractId;
  const expectedDeliverable = asString(candidate.expected_deliverable);
  if (!workContractId || !expectedDeliverable) {
    return { ok: false, skipped: true, reason: "missing_ticket_identity" };
  }

  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "enforce", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { ok: false, reason: "ledger_unavailable", dbPath: openResult.dbPath, work_contract_id: workContractId };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const ticketId = asString(candidate.ticket_id) || ticketIdFor(workContractId);
  const ticketJson = {
    ticket_id: ticketId,
    work_contract_id: workContractId,
    turn_id: input.contract.turnId,
    session_key: input.contract.sessionKey,
    delivery_target_id: input.contract.continuity?.threadBindingKey || input.contract.sessionKey,
    expected_deliverable: expectedDeliverable,
    complexity_final: asString(candidate.complexity_final) || null,
    status: "issued",
    candidate: true,
  };

  try {
    db.exec("BEGIN");
    const existing = db.prepare("SELECT status FROM delegation_tickets WHERE ticket_id = ?").get(ticketId);
    const existingStatus = asString(asRecord(existing).status);
    if (existingStatus && existingStatus !== "issued") {
      db.exec("ROLLBACK");
      return { ok: false, skipped: true, reason: `ticket_${existingStatus}`, ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath };
    }

    db.prepare(
      `INSERT INTO delegation_tickets (
         ticket_id, work_contract_id, turn_id, session_key,
         delivery_target_id, expected_deliverable, complexity_final,
         status, issued_at, expires_at, ticket_json, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, 0)
       ON CONFLICT(ticket_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         session_key = excluded.session_key,
         delivery_target_id = excluded.delivery_target_id,
         expected_deliverable = excluded.expected_deliverable,
         complexity_final = excluded.complexity_final,
         expires_at = excluded.expires_at,
         ticket_json = excluded.ticket_json,
         revision = revision + 1
       WHERE delegation_tickets.status = 'issued'`,
    ).run(
      ticketId,
      workContractId,
      input.contract.turnId,
      input.contract.sessionKey,
      input.contract.continuity?.threadBindingKey || input.contract.sessionKey,
      expectedDeliverable,
      asString(candidate.complexity_final) || null,
      nowIso,
      expiresAt,
      JSON.stringify(ticketJson),
    );

    appendRuntimeEvent(db, "delegation_ticket_issued", workContractId, null, {
      ticketId,
      expectedDeliverable,
    }, nowIso);
    db.exec("COMMIT");
    return { ok: true, ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, reason: err instanceof Error ? err.message : String(err), ticket_id: ticketId, work_contract_id: workContractId, dbPath: openResult.dbPath };
  } finally {
    try { db.close(); } catch {}
  }
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
      `UPDATE delegation_tickets
       SET status = 'used', used_at = ?, revision = revision + 1
       WHERE ticket_id = ? AND status = 'issued'`,
    ).run(nowIso, ticketId);

    appendRuntimeEvent(db, "delegation_ticket_used", workContractId, attemptId, {
      ticketId,
      delegateTaskId,
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
