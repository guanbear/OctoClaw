import { asBooleanStrict, asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";
import { hashSessionsSpawnArgs, type NativeSpawnIntent, type SessionsSpawnArgs } from "./native-spawn-intent.js";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";

export interface NativeSpawnGateInput {
  sessionKeys: string[];
  args: SessionsSpawnArgs;
  decision?: UnknownRecord | null;
  now?: Date;
  expectedWorkContractId?: string;
}

export type NativeSpawnGateDecision =
  | {
      allowed: true;
      intent: NativeSpawnIntent;
      reason: "matched_pending_intent";
      canonicalArgs?: SessionsSpawnArgs;
      expectedHash?: string;
      actualHash?: string;
    }
  | {
      allowed: false;
      reason: string;
      intent?: NativeSpawnIntent;
      expectedHash?: string;
      actualHash?: string;
    };

export type NativeSessionsSendGateDecision =
  | {
      allowed: true;
      intent: NativeSpawnIntent;
      reason: "matched_speculative_send_intent";
      canonicalArgs?: SessionsSpawnArgs;
      expectedHash?: string;
      actualHash?: string;
    }
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
      pending = nativeSpawnIntentStore.findPendingMatchingForSession(sessionKey, { now: input.now, dispatchMode: "send_to_speculative", argsHash: actualHash })
        ?? nativeSpawnIntentStore.findPendingForSession(sessionKey, { now: input.now, dispatchMode: "send_to_speculative" });
    } catch (error) {
      firstTransitionFailure ??= { allowed: false, reason: storeErrorReason(error) };
      continue;
    }
    if (!pending) continue;
    const canonicalizedArgs = pending.canonicalArgsHash !== actualHash;
    if (canonicalizedArgs && !shouldCanonicalizePendingArgsDrift(pending, input.args, input.expectedWorkContractId)) {
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
      sessionsSpawnArgs: canonicalizedArgs ? pending.sessionsSpawnArgs : input.args,
      now: input.now,
    });
    if (!started.ok) {
      firstTransitionFailure ??= { allowed: false, reason: started.error || "intent_transition_failed", intent: started.intent ?? pending };
      continue;
    }
    return {
      allowed: true,
      reason: "matched_speculative_send_intent",
      intent: started.intent,
      ...(canonicalizedArgs ? {
        canonicalArgs: pending.sessionsSpawnArgs,
        expectedHash: pending.canonicalArgsHash,
        actualHash,
      } : {}),
    };
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
  if (hasRecoverableOmittedRuntimePacketDrift(expectedTask, actualTask)) return true;
  if (hasRecoverablePlannerEnvelopeDrift(expectedTask, actualTask)) return true;

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

function hasRecoverablePlannerEnvelopeDrift(expectedTask: string, actualTask: string): boolean {
  if (!expectedTask.startsWith("[OctoClaw delegated work]")) return false;
  if (!actualTask.startsWith("[OctoClaw delegated work]")) return false;
  if (!expectedTask.includes("\n## Runtime Context Packet\n") || !actualTask.includes("\n## Runtime Context Packet\n")) return false;

  for (const field of ["workContractId", "delegateTaskId", "attemptId"] as const) {
    const expectedValue = plannerHeaderField(expectedTask, field);
    const actualValue = plannerHeaderField(actualTask, field);
    if (!expectedValue || expectedValue !== actualValue) return false;
  }

  const expectedTerminalTask = extractTerminalPlannerTask(expectedTask);
  const actualTerminalTask = extractTerminalPlannerTask(actualTask);
  if (!expectedTerminalTask || expectedTerminalTask !== actualTerminalTask) return false;

  const requiredActualSafetyMarkers = [
    "## Runtime Context Packet",
    "Native announce handles final delivery",
    "If you are blocked, include exactly one control block",
    "Rules:",
    "Work only on the task below",
    "do not expose hidden reasoning or raw transcript",
  ];
  return requiredActualSafetyMarkers.every((marker) => actualTask.includes(marker));
}

function plannerHeaderField(value: string, field: "workContractId" | "delegateTaskId" | "attemptId"): string {
  const match = value.match(new RegExp(`^${field}:\\s*(.+)$`, "imu"));
  return asString(match?.[1]);
}

