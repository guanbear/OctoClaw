import { hashSessionsSpawnArgs, type NativeSpawnIntent, type SessionsSpawnArgs } from "./native-spawn-intent.js";
import { nativeSpawnIntentStore } from "./native-spawn-intent-store.js";

type UnknownRecord = Record<string, unknown>;

export interface NativeSpawnGateInput {
  sessionKeys: string[];
  args: SessionsSpawnArgs;
  decision?: UnknownRecord | null;
  now?: Date;
}

export type NativeSpawnGateDecision =
  | { allowed: true; intent: NativeSpawnIntent; reason: "matched_pending_intent" }
  | { allowed: false; reason: string; intent?: NativeSpawnIntent; expectedHash?: string; actualHash?: string };

function asRecord(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function uniqueSessionKeys(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => asString(value)).filter(Boolean)));
}

function executionFollowupBlocked(decision: UnknownRecord | null | undefined): boolean {
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
    || asBoolean(conversationControl.status_followup)
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(coverageExecution.supports_status_reply)
    || asBoolean(coverageExecution.supports_provenance_reply);
}

export function evaluateNativeSpawnGate(input: NativeSpawnGateInput): NativeSpawnGateDecision {
  if (executionFollowupBlocked(input.decision)) {
    return { allowed: false, reason: "execution_followup_spawn_blocked" };
  }
  const keys = uniqueSessionKeys(input.sessionKeys);
  if (keys.length === 0) return { allowed: false, reason: "missing_session_key" };
  const actualHash = hashSessionsSpawnArgs(input.args);
  for (const sessionKey of keys) {
    const pending = nativeSpawnIntentStore.findPendingForSession(sessionKey, { now: input.now });
    if (!pending) continue;
    if (pending.canonicalArgsHash !== actualHash) {
      return {
        allowed: false,
        reason: "args_hash_mismatch",
        intent: pending,
        expectedHash: pending.canonicalArgsHash,
        actualHash,
      };
    }
    const started = nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId: pending.spawnIntentId,
      sessionKey,
      sessionsSpawnArgs: input.args,
      now: input.now,
    });
    if (!started.ok || !started.intent) {
      return { allowed: false, reason: started.error || "intent_transition_failed", intent: started.intent ?? pending };
    }
    return { allowed: true, reason: "matched_pending_intent", intent: started.intent };
  }
  return { allowed: false, reason: "missing_pending_intent" };
}
