import {
  buildConversationGrounding,
  buildDirectLookupGuard,
} from "./conversation-grounding.js";
import {
  cancelAckGuard,
  cancelAckGuardForState,
  maybeSendLatencyAck,
  notifyUserMessage,
  sendReactionAck,
  startAckGuard,
  watchdogTick,
  WATCHDOG_INTERVAL_MS,
} from "./ack/ack-guard.js";
import {
  buildPolicyMetadata,
  detectSessionBoundary,
  isManagedAgentContext,
  resolveAckDeliverySessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "./resolve/session.js";
import { resolvePolicyDecisionForContext } from "./resolve/policy-resolver.js";
import { envOverrides, resolveReplayLogPath, resolveTaskStatePath } from "./resolve/env.js";
import { buildLiveJudgeContextPacket } from "./resolve/llm-judge.js";
import { initNativeHelperBridge } from "./adapter/native-helper.js";
import {
  compactPolicyPrompt,
  guardAssistantMessageForPolicyState,
  isControlObserverDecision,
  isDelegatedRoute,
  isSessionControlDecision,
  matchesBlockedPattern,
  observerControlTools,
  preHintAllowedTools,
  recordAckReplay,
  recordDeliveryRelayEvent,
  recordObservedDeliveryFromMessage,
  recordPolicyReplay,
  routeHintRequired,
  sessionControlTools,
  shouldRetainPolicyStateOnAgentEnd,
  stringifyParamsForPolicy,
  workflowEnforcementRule,
} from "./replay/replay-logger.js";
import { policyState, type PolicyStateEntry } from "./state/policy-state.js";
import { getCommandRegistrations, getToolRegistrations } from "./tools/registration.js";

type UnknownRecord = Record<string, unknown>;
type HookHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown;

interface LoggerLike {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

export interface PluginInterface {
  pluginConfig?: Record<string, unknown>;
  logger?: LoggerLike;
  on?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerHook?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerTool?(definition: Record<string, unknown>): void;
  registerCommand?(definition: Record<string, unknown>): void;
}

const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
  "If the judge recommended delegation, it provided structured reason codes (e.g. context_hygiene, fast_first_response, background_execution, cost_tiering, specialized_tools, quality_isolation).",
  "",
  "Why delegate instead of doing it yourself:",
  "- Sub-agents run in isolated context — your conversation stays clean and responsive for the user.",
  "- Complex tasks get capable models; simple tasks get fast, cheap models — better latency and lower cost.",
  "- The user gets faster replies because you stay available while sub-agents work in parallel.",
  "- Delegating keeps your context window fresh for the next user message.",
].join("\n");

const LATENCY_ACK_DELAY_MS = 4000;
const pendingLatencyAckTimers = new Map<string, ReturnType<typeof setTimeout>>();

const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "For non-hard-observe requests, submit a structured route hint before answering or dispatching.",
  "Use octoclaw_route_hint to state whether this should be reply, delegate.single, or observe.",
  "After route_hint merge: reply may answer directly; delegated routes must go through octoclaw_dispatch.",
  "",
  "Prefer delegation for multi-step tasks (writing code, research, analysis, file changes).",
  "Handle directly only for simple Q&A, greetings, or quick clarifications.",
].join("\n");

const OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT = [
  "When the user asks for task progress or acts on an OctoClaw task anchor, prefer the octoclaw_task_action tool.",
  "Use it for commands like: details <task_id>, queue, artifacts <task_id>, stop <task_id>, retry <task_id>, approve <task_id>, reject <task_id>.",
].join("\n");

const OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT = [
  "Before dispatching this task to a subagent, briefly confirm:",
  "- What is the core deliverable?",
  "- What are the key constraints?",
  "- Is the task boundary clear enough for a subagent to execute independently?",
  "Then proceed with octoclaw_dispatch.",
].join("\n");

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return String((content as { text: string }).text).trim();
  }
  return "";
}

