import type { RuntimeWorkflowState } from "../workflow/index.js";
import { markWorkflowForRecovery, markWorkflowTimedOut } from "../workflow/index.js";
import { canClaim } from "../tasks/claims.js";
import {
  enforceableDeadlinesForPhase,
  nextDeadlineToEnforce,
  type RuntimeDeadlines,
  type RuntimeDeadlinePhase,
} from "../tasks/deadlines.js";

export type RecoveryTrigger =
  | "claim_conflict"
  | "lease_expired"
  | "queue_deadline_exceeded"
  | "start_deadline_exceeded"
  | "progress_deadline_exceeded"
  | "runtime_deadline_exceeded"
  | "delivery_deadline_exceeded";

export interface RecoveryAssessment {
  required: boolean;
  trigger: RecoveryTrigger | null;
  timedOut: boolean;
  deadlineField: keyof RuntimeDeadlines | null;
  reason: string;
}

const DEADLINE_TRIGGER_MAP: Record<keyof RuntimeDeadlines, RecoveryTrigger> = {
  queueDeadline: "queue_deadline_exceeded",
  startDeadline: "start_deadline_exceeded",
  progressDeadline: "progress_deadline_exceeded",
  runtimeDeadline: "runtime_deadline_exceeded",
  deliveryDeadline: "delivery_deadline_exceeded",
};

function deadlinePhaseForWorkflow(state: RuntimeWorkflowState): RuntimeDeadlinePhase {
  if (state.lifecycle.phase === "completed" || state.lifecycle.phase === "failed") {
    return "terminal";
  }

  if (state.lifecycle.phase === "deliverable_ready" || state.lifecycle.phase === "delivery_pending") {
    return "delivery";
  }

  if (state.lifecycle.phase === "checkpoint_pending" || state.lifecycle.phase === "checkpoint_emitted") {
    return "checkpoint";
  }

  if (state.lifecycle.phase === "running") {
    return "running";
  }

  return "pre_start";
}

export function assessRecoveryNeed(state: RuntimeWorkflowState, now = new Date()): RecoveryAssessment {
  const deadlineField = nextDeadlineToEnforce(
    state.deadlines,
    now,
    enforceableDeadlinesForPhase(deadlinePhaseForWorkflow(state)),
  );
  if (deadlineField) {
    return {
      required: true,
      trigger: DEADLINE_TRIGGER_MAP[deadlineField],
      timedOut: true,
      deadlineField,
      reason: DEADLINE_TRIGGER_MAP[deadlineField],
    };
  }

  if (state.claim && canClaim(state.claim, now)) {
    return {
      required: true,
      trigger: "lease_expired",
      timedOut: false,
      deadlineField: null,
      reason: "lease_expired",
    };
  }

  return {
    required: false,
    trigger: null,
    timedOut: false,
    deadlineField: null,
    reason: "workflow_healthy",
  };
}

export function applyRecoveryHook(
  state: RuntimeWorkflowState,
  now = new Date(),
): RuntimeWorkflowState {
  const assessment = assessRecoveryNeed(state, now);
  if (!assessment.required) {
    return state;
  }

  if (assessment.timedOut) {
    const failedAt = now.toISOString();
    return markWorkflowTimedOut(state, failedAt, failedAt);
  }

  return markWorkflowForRecovery(state);
}
