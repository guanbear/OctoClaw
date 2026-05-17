export type CanonicalLifecycleStatus =
  | "queued"
  | "running"
  | "running_slow"
  | "stalled"
  | "timed_out"
  | "failed"
  | "degraded"
  | "delivered"
  | "completed";

export type NativeLifecycleStatus = "running" | "completed" | "failed" | "timed_out" | "missing" | "unavailable";

export interface LifecycleReconcileInput {
  currentStatus: string;
  nativeStatus: NativeLifecycleStatus;
  hasCompletionReceipt: boolean;
  hasArtifactRef: boolean;
  hasReportPath: boolean;
  hasResultSummary: boolean;
  hasDeliveryAck: boolean;
  expectedAt: string | null;
  hardTimeoutAt: string | null;
  lastHeartbeatAt: string | null;
  lastProgressAt: string | null;
  tmuxEvidence?: {
    enabled: boolean;
    available: boolean;
    alive: boolean;
    outputChangedSinceLastCheck: boolean;
    lastOutputAt: string | null;
  } | null;
  now: string;
  workContractId?: string;
  attemptId?: string;
  childRunId?: string;
  childSessionKey?: string;
  summary?: string;
  resultLocation?: string;
  artifacts?: string[];
}

export type LifecycleReconcileReason =
  | "delivered_with_ack"
  | "completed_with_result"
  | "completed_without_result"
  | "expected_deadline_passed_live_output"
  | "expected_deadline_passed_no_progress"
  | "hard_timeout_no_live_evidence"
  | "hard_timeout_live_evidence"
  | "native_failed"
  | "native_timed_out"
  | "native_registry_unavailable"
  | "fresh_running"
  | "no_dispatch_evidence"
  | "no_spawn_evidence"
  | "terminal_state_preserved";

export type SuggestedAction = "wait" | "inspect" | "retry" | "stop" | "deliver" | "ask_user";

export interface LifecycleReconcileResult {
  status: CanonicalLifecycleStatus;
  reason: LifecycleReconcileReason;
  suggestedAction: SuggestedAction;
}

export interface CompactExecutionStatusPacket {
  workContractId: string;
  attemptId?: string;
  status: CanonicalLifecycleStatus;
  reason: LifecycleReconcileReason;
  summary?: string;
  resultLocation?: string;
  artifacts: string[];
  nativeStatus?: string;
  childRunId?: string;
  childSessionKey?: string;
  elapsedMs?: number;
  expectedAt?: string;
  hardTimeoutAt?: string;
  evidence: {
    native: NativeLifecycleStatus;
    receipt: "present" | "missing";
    artifact: "present" | "missing";
    tmux?: "alive_active" | "alive_idle" | "missing" | "unavailable" | "disabled";
  };
  suggestedAction: SuggestedAction;
}

const RECENT_EVIDENCE_MS = 60_000;
const QUEUED_SOURCE_STATUSES = new Set(["queued", "materializing", "planned"]);

