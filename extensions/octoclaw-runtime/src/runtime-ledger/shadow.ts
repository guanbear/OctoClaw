import type { WorkContract } from "@octoclaw/contracts/work-contract";
import type {
  DatabaseSync,
  RuntimeLedgerEnvMode,
  ShadowMirrorResult,
  SqliteProvider,
} from "./types.js";
import { openRuntimeLedger } from "./index.js";

export function resolveRuntimeLedgerMode(): RuntimeLedgerEnvMode {
  const value = String(process.env.OCTOCLAW_RUNTIME_LEDGER || "").trim().toLowerCase();
  if (value === "shadow") return "shadow";
  if (value === "enforce") return "enforce";
  return "off";
}

export function isShadowActive(mode?: RuntimeLedgerEnvMode): boolean {
  const resolved = mode ?? resolveRuntimeLedgerMode();
  return resolved === "shadow" || resolved === "enforce";
}

interface MirrorOptions {
  dbPath?: string;
  sqlite?: SqliteProvider;
}

function upsertWorkContract(db: DatabaseSync, contract: WorkContract): number {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT revision FROM work_contracts WHERE work_contract_id = ?")
    .get(contract.workContractId);
  const nextRevision = existing ? Number(existing.revision) + 1 : 0;

  db.prepare(
    `INSERT INTO work_contracts (
       work_contract_id, route, intent_class, expected_deliverable,
       complexity_final, complexity_reason_codes_json, delivery_target_json,
       work_contract_json, status, created_at, updated_at, completed_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_contract_id) DO UPDATE SET
       route = excluded.route,
       intent_class = excluded.intent_class,
       expected_deliverable = excluded.expected_deliverable,
       complexity_final = excluded.complexity_final,
       complexity_reason_codes_json = excluded.complexity_reason_codes_json,
       delivery_target_json = excluded.delivery_target_json,
       work_contract_json = excluded.work_contract_json,
       status = excluded.status,
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at,
       revision = excluded.revision`,
  ).run(
    contract.workContractId,
    contract.route,
    contract.intentClass ?? null,
    contract.mainContext?.summary?.slice(0, 200) ?? null,
    null,
    JSON.stringify(contract.decision?.reasonCodes ?? []),
    JSON.stringify({
      sessionKey: contract.sessionKey,
      turnId: contract.turnId,
    }),
    JSON.stringify(contract),
    contract.status,
    contract.createdAt ?? now,
    contract.updatedAt ?? now,
    ["completed", "failed", "cancelled"].includes(contract.status) ? now : null,
    nextRevision,
  );

  return 1;
}

