import {
  maybeSendLatencyAck,
  updateAckTrackingState,
} from "../ack/ack-guard.js";
import {
  buildPolicyMetadata,
  isManagedAgentContext,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import {
  isControlObserverDecision,
  isSessionControlDecision,
  observerControlTools,
  preHintAllowedTools,
  routeHintRequired,
  sessionControlTools,
  stringifyParamsForPolicy,
} from "../replay/policy-utils.js";
import { recordAckReplay, recordPolicyReplay } from "../replay/replay.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { isPlannerAllowedForSession, resolveSpawnBackend, resolveSpeculativePreloadEnabled } from "../config/index.js";
import {
  buildBudgetedMainState,
  budgetedMainVisibleStartAt,
  escalateBudgetedMainForTool,
  hasBudgetedMainEscalationEvidence,
  promoteBudgetedMainDispatch,
  readBudgetedMainState,
  recordBudgetedMainEvent,
  scheduleBudgetedMainTimeout,
  updateBudgetedMainForContext,
} from "../budgeted-main.js";
import { explicitDelegateDispatchRequest } from "../dispatch-admission.js";
import {
  isMatchingSpeculativePreloadSpawn,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { evaluateActiveBudgetedMainGate, evaluateReplyToolBudgetGate } from "./budgeted-main-gate.js";
import { evaluateNativeSessionsSendHookGate, evaluateNativeSpawnHookGate } from "./native-spawn-gate-runner.js";
import { evaluateRouteHintGate, shouldBindRouteHintPrompt } from "./route-hint-gate.js";
import { evaluateNativeAnnounceDeliveryGate, evaluateSessionControlGate } from "./session-control-gate.js";
import type { ToolGateResult } from "./tool-gate-types.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringArray, stringValue } from "../extension-entry-shared.js";
import {
  getPolicyStateForContext,
  updatePolicyState,
  bindRouteHintPromptToCurrentContext,
  stateWorkContractId,
} from "../extension-entry.js";
import { evaluateDelegationWorkflowGuard } from "./delegation-workflow-guard.js";

export interface BeforeToolCallDeps {
  pi: PluginInterface;
  currentPluginConfig: () => UnknownRecord;
}

function mergeGateStatePatch(current: PolicyStateEntry, patch: UnknownRecord): PolicyStateEntry {
  const blockedTools = Array.isArray(patch.blockedTools)
    ? [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), ...patch.blockedTools].filter(Boolean)
    : undefined;
  return {
    ...current,
    ...patch,
    ...(blockedTools ? { blockedTools } : {}),
  };
}

function applyToolGateResult(input: {
  result: ToolGateResult;
  stateKey: string;
  logger: unknown;
  decision: UnknownRecord;
}): void {
  if (input.result.statePatch) {
    updatePolicyState(input.stateKey, (current) => mergeGateStatePatch(current, input.result.statePatch ?? {}));
  }
  for (const replayEvent of input.result.replayEvents ?? []) {
    void recordPolicyReplay(
      replayEvent.event,
      replayEvent.payload,
      input.logger,
      replayEvent.decision === "none" ? undefined : input.decision,
    ).catch(() => {});
  }
}

function toolGateHookReturn(result: ToolGateResult): { block: true; blockReason: string } | undefined {
  return result.kind === "block" ? { block: true, blockReason: result.blockReason } : undefined;
}

export function makeBeforeToolCallHook(deps: BeforeToolCallDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    if (!isManagedAgentContext(ctx)) return;
    const toolName = stringValue(event.toolName || ctx.toolName);
    const toolParams = asRecord(event.params || event.arguments || event.input);
    if (shouldBindRouteHintPrompt(toolName)) {
      bindRouteHintPromptToCurrentContext(ctx, toolParams);
    }
    let { key: stateKey, state } = getPolicyStateForContext(ctx);
    const nativeAnnounceGate = evaluateNativeAnnounceDeliveryGate({
      toolName,
      state,
      stateKey,
      sessionId: stringValue(ctx.sessionId),
    });
    if (nativeAnnounceGate.kind !== "allow" || nativeAnnounceGate.stop) {
      applyToolGateResult({
        result: nativeAnnounceGate,
        stateKey,
        logger: deps.pi.logger,
        decision: asRecord(state?.decision),
      });
      return toolGateHookReturn(nativeAnnounceGate);
    }
    let budgetDecision = asRecord(state?.decision);
    let budgetedMainHandledTool = false;
    const budgetState = readBudgetedMainState(asRecord(state));
    if (budgetState?.active && !budgetState.completedAt && !budgetState.escalatedAt) {
      const now = Date.now();
      const activeBudgetGate = evaluateActiveBudgetedMainGate({
        toolName,
        toolParams,
        budgetState,
        now,
      });
      if (activeBudgetGate.kind === "escalate_dispatch" && activeBudgetGate.reason) {
        const escalated = await escalateBudgetedMainForTool({
          stateKey,
          ctx,
          state: asRecord(state),
          decision: budgetDecision,
          budgetState: activeBudgetGate.budgetState ?? budgetState,
          reason: activeBudgetGate.reason,
          logger: deps.pi.logger,
        });
        state = escalated.state as PolicyStateEntry | null;
        budgetDecision = escalated.decision;
      } else if (activeBudgetGate.kind === "block" && activeBudgetGate.reason && activeBudgetGate.budgetState) {
        budgetedMainHandledTool = activeBudgetGate.budgetedMainHandledTool;
        const escalated = await escalateBudgetedMainForTool({
          stateKey,
          ctx,
          state: asRecord(state),
          decision: budgetDecision,
          budgetState: activeBudgetGate.budgetState,
          reason: activeBudgetGate.reason,
          logger: deps.pi.logger,
        });
        state = escalated.state as PolicyStateEntry | null;
        applyToolGateResult({
          result: activeBudgetGate,
          stateKey,
          logger: deps.pi.logger,
          decision: budgetDecision,
        });
        return toolGateHookReturn(activeBudgetGate);
      } else if (activeBudgetGate.budgetedMainHandledTool && activeBudgetGate.budgetState) {
        budgetedMainHandledTool = true;
        state = updateBudgetedMainForContext({
          stateKey,
          ctx,
          state: asRecord(state),
          budgetState: activeBudgetGate.budgetState,
        }) as PolicyStateEntry | null;
      }
    }
    if (toolName === "octoclaw_dispatch") {
      const taskPolicyContext = policyState.getDispatchPolicyContext(ctx, stringValue(toolParams.task));
      const taskDecision = asRecord(taskPolicyContext.state?.decision);
      const taskRoute = stringValue(asRecord(taskDecision.route_decision).route);
      const taskToolPolicy = asRecord(taskDecision.tool_policy);
      const taskRouteHintPolicy = asRecord(taskDecision.route_hint_policy);
      const taskUpdatedAt = Number(taskPolicyContext.state?.updatedAt || taskPolicyContext.state?.createdAt || 0);
      const currentUpdatedAt = Number(state?.updatedAt || state?.createdAt || 0);
      const taskHasSubmittedHint = taskPolicyContext.state?.routeHintSubmitted === true || taskRouteHintPolicy.submitted === true;
      const taskAllowsDispatch = taskRoute === "delegate"
        && taskHasSubmittedHint
        && (!currentUpdatedAt || taskUpdatedAt >= currentUpdatedAt)
        && (stringValue(taskToolPolicy.must_delegate_via) === "octoclaw_dispatch"
          || stringArray(taskToolPolicy.allowed_control_tools).includes("octoclaw_dispatch"));
      if (taskAllowsDispatch) {
        stateKey = stringValue(taskPolicyContext.key) || stateKey;
        state = taskPolicyContext.state as PolicyStateEntry | null;
      }
      const promotedDispatch = await promoteBudgetedMainDispatch({
        stateKey,
        ctx,
        state: asRecord(state),
        decision: asRecord(state?.decision),
        task: stringValue(toolParams.task),
        logger: deps.pi.logger,
      });
      if (promotedDispatch.promoted) {
        state = promotedDispatch.state;
        budgetDecision = promotedDispatch.decision;
      }
    }
    const decision = asRecord(state?.decision);
    const hookConfig = asRecord(asRecord(decision.hook_interface).before_tool_call);
    const speculativeDispatchGuardEnabled = toolName === "octoclaw_dispatch"
      && resolveSpawnBackend() === "planner"
      && resolveSpeculativePreloadEnabled(deps.currentPluginConfig());
    const nativeSessionTool = toolName === "sessions_spawn" || toolName === "sessions_send" || toolName === "sessions_yield";
    if (!hookConfig.enabled && !nativeSessionTool && !speculativeDispatchGuardEnabled) return;

    const routeHintTool = stringValue(hookConfig.route_hint_tool || "octoclaw_route_hint");
    const routeHintIsRequired = routeHintRequired(decision) || Boolean(hookConfig.route_hint_required);
    const delegationEnforcementEnabled = Boolean(hookConfig.delegate_required || hookConfig.delegation_enforcement);
    const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted) || Boolean(asRecord(decision.route_hint_policy).submitted);
    const allowedPreHintTools = preHintAllowedTools(decision, routeHintTool);
    const allowedObserverTools = observerControlTools(decision, routeHintTool);
    const allowedSessionTools = sessionControlTools(decision, routeHintTool);
    const toolPolicy = asRecord(decision.tool_policy);
    const metadata = buildPolicyMetadata(ctx, { stateKey });
    if (["octoclaw_status", "octoclaw_task_action"].includes(toolName)) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        controlToolsSeen: Array.from(new Set([
          ...(Array.isArray(current?.controlToolsSeen) ? current.controlToolsSeen : []),
          toolName,
        ])),
      }));
    }
    const storedInboundTs = stringValue(state?.inboundMessageTs);
    if (storedInboundTs && !stringValue(metadata.message_id)) {
      metadata.message_id = storedInboundTs;
    }

    if (
      speculativeDispatchGuardEnabled
    ) {
      const decisionRoute = stringValue(asRecord(decision.route_decision).route);
      const expectedWorkContractId = stateWorkContractId(state);
      const deferredCandidates: Array<{
        key: string;
        speculative: NonNullable<ReturnType<typeof readSpeculativePreloadState>>;
        spawnArgs: UnknownRecord;
      }> = [];
      const addDeferredCandidate = (key: string, candidateState: unknown): void => {
        const candidateKey = stringValue(key);
        if (!candidateKey || deferredCandidates.some((candidate) => candidate.key === candidateKey)) return;
        const candidateRecord = asRecord(candidateState);
        if (expectedWorkContractId && stateWorkContractId(candidateRecord) !== expectedWorkContractId) return;
        const candidateSpeculative = readSpeculativePreloadState(candidateRecord);
        const candidateSpawnArgs = asRecord(candidateSpeculative?.spawnArgs);
        if (candidateSpeculative?.status !== "hinted" || Object.keys(candidateSpawnArgs).length === 0) return;
        deferredCandidates.push({ key: candidateKey, speculative: candidateSpeculative, spawnArgs: candidateSpawnArgs });
      };
      for (const key of Array.from(new Set([
        stateKey,
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(asRecord(decision.request).session_key),
        ...resolvePolicyStateKeys(ctx),
      ].map((value) => stringValue(value)).filter(Boolean)))) {
        addDeferredCandidate(key, policyState.get(key));
      }
      if (stateKey) addDeferredCandidate(stateKey, state);
      if (deferredCandidates.length === 0 && expectedWorkContractId) {
        for (const entry of policyState.entries()) addDeferredCandidate(entry.key, entry.state);
      }
      const deferred = deferredCandidates[0];
      if (decisionRoute === "delegate" && deferred) {
        void recordPolicyReplay("speculative_preload_dispatch_deferred", {
          sessionKey: stringValue(asRecord(decision.request).session_key) || deferred.key || stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: decisionRoute,
          toolName,
          label: deferred.speculative.label,
          reason: "standby_spawn_required",
          alias_count: deferredCandidates.length,
        }, deps.pi.logger, decision).catch(() => {});
        return {
          block: true,
          blockReason: [
            "OctoClaw speculative preload is active for this delegated route.",
            `First call sessions_spawn exactly with these runtime-generated args: ${JSON.stringify(deferred.spawnArgs)}.`,
            "After sessions_spawn returns, call octoclaw_dispatch with the original task.",
            "If sessions_spawn is rejected or unavailable, call octoclaw_dispatch after the failed result so OctoClaw can fall back to new_spawn.",
          ].join(" "),
        };
      }
    }

    if (toolName === "sessions_spawn") {
      const sessionKeys = [
        stateKey,
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(asRecord(decision.request).session_key),
        ...resolvePolicyStateKeys(ctx),
      ];
      const plannerGateEnabled = resolveSpawnBackend() === "planner"
        && sessionKeys.some((sessionKey) => isPlannerAllowedForSession(sessionKey));
      if (plannerGateEnabled) {
        const speculativeMatches: Array<{ key: string; state: UnknownRecord; speculative: NonNullable<ReturnType<typeof readSpeculativePreloadState>> }> = [];
        for (const key of Array.from(new Set(sessionKeys.map((value) => stringValue(value)).filter(Boolean)))) {
          const candidateState = asRecord(policyState.get(key));
          const candidateSpeculative = readSpeculativePreloadState(candidateState);
          if (candidateSpeculative?.status !== "hinted") continue;
          if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
          speculativeMatches.push({ key, state: candidateState, speculative: candidateSpeculative });
        }
        const directSpeculative = readSpeculativePreloadState(state);
        if (
          stateKey
          && speculativeMatches.every((match) => match.key !== stateKey)
          && directSpeculative?.status === "hinted"
          && isMatchingSpeculativePreloadSpawn(state, toolParams)
        ) {
          speculativeMatches.push({ key: stateKey, state: asRecord(state), speculative: directSpeculative });
        }
        if (speculativeMatches.length === 0) {
          for (const entry of policyState.entries()) {
            const candidateState = asRecord(entry.state);
            const candidateSpeculative = readSpeculativePreloadState(candidateState);
            if (candidateSpeculative?.status !== "hinted") continue;
            if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
            speculativeMatches.push({ key: entry.key, state: candidateState, speculative: candidateSpeculative });
          }
        }
        if (resolveSpeculativePreloadEnabled(deps.currentPluginConfig()) && speculativeMatches.length > 0) {
          const now = Date.now();
          for (const match of speculativeMatches) {
            const nextSpeculative = serializeSpeculativePreloadState({
              ...match.speculative,
              status: "spawn_call_started",
              updatedAt: now,
            });
            updatePolicyState(match.key, (current) => ({
              ...current,
              speculativePreload: nextSpeculative,
              speculative_preload: nextSpeculative,
              controlToolsSeen: Array.from(new Set([...(Array.isArray(current.controlToolsSeen) ? current.controlToolsSeen : []), toolName])),
            }));
          }
          const preferredReplayKeys = new Set([
            stringValue(ctx.sessionKey),
            stringValue(ctx.canonicalSessionKey),
            stringValue(asRecord(decision.request).session_key),
            stringValue(stateKey),
          ].filter(Boolean));
          const replayMatch = speculativeMatches.find((match) => preferredReplayKeys.has(match.key)) || speculativeMatches[0];
          const replaySessionKey = stringValue(ctx.sessionKey) || stringValue(ctx.canonicalSessionKey) || replayMatch.key || stateKey || "";
          void recordPolicyReplay("speculative_preload_spawn_allowed", {
            sessionKey: replaySessionKey,
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            label: replayMatch.speculative.label || stringValue(toolParams.label),
            alias_count: speculativeMatches.length,
          }, deps.pi.logger, decision).catch(() => {});
          return;
        }
        const spawnHookGate = evaluateNativeSpawnHookGate({
          toolName,
          sessionKeys,
          args: toolParams as { task: string; [key: string]: unknown },
          decision,
          stateKey,
          sessionId: stringValue(ctx.sessionId),
        });
        if (spawnHookGate.kind === "block") {
          applyToolGateResult({
            result: spawnHookGate,
            stateKey,
            logger: deps.pi.logger,
            decision,
          });
          return toolGateHookReturn(spawnHookGate);
        }
        const gate = spawnHookGate.nativeGate;
        if (!gate?.allowed) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          delegated: false,
          spawnIntentId: gate.intent.spawnIntentId,
          workContractId: gate.intent.workContractId,
          dispatchStatus: "spawn_call_started",
          controlToolsSeen: Array.from(new Set([...(Array.isArray(current.controlToolsSeen) ? current.controlToolsSeen : []), toolName])),
        }));
        const decisionBucket = stringValue(asRecord(decision.route_decision).decision_bucket || decision._decision_bucket || asRecord(asRecord(decision.route_decision).startup_cost_policy).decision_bucket);
        if (decisionBucket === "budgeted_main_then_delegate") {
          const now = Date.now();
          const stateRecord = asRecord(state);
          const liveBudget = readBudgetedMainState(stateRecord);
          if (!liveBudget?.escalatedAt) {
            const startedBudget = liveBudget ?? buildBudgetedMainState({
              now,
              decision,
              visibleStartAt: budgetedMainVisibleStartAt(stateRecord, now),
              budgetStartSource: "sessions_spawn_gate_fallback",
              workContractId: gate.intent.workContractId,
              spawnIntentId: gate.intent.spawnIntentId,
            });
            const reason = liveBudget?.escalatedPending || now - startedBudget.startedAt >= startedBudget.maxWallMs
              ? "wall_time_over_budget"
              : "main_agent_called_dispatch";
            const escalatedBudget = {
              ...startedBudget,
              active: false,
              escalatedAt: now,
              escalatedPending: false,
              reason,
              workContractId: gate.intent.workContractId,
              spawnIntentId: gate.intent.spawnIntentId,
            };
            updateBudgetedMainForContext({
              stateKey: stateKey || gate.intent.sessionKey,
              ctx,
              state: stateRecord,
              budgetState: escalatedBudget,
              extra: {
                budgeted_main_escalated: true,
                budgeted_main_escalated_at: new Date(now).toISOString(),
              },
            });
            await recordBudgetedMainEvent({
              event: "budgeted_main_escalated",
              stateKey: stateKey || gate.intent.sessionKey,
              ctx,
              state: stateRecord,
              decision,
              budgetState: escalatedBudget,
              reason,
              logger: deps.pi.logger,
              now,
            }).catch(() => {});
          }
        }
        void recordPolicyReplay("sessions_spawn_intent_allowed", {
          sessionKey: stateKey || gate.intent.sessionKey,
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          decision_bucket: decisionBucket,
          decisionBucket,
          toolName,
          spawn_intent_id: gate.intent.spawnIntentId,
          work_contract_id: gate.intent.workContractId,
        }, deps.pi.logger).catch(() => {});
        return;
      }
    }
    if (toolName === "sessions_yield") {
      const sessionKeys = [
        stateKey,
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(asRecord(decision.request).session_key),
        ...resolvePolicyStateKeys(ctx),
      ];
      const plannerGateEnabled = resolveSpawnBackend() === "planner"
        && sessionKeys.some((sessionKey) => isPlannerAllowedForSession(sessionKey));
      if (plannerGateEnabled) {
        const keys = Array.from(new Set(sessionKeys.map((value) => stringValue(value)).filter(Boolean)));
        let pendingIntent: ReturnType<typeof nativeSpawnIntentStore.findPendingForSession> | null = null;
        for (const key of keys) {
          try {
            pendingIntent = nativeSpawnIntentStore.findPendingForSession(key, { dispatchMode: "new_spawn" })
              ?? nativeSpawnIntentStore.findPendingForSession(key, { dispatchMode: "send_to_speculative" });
          } catch {
            pendingIntent = null;
          }
          if (pendingIntent) break;
        }
        if (pendingIntent) {
          updatePolicyState(stateKey, (current) => ({
            ...current,
            blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
          }));
          const nextTool = pendingIntent.dispatchMode === "send_to_speculative" ? "sessions_send" : "sessions_spawn";
          void recordPolicyReplay("sessions_yield_blocked_pending_native_spawn", {
            sessionKey: stateKey || pendingIntent.sessionKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            spawn_intent_id: pendingIntent.spawnIntentId,
            work_contract_id: pendingIntent.workContractId,
            dispatch_mode: pendingIntent.dispatchMode || "new_spawn",
          }, deps.pi.logger, decision).catch(() => {});
          return {
            block: true,
            blockReason: [
              "OctoClaw blocked sessions_yield because a native spawn intent is pending but the child session has not started.",
              `Call ${nextTool} exactly with the args from the latest octoclaw_dispatch result before waiting.`,
              "Do not wait for a child that has not started.",
            ].join(" "),
          };
        }
      }
    }
    if (toolName === "sessions_send") {
      const sessionKeys = [
        stateKey,
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(asRecord(decision.request).session_key),
        ...resolvePolicyStateKeys(ctx),
      ];
      const plannerGateEnabled = resolveSpawnBackend() === "planner"
        && sessionKeys.some((sessionKey) => isPlannerAllowedForSession(sessionKey));
      const route = stringValue(asRecord(decision.route_decision).route);
      const speculativeSendExpected = plannerGateEnabled && route === "delegate";
      if (speculativeSendExpected) {
        const sendHookGate = evaluateNativeSessionsSendHookGate({
          toolName,
          sessionKeys,
          args: toolParams as { task: string; [key: string]: unknown },
          decision,
          stateKey,
          sessionId: stringValue(ctx.sessionId),
        });
        if (sendHookGate.kind === "block") {
          applyToolGateResult({
            result: sendHookGate,
            stateKey,
            logger: deps.pi.logger,
            decision,
          });
          return toolGateHookReturn(sendHookGate);
        }
        const gate = sendHookGate.nativeGate;
        if (!gate?.allowed) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          delegated: false,
          spawnIntentId: gate.intent.spawnIntentId,
          workContractId: gate.intent.workContractId,
          dispatchStatus: "spawn_call_started",
          controlToolsSeen: Array.from(new Set([...(Array.isArray(current.controlToolsSeen) ? current.controlToolsSeen : []), toolName])),
        }));
        void recordPolicyReplay("sessions_send_intent_allowed", {
          sessionKey: stateKey || gate.intent.sessionKey,
          sessionId: stringValue(ctx.sessionId),
          route,
          decision_bucket: stringValue(asRecord(decision.route_decision).decision_bucket),
          toolName,
          spawn_intent_id: gate.intent.spawnIntentId,
          work_contract_id: gate.intent.workContractId,
          dispatch_mode: gate.intent.dispatchMode || "send_to_speculative",
          speculative_session_label: gate.intent.speculativeSessionLabel || "",
        }, deps.pi.logger).catch(() => {});
        return;
      }
    }

    if (!hookConfig.enabled) return;

    if (
      stringValue(asRecord(decision.route_decision).route) === "reply"
      && !isControlObserverDecision(decision)
      && !isSessionControlDecision(decision)
      && toolName
      && !toolName.startsWith("octoclaw_")
    ) {
      const stateRecord = asRecord(state);
      const replyBudgetGate = evaluateReplyToolBudgetGate({
        toolName,
        toolParams,
        state: stateRecord,
        decision,
        budgetedMainHandledTool,
        stateKey,
        sessionId: stringValue(ctx.sessionId),
        now: Date.now(),
      });
      if (replyBudgetGate.kind === "block" && replyBudgetGate.reason && replyBudgetGate.budgetState) {
        const escalated = await escalateBudgetedMainForTool({
          stateKey,
          ctx,
          state: stateRecord,
          decision,
          budgetState: replyBudgetGate.budgetState,
          reason: replyBudgetGate.reason,
          logger: deps.pi.logger,
        });
        state = escalated.state as PolicyStateEntry | null;
        applyToolGateResult({
          result: replyBudgetGate,
          stateKey,
          logger: deps.pi.logger,
          decision,
        });
        return toolGateHookReturn(replyBudgetGate);
      }
      if (replyBudgetGate.kind === "observe" && replyBudgetGate.budgetState) {
        state = updateBudgetedMainForContext({
          stateKey,
          ctx,
          state: stateRecord,
          budgetState: replyBudgetGate.budgetState,
        }) as PolicyStateEntry | null;
        if (replyBudgetGate.scheduleTimeout) {
          scheduleBudgetedMainTimeout({
            stateKey,
            ctx,
            state: stateRecord,
            decision,
            budgetState: replyBudgetGate.budgetState,
            logger: deps.pi.logger,
          });
        }
        applyToolGateResult({
          result: replyBudgetGate,
          stateKey,
          logger: deps.pi.logger,
          decision,
        });
      }
      updateAckTrackingState(stateKey, { tool_active: true });
      const latencyAck = await maybeSendLatencyAck(decision, metadata, stateKey, asRecord(state), ctx, deps.pi.logger ?? {}, toolName);
      updatePolicyState(stateKey, (current) => ({
        ...current,
        directToolsSeen: Array.from(new Set([...(Array.isArray(current?.directToolsSeen) ? current.directToolsSeen : []), toolName])),
      }));
      await recordAckReplay({
        decision,
        stateKey,
        ctx,
        logger: deps.pi.logger,
        kind: "latency",
        phase: "direct_tool",
        result: latencyAck,
        toolName,
      });
      void recordPolicyReplay(
        "direct_tool_called",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          taskClass: stringValue(asRecord(decision.route_decision).task_class),
          protectedLane: stringValue(asRecord(decision.route_decision).protected_lane),
          toolName,
          latencyAckRequired: Boolean(asRecord(decision.latency_ack).required),
          latencyAckSent: Boolean(latencyAck?.sent),
          latencyAckReason: stringValue(latencyAck?.reason),
        },
        deps.pi.logger,
        decision,
      ).catch(() => {});
      void recordPolicyReplay(
        "tool_used",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          taskClass: stringValue(asRecord(decision.route_decision).task_class),
          protectedLane: stringValue(asRecord(decision.route_decision).protected_lane),
          toolName,
          latencyAckRequired: Boolean(asRecord(decision.latency_ack).required),
          latencyAckSent: Boolean(latencyAck?.sent),
          latencyAckReason: stringValue(latencyAck?.reason),
        },
        deps.pi.logger,
        decision,
      ).catch(() => {});
    }

    const sessionControlGate = evaluateSessionControlGate({
      toolName,
      decision,
      allowedObserverTools,
      allowedSessionTools,
      stateKey,
      sessionId: stringValue(ctx.sessionId),
    });
    if (sessionControlGate.kind !== "allow" || sessionControlGate.stop) {
      applyToolGateResult({
        result: sessionControlGate,
        stateKey,
        logger: deps.pi.logger,
        decision,
      });
      return toolGateHookReturn(sessionControlGate);
    }

    const routeAllowsDirectTools = stringValue(asRecord(decision.route_decision).route) === "reply"
      || Boolean(toolPolicy.allow_direct_tools);
    const directReplyToolsAllowed = routeAllowsDirectTools
      && !isControlObserverDecision(decision)
      && !isSessionControlDecision(decision);
    const routeHintGate = evaluateRouteHintGate({
      toolName,
      decision,
      routeHintTool,
      routeHintIsRequired,
      routeHintAlreadySubmitted,
      directReplyToolsAllowed,
      allowedPreHintTools,
      stateKey,
      sessionId: stringValue(ctx.sessionId),
    });
    if (routeHintGate.kind !== "allow" || routeHintGate.stop) {
      applyToolGateResult({
        result: routeHintGate,
        stateKey,
        logger: deps.pi.logger,
        decision,
      });
      return toolGateHookReturn(routeHintGate);
    }

    const workContractProjection = asRecord(decision.work_contract);
    const forbiddenContractTools = new Set(stringArray(workContractProjection.forbiddenTools || workContractProjection.forbidden_tools));
    const routeDecision = asRecord(decision.route_decision);
    const isDeterministicFallbackToDelegate = stringValue(routeDecision.route) === "delegate"
      && (stringValue(routeDecision.route_source) === "fallback" || stringValue(routeDecision.fallback_reason).includes("explicit_delegate"));
    const isBudgetedMainDispatch = toolName === "octoclaw_dispatch"
      && hasBudgetedMainEscalationEvidence(asRecord(state), decision);
    const isExplicitDelegateDispatch = toolName === "octoclaw_dispatch"
      && explicitDelegateDispatchRequest({
        params: toolParams,
        metadata,
        cachedDecision: decision,
        dispatchCallImpliesDelegateObjection: true,
      }).requested;
    if (isExplicitDelegateDispatch) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      updateAckTrackingState(stateKey, { delegated_running: true, tool_active: false });
      return;
    }
    const delegationGuard = evaluateDelegationWorkflowGuard({
      toolName,
      paramsText: stringifyParamsForPolicy(event.params),
      decision,
      toolPolicy,
      routeHintTool,
      delegationEnforcementEnabled,
      stateKey,
      sessionId: stringValue(ctx.sessionId),
      forbiddenContractTools,
      isDeterministicFallbackToDelegate,
      isBudgetedMainDispatch,
      isExplicitDelegateDispatch,
    });
    if (delegationGuard.kind === "delegate_tool") {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      updateAckTrackingState(stateKey, { delegated_running: true, tool_active: false });
      return;
    }
    if (delegationGuard.kind !== "allow" || delegationGuard.stop) {
      applyToolGateResult({
        result: delegationGuard,
        stateKey,
        logger: deps.pi.logger,
        decision,
      });
      return toolGateHookReturn(delegationGuard);
    }
    return;
  };
}
