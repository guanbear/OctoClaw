import { resolveSpawnBackend, resolveSpeculativePreloadEnabled } from "../config/index.js";
import {
  buildSpeculativePreloadHint,
  buildSpeculativePreloadLabel,
  buildSpeculativePreloadSpawnArgs,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
  speculativePreloadStateForHint,
} from "../delegate/speculative-preload.js";
import { resolvePlannerNativeCwd } from "../delegate/planner-cwd.js";
import type { LoggerLike } from "../extension-entry-shared.js";
import { firstNonEmptyString, stringValue, toolResultRecord } from "../extension-entry-shared.js";
import { isDelegatedRoute } from "../replay/policy-utils.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { resolvePolicyStateKeys } from "../resolve/session.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";

export function isAcceptedSpeculativeSpawnResult(result: unknown): boolean {
  const record = toolResultRecord(result);
  return stringValue(record.status) === "accepted"
    && Boolean(firstNonEmptyString(record.runId, record.run_id, record.childRunId, record.child_run_id, record.childSessionKey, record.child_session_key));
}

export function speculativeSpawnResultError(result: unknown, fallback?: unknown): string {
  const record = toolResultRecord(result);
  return firstNonEmptyString(record.error, fallback, "speculative_preload_spawn_not_accepted");
}

export function speculativePreloadThreadBindingUnavailable(error: unknown): boolean {
  const text = stringValue(error).toLowerCase();
  if (!text) return false;
  return (
    text.includes("sessions_spawn(mode=\"session\")")
    && (text.includes("thread binding") || text.includes("thread bindings"))
    && (text.includes("not running on a channel") || text.includes("unavailable") || text.includes("disabled"))
  ) || (
    text.includes("thread=true")
    && (text.includes("thread binding") || text.includes("thread bindings"))
    && text.includes("not running on a channel")
  );
}

export function maybeInjectSpeculativePreload(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  route: string;
  prompt: string;
  prependSystem: string[];
  pluginConfig?: UnknownRecord;
  logger?: LoggerLike;
}): UnknownRecord {
  if (!resolveSpeculativePreloadEnabled(input.pluginConfig)) return input.state;
  const spawnBackend = resolveSpawnBackend();
  if (spawnBackend !== "planner") {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      reason: "spawn_backend_not_planner",
      spawn_backend: spawnBackend,
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const routeDecisionRoute = stringValue(asRecord(input.decision.route_decision).route);
  const delegateRoute = input.route === "delegate" || routeDecisionRoute === "delegate" || isDelegatedRoute(input.decision);
  if (!input.stateKey || !delegateRoute) {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: !input.stateKey ? "missing_state_key" : "route_not_delegate",
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const existing = readSpeculativePreloadState(input.state);
  if (existing?.status === "stale" && speculativePreloadThreadBindingUnavailable(existing.error)) {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: "thread_binding_unavailable",
      status: existing.status,
      label: existing.label,
      error: existing.error || "",
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  if (existing?.label && existing.status !== "stale") {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: "existing_speculative_state",
      status: existing.status,
      label: existing.label,
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const label = buildSpeculativePreloadLabel({
    stateKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    inboundMessageTs: stringValue(input.state.inboundMessageTs || input.state.inbound_message_ts || input.ctx.messageTs || input.ctx.message_ts),
    prompt: input.prompt,
    nonce: stringValue(existing?.updatedAt || input.state.updatedAt || input.state.updated_at || input.state.createdAt || input.state.created_at || Date.now()),
  });
  const spawnArgs = buildSpeculativePreloadSpawnArgs({
    label,
    model: stringValue(asRecord(input.decision.route_decision).model || asRecord(input.decision.route_decision).worker_model),
    cwd: resolvePlannerNativeCwd(stringValue(input.ctx.cwd)),
  });
  const speculative = speculativePreloadStateForHint({ label, spawnArgs });
  const serialized = serializeSpeculativePreloadState(speculative);
  const nextState = {
    ...input.state,
    speculativePreload: serialized,
    speculative_preload: serialized,
  };
  const aliasKeys = Array.from(new Set([
    input.stateKey,
    ...resolvePolicyStateKeys(input.ctx),
  ].map((value) => stringValue(value)).filter(Boolean)));
  for (const key of aliasKeys) {
    policyState.set(key, nextState as PolicyStateEntry);
  }
  input.prependSystem.push(buildSpeculativePreloadHint(spawnArgs));
  void recordPolicyReplay("speculative_preload_hint_injected", {
    sessionKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    label,
    route: stringValue(asRecord(input.decision.route_decision).route),
    decision_bucket: stringValue(asRecord(input.decision.route_decision).decision_bucket),
    alias_count: aliasKeys.length,
  }, input.logger, input.decision).catch(() => {});
  return nextState;
}