function upsertDelegationTicketCandidate(db: DatabaseSync, contract: WorkContract): number {
  if (contract.route !== "delegate") return 0;

  const ticketId = `candidate:${contract.workContractId}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const ticketJson = {
    ticket_id: ticketId,
    work_contract_id: contract.workContractId,
    turn_id: contract.turnId,
    session_key: contract.sessionKey,
    delivery_target_id: contract.continuity?.threadBindingKey ?? contract.sessionKey,
    expected_deliverable: contract.mainContext?.summary?.slice(0, 200) ?? "",
    complexity_final: null,
    status: "issued",
    candidate: true,
    shadow: true,
  };

  db.prepare(
    `INSERT INTO delegation_tickets (
       ticket_id, work_contract_id, turn_id, session_key,
       delivery_target_id, expected_deliverable, complexity_final,
       status, issued_at, expires_at, ticket_json, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(ticket_id) DO UPDATE SET
       turn_id = excluded.turn_id,
       session_key = excluded.session_key,
       delivery_target_id = excluded.delivery_target_id,
       expected_deliverable = excluded.expected_deliverable,
       complexity_final = excluded.complexity_final,
       ticket_json = excluded.ticket_json,
       revision = revision + 1`,
  ).run(
    ticketId,
    contract.workContractId,
    contract.turnId,
    contract.sessionKey,
    contract.continuity?.threadBindingKey ?? contract.sessionKey,
    contract.mainContext?.summary?.slice(0, 200) ?? "",
    null,
    "issued",
    now,
    expiresAt,
    JSON.stringify(ticketJson),
  );

  return 1;
}

function upsertTaskAttempt(db: DatabaseSync, contract: WorkContract): number {
  const delegate = contract.delegate;
  if (!delegate) return 0;

  const attemptId = delegate.currentAttemptId;
  const delegateTaskId = delegate.delegateTaskId;
  if (!attemptId || !delegateTaskId) return 0;

  const now = new Date().toISOString();
  const nativeBinding = delegate.nativeBinding;
  const telemetry = contract.telemetry ?? {};

  const existingAttempt = db
    .prepare("SELECT attempt_no FROM task_attempts WHERE attempt_id = ?")
    .get(attemptId);

  if (existingAttempt) {
    const attemptJson = {
      attempt_id: attemptId,
      delegate_task_id: delegateTaskId,
      child_session_key: telemetry.childSessionKey ?? nativeBinding?.childSessionKey ?? null,
      model_profile: delegate.modelProfile ?? null,
      worker_pool: delegate.role ?? null,
    };

    db.prepare(
      `UPDATE task_attempts SET
         delegate_task_id = ?,
         status = ?,
         native_flow_id = ?,
         native_task_id = ?,
         child_session_key = ?,
         child_run_id = ?,
         model_profile = ?,
         worker_pool = ?,
         updated_at = ?,
         attempt_json = ?,
         revision = revision + 1
       WHERE attempt_id = ?`,
    ).run(
      delegateTaskId,
      contract.status ?? "queued",
      nativeBinding?.nativeFlowId ?? nativeBinding?.flowId ?? null,
      nativeBinding?.nativeTaskId ?? nativeBinding?.taskId ?? telemetry.nativeTaskId ?? null,
      telemetry.childSessionKey ?? nativeBinding?.childSessionKey ?? null,
      telemetry.childRunId ?? nativeBinding?.childRunId ?? null,
      delegate.modelProfile ?? null,
      delegate.role ?? null,
      now,
      JSON.stringify(attemptJson),
      attemptId,
    );
    return 1;
  }

  const maxRow = db
    .prepare("SELECT MAX(attempt_no) as max_no FROM task_attempts WHERE work_contract_id = ?")
    .get(contract.workContractId);
  const nextAttemptNo = maxRow && maxRow.max_no != null ? Number(maxRow.max_no) + 1 : 1;

  const attemptJson = {
    attempt_id: attemptId,
    delegate_task_id: delegateTaskId,
    child_session_key: telemetry.childSessionKey ?? nativeBinding?.childSessionKey ?? null,
    model_profile: delegate.modelProfile ?? null,
    worker_pool: delegate.role ?? null,
  };

  db.prepare(
    `INSERT INTO task_attempts (
       attempt_id, work_contract_id, delegate_task_id, attempt_no,
       attempt_kind, status, native_flow_id, native_task_id,
       child_session_key, child_run_id, model_profile, worker_pool,
       started_at, updated_at, attempt_json, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    attemptId,
    contract.workContractId,
    delegateTaskId,
    nextAttemptNo,
    "initial",
    contract.status ?? "queued",
    nativeBinding?.nativeFlowId ?? nativeBinding?.flowId ?? null,
    nativeBinding?.nativeTaskId ?? nativeBinding?.taskId ?? telemetry.nativeTaskId ?? null,
    telemetry.childSessionKey ?? nativeBinding?.childSessionKey ?? null,
    telemetry.childRunId ?? nativeBinding?.childRunId ?? null,
    delegate.modelProfile ?? null,
    delegate.role ?? null,
    telemetry.spawnExecuted ? now : null,
    now,
    JSON.stringify(attemptJson),
  );

  return 1;
}

function appendRuntimeEvent(
  db: DatabaseSync,
  eventType: string,
  workContractId: string,
  attemptId: string | null,
  payload: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventType, workContractId, attemptId, JSON.stringify(payload), now);
}

export function mirrorWorkContractToRuntimeLedger(
  contract: WorkContract,
  options?: MirrorOptions,
): ShadowMirrorResult {
  const mode = resolveRuntimeLedgerMode();
  if (mode === "off") {
    return {
      status: "off",
      workContractId: contract.workContractId,
      dbPath: options?.dbPath ?? "",
    };
  }

  let rowsAffected = 0;
  let eventsAppended = 0;

  try {
    const openResult = openRuntimeLedger({
      dbPath: options?.dbPath,
      mode: "best_effort",
      sqlite: options?.sqlite,
    });

    if (openResult.status !== "ok" || !openResult.db) {
      return {
        status: "degraded",
        workContractId: contract.workContractId,
        dbPath: openResult.dbPath,
        error: openResult.error ?? "ledger_unavailable",
      };
    }

    const db = openResult.db;
    try {
      db.exec("BEGIN");

      rowsAffected += upsertWorkContract(db, contract);
      eventsAppended++;
      appendRuntimeEvent(db, "work_contract_mirror", contract.workContractId, null, {
        route: contract.route,
        status: contract.status,
        sessionKey: contract.sessionKey,
      });

      const ticketRows = upsertDelegationTicketCandidate(db, contract);
      if (ticketRows > 0) {
        rowsAffected += ticketRows;
        eventsAppended++;
        appendRuntimeEvent(db, "delegation_ticket_candidate_mirror", contract.workContractId, null, {
          ticketId: `candidate:${contract.workContractId}`,
          route: contract.route,
        });
      }

      const attemptRows = upsertTaskAttempt(db, contract);
      if (attemptRows > 0) {
        rowsAffected += attemptRows;
        eventsAppended++;
        const attemptId = contract.delegate?.currentAttemptId ?? null;
        appendRuntimeEvent(
          db,
          "task_attempt_mirror",
          contract.workContractId,
          attemptId,
          {
            attemptId,
            delegateTaskId: contract.delegate?.delegateTaskId ?? null,
            attemptKind: "initial",
          },
        );
      }

      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      return {
        status: "degraded",
        workContractId: contract.workContractId,
        dbPath: openResult.dbPath,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try { db.close(); } catch {}
    }

    return {
      status: "ok",
      workContractId: contract.workContractId,
      dbPath: openResult.dbPath,
      rowsAffected,
      eventsAppended,
    };
  } catch (err) {
    return {
      status: "degraded",
      workContractId: contract.workContractId,
      dbPath: options?.dbPath ?? "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
