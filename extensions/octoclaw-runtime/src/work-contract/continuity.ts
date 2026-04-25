import type {
  ChildSessionContinuity,
  ChildSessionStatus,
  ChildReuseState,
  ContinuationPreferredMode,
  ProviderSessionBinding,
  WorkContract,
} from "@octoclaw/contracts/work-contract";
import { updateWorkContract } from "./store.js";

export interface SelectPreferredChildSessionResult {
  selected: ChildSessionContinuity | null;
  reason: string;
}

export function selectPreferredChildSession(
  contract: WorkContract,
  requestedMode?: ContinuationPreferredMode,
): SelectPreferredChildSessionResult {
  if (requestedMode === "new_attempt") {
    return { selected: null, reason: "new_attempt_requested" };
  }

  if (requestedMode === "status_only") {
    const preferred = findPreferredSession(contract);
    return preferred
      ? { selected: preferred, reason: "status_only_with_preferred" }
      : { selected: null, reason: "no_preferred_available" };
  }

  const preferred = findPreferredSession(contract);
  if (preferred) {
    return { selected: preferred, reason: "preferred_child_session_found" };
  }

  const eligible = findEligibleSession(contract);
  if (eligible) {
    return { selected: eligible, reason: "eligible_child_session_promoted" };
  }

  return { selected: null, reason: "no_reusable_child_session" };
}

export interface MarkChildSessionPreferredInput {
  workContractId: string;
  ledgerPath?: string;
  childSessionKey: string;
  delegateTaskId: string;
  attemptId: string;
  agentRole: string;
  modelProfile: string;
  parentSessionKey: string;
  threadBindingKey: string;
  scopeFingerprint: string;
  childSessionId?: string;
  runId?: string;
  providerSessionBinding?: ProviderSessionBinding;
  expectsCompletionMessage?: boolean;
  directThreadDelivery?: boolean;
  category?: string;
}

export function markChildSessionPreferred(input: MarkChildSessionPreferredInput): WorkContract | null {
  return updateWorkContract(
    input.workContractId,
    (contract) => {
      const now = new Date().toISOString();
      const existing = contract.delegate?.childSessions ?? [];

      const demoted = existing.map((session) =>
        session.reuseState === "preferred"
          ? { ...session, reuseState: "eligible" as ChildReuseState }
          : session,
      );

      const existingEntry = demoted.find(
        (session) => session.childSessionKey === input.childSessionKey,
      );

      let updatedSessions: ChildSessionContinuity[];
      if (existingEntry) {
        updatedSessions = demoted.map((session) =>
          session.childSessionKey === input.childSessionKey
            ? {
                ...session,
                reuseState: "preferred" as ChildReuseState,
                latestAttemptId: input.attemptId,
                status: "running" as ChildSessionStatus,
                lastEventAt: now,
                ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
                ...(input.runId !== undefined ? { runId: input.runId } : {}),
                ...(input.providerSessionBinding !== undefined ? { providerSessionBinding: input.providerSessionBinding } : {}),
                ...(input.expectsCompletionMessage !== undefined ? { expectsCompletionMessage: input.expectsCompletionMessage } : {}),
                ...(input.directThreadDelivery !== undefined ? { directThreadDelivery: input.directThreadDelivery } : {}),
              }
            : session,
        );
      } else {
        const newSession: ChildSessionContinuity = {
          childSessionKey: input.childSessionKey,
          delegateTaskId: input.delegateTaskId,
          firstAttemptId: input.attemptId,
          latestAttemptId: input.attemptId,
          agentRole: input.agentRole,
          modelProfile: input.modelProfile,
          parentSessionKey: input.parentSessionKey,
          threadBindingKey: input.threadBindingKey,
          scopeFingerprint: input.scopeFingerprint,
          status: "running",
          reuseState: "preferred",
          lastEventAt: now,
          ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.providerSessionBinding !== undefined ? { providerSessionBinding: input.providerSessionBinding } : {}),
          ...(input.expectsCompletionMessage !== undefined ? { expectsCompletionMessage: input.expectsCompletionMessage } : {}),
          ...(input.directThreadDelivery !== undefined ? { directThreadDelivery: input.directThreadDelivery } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
        };
        updatedSessions = [...demoted, newSession];
      }

      const delegate = contract.delegate
        ? { ...contract.delegate, childSessions: updatedSessions }
        : undefined;

      const resolvedChildSessionId = input.childSessionId
        ?? existingEntry?.childSessionId
        ?? contract.continuity.preferredChildSessionId;
      const resolvedRunId = input.runId
        ?? existingEntry?.runId
        ?? contract.continuity.preferredRunId;

      const continuity = {
        ...contract.continuity,
        preferredChildSessionKey: input.childSessionKey,
        preferredChildSessionId: resolvedChildSessionId,
        preferredRunId: resolvedRunId,
        delegateTaskId: input.delegateTaskId,
      };

      const mainContext = {
        ...contract.mainContext,
        visibleIds: {
          ...contract.mainContext.visibleIds,
          childSessionKey: input.childSessionKey,
          childSessionId: resolvedChildSessionId,
        },
      };

      return {
        ...contract,
        delegate,
        continuity,
        mainContext,
        updatedAt: now,
      };
    },
    input.ledgerPath,
  );
}

