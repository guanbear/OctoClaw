import type { WorkContract } from "@octoclaw/contracts/work-contract";

type UnknownRecord = Record<string, unknown>;

export type DelegationTicketDryRunDecision = "ticket_would_issue" | "ticket_not_issued";
export type DelegationTicketDenialReason = "" | "not_new_work" | "missing_expected_deliverable" | "recent_delegated_execution";

export interface DelegationTicketDryRunResult {
  ticket_decision: DelegationTicketDryRunDecision;
  ticket_denial_reason: DelegationTicketDenialReason;
  is_new_work: boolean;
  expected_deliverable: string;
  ticket_id?: string;
  work_contract_id?: string;
  delegate_task_id?: string;
}

export interface DelegationTicketDryRunInput {
  contract?: WorkContract | null;
  decision?: UnknownRecord | null;
  payload?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return "";
}

function routeFrom(input: DelegationTicketDryRunInput): string {
  const decision = asRecord(input.decision);
  const payload = asRecord(input.payload);
  const routeDecision = asRecord(decision.route_decision);
  return firstString(input.contract?.route, routeDecision.route, payload.route);
}

function isFollowup(input: DelegationTicketDryRunInput): boolean {
  const contract = input.contract;
  const decision = asRecord(input.decision);
  const metadata = asRecord(input.metadata);
  const request = asRecord(decision.request);
  const requestMetadata = asRecord(request.metadata);
  const conversationControl = asRecord(
    metadata.conversation_control ?? requestMetadata.conversation_control,
  );
  const intentPacket = asRecord(
    metadata.intent_packet ?? requestMetadata.intent_packet,
  );
  const requestIntentPacket = asRecord(requestMetadata.intent_packet);
  const routerDecision = asRecord(decision.router_decision_v2);
  const executionCoverage = asRecord(decision._execution_coverage_packet);
  const coverageExecution = asRecord(asRecord(executionCoverage.coverage).execution);

  const intentClass = firstString(
    contract?.intentClass,
    conversationControl.intent_class,
    intentPacket.intent_class,
    intentPacket.intentClass,
  );
  const requestKind = asString(routerDecision.request_kind);
  const relationToRecent = firstString(
    metadata.relation_to_recent_execution,
    asRecord(intentPacket).relation_to_recent_execution,
    requestMetadata.relation_to_recent_execution,
    requestIntentPacket.relation_to_recent_execution,
  );

  if (
    relationToRecent === "existing_execution_followup"
    || relationToRecent === "existing_execution_provenance_query"
  ) {
    return true;
  }

  return intentClass === "execution_followup"
    || requestKind === "status_or_provenance"
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(conversationControl.status_followup)
    || asBoolean(coverageExecution.supports_provenance_reply)
    || asBoolean(coverageExecution.supports_status_reply);
}

function expectedDeliverableFrom(input: DelegationTicketDryRunInput): string {
  const decision = asRecord(input.decision);
  const payload = asRecord(input.payload);
  const existingCandidate = asRecord(decision.delegation_ticket_candidate);
  const handoff = asRecord(payload.handoff);
  return firstString(
    existingCandidate.expected_deliverable,
    input.contract?.mainContext?.summary,
    handoff.summary,
    payload.summary,
    payload.task,
  ).slice(0, 200);
}

function delegateTaskIdFrom(input: DelegationTicketDryRunInput): string {
  const decision = asRecord(input.decision);
  const payload = asRecord(input.payload);
  const workContract = asRecord(decision.work_contract);
  const materialization = asRecord(payload.materialization);
  return firstString(
    input.contract?.delegate?.delegateTaskId,
    workContract.delegateTaskId,
    payload.delegateTaskId,
    materialization.delegateTaskId,
    materialization.task_id,
    payload.task_id,
  );
}

export function buildDelegationTicketDryRun(
  input: DelegationTicketDryRunInput = {},
): DelegationTicketDryRunResult {
  const route = routeFrom(input);
  const expectedDeliverable = expectedDeliverableFrom(input);
  const workContractId = firstString(
    input.contract?.workContractId,
    asRecord(input.decision).workContractId,
    asRecord(asRecord(input.decision).work_contract).workContractId,
    asRecord(input.payload).workContractId,
    asRecord(input.metadata).workContractId,
  );
  const delegateTaskId = delegateTaskIdFrom(input);
  const ticketId = workContractId ? `candidate:${workContractId}` : "";

  if (route !== "delegate" || isFollowup(input)) {
    return {
      ticket_decision: "ticket_not_issued",
      ticket_denial_reason: "not_new_work",
      is_new_work: false,
      expected_deliverable: expectedDeliverable,
      ...(ticketId ? { ticket_id: ticketId } : {}),
      ...(workContractId ? { work_contract_id: workContractId } : {}),
      ...(delegateTaskId ? { delegate_task_id: delegateTaskId } : {}),
    };
  }

  if (!expectedDeliverable) {
    return {
      ticket_decision: "ticket_not_issued",
      ticket_denial_reason: "missing_expected_deliverable",
      is_new_work: false,
      expected_deliverable: "",
      ...(ticketId ? { ticket_id: ticketId } : {}),
      ...(workContractId ? { work_contract_id: workContractId } : {}),
      ...(delegateTaskId ? { delegate_task_id: delegateTaskId } : {}),
    };
  }

  return {
    ticket_decision: "ticket_would_issue",
    ticket_denial_reason: "",
    is_new_work: true,
    expected_deliverable: expectedDeliverable,
    ...(ticketId ? { ticket_id: ticketId } : {}),
    ...(workContractId ? { work_contract_id: workContractId } : {}),
    ...(delegateTaskId ? { delegate_task_id: delegateTaskId } : {}),
  };
}
