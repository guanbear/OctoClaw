import { resolveSpeculativePreloadEnabled } from "../config/index.js";
import { confirmNativeSpawn } from "../delegate/native-spawn-confirm.js";
import {
  isMatchingSpeculativePreloadSpawn,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { isManagedAgentContext, resolvePolicyStateKeys } from "../resolve/session.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { policyState } from "../state/policy-state.js";
import { recordRuntimeHealthCall } from "../router-lite/health-recorder.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import {
  firstNonEmptyString,
  stringValue,
  toolResultRecord,
} from "../extension-entry-shared.js";
import {
  getPolicyStateForContext,
  isAcceptedSpeculativeSpawnResult,
  speculativeSpawnResultError,
  updatePolicyState,
} from "../extension-entry.js";

export interface AfterToolCallDeps {
  pi: PluginInterface;
  currentPluginConfig: () => UnknownRecord;
}

async function autoConfirmPlannerSpawn(input: {
  ctx: UnknownRecord;
  state: UnknownRecord;
  stateKey: string;
  resultRecord: UnknownRecord;
  accepted: boolean;
  logger: PluginInterface["logger"];
}): Promise<void> {
  const spawnIntentId = firstNonEmptyString(input.state.spawnIntentId, input.state.spawn_intent_id);
  const workContractId = firstNonEmptyString(input.state.workContractId, input.state.work_contract_id);
  if (!input.accepted || !spawnIntentId || !workContractId) return;

  const decision = asRecord(input.state.decision);
  const sessionKey = firstNonEmptyString(
    asRecord(decision.request).session_key,
    input.ctx.sessionKey,
    input.ctx.canonicalSessionKey,
    input.stateKey,
  );
  const runId = firstNonEmptyString(
    input.resultRecord.runId,
    input.resultRecord.run_id,
    input.resultRecord.childRunId,
    input.resultRecord.child_run_id,
  );
  if (!runId) return;

  const childRunId = firstNonEmptyString(input.resultRecord.childRunId, input.resultRecord.child_run_id, runId);
  const childSessionKey = firstNonEmptyString(
    input.resultRecord.childSessionKey,
    input.resultRecord.child_session_key,
    input.resultRecord.sessionKey,
    input.resultRecord.session_key,
  );
  const confirmed = await confirmNativeSpawn({
    spawnIntentId,
    workContractId,
    sessionKey,
    stateKey: input.stateKey,
    sessionsSpawnStatus: "accepted",
    runId,
    childRunId,
    childSessionKey,
    modelId: firstNonEmptyString(input.resultRecord.model, input.resultRecord.modelId, input.resultRecord.model_id),
    cwd: stringValue(input.ctx.cwd) || undefined,
    decision,
  });
  await recordPolicyReplay("sessions_spawn_auto_confirm_completed", {
    sessionKey,
    stateKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    spawn_intent_id: spawnIntentId,
    work_contract_id: workContractId,
    ok: confirmed.ok,
    confirm_status: confirmed.status,
    error: stringValue(confirmed.error),
    run_id: stringValue(confirmed.runId),
    child_run_id: stringValue(confirmed.childRunId),
    child_session_key: stringValue(confirmed.childSessionKey),
    ack_sent: confirmed.ackSent === true,
    ack_skipped: confirmed.ackSkipped === true,
  }, input.logger, decision).catch(() => {});
}