function extractPromptText(event: UnknownRecord): string {
  const prompt = stringValue(event.prompt);
  if (prompt) {
    return prompt;
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if (stringValue((message as UnknownRecord).role).toLowerCase() !== "user") {
      continue;
    }
    const text = extractMessageText((message as UnknownRecord).content);
    if (text) {
      return text;
    }
  }
  return "";
}

function getPolicyStateForContext(ctx: UnknownRecord): { key: string; state: PolicyStateEntry | null } {
  const resolved = policyState.resolveForContext(ctx);
  return {
    key: stringValue(resolved.key),
    state: resolved.state ?? null,
  };
}

function updatePolicyState(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
  const key = stringValue(stateKey);
  if (!key) {
    return;
  }
  policyState.update(key, (current) => mutator(current));
}

function clearPolicyStateForContext(ctx: UnknownRecord): void {
  const { key } = getPolicyStateForContext(ctx);
  if (key) {
    policyState.clear(key);
  }
}

function toOpenClawToolDefinition(definition: Record<string, unknown>): Record<string, unknown> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.params,
    execute: async (
      _toolCallId: unknown,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => {
      const execute = definition.execute as ((params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>);
      return execute(params, ctx);
    },
  };
}

function toOpenClawCommandDefinition(definition: Record<string, unknown>): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    acceptsArgs: definition.acceptsArgs,
    execute: async (ctx: Record<string, unknown>) => {
      const handler = definition.handler as (ctx: Record<string, unknown>) => Promise<void>;
      await handler(ctx);
    },
    handler: definition.handler,
  };
}

