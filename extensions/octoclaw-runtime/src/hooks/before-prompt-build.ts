import {
  buildConversationGrounding,
  buildDirectLookupGuard,
} from "../conversation-grounding.js";
import {
  cancelAckGuard,
  getAckTrackingState,
  maybeSendLatencyAck,
  notifyUserMessage,
  startAckGuard,
  updateAckGuardDecision,
  updateAckTrackingState,
} from "../ack/ack-guard.js";
import {
  LATENCY_ACK_DELAY_MS,
  pendingLatencyAckTimers,
  lastGroundedPromptByStateKey,
} from "../ack/ack-scheduler.js";
import { sendRouteCommitAck } from "../ack/ack-route-commit.js";
import {
  buildPolicyMetadata,
  detectSessionBoundary,
  isManagedAgentContext,
  resolveAckDeliverySessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import { checkActiveTaskRecovery, resolvePolicyDecisionForContext } from "../resolve/policy-resolver.js";
import { resolveReplayLogPath, resolveTaskStatePath } from "../resolve/env.js";
import { buildLiveJudgeContextPacket } from "../resolve/llm-judge.js";
import {
  compactDelegatePolicyPrompt,
  compactPolicyPrompt,
  isDelegatedRoute,
  routeHintPromptRequired,
} from "../replay/policy-utils.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { type PolicyStateEntry } from "../state/policy-state.js";
import {
  BUDGETED_MAIN_MAX_WALL_MS,
  MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT,
  isBudgetedMainDecision,
  maybeStartBudgetedMain,
  readBudgetedMainState,
} from "../budgeted-main.js";
import {
  readSpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { resolveSpeculativePreloadEnabled } from "../config/index.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import { buildPromptContextProjection, extractPromptText } from "../extension-entry-helpers.js";
import { extractInboundMessageTimestampWithSource, type InboundMessageTimestampSource } from "../inbound-timestamps.js";
import {
  buildImmutableDeliveryTarget,
  deliveryTargetReplyTo,
} from "./footer-mode.js";
import {
  getPolicyStateForContext,
  updatePolicyState,
  handleNativeAnnounceCompletion,
  nativeAnnounceSendOverride,
  syncPolicyStateAliases,
  buildRecentExecutionFacts,
  collectRecentExecutionReceipts,
} from "../extension-entry.js";
import { maybeInjectSpeculativePreload } from "./speculative-preload-handler.js";
import {
  bindContextToCurrentTurn,
  promptMatchedInboundAnchor,
  resolveCurrentTurnBinding,
  usableExistingInboundAnchor,
} from "./inbound-anchor-state.js";

import {
  resolveSlimMainContextEnabled,
  OCTOCLAW_DELEGATION_SYSTEM_CONTEXT,
  OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT,
  OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT,
  OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT,
  OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT,
} from "./system-context.js";

export interface BeforePromptBuildDeps {
  pi: PluginInterface;
  judgeFastRaw: Record<string, unknown>;
  delegationEnabled: boolean;
  buildReactionAckState: (sessionKey?: string) => Partial<PolicyStateEntry>;
  applyReactionAckState: (state: PolicyStateEntry | null | undefined, sessionKey?: string) => void;
  maybeSendNeutralInboundAckForContext: (
    hookName: string,
    event: UnknownRecord,
    ctx: UnknownRecord,
    prompt?: string,
    overrides?: { stateKey?: string; sessionKey?: string; inboundMessageTs?: string; inboundMessageTsSource?: InboundMessageTimestampSource },
  ) => Promise<void>;
  currentPluginConfig: () => UnknownRecord;
}

export function makeBeforePromptBuildHook(deps: BeforePromptBuildDeps) {
  return async (event: UnknownRecord, rawCtx: UnknownRecord) => {
    if (!isManagedAgentContext(rawCtx)) return;
    const hookStartedAt = Date.now();
    const prompt = extractPromptText(event);
    const explicitInboundAnchor = extractInboundMessageTimestampWithSource(
      rawCtx,
      event,
      [prompt, extractPromptText(asRecord(event))].filter(Boolean).join("\n"),
    );
    const initialStateKey = resolvePolicyStateKey(rawCtx);
    const initialStateInfo = getPolicyStateForContext(rawCtx);
    const currentTurnBinding = resolveCurrentTurnBinding({
      prompt,
      ctx: rawCtx,
      event,
      fallbackStateKey: initialStateInfo.key || initialStateKey,
      fallbackState: initialStateInfo.state,
    });
    const ctx = currentTurnBinding ? bindContextToCurrentTurn(rawCtx, currentTurnBinding) : rawCtx;

    const preStateKey = currentTurnBinding?.stateKey || resolvePolicyStateKey(ctx);
    const nativeAnnounceHandled = await handleNativeAnnounceCompletion({
      event,
      ctx,
      prompt,
      pluginConfig: deps.pi.pluginConfig,
      logger: deps.pi.logger,
      cwd: stringValue(ctx.cwd) || process.cwd(),
      sendMessage: nativeAnnounceSendOverride(deps.pi.pluginConfig),
    });
    if (nativeAnnounceHandled) return nativeAnnounceHandled.projection;
    void recordPolicyReplay(
      "before_prompt_build_started",
      {
        sessionKey: preStateKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey: preStateKey,
        elapsedMs: Date.now() - hookStartedAt,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const preMetadata = buildPolicyMetadata(ctx, { stateKey: preStateKey });
    const sessionKeys = resolvePolicyStateKeys(ctx);
    preMetadata.judge_replay_log_path = resolveReplayLogPath();
    preMetadata.judge_task_state_path = resolveTaskStatePath();
    preMetadata.judge_session_keys = sessionKeys;
    preMetadata.recent_execution_facts = buildRecentExecutionFacts(collectRecentExecutionReceipts(preStateKey));
    preMetadata.judge_context_packet = buildLiveJudgeContextPacket({
      prompt,
      metadata: preMetadata,
    });
    preMetadata._judgeFastConfig = deps.judgeFastRaw;
    preMetadata._delegationEnabled = deps.delegationEnabled;
    const preSessionKey = currentTurnBinding?.sessionKey
      || resolveAckDeliverySessionKey(preMetadata, preStateKey, asRecord(getPolicyStateForContext(ctx).state), ctx);

    if (preSessionKey) {
      notifyUserMessage(preSessionKey, preStateKey);
    }

    const inboundAnchor = explicitInboundAnchor.ts
      ? explicitInboundAnchor
      : extractInboundMessageTimestampWithSource(
          ctx,
          event,
          [prompt, extractPromptText(asRecord(event))].filter(Boolean).join("\n"),
        );
    let inboundMessageTs = currentTurnBinding?.replyToMessageId || inboundAnchor.ts;
    let inboundMessageTsSource: InboundMessageTimestampSource = currentTurnBinding
      ? (inboundAnchor.ts ? inboundAnchor.source : "ctx")
      : inboundAnchor.source;
    let inboundAnchorSessionKey = currentTurnBinding?.sessionKey || "";
    if (!inboundMessageTs) {
      const promptMatch = promptMatchedInboundAnchor(prompt);
      if (promptMatch) {
        inboundMessageTs = promptMatch.replyToMessageId;
        inboundMessageTsSource = "ctx";
        inboundAnchorSessionKey = promptMatch.sessionKey;
      }
    }

    const existingPreStateInfo = getPolicyStateForContext(ctx);
    const existingPreState = asRecord(existingPreStateInfo.state);
    if (!inboundMessageTs) {
      const existingAnchor = usableExistingInboundAnchor({
        prompt,
        currentStateKey: preStateKey,
        resolvedStateKey: existingPreStateInfo.key,
        state: existingPreState,
      });
      if (existingAnchor) {
        inboundMessageTs = existingAnchor.replyToMessageId;
        inboundMessageTsSource = "ctx";
        inboundAnchorSessionKey = existingAnchor.sessionKey;
      }
    }
    void recordPolicyReplay(
      "before_prompt_build_observed",
      {
        sessionKey: preSessionKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey: preStateKey,
        inboundMessageTs,
        anchor_source: inboundMessageTsSource,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const bindingDeliveryTarget = asRecord(currentTurnBinding?.deliveryTarget);
    const immutableDeliveryTarget = asRecord(bindingDeliveryTarget).immutable
      ? bindingDeliveryTarget
      : buildImmutableDeliveryTarget(inboundAnchorSessionKey || preSessionKey || stringValue(ctx.sessionKey), inboundMessageTs);
    void deps.maybeSendNeutralInboundAckForContext("before_prompt_build", event, ctx, prompt, {
      stateKey: preStateKey,
      sessionKey: inboundAnchorSessionKey || preSessionKey,
      inboundMessageTs,
      inboundMessageTsSource,
    }).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
    });

    if (process.env.OCTOCLAW_ACK_DEBUG) {
      // Log what we extracted so we can debug thread anchor issues
      const ctxKeys = Object.keys(ctx).join(",");
      console.error(`[ack-dbg] inboundMessageTs=${inboundMessageTs || "(empty)"} sessionKey=${stringValue(ctx.sessionKey).substring(0,50)} ctxKeys=${ctxKeys.substring(0,120)}`);
    }

    // When judgeAckEnabled=false: start latency timer BEFORE judge (fast ACK).
    // When judgeAckEnabled=true: ALSO start latency timer BEFORE judge so ACK0 fires at 5s from message arrival.
    // Judge ack_text can override the message if it returns before deadline.
    const pendingDecision: { value: UnknownRecord | null } = { value: null };

    const startLatencyAckTimer = (timerStateKey: string) => {
      const existingTimer = pendingLatencyAckTimers.get(timerStateKey);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(async () => {
        pendingLatencyAckTimers.delete(timerStateKey);
        const currentDecision = pendingDecision.value ?? {};
        const latencyMetadata = buildPolicyMetadata(ctx, { stateKey: timerStateKey });
        if (inboundMessageTs && !stringValue(latencyMetadata.message_id)) {
          latencyMetadata.message_id = inboundMessageTs;
        }
        const latencyResult = await maybeSendLatencyAck(currentDecision, latencyMetadata, timerStateKey, asRecord(getPolicyStateForContext(ctx).state), ctx, deps.pi.logger ?? {}, "direct_lookup");
        if (latencyResult?.sent) {
          cancelAckGuard(preSessionKey);
        }
      }, LATENCY_ACK_DELAY_MS);
      pendingLatencyAckTimers.set(timerStateKey, timer);
    };

    if (preSessionKey) {
      if (process.env.OCTOCLAW_ACK_DEBUG) {
        console.error(`[ack-dbg] preSessionKey=${preSessionKey.substring(0,40)} inboundMessageTs=${inboundMessageTs || "(empty)"}`);
      }
      startAckGuard(preSessionKey, stringValue(ctx.cwd) || process.cwd(), {
        stateKey: preStateKey,
        decision: {},
        state: deps.buildReactionAckState(preSessionKey),
        replyToMessageId: inboundMessageTs,
      });
    }
    const preliminaryState = getPolicyStateForContext(ctx).state;
    if (preliminaryState) {
      deps.applyReactionAckState(preliminaryState, preSessionKey);
      preliminaryState.ackGuardKey = preSessionKey || "";
      preliminaryState.deliveryTarget = immutableDeliveryTarget;
      preliminaryState.delivery_target = immutableDeliveryTarget;
      if (inboundMessageTs) {
        preliminaryState.inboundMessageTs = inboundMessageTs;
        preliminaryState.replyToMessageId = inboundMessageTs;
      }
    }

    startLatencyAckTimer(preStateKey);

    const policyResolveStartedAt = Date.now();
    void recordPolicyReplay(
      "policy_resolve_started",
      {
        sessionKey: preSessionKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey: preStateKey,
        elapsedMs: policyResolveStartedAt - hookStartedAt,
        anchor_source: inboundMessageTsSource,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      deps.pi.logger,
    ).catch((judgeErr: unknown) => {
      if (deps.pi.logger?.warn) {
        deps.pi.logger.warn(`octoclaw judge failed: ${String(judgeErr)}`);
      }
      return null;
    });
    const resolvedDecisionForTiming = asRecord(resolved?.decision);
    void recordPolicyReplay(
      "policy_resolve_completed",
      {
        sessionKey: preSessionKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey: stringValue(resolved?.stateKey || preStateKey),
        elapsedMs: Date.now() - policyResolveStartedAt,
        hookElapsedMs: Date.now() - hookStartedAt,
        resolved: Boolean(resolved),
        usedCachedPolicy: resolved?.usedCachedPolicy === true,
        route: stringValue(asRecord(resolvedDecisionForTiming.route_decision).route),
        decision_bucket: stringValue(asRecord(resolvedDecisionForTiming.route_decision).decision_bucket),
        workContractId: stringValue(resolvedDecisionForTiming.workContractId || asRecord(resolvedDecisionForTiming.work_contract).workContractId || asRecord(resolvedDecisionForTiming.work_contract).work_contract_id),
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    pendingDecision.value = asRecord(resolved?.decision);

    if (resolved) {
      const postDecision = asRecord(resolved?.decision);
      updateAckGuardDecision(preStateKey || preSessionKey, postDecision ?? {});
    }

    const decision = asRecord(resolved?.decision);
    const hookConfig = asRecord(asRecord(decision.hook_interface).before_prompt_build);
    if (!hookConfig.enabled) return;
    const stateKey = stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || "");
    const state = (resolved?.state as PolicyStateEntry | null | undefined) ?? getPolicyStateForContext(ctx).state;
    const recoveryCheck = isDelegatedRoute(decision)
      ? checkActiveTaskRecovery({
          taskId: stringValue(asRecord(asRecord(decision.runtime_truth).binding).taskId),
        })
      : { checkedAt: "", updatedCount: 0, timedOutCount: 0, recoveries: [] as UnknownRecord[] };
    const activeRecoveryState = recoveryCheck.updatedCount > 0 && stateKey
      ? getPolicyStateForContext({ ...ctx, canonicalSessionKey: stateKey }).state
      : state;
    let effectiveState = activeRecoveryState ?? state;
    let effectiveDecision = recoveryCheck.updatedCount > 0
      ? asRecord(effectiveState?.decision)
      : decision;
    if (stateKey) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        ...deps.buildReactionAckState(preSessionKey),
        ackGuardKey: preSessionKey || current.ackGuardKey || "",
        inboundMessageTs: inboundMessageTs || current.inboundMessageTs,
        inboundObservedAt: Number(current.inboundObservedAt || current.inbound_observed_at || 0) || Date.now(),
        inbound_observed_at: Number(current.inboundObservedAt || current.inbound_observed_at || 0) || Date.now(),
        replyToMessageId: inboundMessageTs || current.replyToMessageId,
        deliveryTarget: asRecord(current.deliveryTarget).immutable ? current.deliveryTarget : immutableDeliveryTarget,
        delivery_target: asRecord(current.delivery_target).immutable ? current.delivery_target : immutableDeliveryTarget,
      }));
    }
    if (effectiveState) {
      deps.applyReactionAckState(effectiveState, preSessionKey);
      effectiveState.ackGuardKey = preSessionKey || "";
      effectiveState.ack_guard_key = preSessionKey || "";
      effectiveState.deliveryTarget = immutableDeliveryTarget;
      effectiveState.delivery_target = immutableDeliveryTarget;
      effectiveState.inboundObservedAt = Number(effectiveState.inboundObservedAt || effectiveState.inbound_observed_at || 0) || Date.now();
      effectiveState.inbound_observed_at = effectiveState.inboundObservedAt;
      if (inboundMessageTs) {
        effectiveState.inboundMessageTs = inboundMessageTs;
        effectiveState.replyToMessageId = inboundMessageTs;
      }
      const syncedState = syncPolicyStateAliases(stateKey, ctx, asRecord(effectiveState));
      if (syncedState) {
        effectiveState = syncedState;
      }
    }

    // D1: Route Commit ACK — send truthful ACK projection after route seal, before dispatch.
    // For delegate/observe routes: send immediately (user needs to know task was delegated).
    // For reply routes: delay 500ms so fast local models don't produce a simultaneous ACK+reply.
    // At fire time, check firstTokenSeen/formalReplyVisible — if agent already responded, skip.
    const routeCommitRoute = stringValue(asRecord(asRecord(effectiveDecision).route_decision).route);
    const isReplyRoute = routeCommitRoute !== "delegate" && routeCommitRoute !== "observe";
    const routeCommitAckParams = {
      sessionKey: preSessionKey || stringValue(ctx.sessionKey) || "",
      stateKey: stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || ""),
      decision: effectiveDecision ?? {},
      state: asRecord(effectiveState),
      replyToMessageId: deliveryTargetReplyTo(asRecord(effectiveState)) || inboundMessageTs,
      cwd: stringValue(ctx.cwd) || process.cwd(),
      logger: deps.pi.logger,
    };
    const doSendRouteCommitAck = async () => {
      try {
        const liveState = getPolicyStateForContext(ctx).state;
        // For reply routes: cancel if agent has already started responding.
        // Check ack tracking state (reliable even when policyState is null/stale)
        // as well as policy state fields (both camelCase and snake_case variants).
        if (isReplyRoute) {
          const trackingStateKey = routeCommitAckParams.stateKey || preStateKey;
          const tracking = getAckTrackingState(trackingStateKey);
          const ls = liveState as UnknownRecord | null;
          const alreadyReplied =
            Boolean(tracking.formal_reply_visible)
            || Boolean(tracking.reactionAckSent)
            || Boolean(ls?.formal_reply_visible)
            || Boolean(ls?.formalReplyVisible)
            || Boolean(ls?.finalResponseStreaming)
            || Boolean(ls?.final_response_streaming)
            || Boolean(ls?.delivered)
            || Boolean(ls?.firstTokenSeen)
            || Boolean(ls?.first_token_seen);
          if (alreadyReplied) {
            deps.pi.logger?.debug?.("octoclaw route-commit-ack: skipped, agent already responded");
            return;
          }
          // Second check: wait 600ms more, then check again.
          // Handles models that respond in the 800ms–1400ms window (check 1 passed
          // but model responds before sendRouteCommitAck HTTP call completes).
          // Also skip if a reaction ACK was already sent (emoji replaces text ACK).
          await new Promise<void>((r) => { const t = setTimeout(r, 600); (t as unknown as { unref?: () => void }).unref?.(); });
          const tracking2 = getAckTrackingState(trackingStateKey);
          if (Boolean(tracking2.formal_reply_visible) || Boolean(tracking2.reactionAckSent)) {
            deps.pi.logger?.debug?.("octoclaw route-commit-ack: skipped on second check, agent responded or reaction already sent");
            return;
          }
        }
        const routeCommitResult = await sendRouteCommitAck({
          ...routeCommitAckParams,
          state: asRecord(liveState ?? effectiveState),
        });
        if (routeCommitResult.sent && effectiveState) {
          effectiveState.routeCommitAckSent = true;
          effectiveState.route_commit_ack_sent = true;
          effectiveState.routeCommitAckId = routeCommitResult.routeCommitId;
          if (routeCommitResult.reason === "reaction_ack_sent") {
            updateAckTrackingState(routeCommitAckParams.stateKey || preStateKey, {
              reactionAckSent: true,
              reaction_ack_sent: true,
              reactionAckAttempted: true,
              reaction_ack_attempted: true,
              latencyAckSent: true,
              latencyAckMode: "reaction",
            });
          }
        }
      } catch (routeCommitErr) {
        deps.pi.logger?.warn?.(`octoclaw route-commit-ack error: ${String(routeCommitErr)}`);
      }
    };
    if (isReplyRoute) {
      // Delay for reply routes: cancel if agent starts within 500ms
      const REPLY_ACK_DELAY_MS = 800;
      const replyAckTimer = setTimeout(() => { void doSendRouteCommitAck(); }, REPLY_ACK_DELAY_MS);
      (replyAckTimer as unknown as { unref?: () => void }).unref?.();
    } else {
      void doSendRouteCommitAck();
    }

    const metadata = buildPolicyMetadata(ctx, { stateKey });
    const immutableReplyToMessageId = deliveryTargetReplyTo(asRecord(effectiveState)) || inboundMessageTs;
    if (immutableReplyToMessageId && !stringValue(metadata.message_id)) {
      metadata.message_id = immutableReplyToMessageId;
    }
    metadata.delivery_target = immutableDeliveryTarget;

    const prependSystem: string[] = [];
    const currentBudgetedMainState = readBudgetedMainState(asRecord(effectiveState));
    if (currentBudgetedMainState?.escalatedPending && stateKey) {
      prependSystem.push([
        "[OctoClaw budgeted main soft-budget notice]",
        `This budgeted main execution exceeded ${BUDGETED_MAIN_MAX_WALL_MS}ms before this prompt injection point.`,
        "If you already have enough information, produce the final answer now.",
        `You may use at most ${MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT} lightweight read-only tools if they are necessary to finish the answer.`,
        "If writing, long commands, multi-step tools, tests/build/review/validation, or more work is needed, call octoclaw_dispatch with the original task.",
        "Do not claim the task has started until sessions_spawn is accepted and octoclaw_dispatch_confirm succeeds.",
      ].join("\n"));
    } else if (isBudgetedMainDecision(effectiveDecision)) {
      prependSystem.push([
        "[OctoClaw budgeted main execution]",
        `This turn is decision_bucket=budgeted_main_then_delegate with maxWallMs=${BUDGETED_MAIN_MAX_WALL_MS}.`,
        `Answer directly only if the task can be completed in the main agent with at most ${MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT} lightweight read-only tools.`,
        "If writing, long commands, multi-step tools, tests/build/review/validation, or more work is needed, call octoclaw_dispatch.",
        `If dispatching local code/docs/repo work, pass known exact anchors as metadataJson.context_refs; use at most ${MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT} lightweight read-only lookups to find refs, and do not invent anchors.`,
        "Do not claim the task has started until sessions_spawn is accepted and octoclaw_dispatch_confirm succeeds.",
      ].join("\n"));
    }
    const judgeSucceeded = Boolean(effectiveDecision._judge_succeeded);
    const decisionDelegationEnabled = Boolean(effectiveDecision._delegation_enabled ?? true);

    const promptRequiresRouteHint = routeHintPromptRequired(effectiveDecision);
    if (promptRequiresRouteHint) {
      prependSystem.push(OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT);
    }

    if (decisionDelegationEnabled && !judgeSucceeded && promptRequiresRouteHint) {
      prependSystem.push([
        "OctoClaw delegation is available for this run.",
        "You can decide whether to handle this request directly or delegate to a sub-agent via octoclaw_dispatch.",
        "Use octoclaw_route_hint to indicate your routing preference (reply or delegate). Read-only observation is delegate with observer role.",
      ].join("\n"));
    }

    const route = stringValue(asRecord(effectiveDecision.route_decision).route);
    const slimMainContextEnabled = resolveSlimMainContextEnabled(deps.currentPluginConfig());
    const useSlimDelegateContext = slimMainContextEnabled && route === "delegate";
    if (isDelegatedRoute(effectiveDecision)) {
      prependSystem.push(useSlimDelegateContext ? OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT : OCTOCLAW_DELEGATION_SYSTEM_CONTEXT);
    }
    const isSpawnRoute = route === "delegate";
    const reviewRequired = Boolean(asRecord(effectiveDecision.review_policy).required);
    if (isSpawnRoute && reviewRequired) {
      prependSystem.push(OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT);
    }
    const lookupGuard = buildDirectLookupGuard(effectiveDecision);
    if (lookupGuard) {
      prependSystem.push(lookupGuard);
    }
    if (asRecord(effectiveDecision.state_grounding).required) {
      const executionFacts = buildRecentExecutionFacts(collectRecentExecutionReceipts(stateKey));
      const grounding = buildConversationGrounding({
        prompt,
        replayLogPath: resolveReplayLogPath(),
        taskStatePath: resolveTaskStatePath(),
        sessionKeys: [
          stateKey,
          stringValue((metadata as { session_key?: unknown }).session_key),
          stringValue(effectiveState?.canonicalSessionKey),
          stringValue(ctx.sessionKey),
        ].filter(Boolean),
        recentExecutionFacts: executionFacts,
      });
      if (grounding?.context) {
        prependSystem.push(grounding.context);
      }
    }
    const resolvedStateBoundaryStatus = stringValue(
      asRecord((resolved?.state as UnknownRecord | undefined)?.sessionBoundary).status,
    );
    if (stringValue(effectiveState?.sessionBoundary?.status || resolvedStateBoundaryStatus || detectSessionBoundary(ctx).status) === "contaminated_subagent_identity") {
      prependSystem.push([
        "[OctoClaw session boundary guard]",
        "Prior subagent context in this session is stale. Only use authoritative execution facts from the current turn or fresh workflow outputs.",
        "Do not claim a task was dispatched unless octoclaw_dispatch actually ran and returned a materialized result.",
      ].join("\n"));
    }
    const anomalyNotice = asRecord(effectiveState?.latestAnomalyNotice);
    if (stringValue(anomalyNotice.kind)) {
      prependSystem.push([
        "[OctoClaw execution anomaly notice]",
        `kind=${stringValue(anomalyNotice.kind)}, severity=${stringValue(anomalyNotice.severity || "warning")}`,
        stringValue(anomalyNotice.message),
        `task=${stringValue(anomalyNotice.taskId || anomalyNotice.nativeTaskId || "unknown")}, flow=${stringValue(anomalyNotice.nativeFlowId || "unknown")}`,
        "Do not claim the delegated sub-agent is running unless spawnExecuted=true or child session/run evidence exists.",
      ].filter(Boolean).join("\n"));
    }
    if (recoveryCheck.timedOutCount > 0) {
      const timedOutLines = recoveryCheck.recoveries
        .filter((entry) => asRecord(entry).timedOut === true)
        .map((entry) => {
          const item = asRecord(entry);
          return `- ${stringValue(item.delegateTaskId || item.taskId || item.flowId)}: ${stringValue(item.reason || item.trigger || "timed_out")}`;
        });
      prependSystem.push([
        "[OctoClaw recovery notice]",
        "One or more delegated tasks timed out during this event check.",
        "Treat those delegated runs as timed out/requiring recovery and avoid claiming they are still healthy.",
        timedOutLines.length > 0 ? `Timed out tasks:\n${timedOutLines.join("\n")}` : "",
      ].filter(Boolean).join("\n"));
    }
    prependSystem.push(OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT);
    const contextPayload = useSlimDelegateContext
      ? compactDelegatePolicyPrompt(effectiveDecision)
      : compactPolicyPrompt(effectiveDecision);
    const promptKey = prompt || "";
    const hasDedupKey = Boolean(stateKey);
    const shouldInjectPrependContext = !hasDedupKey || lastGroundedPromptByStateKey.get(stateKey) !== promptKey;
    if (hasDedupKey && shouldInjectPrependContext) {
      lastGroundedPromptByStateKey.set(stateKey, promptKey);
    }
    maybeStartBudgetedMain({
      stateKey,
      ctx,
      state: asRecord(effectiveState),
      decision: effectiveDecision,
      logger: deps.pi.logger,
    });
    effectiveState = maybeInjectSpeculativePreload({
      stateKey,
      ctx,
      state: asRecord(effectiveState),
      decision: effectiveDecision,
      route,
      prompt,
      prependSystem,
      pluginConfig: deps.currentPluginConfig(),
      logger: deps.pi.logger,
    }) as PolicyStateEntry;
    const projection = buildPromptContextProjection({
      prependSystem,
      contextPayload,
      shouldInjectPolicyProjection: shouldInjectPrependContext,
    });
    void recordPolicyReplay(
      "prompt_projection_built",
      {
        sessionKey: stateKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey,
        route,
        decision_bucket: stringValue(asRecord(effectiveDecision.route_decision).decision_bucket),
        elapsedMs: Date.now() - hookStartedAt,
        prependSystemCount: prependSystem.length,
        prependSystemChars: prependSystem.join("\n\n").length,
        contextPayloadChars: contextPayload.length,
        injectedPolicyProjection: shouldInjectPrependContext,
        slim_main_context_enabled: slimMainContextEnabled,
        slim_delegate_context_applied: useSlimDelegateContext,
        projectionReturned: Boolean(projection),
        speculative_preload_enabled: resolveSpeculativePreloadEnabled(deps.currentPluginConfig()),
        speculative_preload_state: stringValue(readSpeculativePreloadState(effectiveState)?.status),
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    return projection;
  };
}