export interface MarkChildSessionRetiredInput {
  workContractId: string;
  ledgerPath?: string;
  childSessionKey: string;
  reason: "contamination" | "wrong_scope" | "corrupt_context" | "superseded";
}

export function markChildSessionRetired(input: MarkChildSessionRetiredInput): WorkContract | null {
  return updateWorkContract(
    input.workContractId,
    (contract) => {
      const now = new Date().toISOString();
      const sessions = contract.delegate?.childSessions ?? [];

      const updatedSessions = sessions.map((session) =>
        session.childSessionKey === input.childSessionKey
          ? {
              ...session,
              reuseState: "retired" as ChildReuseState,
              status: "retired" as ChildSessionStatus,
              reuseBlockedReason: input.reason,
              lastEventAt: now,
            }
          : session,
      );

      const wasPreferred = contract.continuity.preferredChildSessionKey === input.childSessionKey;
      const continuity = wasPreferred
        ? {
            ...contract.continuity,
            preferredChildSessionKey: undefined,
            preferredChildSessionId: undefined,
            preferredRunId: undefined,
          }
        : contract.continuity;

      const delegate = contract.delegate
        ? { ...contract.delegate, childSessions: updatedSessions }
        : undefined;

      return {
        ...contract,
        delegate,
        continuity,
        updatedAt: now,
      };
    },
    input.ledgerPath,
  );
}

export function buildContinuationHandle(contract: WorkContract): string | undefined {
  const childSessionKey = contract.continuity.preferredChildSessionKey
    ?? contract.delegate?.nativeBinding?.childSessionKey;

  if (!childSessionKey) return undefined;

  const delegateTaskId = contract.delegate?.delegateTaskId ?? contract.continuity.delegateTaskId ?? "";
  const parts = [
    `workContractId=${contract.workContractId}`,
    `delegateTaskId=${delegateTaskId}`,
    `childSessionKey=${childSessionKey}`,
  ];

  const childSessionId = contract.continuity.preferredChildSessionId;
  if (childSessionId) {
    parts.push(`childSessionId=${childSessionId}`);
  }

  return `resume_dont_restart: ${parts.join(", ")}`;
}

function findPreferredSession(contract: WorkContract): ChildSessionContinuity | null {
  const sessions = contract.delegate?.childSessions ?? [];
  const preferred = sessions.find(
    (session) => session.reuseState === "preferred" && isSessionReusable(session) && isSessionCompatible(session, contract),
  );
  return preferred ?? null;
}

function findEligibleSession(contract: WorkContract): ChildSessionContinuity | null {
  const sessions = contract.delegate?.childSessions ?? [];
  const eligible = sessions.find(
    (session) => session.reuseState === "eligible" && isSessionReusable(session) && isSessionCompatible(session, contract),
  );
  return eligible ?? null;
}

function isSessionReusable(session: ChildSessionContinuity): boolean {
  return session.status !== "retired"
    && session.status !== "failed"
    && session.status !== "blocked";
}

function isSessionCompatible(session: ChildSessionContinuity, contract: WorkContract): boolean {
  const delegateTaskId = contract.delegate?.delegateTaskId;
  const scopeFingerprint = contract.delegate?.scope.scopeFingerprint;
  if (delegateTaskId && session.delegateTaskId !== delegateTaskId) return false;
  if (scopeFingerprint && session.scopeFingerprint !== scopeFingerprint) return false;
  return true;
}