function hasResultEvidence(input: LifecycleReconcileInput): boolean {
  return (
    input.hasCompletionReceipt ||
    input.hasArtifactRef ||
    input.hasReportPath ||
    input.hasResultSummary ||
    input.hasDeliveryAck
  );
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isAfter(now: string, deadline: string | null): boolean {
  const nowMs = parseTimestamp(now);
  const deadlineMs = parseTimestamp(deadline);
  return nowMs !== null && deadlineMs !== null && nowMs > deadlineMs;
}

function isRecent(now: string, value: string | null): boolean {
  const nowMs = parseTimestamp(now);
  const valueMs = parseTimestamp(value);
  return nowMs !== null && valueMs !== null && valueMs <= nowMs && nowMs - valueMs <= RECENT_EVIDENCE_MS;
}

function hasAliveTmux(input: LifecycleReconcileInput): boolean {
  const tmux = input.tmuxEvidence;
  return Boolean(tmux?.enabled && tmux.available && tmux.alive);
}

function hasRecentHeartbeat(input: LifecycleReconcileInput): boolean {
  return isRecent(input.now, input.lastHeartbeatAt);
}

function hasRecentProgress(input: LifecycleReconcileInput): boolean {
  return isRecent(input.now, input.lastProgressAt);
}

function hasLiveEvidence(input: LifecycleReconcileInput): boolean {
  return input.nativeStatus === "running" || hasAliveTmux(input) || hasRecentHeartbeat(input);
}

function hasProgressEvidence(input: LifecycleReconcileInput): boolean {
  const tmux = input.tmuxEvidence;
  const hasActiveTmux = Boolean(tmux?.enabled && tmux.available && tmux.alive && tmux.outputChangedSinceLastCheck);
  return hasActiveTmux || hasRecentHeartbeat(input) || hasRecentProgress(input);
}

function hasAliveEvidence(input: LifecycleReconcileInput): boolean {
  return input.nativeStatus === "running" || hasAliveTmux(input);
}

function normalizeCurrentStatus(status: string): string {
  return status.trim().toLowerCase();
}

function mapTerminalStatus(status: string): CanonicalLifecycleStatus | null {
  switch (normalizeCurrentStatus(status)) {
    case "completed":
    case "deliverable_ready":
      return "completed";
    case "delivered":
      return "delivered";
    case "failed":
    case "canceled":
    case "cancelled":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "degraded":
      return "degraded";
    default:
      return null;
  }
}

function classifyTmuxEvidence(input: LifecycleReconcileInput): CompactExecutionStatusPacket["evidence"]["tmux"] {
  const tmux = input.tmuxEvidence;
  if (!tmux?.enabled) return undefined;
  if (!tmux.available) return "unavailable";
  if (!tmux.alive) return "missing";
  return tmux.outputChangedSinceLastCheck ? "alive_active" : "alive_idle";
}

/**
 * Reduces ledger, native, result, deadline, and progress evidence into one canonical lifecycle status.
 * This function is deterministic and performs no IO; the returned status is solely a function of `input`.
 */
export function reduceCanonicalStatus(input: LifecycleReconcileInput): LifecycleReconcileResult {
  const currentStatus = normalizeCurrentStatus(input.currentStatus);
  if (input.nativeStatus === "failed") {
    return { status: "failed", reason: "native_failed", suggestedAction: "inspect" };
  }

  if (input.nativeStatus === "timed_out") {
    return { status: "timed_out", reason: "native_timed_out", suggestedAction: "inspect" };
  }

  if (input.nativeStatus === "completed" && hasResultEvidence(input) && input.hasDeliveryAck) {
    return { status: "delivered", reason: "delivered_with_ack", suggestedAction: "deliver" };
  }

  if (input.nativeStatus === "completed" && hasResultEvidence(input)) {
    return { status: "completed", reason: "completed_with_result", suggestedAction: "deliver" };
  }

  if (input.nativeStatus === "completed" && !hasResultEvidence(input)) {
    return { status: "degraded", reason: "completed_without_result", suggestedAction: "inspect" };
  }

  if (["completed", "done", "succeeded", "deliverable_ready"].includes(currentStatus) && !hasResultEvidence(input)) {
    return { status: "degraded", reason: "completed_without_result", suggestedAction: "inspect" };
  }

  if (["completed", "done", "succeeded", "deliverable_ready"].includes(currentStatus) && hasResultEvidence(input) && input.hasDeliveryAck) {
    return { status: "delivered", reason: "delivered_with_ack", suggestedAction: "deliver" };
  }

  if (["completed", "done", "succeeded", "deliverable_ready"].includes(currentStatus) && hasResultEvidence(input)) {
    return { status: "completed", reason: "completed_with_result", suggestedAction: "deliver" };
  }

  if (isAfter(input.now, input.hardTimeoutAt) && !hasLiveEvidence(input)) {
    return { status: "timed_out", reason: "hard_timeout_no_live_evidence", suggestedAction: "stop" };
  }

  if (isAfter(input.now, input.hardTimeoutAt) && hasLiveEvidence(input)) {
    return { status: "running_slow", reason: "hard_timeout_live_evidence", suggestedAction: "inspect" };
  }

  if (isAfter(input.now, input.expectedAt) && hasProgressEvidence(input)) {
    return { status: "running_slow", reason: "expected_deadline_passed_live_output", suggestedAction: "wait" };
  }

  if (isAfter(input.now, input.expectedAt) && hasAliveEvidence(input) && !hasProgressEvidence(input)) {
    return { status: "stalled", reason: "expected_deadline_passed_no_progress", suggestedAction: "inspect" };
  }

  if (input.nativeStatus === "running") {
    return { status: "running", reason: "fresh_running", suggestedAction: "wait" };
  }

  if (QUEUED_SOURCE_STATUSES.has(normalizeCurrentStatus(input.currentStatus))) {
    return { status: "queued", reason: "no_spawn_evidence", suggestedAction: "wait" };
  }

  const preservedTerminalStatus = mapTerminalStatus(input.currentStatus);
  if (preservedTerminalStatus) {
    return { status: preservedTerminalStatus, reason: "terminal_state_preserved", suggestedAction: "inspect" };
  }

  return { status: "queued", reason: "no_dispatch_evidence", suggestedAction: "wait" };
}

export function buildCompactParentPacket(
  reconcileResult: LifecycleReconcileResult,
  input: LifecycleReconcileInput,
): CompactExecutionStatusPacket {
  const tmux = classifyTmuxEvidence(input);
  const evidence: CompactExecutionStatusPacket["evidence"] = {
    native: input.nativeStatus,
    receipt: input.hasCompletionReceipt ? "present" : "missing",
    artifact: input.hasArtifactRef ? "present" : "missing",
  };

  if (tmux) evidence.tmux = tmux;

  return {
    workContractId: input.workContractId ?? "",
    attemptId: input.attemptId,
    status: reconcileResult.status,
    reason: reconcileResult.reason,
    summary: input.summary,
    resultLocation: input.resultLocation,
    artifacts: input.artifacts ?? [],
    nativeStatus: input.nativeStatus,
    childRunId: input.childRunId,
    childSessionKey: input.childSessionKey,
    expectedAt: input.expectedAt ?? undefined,
    hardTimeoutAt: input.hardTimeoutAt ?? undefined,
    evidence,
    suggestedAction: reconcileResult.suggestedAction,
  };
}
