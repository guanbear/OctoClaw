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
  isDelegatedRoute,
  isSessionControlDecision,
  matchesBlockedPattern,
  observerControlTools,
  preHintAllowedTools,
  routeHintRequired,
  sessionControlTools,
  stringifyParamsForPolicy,
  workflowEnforcementRule,
} from "../replay/policy-utils.js";
import { recordAckReplay, recordPolicyReplay } from "../replay/replay.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { evaluateNativeSessionsSendGate, evaluateNativeSpawnGate } from "../delegate/native-spawn-gate.js";
import { isPlannerAllowedForSession, resolveSpawnBackend, resolveSpeculativePreloadEnabled } from "../config/index.js";
import {
  buildBudgetedMainState,
  budgetedMainToolEscalationReason,
  classifyBudgetedMainTool,
  hasBudgetedMainEscalationEvidence,
  readBudgetedMainState,
  updateBudgetedMainToolState,
} from "../budgeted-main.js";
import { explicitDelegateDispatchRequest } from "../dispatch-admission.js";
import {
  isMatchingSpeculativePreloadSpawn,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringArray, stringValue } from "../extension-entry-shared.js";
import {
  getPolicyStateForContext,
  updatePolicyState,
  isNativeAnnounceBlockedState,
  isNativeAnnounceDeliveryState,
  NATIVE_ANNOUNCE_BLOCKED_TOOLS,
  bindRouteHintPromptToCurrentContext,
  escalateBudgetedMainForTool,
  updateBudgetedMainForContext,
  scheduleBudgetedMainTimeout,
  promoteBudgetedMainDispatch,
  recordBudgetedMainEvent,
  budgetedMainVisibleStartAt,
  budgetedMainWorkContractId,
  budgetedMainSpawnIntentId,
  stateWorkContractId,
} from "../extension-entry.js";

export interface BeforeToolCallDeps {
  pi: PluginInterface;
  currentPluginConfig: () => UnknownRecord;
}