export function makeAfterToolCallHook(deps: AfterToolCallDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    if (!isManagedAgentContext(ctx)) return;
    const toolName = stringValue(event.toolName || ctx.toolName);
    if (toolName !== "sessions_spawn") return;
    const toolParams = asRecord(event.params || event.arguments || event.input);
    const { key: resolvedStateKey, state: resolvedState } = getPolicyStateForContext(ctx);
    const result = event.result;
    const resultRecord = toolResultRecord(result);
    const accepted = !stringValue(event.error) && isAcceptedSpeculativeSpawnResult(result);
    recordRuntimeHealthCall({
      event,
      ctx,
      state: resolvedState,
      stateKey: resolvedStateKey,
      model: firstNonEmptyString(toolParams.model, resultRecord.model),
      success: accepted,
      toolCallFailed: !accepted,
      logger: deps.pi.logger,
    });
    await autoConfirmPlannerSpawn({
      ctx,
      state: asRecord(resolvedState),
      stateKey: resolvedStateKey,
      resultRecord,
      accepted,
      logger: deps.pi.logger,
    }).catch((error) => {
      void recordPolicyReplay("sessions_spawn_auto_confirm_failed", {
        sessionKey: resolvedStateKey,
        sessionId: stringValue(ctx.sessionId),
        error: error instanceof Error ? error.message : String(error),
      }, deps.pi.logger, asRecord(resolvedState?.decision)).catch(() => {});
    });
    if (!resolveSpeculativePreloadEnabled(deps.currentPluginConfig())) return;
    const candidateKeys = Array.from(new Set([
      resolvedStateKey,
      ...resolvePolicyStateKeys(ctx),
    ].map((value) => stringValue(value)).filter(Boolean)));
    const matches: Array<{ key: string; state: UnknownRecord; speculative: NonNullable<ReturnType<typeof readSpeculativePreloadState>> }> = [];
    for (const key of candidateKeys) {
      const candidateState = asRecord(policyState.get(key));
      const speculative = readSpeculativePreloadState(candidateState);
      if (!speculative || (speculative.status !== "spawn_call_started" && speculative.status !== "hinted")) continue;
      if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
      matches.push({ key, state: candidateState, speculative });
    }
    if (resolvedStateKey && matches.length === 0) {
      const speculative = readSpeculativePreloadState(resolvedState);
      if (
        (speculative?.status === "spawn_call_started" || speculative?.status === "hinted")
        && isMatchingSpeculativePreloadSpawn(resolvedState, toolParams)
      ) {
        matches.push({ key: resolvedStateKey, state: asRecord(resolvedState), speculative });
      }
    }
    if (matches.length === 0) {
      for (const entry of policyState.entries()) {
        const candidateState = asRecord(entry.state);
        const speculative = readSpeculativePreloadState(candidateState);
        if (speculative?.status !== "spawn_call_started" && speculative?.status !== "hinted") continue;
        if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
        matches.push({ key: entry.key, state: candidateState, speculative });
      }
    }
    if (matches.length === 0) return;

    const now = Date.now();
    const runId = firstNonEmptyString(resultRecord.runId, resultRecord.run_id, resultRecord.childRunId, resultRecord.child_run_id) || undefined;
    const childSessionKey = firstNonEmptyString(resultRecord.childSessionKey, resultRecord.child_session_key, resultRecord.sessionKey, resultRecord.session_key) || undefined;
    const error = accepted ? undefined : speculativeSpawnResultError(result, event.error);
    for (const match of matches) {
      const nextSpeculative = serializeSpeculativePreloadState({
        ...match.speculative,
        status: accepted ? "ready" : "stale",
        updatedAt: now,
        runId,
        childSessionKey,
        error,
      });
      updatePolicyState(match.key, (current) => ({
        ...current,
        speculativePreload: nextSpeculative,
        speculative_preload: nextSpeculative,
      }));
    }
    const preferredReplayKeys = new Set([
      stringValue(ctx.sessionKey),
      stringValue(ctx.canonicalSessionKey),
      stringValue(resolvedStateKey),
    ].filter(Boolean));
    const replayMatch = matches.find((match) => preferredReplayKeys.has(match.key)) || matches[0];
    const replaySessionKey = stringValue(ctx.sessionKey) || stringValue(ctx.canonicalSessionKey) || replayMatch.key;
    await recordPolicyReplay(accepted ? "speculative_preload_spawn_ready" : "speculative_preload_spawn_failed", {
      sessionKey: replaySessionKey,
      sessionId: stringValue(ctx.sessionId),
      toolName,
      label: replayMatch.speculative.label,
      status: stringValue(resultRecord.status),
      run_id: runId || "",
      child_session_key: childSessionKey || "",
      error: error || "",
      alias_count: matches.length,
      durationMs: Number(event.durationMs) || 0,
    }, deps.pi.logger, asRecord(replayMatch.state?.decision)).catch(() => {});
  };
}
