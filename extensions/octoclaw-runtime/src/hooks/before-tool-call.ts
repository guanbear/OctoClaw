import { maybeSendLatencyAck, updateAckTrackingState } from "../ack/ack-guard.js";
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
import { evaluateActiveBudgetedMainGate } from "./budgeted-main-gate.js";
import {
  evaluateNativeSessionsSendHookGate,
  evaluateNativeSessionsYieldHookGate,
  evaluateNativeSpawnHookGate,
} from "./native-spawn-gate-runner.js";
import { evaluateRouteHintGate, shouldBindRouteHintPrompt } from "./route-hint-gate.js";
import { runReplyDirectToolGate } from "./reply-direct-tool-runner.js";
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
import {
  evaluateSpeculativePreloadDispatchGate,
  evaluateSpeculativePreloadSpawnGate,
  type SpeculativePreloadSpawnGateResult,
} from "./speculative-preload-gate.js";

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

function applySpeculativeStatePatches(input: {
  result: SpeculativePreloadSpawnGateResult;
  toolName: string;
}): void {
  for (const [key, patch] of Object.entries(input.result.statePatchesByKey ?? {})) {
    updatePolicyState(key, (current) => ({
      ...current,
      ...patch,
      controlToolsSeen: Array.from(new Set([
        ...(Array.isArray(current.controlToolsSeen) ? current.controlToolsSeen : []),
        input.toolName,
      ])),
    }));
  }
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

    if (speculativeDispatchGuardEnabled) {
      const expectedWorkContractId = stateWorkContractId(state);
      const candidateKeys = Array.from(new Set([
        stateKey,
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(asRecord(decision.request).session_key),
        ...resolvePolicyStateKeys(ctx),
      ].map((value) => stringValue(value)).filter(Boolean)));
      const dispatchGate = evaluateSpeculativePreloadDispatchGate({
        toolName,
        decision,
        stateKey,
        state,
        ctx,
        statesByKey: new Map(policyState.entries().map((entry) => [entry.key, entry.state])),
        candidateKeys,
        expectedWorkContractId,
      });
      if (dispatchGate.kind !== "allow" || dispatchGate.stop) {
        applyToolGateResult({
          result: dispatchGate,
          stateKey,
          logger: deps.pi.logger,
          decision,
        });
        return toolGateHookReturn(dispatchGate);
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
        if (resolveSpeculativePreloadEnabled(deps.currentPluginConfig())) {
          const speculativeSpawnGate = evaluateSpeculativePreloadSpawnGate({
            toolName,
            toolParams,
            decision,
            stateKey,
            state,
            ctx,
            statesByKey: new Map(policyState.entries().map((entry) => [entry.key, entry.state])),
            sessionKeys,
          });
          if (speculativeSpawnGate.kind !== "allow") {
            applySpeculativeStatePatches({ result: speculativeSpawnGate, toolName });
            applyToolGateResult({
              result: speculativeSpawnGate,
              stateKey,
              logger: deps.pi.logger,
              decision,
            });
            return;
          }
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
        const yieldHookGate = evaluateNativeSessionsYieldHookGate({
          toolName,
          sessionKeys,
          decision,
          stateKey,
          sessionId: stringValue(ctx.sessionId),
        });
        if (yieldHookGate.kind === "block") {
          applyToolGateResult({
            result: yieldHookGate,
            stateKey,
            logger: deps.pi.logger,
            decision,
          });
          return toolGateHookReturn(yieldHookGate);
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

    const replyDirectToolGate = await runReplyDirectToolGate({
        toolName,
        toolParams,
        decision,
        state: asRecord(state),
        stateKey,
        ctx,
        metadata,
        logger: deps.pi.logger,
        budgetedMainHandledTool,
        isControlObserverDecision: isControlObserverDecision(decision),
        isSessionControlDecision: isSessionControlDecision(decision),
      }, {
        now: Date.now,
        escalateBudgetedMainForTool: async (input) => {
          const escalated = await escalateBudgetedMainForTool({
            ...input,
            logger: deps.pi.logger,
          });
          return {
            ...escalated,
            state: escalated.state as unknown as UnknownRecord | null,
          };
        },
        updateBudgetedMainForContext: (input) => updateBudgetedMainForContext(input) as unknown as UnknownRecord | null,
        scheduleBudgetedMainTimeout: (input) => scheduleBudgetedMainTimeout({
          ...input,
          logger: deps.pi.logger,
        }),
        updateAckTrackingState,
        maybeSendLatencyAck: (nextDecision, nextMetadata, nextStateKey, nextState, nextCtx, _logger, nextToolName) => maybeSendLatencyAck(
          nextDecision,
          nextMetadata,
          nextStateKey,
          nextState,
          nextCtx,
          deps.pi.logger ?? {},
          nextToolName,
        ),
        updatePolicyState: (nextStateKey, updater) => updatePolicyState(
          nextStateKey,
          (current) => updater(asRecord(current)) as PolicyStateEntry,
        ),
        recordAckReplay,
        recordPolicyReplay,
      });
    if (replyDirectToolGate.kind === "block") {
      state = replyDirectToolGate.state as PolicyStateEntry | null;
      applyToolGateResult({
        result: replyDirectToolGate.result,
        stateKey,
        logger: deps.pi.logger,
        decision,
      });
      return toolGateHookReturn(replyDirectToolGate.result);
    }
    if (replyDirectToolGate.kind === "handled") {
      state = replyDirectToolGate.state as PolicyStateEntry | null;
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
