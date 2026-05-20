import { asBooleanStrict, asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";
import { hashSessionsSpawnArgs, type NativeSpawnIntent, type SessionsSpawnArgs } from "./native-spawn-intent.js";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";

export interface NativeSpawnGateInput {
  sessionKeys: string[];
  args: SessionsSpawnArgs;
  decision?: UnknownRecord | null;
  now?: Date;
}

export type NativeSpawnGateDecision =
  | { allowed: true; intent: NativeSpawnIntent; reason: "matched_pending_intent" }
  | {
      allowed: false;
      reason: string;
      intent?: NativeSpawnIntent;
      expectedHash?: string;
      actualHash?: string;
    };

export type NativeSessionsSendGateDecision =
  | { allowed: true; intent: NativeSpawnIntent; reason: "matched_speculative_send_intent" }
  | {
      allowed: false;
      reason: string;
      intent?: NativeSpawnIntent;
      expectedHash?: string;
      actualHash?: string;
    };

export function evaluateNativeSessionsSendGate(input: NativeSpawnGateInput): NativeSessionsSendGateDecision {
  if (executionFollowupBlocked(input.decision)) {
    return { allowed: false, reason: "execution_followup_spawn_blocked" };
  }

  const keys = uniqueSessionKeys(input.sessionKeys);
  if (keys.length === 0) return { allowed: false, reason: "missing_session_key" };

  const actualHash = hashSessionsSpawnArgs(input.args);
  let firstMismatch: NativeSessionsSendGateDecision | null = null;
  let firstTransitionFailure: NativeSessionsSendGateDecision | null = null;
  for (const sessionKey of keys) {
    let pending: NativeSpawnIntent | null;
    try {
      pending = nativeSpawnIntentStore.findPendingForSession(sessionKey, { now: input.now, dispatchMode: "send_to_speculative" });
    } catch (error) {
      firstTransitionFailure ??= { allowed: false, reason: storeErrorReason(error) };
      continue;
    }
    if (!pending) continue;
    if (pending.canonicalArgsHash !== actualHash) {
      firstMismatch ??= {
        allowed: false,
        reason: "args_hash_mismatch",
        intent: pending,
        expectedHash: pending.canonicalArgsHash,
        actualHash,
      };
      continue;
    }

    const started = nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: pending.spawnIntentId,
      sessionKey,
      sessionsSpawnArgs: input.args,
      now: input.now,
    });
    if (!started.ok) {
      firstTransitionFailure ??= { allowed: false, reason: started.error || "intent_transition_failed", intent: started.intent ?? pending };
      continue;
    }
    return { allowed: true, reason: "matched_speculative_send_intent", intent: started.intent };
  }

  return firstTransitionFailure ?? firstMismatch ?? { allowed: false, reason: "missing_pending_intent" };
}

function storeErrorReason(error: unknown): string {
  const record = asRecord(error);
  const code = asString(record.code).toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (code === "sqlite_busy" || code === "sqlite_locked" || message.includes("sqlite_busy") || message.includes("database is locked")) {
    return "sqlite_busy";
  }
  if (code === "sqlite_unavailable" || message.includes("sqlite_unavailable")) return "sqlite_unavailable";
  return "intent_store_error";
}

function uniqueSessionKeys(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => asString(value)).filter(Boolean)));
}

function executionFollowupBlocked(decision: unknown): boolean {
  const record = asRecord(decision);
  const routeDecision = asRecord(record.route_decision);
  const routerDecision = asRecord(record.router_decision_v2);
  const request = asRecord(record.request);
  const metadata = asRecord(request.metadata);
  const conversationControl = asRecord(metadata.conversation_control);
  const executionCoverage = asRecord(record._execution_coverage ?? routeDecision._execution_coverage ?? record._execution_coverage_packet);
  const coverageExecution = asRecord(asRecord(executionCoverage.coverage).execution);
  const intentClass = asString(conversationControl.intent_class || metadata.intent_class);
  const relation = asString(metadata.relation_to_recent_execution || asRecord(metadata.intent_packet).relation_to_recent_execution);

  return intentClass === "execution_followup"
    || asString(routerDecision.request_kind) === "status_or_provenance"
    || relation === "existing_execution_followup"
    || relation === "existing_execution_provenance_query"
    || asBooleanStrict(conversationControl.status_followup)
    || asBooleanStrict(conversationControl.provenance_followup)
    || asBooleanStrict(coverageExecution.supports_status_reply)
    || asBooleanStrict(coverageExecution.supports_provenance_reply);
}