export function makeBeforeToolCallHook(deps: BeforeToolCallDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    if (!isManagedAgentContext(ctx)) return;
    const toolName = stringValue(event.toolName || ctx.toolName);
    const toolParams = asRecord(event.params || event.arguments || event.input);
    if (toolName === "octoclaw_route_hint") {
      bindRouteHintPromptToCurrentContext(ctx, toolParams);
    }
    let { key: stateKey, state } = getPolicyStateForContext(ctx);
    if (state && isNativeAnnounceBlockedState(state) && toolName === "octoclaw_dispatch") {
      void recordPolicyReplay(
        "native_announce_blocker_redispatch_allowed",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          toolName,
          workContractId: stringValue(asRecord(state).workContractId || asRecord(state).work_contract_id),
          blocker: stringValue(asRecord(state).nativeAnnounceBlocker || asRecord(state).native_announce_blocker),
        },
        deps.pi.logger,
        asRecord(state.decision),
      ).catch(() => {});
      return;
    }
    if (state && isNativeAnnounceDeliveryState(state) && NATIVE_ANNOUNCE_BLOCKED_TOOLS.has(toolName)) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      void recordPolicyReplay(
        "tool_blocked_native_announce_completion",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          toolName,
          workContractId: stringValue(asRecord(state).workContractId || asRecord(state).work_contract_id),
          reason: "native_announce_completion_delivery",
        },
        deps.pi.logger,
        asRecord(state.decision),
      ).catch(() => {});
      return {
        block: true,
        blockReason: "OctoClaw is delivering an existing native subagent completion; do not dispatch or spawn new work for this inter-session announce.",
      };
    }
    let budgetDecision = asRecord(state?.decision);
    let budgetedMainHandledTool = false;
    const budgetState = readBudgetedMainState(asRecord(state));
    if (budgetState?.active && !budgetState.completedAt && !budgetState.escalatedAt) {
      const classification = classifyBudgetedMainTool(toolName, toolParams);
      const now = Date.now();
      if (toolName === "octoclaw_dispatch") {
        const reason = budgetState.escalatedPending || now - budgetState.startedAt >= budgetState.maxWallMs
          ? "wall_time_over_budget"
          : "main_agent_called_dispatch";
        const escalated = await escalateBudgetedMainForTool({
          stateKey,
          ctx,
          state: asRecord(state),
          decision: budgetDecision,
          budgetState,
          reason,
          logger: deps.pi.logger,
        });
        state = escalated.state as PolicyStateEntry | null;
        budgetDecision = escalated.decision;
      } else if (classification.counted) {
        budgetedMainHandledTool = true;
        const updatedBudget = updateBudgetedMainToolState(budgetState, classification);
        const escalationReason = budgetedMainToolEscalationReason(updatedBudget, classification);
        if (escalationReason) {
          const escalated = await escalateBudgetedMainForTool({
            stateKey,
            ctx,
            state: asRecord(state),
            decision: budgetDecision,
            budgetState: updatedBudget,
            reason: escalationReason,
            logger: deps.pi.logger,
          });
          state = escalated.state as PolicyStateEntry | null;
          updatePolicyState(stateKey, (current) => ({
            ...current,
            blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
          }));
          return {
            block: true,
            blockReason: `OctoClaw budgeted main execution escalated (${escalationReason}). Call octoclaw_dispatch with the original task; do not use ordinary tools or claim the task has started before dispatch_confirm.`,
          };
        }
        state = updateBudgetedMainForContext({
          stateKey,
          ctx,
          state: asRecord(state),
          budgetState: updatedBudget,
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
    if (!hookConfig.enabled && toolName !== "sessions_spawn" && toolName !== "sessions_send" && !speculativeDispatchGuardEnabled) return;

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
        const gate = evaluateNativeSpawnGate({ sessionKeys, args: toolParams as { task: string; [key: string]: unknown }, decision });
        if (!gate.allowed) {
          updatePolicyState(stateKey, (current) => ({
            ...current,
            blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
          }));
          void recordPolicyReplay("sessions_spawn_intent_blocked", {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            reason: gate.reason,
            spawn_intent_id: gate.intent?.spawnIntentId ?? null,
            expected_hash: gate.expectedHash ?? null,
            actual_hash: gate.actualHash ?? null,
          }, deps.pi.logger).catch(() => {});
          return {
            block: true,
            blockReason: gate.reason === "args_hash_mismatch"
              ? "OctoClaw blocked sessions_spawn because the arguments do not match the pending native spawn intent. Call octoclaw_dispatch again or use the exact sessionsSpawnArgs."
              : "OctoClaw blocked sessions_spawn because no current pending native spawn intent exists. Call octoclaw_dispatch first.",
          };
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
        const gate = evaluateNativeSessionsSendGate({ sessionKeys, args: toolParams as { task: string; [key: string]: unknown }, decision });
        if (!gate.allowed) {
          updatePolicyState(stateKey, (current) => ({
            ...current,
            blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
          }));
          void recordPolicyReplay("sessions_send_intent_blocked", {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route,
            toolName,
            reason: gate.reason,
            spawn_intent_id: gate.intent?.spawnIntentId ?? null,
            expected_hash: gate.expectedHash ?? null,
            actual_hash: gate.actualHash ?? null,
          }, deps.pi.logger, decision).catch(() => {});
          return {
            block: true,
            blockReason: gate.reason === "args_hash_mismatch"
              ? "OctoClaw blocked sessions_send because the arguments do not match the pending speculative send intent. Call octoclaw_dispatch again or use the exact sessionsSendArgs."
              : "OctoClaw blocked sessions_send because no current pending speculative send intent exists. Call octoclaw_dispatch first.",
          };
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
      const classification = classifyBudgetedMainTool(toolName, toolParams);
      if (!budgetedMainHandledTool && classification.counted) {
        const now = Date.now();
        const stateRecord = asRecord(state);
        const existingBudget = readBudgetedMainState(stateRecord);
        const startedBudget = existingBudget?.active && !existingBudget.completedAt && !existingBudget.escalatedAt
          ? existingBudget
          : {
              ...buildBudgetedMainState({
                now,
                decision,
                visibleStartAt: budgetedMainVisibleStartAt(stateRecord, now),
                budgetStartSource: "main_reply_tool_guard",
                workContractId: budgetedMainWorkContractId(stateRecord, decision),
                spawnIntentId: budgetedMainSpawnIntentId(stateRecord),
              }),
              reason: "main_reply_tool_observed",
              decisionBucket: stringValue(asRecord(decision.route_decision).decision_bucket || decision._decision_bucket || "main_reply_tool_guard"),
            };
        const updatedBudget = updateBudgetedMainToolState(startedBudget, classification);
        const escalationReason = budgetedMainToolEscalationReason(updatedBudget, classification);
        if (escalationReason) {
          const escalated = await escalateBudgetedMainForTool({
            stateKey,
            ctx,
            state: stateRecord,
            decision,
            budgetState: updatedBudget,
            reason: escalationReason,
            logger: deps.pi.logger,
          });
          state = escalated.state as PolicyStateEntry | null;
          updatePolicyState(stateKey, (current) => ({
            ...current,
            blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
          }));
          return {
            block: true,
            blockReason: `OctoClaw main reply tool budget escalated (${escalationReason}). Call octoclaw_dispatch with the original task; do not continue ordinary tool execution in the main agent.`,
          };
        }
        state = updateBudgetedMainForContext({
          stateKey,
          ctx,
          state: stateRecord,
          budgetState: updatedBudget,
        }) as PolicyStateEntry | null;
        scheduleBudgetedMainTimeout({
          stateKey,
          ctx,
          state: stateRecord,
          decision,
          budgetState: updatedBudget,
          logger: deps.pi.logger,
        });
        void recordPolicyReplay(
          "main_reply_tool_guard_observed",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            decision_bucket: updatedBudget.decisionBucket,
            toolName,
            toolCount: updatedBudget.toolCount,
            readOnlyToolCount: updatedBudget.readOnlyToolCount,
            budgetStartSource: updatedBudget.budgetStartSource,
          },
          deps.pi.logger,
          decision,
        ).catch(() => {});
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

    if (isControlObserverDecision(decision)) {
      if (allowedObserverTools.has(toolName)) {
        return;
      }
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      void recordPolicyReplay(
        "tool_blocked_control_observer",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          toolName,
          allowedTools: [...allowedObserverTools],
        },
        deps.pi.logger,
        decision,
      ).catch(() => {});
      return {
        block: true,
        blockReason: `OctoClaw control/observer request must use control tools only: ${[...allowedObserverTools].join(", ")}.`,
      };
    }

    if (isSessionControlDecision(decision)) {
      if (allowedSessionTools.has(toolName)) {
        return;
      }
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      void recordPolicyReplay(
        "tool_blocked_session_control",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          toolName,
          allowedTools: [...allowedSessionTools],
        },
        deps.pi.logger,
        decision,
      ).catch(() => {});
      return {
        block: true,
        blockReason: `OctoClaw current-session control request must use session control tools only: ${[...allowedSessionTools].join(", ")}.`,
      };
    }

    const routeAllowsDirectTools = stringValue(asRecord(decision.route_decision).route) === "reply"
      || Boolean(toolPolicy.allow_direct_tools);
    const directReplyToolsAllowed = routeAllowsDirectTools
      && !isControlObserverDecision(decision)
      && !isSessionControlDecision(decision);
    if (routeHintIsRequired && !routeHintAlreadySubmitted && !directReplyToolsAllowed && !allowedPreHintTools.has(toolName)) {
      if (toolName === "octoclaw_dispatch") {
        void recordPolicyReplay(
          "route_hint_dispatch_advisory",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            requiredTool: routeHintTool,
          },
          deps.pi.logger,
          decision,
        ).catch(() => {});
      } else {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        void recordPolicyReplay(
          "tool_blocked_before_route_hint",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            requiredTool: routeHintTool,
          },
          deps.pi.logger,
          decision,
        ).catch(() => {});
        return {
          block: true,
          blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
        };
      }
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
    if (forbiddenContractTools.has(toolName) && !isDeterministicFallbackToDelegate && !isBudgetedMainDispatch && !isExplicitDelegateDispatch) {
      if (toolName === "octoclaw_dispatch") {
        void recordPolicyReplay(
          "work_contract_forbidden_dispatch_advisory",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(workContractProjection.route || asRecord(decision.route_decision).route),
            toolName,
            workContractId: stringValue(workContractProjection.workContractId || workContractProjection.work_contract_id),
          },
          deps.pi.logger,
          decision,
        ).catch(() => {});
      } else {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        void recordPolicyReplay(
          "tool_blocked_work_contract_forbidden",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(workContractProjection.route || asRecord(decision.route_decision).route),
            toolName,
            workContractId: stringValue(workContractProjection.workContractId || workContractProjection.work_contract_id),
          },
          deps.pi.logger,
          decision,
        ).catch(() => {});
        return {
          block: true,
          blockReason: `OctoClaw WorkContract forbids ${toolName} for this turn.`,
        };
      }
    }
    if (isExplicitDelegateDispatch) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      updateAckTrackingState(stateKey, { delegated_running: true, tool_active: false });
      return;
    }
    const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns)
      ? toolPolicy.block_tool_patterns.map((item) => stringValue(item)).filter(Boolean)
      : [];
    const delegateTool = stringValue(toolPolicy.must_delegate_via || "octoclaw_dispatch");
    const isPolicyControlTool = toolName.startsWith("octoclaw_") || toolName === routeHintTool || toolName === delegateTool;
    const currentRouteIsDelegated = isDelegatedRoute(decision);
    if (currentRouteIsDelegated && !isPolicyControlTool && matchesBlockedPattern(stringifyParamsForPolicy(event.params), blockedPatterns)) {
      void recordPolicyReplay(
        "tool_blocked_manual_delegation",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(decision.route_decision).route),
          toolName,
        },
        deps.pi.logger,
        decision,
      ).catch(() => {});
      return {
        block: true,
        blockReason: `OctoClaw runtime policy blocked a manual delegation pattern. Use ${stringValue(toolPolicy.must_delegate_via || "octoclaw_dispatch")} instead.`,
      };
    }

    if (!delegationEnforcementEnabled) {
      return;
    }

    const workflowRule = workflowEnforcementRule(decision, toolName, routeHintTool);
    if (!workflowRule.block && workflowRule.delegateTool && toolName === workflowRule.delegateTool) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      updateAckTrackingState(stateKey, { delegated_running: true, tool_active: false });
      return;
    }
    if (!workflowRule.block) {
      return;
    }

    if (toolName === "octoclaw_dispatch") {
      void recordPolicyReplay(
        "workflow_enforcement_dispatch_advisory",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(workflowRule.route || asRecord(decision.route_decision).route),
          toolName,
          allowedTools: workflowRule.allowedTools,
        },
        deps.pi.logger,
        state?.decision as Record<string, unknown> | null,
      ).catch(() => {});
      return;
    }

    updatePolicyState(stateKey, (current) => ({
      ...current,
      blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
    }));
    const workflowRoute = stringValue(workflowRule.route || asRecord(decision.route_decision).route);
    const observerOnly = Boolean(asRecord(asRecord(decision.hook_interface).before_tool_call).observe_only);
    void recordPolicyReplay(
      observerOnly ? "tool_blocked_runner_policy" : "tool_blocked_delegation_policy",
      {
        sessionKey: stateKey || "",
        sessionId: stringValue(ctx.sessionId),
        route: workflowRoute,
        toolName,
        allowedTools: workflowRule.allowedTools,
      },
      deps.pi.logger,
      state?.decision as Record<string, unknown> | null,
    ).catch(() => {});
    return {
      block: true,
        blockReason: observerOnly
          ? `OctoClaw runtime policy route=delegate with role=observer_probe requires the observe workflow. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed workflow tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`
          : `OctoClaw runtime policy route=${stringValue(asRecord(decision.route_decision).route || "reply")} requires delegation. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed control tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`,
    };
  };
}