export const plugin = {
  id: "octoclaw-runtime",
  name: "OctoClaw Runtime",
  description: "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  register(pi: PluginInterface): void {
    envOverrides.octoclawRoot = stringValue(pi.pluginConfig?.octoclawRoot);
    envOverrides.workspaceRoot = stringValue(pi.pluginConfig?.workspaceRoot);
    const ackTimerFirstTierMs = Number(pi.pluginConfig?.ackTimerFirstTierMs) || 60_000;
    const ackTimerTierCount = Math.min(6, Math.max(1, Number(pi.pluginConfig?.ackTimerTierCount) || 3));

    const judgeFastFromPlugin = (pi.pluginConfig?.judgeFast && typeof pi.pluginConfig.judgeFast === "object" && !Array.isArray(pi.pluginConfig.judgeFast)) ? pi.pluginConfig.judgeFast as Record<string, unknown> : {};
    const judgeFastFromEnv = (() => {
      const json = process.env.OCTOCLAW_JUDGE_FAST?.trim();
      if (!json) return {};
      try { const p = JSON.parse(json); return (typeof p === "object" && p && !Array.isArray(p)) ? p as Record<string, unknown> : {}; } catch { return {}; }
    })();
    const judgeFastRaw = (Object.keys(judgeFastFromPlugin).length > 0) ? judgeFastFromPlugin : judgeFastFromEnv;

    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log(`[octoclaw-judge] pluginKeys=${Object.keys(judgeFastFromPlugin).length} envKeys=${Object.keys(judgeFastFromEnv).length} rawKeys=${Object.keys(judgeFastRaw).length} envVar="${process.env.OCTOCLAW_JUDGE_FAST?.slice(0, 50) ?? "(none)"}" modelId="${(judgeFastRaw as Record<string, unknown>).modelId ?? "(none)"}"`);
    }

    const delegationEnabled = pi.pluginConfig?.delegationEnabled !== false && process.env.OCTOCLAW_DELEGATION_ENABLED !== "false";

    // Fire-and-forget bridge init — lazy-loads openclaw runtime binding
    // If runtime unavailable, getCachedBridge() returns unavailable bridge (fail-closed)
    initNativeHelperBridge().catch(() => { /* bridge will use unavailable fallback */ });

    const registerLifecycleHook = (hookName: string, handler: HookHandler, priority = 180): boolean => {
      if (typeof pi.on === "function") {
        pi.on(hookName, handler, { priority });
        pi.logger?.debug?.(`octoclaw hook registered via pi.on: ${hookName} (priority=${priority})`);
        return true;
      }
      if (typeof pi.registerHook === "function") {
        pi.registerHook(hookName, handler, { priority });
        return true;
      }
      return false;
    };

    registerLifecycleHook("before_model_resolve", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const prompt = extractPromptText(event);
      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      );
      const decision = asRecord(resolved?.decision);
      const hookConfig = asRecord(decision.hook_interface).before_model_resolve;
      const resolvedHookConfig = asRecord(hookConfig);
      if (!resolvedHookConfig.enabled) return;
      if (stringValue(asRecord(decision.route_decision).route || "reply") !== "reply") return;
      const modelOverride = stringValue(resolvedHookConfig.selected_model);
      if (!modelOverride) return;
      pi.logger?.debug?.(`octoclaw before_model_resolve modelOverride=${modelOverride}`);
      return { modelOverride };
    });

    registerLifecycleHook("before_prompt_build", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const prompt = extractPromptText(event);

      const preStateKey = resolvePolicyStateKey(ctx);
      const preMetadata = buildPolicyMetadata(ctx, { stateKey: preStateKey });
      const sessionKeys = resolvePolicyStateKeys(ctx);
      preMetadata.judge_replay_log_path = resolveReplayLogPath();
      preMetadata.judge_task_state_path = resolveTaskStatePath();
      preMetadata.judge_session_keys = sessionKeys;
      preMetadata.judge_context_packet = buildLiveJudgeContextPacket({
        prompt,
        metadata: preMetadata,
      });
      preMetadata._judgeFastConfig = judgeFastRaw;
      preMetadata._delegationEnabled = delegationEnabled;
      const preSessionKey = resolveAckDeliverySessionKey(preMetadata, preStateKey, getPolicyStateForContext(ctx).state, ctx);

      if (preSessionKey) {
        notifyUserMessage(preSessionKey, preStateKey);
      }

      let inboundMessageTs = "";
      {
        const inbound = asRecord(ctx.inboundMessage);
        const ev = asRecord(ctx.event);
        const hookEvent = asRecord(event);
        if (inbound && Object.keys(inbound).length > 0) inboundMessageTs = stringValue(inbound.ts || inbound.messageTs || inbound.messageId);
        else if (ev && Object.keys(ev).length > 0) inboundMessageTs = stringValue(ev.ts || ev.messageTs || ev.messageId);
        if (!inboundMessageTs && hookEvent) {
          const promptText = extractPromptText(hookEvent);
          const msgIdMatch = promptText.match(/"message_id"\s*:\s*"(\d+\.\d+)"/);
          if (msgIdMatch) inboundMessageTs = msgIdMatch[1];
        }
      }

      const judgeAckEnabled = Boolean(judgeFastRaw.judgeAckEnabled);
      const ackReactionEmoji = stringValue(judgeFastRaw.ackReactionEmoji);

      if (ackReactionEmoji && preSessionKey && inboundMessageTs) {
        sendReactionAck(preSessionKey, inboundMessageTs, ackReactionEmoji).catch(() => {});
      }

      // When judgeAckEnabled=false: start latency timer BEFORE judge (4s from message arrival, fast ACK).
      // When judgeAckEnabled=true: start latency timer AFTER judge (so ack_text is available).
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
          const latencyResult = await maybeSendLatencyAck(currentDecision, latencyMetadata, timerStateKey, getPolicyStateForContext(ctx).state ?? {}, ctx, pi.logger ?? {}, "direct_lookup");
          if (latencyResult?.sent) {
            cancelAckGuard(preSessionKey);
          }
        }, LATENCY_ACK_DELAY_MS);
        pendingLatencyAckTimers.set(timerStateKey, timer);
      };

      if (!judgeAckEnabled && !ackReactionEmoji) {
        startLatencyAckTimer(preStateKey);
      }

      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      );
      pendingDecision.value = asRecord(resolved?.decision);

      const decision = asRecord(resolved?.decision);
      const hookConfig = asRecord(asRecord(decision.hook_interface).before_prompt_build);
      if (!hookConfig.enabled) return;
      const stateKey = stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || "");
      const state = (resolved?.state as PolicyStateEntry | null | undefined) ?? getPolicyStateForContext(ctx).state;

      if (preSessionKey) {
        if (process.env.OCTOCLAW_ACK_DEBUG) {
          console.error(`[ack-dbg] preSessionKey=${preSessionKey.substring(0,40)} inboundMessageTs=${inboundMessageTs || "(empty)"}`);
        }
        startAckGuard(preSessionKey, stringValue(ctx.cwd) || process.cwd(), { stateKey, decision, replyToMessageId: inboundMessageTs, ackTimingConfig: { firstTierMs: ackTimerFirstTierMs, tierCount: ackTimerTierCount } });
      }
      if (state) {
        state.ackGuardKey = preSessionKey || "";
        if (inboundMessageTs) {
          state.inboundMessageTs = inboundMessageTs;
        }
      }

      const metadata = buildPolicyMetadata(ctx, { stateKey });
      if (inboundMessageTs && !stringValue(metadata.message_id)) {
        metadata.message_id = inboundMessageTs;
      }

      if (judgeAckEnabled && !ackReactionEmoji) {
        startLatencyAckTimer(stateKey);
      }

      const prependSystem: string[] = [];
      const judgeSucceeded = Boolean(decision._judge_succeeded);
      const decisionDelegationEnabled = Boolean(decision._delegation_enabled ?? true);

      if (routeHintRequired(decision)) {
        prependSystem.push(OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT);
      }

      if (decisionDelegationEnabled && !judgeSucceeded) {
        prependSystem.push([
          "OctoClaw delegation is available for this run.",
          "You can decide whether to handle this request directly or delegate to a sub-agent via octoclaw_dispatch.",
          "Use octoclaw_route_hint to indicate your routing preference (reply, delegate.single, or observe).",
        ].join("\n"));
      }

      if (isDelegatedRoute(decision)) {
        prependSystem.push(OCTOCLAW_DELEGATION_SYSTEM_CONTEXT);
      }
      const route = stringValue(asRecord(decision.route_decision).route);
      const isSpawnRoute = route === "delegate.single";
      const reviewRequired = Boolean(asRecord(decision.review_policy).required);
      if (isSpawnRoute && reviewRequired) {
        prependSystem.push(OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT);
      }
      const lookupGuard = buildDirectLookupGuard(decision);
      if (lookupGuard) {
        prependSystem.push(lookupGuard);
      }
      if (asRecord(decision.state_grounding).required) {
        const grounding = buildConversationGrounding({
          prompt,
          replayLogPath: resolveReplayLogPath(),
          taskStatePath: resolveTaskStatePath(),
          sessionKeys: [
            stateKey,
            stringValue((metadata as { session_key?: unknown }).session_key),
            stringValue(state?.canonicalSessionKey),
            stringValue(ctx.sessionKey),
          ].filter(Boolean),
        });
        if (grounding?.context) {
          prependSystem.push(grounding.context);
        }
      }
      const resolvedStateBoundaryStatus = stringValue(
        asRecord((resolved?.state as UnknownRecord | undefined)?.sessionBoundary).status,
      );
      if (stringValue(state?.sessionBoundary?.status || resolvedStateBoundaryStatus || detectSessionBoundary(ctx).status) === "contaminated_subagent_identity") {
        prependSystem.push([
          "[OctoClaw session boundary guard]",
          "This turn arrived on a session contaminated by subagent identity.",
          "Ignore any recalled subagent memory, tool history, or prior task outcome unless it appears in authoritative execution facts below or in fresh workflow outputs from this turn.",
          "For delegated routes, you must not claim the task was dispatched unless octoclaw_dispatch actually ran and returned a materialized result.",
        ].join("\n"));
      }
      prependSystem.push(OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT);
      if (prependSystem.length === 0) return;
      return {
        prependSystemContext: prependSystem.join("\n\n"),
        prependContext: compactPolicyPrompt(decision),
      };
    });

    registerLifecycleHook("before_tool_call", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext(ctx);
      const decision = asRecord(state?.decision);
      const hookConfig = asRecord(asRecord(decision.hook_interface).before_tool_call);
      if (!hookConfig.enabled) return;

      const toolName = stringValue(event.toolName || ctx.toolName);
      const routeHintTool = stringValue(hookConfig.route_hint_tool || "octoclaw_route_hint");
      const routeHintIsRequired = Boolean(hookConfig.route_hint_required);
      const delegationEnforcementEnabled = Boolean(hookConfig.delegation_enforcement);
      const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted);
      const allowedPreHintTools = preHintAllowedTools(decision, routeHintTool);
      const allowedObserverTools = observerControlTools(decision, routeHintTool);
      const allowedSessionTools = sessionControlTools(decision, routeHintTool);
      const metadata = buildPolicyMetadata(ctx, { stateKey });
      const storedInboundTs = stringValue(state?.inboundMessageTs);
      if (storedInboundTs && !stringValue(metadata.message_id)) {
        metadata.message_id = storedInboundTs;
      }

      if (
        stringValue(asRecord(decision.route_decision).route) === "reply"
        && !isControlObserverDecision(decision)
        && !isSessionControlDecision(decision)
        && toolName
        && !toolName.startsWith("octoclaw_")
      ) {
        const latencyAck = await maybeSendLatencyAck(decision, metadata, stateKey, state ?? {}, ctx, pi.logger ?? {}, toolName);
        updatePolicyState(stateKey, (current) => ({
          ...current,
          directToolsSeen: Array.from(new Set([...(Array.isArray(current?.directToolsSeen) ? current.directToolsSeen : []), toolName])),
        }));
        await recordAckReplay({
          decision,
          stateKey,
          ctx,
          logger: pi.logger,
          kind: "latency",
          phase: "direct_tool",
          result: latencyAck,
          toolName,
        });
        await recordPolicyReplay(
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
          pi.logger,
          decision,
        );
        await recordPolicyReplay(
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
          pi.logger,
          decision,
        );
      }

      if (isControlObserverDecision(decision)) {
        if (allowedObserverTools.has(toolName)) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        await recordPolicyReplay(
          "tool_blocked_control_observer",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            allowedTools: [...allowedObserverTools],
          },
          pi.logger,
          decision,
        );
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
        await recordPolicyReplay(
          "tool_blocked_session_control",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            allowedTools: [...allowedSessionTools],
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw current-session control request must use session control tools only: ${[...allowedSessionTools].join(", ")}.`,
        };
      }

      if (routeHintIsRequired && !routeHintAlreadySubmitted && !allowedPreHintTools.has(toolName)) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        await recordPolicyReplay(
          "tool_blocked_before_route_hint",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            requiredTool: routeHintTool,
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
        };
      }

      const toolPolicy = asRecord(decision.tool_policy);
      const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns)
        ? toolPolicy.block_tool_patterns.map((item) => stringValue(item)).filter(Boolean)
        : [];
      if (matchesBlockedPattern(stringifyParamsForPolicy(event.params), blockedPatterns)) {
        await recordPolicyReplay(
          "tool_blocked_manual_delegation",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
          },
          pi.logger,
          decision,
        );
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
        return;
      }
      if (!workflowRule.block) {
        return;
      }

      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      const workflowRoute = stringValue(workflowRule.route || asRecord(decision.route_decision).route);
      await recordPolicyReplay(
        workflowRoute === "observe" ? "tool_blocked_runner_policy" : "tool_blocked_delegation_policy",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: workflowRoute,
          toolName,
          allowedTools: workflowRule.allowedTools,
        },
        pi.logger,
        state?.decision as Record<string, unknown> | null,
      );
      return {
        block: true,
          blockReason: workflowRoute === "observe"
            ? `OctoClaw runtime policy route=observe requires the observe workflow. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed workflow tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`
            : `OctoClaw runtime policy route=${stringValue(asRecord(decision.route_decision).route || "reply")} requires delegation. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed control tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`,
      };
    });

    registerLifecycleHook("agent_end", async (_event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext(ctx);
      if (!stateKey) return;
      const pendingTimer = pendingLatencyAckTimers.get(stateKey);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingLatencyAckTimers.delete(stateKey);
      }
      cancelAckGuardForState(stateKey);
      await recordPolicyReplay(
        "agent_end",
        {
          sessionKey: stateKey,
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(state?.decision).route_decision && asRecord(asRecord(state?.decision).route_decision).route),
          systemPreferredRoute: stringValue(asRecord(asRecord(state?.decision).route_decision).system_preferred_route),
          workerPool: stringValue(asRecord(asRecord(state?.decision).route_decision).worker_pool),
          taskClass: stringValue(asRecord(asRecord(state?.decision).route_decision).task_class),
          protectedLane: stringValue(asRecord(asRecord(state?.decision).route_decision).protected_lane),
          routeHintRequired: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).required),
          routeHintSubmitted: Boolean(state?.routeHintSubmitted),
          delegated: Boolean(state?.delegated),
          delegationTool: stringValue(state?.delegationTool),
          directToolsSeen: Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : [],
          blockedTools: Array.isArray(state?.blockedTools) ? state.blockedTools : [],
          ackFollowupCandidate: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).ack_followup_candidate),
          ackFollowupApplied: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).ack_followup_applied),
          latencyAckRequired: Boolean(asRecord(asRecord(state?.decision).latency_ack).required),
          latencyAckSent: Boolean(state?.latencyAckSent),
          routeLanguagePacks: Array.isArray(asRecord(state?.decision).route_language_packs)
            ? asRecord(state?.decision).route_language_packs
            : [],
        },
        pi.logger,
        state?.decision as Record<string, unknown> | null,
      );
      if (stringValue(state?.pendingDeliveryId) && !state?.deliveryObserved) {
        await recordDeliveryRelayEvent(
          "delivery_agent_end_pending",
          {
            deliveryId: stringValue(state?.pendingDeliveryId),
            sessionKey: stateKey,
            route: stringValue(asRecord(asRecord(state?.decision).route_decision).route),
            taskId: stringValue(state?.pendingDeliveryTaskId),
            runnerJobId: stringValue(state?.pendingDeliveryRunnerJobId),
            state: "pending_at_agent_end",
          },
          pi.logger,
        );
      }
      if (shouldRetainPolicyStateOnAgentEnd(asRecord(state))) {
        return;
      }
      clearPolicyStateForContext(ctx);
    }, 50);

    registerLifecycleHook("before_message_write", (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext({
        sessionKey: stringValue(ctx.sessionKey),
        agentId: stringValue(ctx.agentId),
      });
      if (!state) return;
      const guarded = guardAssistantMessageForPolicyState(asRecord(event.message), asRecord(state));
      const visibleMessage = guarded.mode === "replace" && guarded.message ? guarded.message : asRecord(event.message);
      void recordObservedDeliveryFromMessage(visibleMessage, asRecord(state), stateKey, pi.logger).catch((err) => {
        pi.logger?.warn?.(`octoclaw delivery observe failed: ${String(err)}`);
      });
      if (guarded.mode === "replace" && guarded.message) {
        return { message: guarded.message };
      }
    }, 120);

    if (watchdogInterval) {
      clearInterval(watchdogInterval);
    }
    watchdogInterval = setInterval(() => {
      void watchdogTick(pi.logger).catch(() => undefined);
    }, WATCHDOG_INTERVAL_MS);

    if (typeof pi.registerTool === "function") {
      for (const tool of getToolRegistrations()) {
        pi.registerTool(toOpenClawToolDefinition(tool as unknown as Record<string, unknown>));
      }
    }

    if (typeof pi.registerCommand === "function") {
      for (const command of getCommandRegistrations()) {
        pi.registerCommand(toOpenClawCommandDefinition(command as unknown as Record<string, unknown>));
      }
    }
  },
};

export default plugin;