function splitPlannerTaskAtRuntimePacket(value: string): { prefix: string; suffix: string } | null {
  const marker = "\n## Runtime Context Packet\n";
  const markerIndex = value.indexOf(marker);
  if (markerIndex > 0) return { prefix: value.slice(0, markerIndex), suffix: value.slice(markerIndex) };

  const doubleNewlineMarker = "\n\n## Runtime Context Packet\n";
  const doubleMarkerIndex = value.indexOf(doubleNewlineMarker);
  if (doubleMarkerIndex > 0) {
    return {
      prefix: value.slice(0, doubleMarkerIndex + 1),
      suffix: value.slice(doubleMarkerIndex + 1),
    };
  }

  return null;
}

function hasRecoverablePlannerTaskDrift(expectedTask: string, actualTask: string): boolean {
  const expectedParts = splitPlannerTaskAtRuntimePacket(expectedTask);
  const actualParts = splitPlannerTaskAtRuntimePacket(actualTask);
  if (!expectedParts || !actualParts) return false;

  const expectedPrefix = expectedParts.prefix;
  const actualPrefix = actualParts.prefix;
  const expectedSuffix = expectedParts.suffix;
  const actualSuffix = actualParts.suffix;
  if (expectedSuffix !== actualSuffix) return false;
  if (!actualPrefix.startsWith(expectedPrefix)) return false;

  const completedTail = actualPrefix.slice(expectedPrefix.length);
  if (completedTail.length === 0 || completedTail.length > 256) return false;
  return !/```|## Runtime Context Packet|Operational rules:|Rules:|Task:|workContractId:|delegateTaskId:|attemptId:/iu.test(completedTail);
}

function hasRecoverablePlannerArgsDrift(expected: SessionsSpawnArgs, actual: SessionsSpawnArgs, expectedHash: string): boolean {
  const expectedTask = asString(expected.task);
  const actualTask = asString(actual.task);
  if (!expectedTask || !actualTask) return false;
  if (expectedTask === actualTask) {
    return hashSessionsSpawnArgs({ ...actual, label: expected.label }) === expectedHash;
  }
  if (!hasRecoverablePlannerTaskDrift(expectedTask, actualTask)) return false;
  return hashSessionsSpawnArgs({ ...actual, task: expectedTask }) === expectedHash
    || hashSessionsSpawnArgs({ ...actual, task: expectedTask, label: expected.label }) === expectedHash;
}

export function evaluateNativeSpawnGate(input: NativeSpawnGateInput): NativeSpawnGateDecision {
  if (executionFollowupBlocked(input.decision)) {
    return { allowed: false, reason: "execution_followup_spawn_blocked" };
  }

  const keys = uniqueSessionKeys(input.sessionKeys);
  if (keys.length === 0) return { allowed: false, reason: "missing_session_key" };

  const actualHash = hashSessionsSpawnArgs(input.args);
  let firstMismatch: NativeSpawnGateDecision | null = null;
  let firstTransitionFailure: NativeSpawnGateDecision | null = null;
  for (const sessionKey of keys) {
    let pending: NativeSpawnIntent | null;
    try {
      pending = nativeSpawnIntentStore.findPendingForSession(sessionKey, { now: input.now, dispatchMode: "new_spawn" });
    } catch (error) {
      firstTransitionFailure ??= { allowed: false, reason: storeErrorReason(error) };
      continue;
    }
    if (!pending) continue;
    const recoverableArgsDrift = pending.canonicalArgsHash !== actualHash
      && hasRecoverablePlannerArgsDrift(pending.sessionsSpawnArgs, input.args, pending.canonicalArgsHash);
    if (pending.canonicalArgsHash !== actualHash && !recoverableArgsDrift) {
      firstMismatch ??= {
        allowed: false,
        reason: "args_hash_mismatch",
        intent: pending,
        expectedHash: pending.canonicalArgsHash,
        actualHash,
      };
      continue;
    }

    const started = nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: pending.spawnIntentId,
      sessionKey,
      sessionsSpawnArgs: recoverableArgsDrift ? pending.sessionsSpawnArgs : input.args,
      now: input.now,
    });
    if (!started.ok) {
      firstTransitionFailure ??= { allowed: false, reason: started.error || "intent_transition_failed", intent: started.intent ?? pending };
      continue;
    }
    return { allowed: true, reason: "matched_pending_intent", intent: started.intent };
  }

  return firstTransitionFailure ?? firstMismatch ?? { allowed: false, reason: "missing_pending_intent" };
}