function normalizePlannerTaskForComparison(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function extractTerminalPlannerTask(value: string): string {
  const marker = "\nTask:\n";
  const index = value.lastIndexOf(marker);
  return index >= 0 ? normalizePlannerTaskForComparison(value.slice(index + marker.length)) : "";
}

function hasRecoverableOmittedRuntimePacketDrift(expectedTask: string, actualTask: string): boolean {
  if (!expectedTask.startsWith("[OctoClaw delegated work]")) return false;
  if (!actualTask.startsWith("[OctoClaw delegated work]")) return false;
  if (!expectedTask.includes("\n## Runtime Context Packet\n")) return false;
  if (actualTask.includes("## Runtime Context Packet") || actualTask.includes("```")) return false;

  const expectedWorkContractId = plannerHeaderField(expectedTask, "workContractId");
  const actualWorkContractId = plannerHeaderField(actualTask, "workContractId");
  const expectedDelegateTaskId = plannerHeaderField(expectedTask, "delegateTaskId");
  const actualDelegateTaskId = plannerHeaderField(actualTask, "delegateTaskId");
  const expectedAttemptId = plannerHeaderField(expectedTask, "attemptId");
  const actualAttemptId = plannerHeaderField(actualTask, "attemptId");
  if (!expectedWorkContractId || expectedWorkContractId !== actualWorkContractId) return false;
  if (!expectedDelegateTaskId || expectedDelegateTaskId !== actualDelegateTaskId) return false;
  if (expectedAttemptId && expectedAttemptId !== actualAttemptId) return false;

  const terminalTask = extractTerminalPlannerTask(expectedTask);
  if (!terminalTask) return false;
  const actualNormalized = normalizePlannerTaskForComparison(actualTask);
  return actualNormalized.endsWith(terminalTask) || actualNormalized.includes(`Expected deliverable:\n${terminalTask}`);
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

function argsTopLevelReferencePendingIntent(actual: SessionsSpawnArgs, pending: NativeSpawnIntent): boolean {
  const record = asRecord(actual);
  const exactRefs = [
    record.spawnIntentId,
    record.spawn_intent_id,
    record.workContractId,
    record.work_contract_id,
    record.delegateTaskId,
    record.delegate_task_id,
    record.attemptId,
    record.attempt_id,
  ].map((value) => asString(value)).filter(Boolean);
  if (exactRefs.includes(pending.spawnIntentId) || exactRefs.includes(pending.workContractId)) return true;
  if (pending.delegateTaskId && exactRefs.includes(pending.delegateTaskId)) return true;
  if (pending.attemptId && exactRefs.includes(pending.attemptId)) return true;
  return false;
}

function expectedWorkContractMatchesPending(pending: NativeSpawnIntent, expectedWorkContractId: unknown): boolean {
  const expected = asString(expectedWorkContractId);
  return Boolean(expected && expected === pending.workContractId);
}

function shouldCanonicalizePendingArgsDrift(pending: NativeSpawnIntent, actual: SessionsSpawnArgs, expectedWorkContractId?: string): boolean {
  return hasRecoverablePlannerArgsDrift(pending.sessionsSpawnArgs, actual, pending.canonicalArgsHash)
    || argsTopLevelReferencePendingIntent(actual, pending)
    || expectedWorkContractMatchesPending(pending, expectedWorkContractId);
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
      pending = nativeSpawnIntentStore.findPendingMatchingForSession(sessionKey, { now: input.now, dispatchMode: "new_spawn", argsHash: actualHash })
        ?? nativeSpawnIntentStore.findPendingForSession(sessionKey, { now: input.now, dispatchMode: "new_spawn" });
    } catch (error) {
      firstTransitionFailure ??= { allowed: false, reason: storeErrorReason(error) };
      continue;
    }
    if (!pending) continue;
    const canonicalizedArgs = pending.canonicalArgsHash !== actualHash;
    if (canonicalizedArgs && !shouldCanonicalizePendingArgsDrift(pending, input.args, input.expectedWorkContractId)) {
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
      sessionsSpawnArgs: canonicalizedArgs ? pending.sessionsSpawnArgs : input.args,
      now: input.now,
    });
    if (!started.ok) {
      firstTransitionFailure ??= { allowed: false, reason: started.error || "intent_transition_failed", intent: started.intent ?? pending };
      continue;
    }
    return {
      allowed: true,
      reason: "matched_pending_intent",
      intent: started.intent,
      ...(canonicalizedArgs ? {
        canonicalArgs: pending.sessionsSpawnArgs,
        expectedHash: pending.canonicalArgsHash,
        actualHash,
      } : {}),
    };
  }

  return firstTransitionFailure ?? firstMismatch ?? { allowed: false, reason: "missing_pending_intent" };
}
