import {
  ensurePreDispatchAck,
} from "../ack/ack-guard.js";
import {
  buildDecision,
  applyPhaseTwoLivePathPolicy,
  buildTsRuntimeDispatchPayload,
  buildTsRuntimeSpawnPayload,
  resolveStatelessPolicyDecision,
} from "../resolve/policy-resolver.js";
import {
  stableId,
  truncateText,
} from "../resolve/env.js";
import {
  type NativeHelperInvoker,
} from "../adapter/native-helper.js";
import {
  applyUserMetadataOverrides,
  buildPolicyMetadata,
  detectSessionBoundary,
  finalizeDispatchMetadata,
  isManagedAgentContext,
  resolvePolicyStateKey,
} from "../resolve/session.js";
import {
  policySummaryText,
  recordAckReplay,
  recordDispatchLifecycleReplayEvents,
  recordPolicyReplay,
  registerPendingDelivery,
} from "../replay/replay-logger.js";
import { policyState } from "../state/policy-state.js";

type UnknownRecord = Record<string, unknown>;

export interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  params?: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CommandRegistration {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: (ctx: Record<string, unknown>) => Promise<void>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function nestedRecord(value: unknown, key: string): UnknownRecord {
  return asRecord(asRecord(value)[key]);
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseObjectJson(value: unknown): UnknownRecord {
  const text = asString(value);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePolicyDecisionJson(value: unknown): UnknownRecord | null {
  const parsed = parseObjectJson(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function toolLogger(ctx: UnknownRecord): UnknownRecord {
  return asRecord(ctx.logger);
}

function toolResponse(summary: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: summary,
    json: details,
  };
}

function statusToolResponse(rawOutput: string, format: string): Record<string, unknown> {
  const text = [
    "OctoClaw raw status panel below. Return it verbatim to the user without summarizing or rewriting.",
    "```text",
    rawOutput,
    "```",
  ].join("\n");
  return {
    text,
    json: {
      format,
      source: "native_runtime",
      raw_output: rawOutput,
      return_verbatim: true,
    },
  };
}

function normalizeTaskActionFormat(format: string): "text" | "json" {
  return format === "text" ? "text" : "json";
}

function parseTaskAction(rawText: string): { action: string; taskId: string } {
  const [action = "", taskId = ""] = rawText.trim().split(/\s+/u);
  return {
    action: action.trim(),
    taskId: taskId.trim(),
  };
}

function buildNativeTaskActionPayload(rawText: string, format: "text" | "json"): { summary: string; payload: UnknownRecord } {
  const { action, taskId } = parseTaskAction(rawText);
  const normalizedAction = action || "details";
  const target = taskId || "current-task";
  const summary = [
    `OctoClaw native runtime accepted task action '${normalizedAction}' for ${target}.`,
    "Use the native status/task surfaces to inspect details, queue state, artifacts, or approval flow.",
  ].join(" ");
  const payload: UnknownRecord = {
    mode: "native_runtime",
    action: normalizedAction,
    taskId: taskId || undefined,
    format,
    accepted: true,
    summary,
  };
  return {
    summary: format === "text" ? summary : JSON.stringify(payload, null, 2),
    payload,
  };
}

function buildNativeStatusOutput(format: string): string {
  const normalizedFormat = format || "anchors";
  return [
    `OctoClaw native runtime status (${normalizedFormat})`,
    "Legacy shell status renderers are removed from tool registration.",
    "Use the native status surface / read-model pipeline for queue, details, timeline, and anchor views.",
  ].join("\n");
}

function handoffText(payload: Record<string, unknown>, fallback: string): string {
  const handoff = asRecord(payload.handoff);
  if (handoff.user_safe === true && asString(handoff.reply_text)) {
    return asString(handoff.reply_text);
  }
  if (asString(handoff.summary)) {
    return asString(handoff.summary);
  }
  return fallback;
}

async function readReportExcerpt(reportPath: string, cwd?: string): Promise<Record<string, unknown>> {
  const resolvedPath = reportPath.startsWith("/")
    ? reportPath
    : `${asString(cwd, process.cwd()).replace(/\/$/u, "")}/${reportPath}`;
  return {
    exists: false,
    excerpt: "",
    path: resolvedPath,
    source: "native_runtime",
    note: "report excerpt preview is surfaced by native runtime consumers rather than this tool shim",
  };
}

async function userFacingHandoff(payload: Record<string, unknown>, fallback: string, cwd?: string): Promise<string> {
  const base = handoffText(payload, fallback);
  const handoff = asRecord(payload.handoff);
  const reportPath = asString(handoff.report_path ?? payload.report_path);
  const job = asRecord(payload.job);
  const taskId = asString(job.id ?? payload.task_id);
  if (!reportPath) {
    return base;
  }
  const artifactsCmd = taskId ? `octoclaw_task_action artifacts ${taskId}` : "octoclaw_task_action artifacts";
  try {
    const preview = await readReportExcerpt(reportPath, cwd);
    if (preview.exists === true && asString(preview.excerpt)) {
      return `${base}\n\n报告摘录：\n${asString(preview.excerpt)}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
    }
  } catch {
    // Fall back to base handoff text.
  }
  return `${base}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
}

function resolveToolPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.resolveForContext(ctx));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
  }
  if (prompt) {
    const byPrompt = asRecord(policyState.findByPrompt(prompt));
    return {
      key: asString(byPrompt.key),
      state: isRecord(byPrompt.state) ? byPrompt.state : null,
    };
  }
  return { key: asString(resolvePolicyStateKey(ctx)), state: null };
}

function setPolicyStateForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKey = ""): string {
  const stateKey = asString(explicitKey || resolvePolicyStateKey(ctx));
  if (stateKey) {
    policyState.set(stateKey, entry);
  }
  return stateKey;
}

function delegatedStickyRoute(decision: UnknownRecord): boolean {
  const route = asString(asRecord(decision.route_decision).route);
  return route === "runner" || route === "spawn_single" || route === "spawn_multi";
}

async function persistStickyLane(sessionKey: string, payload: UnknownRecord, logger: unknown, source: string): Promise<Record<string, unknown>> {
  const stickyPersisted = {
    persisted: Boolean(sessionKey),
    source,
    reason_codes: delegatedStickyRoute(payload) ? ["delegated_route"] : [],
  };
  if (sessionKey) {
    await recordPolicyReplay("sticky_lane_persisted", { sessionKey, source }, logger, payload);
  }
  return stickyPersisted;
}

function compactDispatchDetails(payload: UnknownRecord): UnknownRecord {
  return {
    route: asString(payload.route),
    status: asString(payload.status),
    executed: payload.executed === true,
    worker_pool: asString(payload.worker_pool),
    model: asString(payload.model),
    task_id: asString(payload.task_id ?? asRecord(payload.materialization).task_id),
    flow_id: asString(payload.flow_id ?? asRecord(payload.materialization).flow_id),
    materialization: asRecord(payload.materialization),
    policy_decision: asRecord(payload.policy_decision),
    telemetry: asRecord(payload.telemetry),
    runtime_truth: asRecord(payload.runtime_truth),
    orchestration: asRecord(payload.orchestration),
    handoff: asRecord(payload.handoff),
    capability_failure: asRecord(payload.capability_failure),
  };
}

function ctxCwd(ctx: UnknownRecord): string {
  return asString(ctx.cwd, process.cwd());
}

function ctxUi(ctx: UnknownRecord): { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void } {
  return asRecord(ctx.ui) as { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void };
}

function hasUi(ctx: UnknownRecord): boolean {
  return ctx.hasUI === true;
}

function readHelperInvoker(...values: unknown[]): NativeHelperInvoker | null {
  for (const value of values) {
    if (typeof value === "function") {
      return value as NativeHelperInvoker;
    }
  }
  return null;
}

async function executeTaskAnchorCommand(rawText: string, format: string, cwd: string): Promise<{ summary: string; payload: UnknownRecord }> {
  void cwd;
  return buildNativeTaskActionPayload(rawText, normalizeTaskActionFormat(format));
}

export function getToolRegistrations(): ToolRegistration[] {
  return [
    {
      name: "octoclaw_route_hint",
      label: "OctoClaw Route Hint",
      description: "Submit a structured main-brain route hint so OctoClaw can merge it with system policy and return the final decision.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "Optional task override. Defaults to the current prompt for this session." },
          command: { type: "string", description: "Optional shell command context." },
          routeHint: { type: "string", enum: ["direct", "spawn_single", "spawn_multi"] },
          workType: { type: "string", enum: ["ops", "research", "code", "review"] },
          phase: { type: "string", description: "Optional phase hint such as inspect, implement, collect, report, verify." },
          reviewRequired: { type: "boolean", description: "Whether review should be required after merge." },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          reason: { type: "string", description: "Short explanation for the route hint." },
        },
        required: ["routeHint"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const { key: existingStateKey, state: existing } = resolveToolPolicyContext(ctx, asString(params.task));
        const task = asString(params.task ?? existing?.prompt);
        if (!task) {
          return { error: "octoclaw_route_hint requires task context" };
        }
        const existingDecision = nestedRecord(existing, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        const metadata = buildPolicyMetadata(ctx, { stateKey: existingStateKey || asString(existingRequest.session_key) });
        const replaySessionKey = asString(existingStateKey || metadata.session_key || existingRequest.session_key);
        const routeHintPayload = {
          route_hint: asString(params.routeHint),
          work_type: asString(params.workType),
          phase: asString(params.phase),
          review_required: params.reviewRequired === true,
          confidence: asNumber(params.confidence) ?? 0,
          reason: asString(params.reason),
          source: "main_agent",
        };
        const payload = await resolveStatelessPolicyDecision(task, {
          command: asString(params.command),
          metadata,
          routeHint: routeHintPayload,
        });
        const stickyPersisted = await persistStickyLane(replaySessionKey, payload, toolLogger(ctx), "route_hint");
        setPolicyStateForContext(ctx, {
          ...(existing ?? {}),
          prompt: task,
          decision: payload,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          delegated: existing?.delegated === true,
          delegationTool: asString(existing?.delegationTool),
          blockedTools: Array.isArray(existing?.blockedTools) ? existing?.blockedTools : [],
          routeHintSubmitted: true,
          routeHintPayload,
        }, existingStateKey || replaySessionKey);
        await recordPolicyReplay(
          "route_hint_submitted",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            routeHint: asString(params.routeHint),
            workType: asString(params.workType),
            phase: asString(params.phase),
            reviewRequired: params.reviewRequired === true,
            confidence: asNumber(params.confidence) ?? 0,
            reason: truncateText(params.reason, 180),
            systemPreferredRoute: asString(asRecord(payload.route_decision).system_preferred_route),
            finalRoute: asString(asRecord(payload.route_decision).route),
            workerPool: asString(asRecord(payload.route_decision).worker_pool),
            stickyPersisted,
          },
          toolLogger(ctx),
          payload,
        );
        const nextSummary = asString(asRecord(payload.route_decision).route) === "direct"
          ? "route_hint merged: final route is direct. You may answer directly."
          : `route_hint merged: final route is ${asString(asRecord(payload.route_decision).route, "spawn_single")}. Next call octoclaw_dispatch.`;
        return toolResponse(nextSummary, payload);
      },
    },
    {
      name: "octoclaw_policy_decide",
      label: "OctoClaw Policy Decide",
      description: "Debug/parity helper that returns the structured OctoClaw runtime policy decision object, including route, model/profile, skill bundle, review policy, and hook interface hints.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify and route." },
          command: { type: "string", description: "Optional shell command if one already exists." },
          channel: { type: "string", description: "Optional transport/origin hint such as slack, wechat, webchat, or any other IM identifier." },
          sessionKey: { type: "string", description: "Optional main session key." },
          forceRoute: { type: "string", enum: ["direct", "runner", "spawn_single", "spawn_multi"] },
          metadataJson: { type: "string", description: "Optional JSON object with extra routing metadata." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        let metadata = applyUserMetadataOverrides(buildPolicyMetadata(ctx), parseObjectJson(params.metadataJson));
        if (asString(params.channel)) metadata.channel = asString(params.channel);
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: asString(params.sessionKey) });
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata,
          forceRoute: asString(params.forceRoute),
        });
        const json = applyPhaseTwoLivePathPolicy({
          ...payload,
          managed_agent_context: isManagedAgentContext(ctx),
        });
        return toolResponse(policySummaryText(json), json);
      },
    },
    {
      name: "octoclaw_route",
      label: "OctoClaw Route",
      description: "Debug/parity helper that exposes the current Node-side route decision for a task.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify." },
          command: { type: "string", description: "Optional shell command if the task already includes one." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata: buildPolicyMetadata(ctx),
        });
        return toolResponse(policySummaryText(payload), payload);
      },
    },
    {
      name: "octoclaw_dispatch",
      label: "OctoClaw Dispatch",
      description: "Run OctoClaw dispatch so lightweight tasks use runner and larger tasks return a subagent execution plan.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to dispatch." },
          command: { type: "string", description: "Optional shell command for runner tasks." },
          cwd: { type: "string", description: "Optional working directory override." },
          forceRoute: { type: "string", enum: ["auto", "direct", "runner", "spawn_single", "spawn_multi"] },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          sessionKey: { type: "string", description: "Optional session key override." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        let { key: stateKey, state } = resolveToolPolicyContext(ctx, asString(params.task));
        const hadCachedDecision = Boolean(params.policyJson || state?.decision);
        let cachedDecision = (isRecord(state?.decision) ? state?.decision : null) ?? parsePolicyDecisionJson(params.policyJson);
        let freshDecisionSource = "";
        if (!cachedDecision) {
          cachedDecision = await resolveStatelessPolicyDecision(asString(params.task), {
            command: asString(params.command),
            metadata: buildPolicyMetadata(ctx, { stateKey }),
            forceRoute: asString(params.forceRoute === "auto" ? "" : params.forceRoute),
          });
          freshDecisionSource = "fresh_context_resolve";
        }
        const managedSessionKey = asString(asRecord(cachedDecision.request).session_key || buildPolicyMetadata(ctx).session_key);
        const resolvedRoute = asString(params.forceRoute === "auto" ? "" : params.forceRoute || asRecord(cachedDecision.route_decision).route, "direct");
        const isDelegatedRoute = ["runner", "spawn_single", "spawn_multi"].includes(resolvedRoute);
        if (!hadCachedDecision && isDelegatedRoute && managedSessionKey && !params.policyJson) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.slice(0, 40)}… requires cached/passed policy for delegated route=${resolvedRoute}; got fresh decision from freeform prompt (source=${freshDecisionSource}). This violates §4.6.1 (dispatch must not re-judge).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            freshDecisionSource,
            hadCachedDecision: false,
            policyJsonProvided: false,
          }, toolLogger(ctx));
          return toolResponse(driftSummary, { sealed_decision_required: true, route: resolvedRoute, error: "freeform_reroute_blocked" });
        }
        let metadata = { ...buildPolicyMetadata(ctx, { stateKey: stateKey || asString(asRecord(cachedDecision.request).session_key) }) };
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        metadata = applyUserMetadataOverrides(metadata, parseObjectJson(params.metadataJson));
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey, state, cachedDecision });
        const ackResult = await ensurePreDispatchAck(
          cachedDecision,
          metadata,
          stateKey,
          state ?? {},
          ctx,
          ctx.onUpdate,
          toolLogger(ctx),
        );
        await recordAckReplay({
          decision: cachedDecision,
          stateKey,
          ctx,
          logger: toolLogger(ctx),
          kind: "pre_dispatch",
          phase: "before_dispatch",
          result: ackResult,
        });
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeDispatchPayload({
            task: asString(params.task),
            command: asString(params.command),
            cwd: asString(params.cwd, ctxCwd(ctx)),
            decision: cachedDecision,
            metadata,
            timeoutSeconds: asNumber(params.timeoutSeconds) ?? undefined,
            helperInvoker: readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker),
          });
        } catch (error) {
          const candidate = asRecord(error);
          payload = isRecord(candidate.payload) ? asRecord(candidate.payload) : {};
          if (Object.keys(payload).length === 0) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }
        const authoritativeDecision = asRecord(payload.policy_decision ?? cachedDecision);
        const replaySessionKey = asString(
          stateKey
          || metadata.session_key
          || asRecord(authoritativeDecision.request).session_key
          || asRecord(payload.job).session_key
          || payload.session_key,
        );
        const stickyDecision = delegatedStickyRoute(authoritativeDecision)
          ? authoritativeDecision
          : {
              route_decision: {
                route: asString(payload.route),
                system_preferred_route: asString(payload.system_preferred_route ?? payload.route),
                work_type: asString(payload.work_type),
                phase: asString(payload.phase),
                protocol: asString(payload.protocol),
              },
            };
        const stickyPersisted = await persistStickyLane(replaySessionKey, stickyDecision, toolLogger(ctx), "dispatch");
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${asString(payload.route)}${payload.executed === true ? " (executed)" : " (planned)"}`,
          ctxCwd(ctx),
        );
        await registerPendingDelivery({
          decision: authoritativeDecision,
          payload,
          summary,
          sessionKey: replaySessionKey,
          stateKey,
          logger: toolLogger(ctx),
        });
        await recordDispatchLifecycleReplayEvents({
          decision: authoritativeDecision,
          payload,
          sessionKey: replaySessionKey,
          sessionId: asString(ctx.sessionId),
          logger: toolLogger(ctx),
        });
        const sessionBoundary = detectSessionBoundary(ctx);
        await recordPolicyReplay(
          "dispatch_called",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            route: asString(asRecord(authoritativeDecision.route_decision).route || payload.route),
            systemPreferredRoute: asString(asRecord(authoritativeDecision.route_decision).system_preferred_route || payload.system_preferred_route),
            workerPool: asString(asRecord(authoritativeDecision.route_decision).worker_pool || payload.worker_pool),
            executed: payload.executed === true,
            usedCachedPolicy: hadCachedDecision,
            originalRoute: asString(asRecord(cachedDecision.route_decision).route || params.forceRoute),
            routeChanged: asString(asRecord(cachedDecision.route_decision).route) !== asString(payload.route),
            decisionSource: hadCachedDecision ? "cached" : (params.policyJson ? "policy_json" : freshDecisionSource || "fresh"),
            stickyPersisted,
            sessionBoundaryStatus: asString(sessionBoundary.status),
            canonicalSessionKey: asString(sessionBoundary.canonicalSessionKey || replaySessionKey),
          },
          toolLogger(ctx),
          authoritativeDecision,
        );
        if (!stateKey) {
          stateKey = asString(metadata.session_key, stableId("policy", [asString(params.task), asString(ctx.sessionId)]));
        }
        setPolicyStateForContext(ctx, {
          ...(state ?? {}),
          prompt: asString(params.task),
          decision: authoritativeDecision,
          delegated: delegatedStickyRoute(authoritativeDecision),
          updatedAt: Date.now(),
        }, stateKey);
        return toolResponse(summary, compactDispatchDetails(payload));
      },
    },
    {
      name: "octoclaw_spawn",
      label: "OctoClaw Spawn",
      description: "Generate and register a validated OctoClaw spawn task. Use this instead of hand-writing sessions_spawn arguments.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to run in a subagent." },
          route: { type: "string", enum: ["spawn_single", "spawn_multi"] },
          model: { type: "string", description: "Optional model override." },
          runtime: { type: "string", enum: ["subagent", "acp"] },
          streamTo: { type: "string", description: "Only valid when runtime=acp." },
          parentId: { type: "string", description: "Optional parent task id." },
          sessionKey: { type: "string", description: "Optional parent session key." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          execute: { type: "boolean", description: "Whether to immediately execute spawn via ClawTeam when enabled." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const { key: existingStateKey, state: existingState } = resolveToolPolicyContext(ctx, asString(params.task));
        const parentDecision = asRecord(existingState?.decision);
        const parentRoute = asString(asRecord(parentDecision.route_decision).route);
        const parentSessionKey = asString(asRecord(parentDecision.request).session_key);
        if (Object.keys(parentDecision).length > 0 && parentRoute === "runner" && asString(params.route) === "spawn_single") {
          return toolResponse(
            "sealed_route_violation: parent route is runner, cannot reroute to spawn_single. This violates §4.6.1.",
            { sealed_route_violation: true, parent_route: "runner", attempted_route: "spawn_single", error: "freeform_reroute_blocked" },
          );
        }
        const existingDecision = nestedRecord(existingState, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        let metadata = { ...buildPolicyMetadata(ctx, { stateKey: existingStateKey || parentSessionKey || asString(existingRequest.session_key) }) };
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        if (!metadata.session_key && parentSessionKey) metadata.session_key = parentSessionKey;
        metadata = applyUserMetadataOverrides(metadata, parseObjectJson(params.metadataJson));
        metadata = finalizeDispatchMetadata(ctx, metadata, {
          stateKey: existingStateKey,
          state: existingState,
          cachedDecision: existingState?.decision,
        });
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeSpawnPayload({
            task: asString(params.task),
            route: asString(params.route, "spawn_single"),
            decision: existingState?.decision as UnknownRecord | undefined,
            metadata: {
              ...metadata,
              model: asString(params.model),
              runtime: asString(params.runtime),
              stream_to: asString(params.streamTo),
              parent_id: asString(params.parentId),
            },
            helperInvoker: readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker),
            execute: params.execute === true,
          });
        } catch (error) {
          const candidate = asRecord(error);
          payload = isRecord(candidate.payload) ? asRecord(candidate.payload) : {};
          if (Object.keys(payload).length === 0) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw spawn registered: ${asString(payload.worker_pool || payload.route)} / ${asString(payload.model)}`,
          ctxCwd(ctx),
        );
        return toolResponse(summary, compactDispatchDetails(payload));
      },
    },
    {
      name: "octoclaw_task_action",
      label: "OctoClaw Task Action",
      description: "Handle task anchor fallback commands like details, queue, artifacts, stop, retry, approve, and reject.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Fallback command text such as 'details task-123' or 'queue'." },
          action: { type: "string", enum: ["details", "queue", "artifacts", "stop", "retry", "approve", "reject", "view", "detail"] },
          taskId: { type: "string", description: "Task id for task-scoped actions." },
          format: { type: "string", enum: ["text", "json"] },
        },
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const action = asString(params.action);
        const taskId = asString(params.taskId);
        const rawText = asString(params.text) || [action, taskId].filter(Boolean).join(" ").trim();
        if (!rawText) {
          return { error: "octoclaw_task_action requires either text or action/taskId" };
        }
        const format = asString(params.format, "json");
        const result = await executeTaskAnchorCommand(rawText, format, ctxCwd(ctx));
        return toolResponse(result.summary, result.payload);
      },
    },
    {
      name: "octoclaw_status",
      label: "OctoClaw Status",
      description: "Show current OctoClaw runner and task state. Default to task anchors; use compact/table/lanes only when the user explicitly asks for those legacy views.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["anchors", "compact", "table", "lanes"] },
        },
      },
      execute: async (params) => {
        const format = asString(params.format, "anchors");
        const output = buildNativeStatusOutput(format);
        return statusToolResponse(output, format);
      },
    },
  ];
}

export function getCommandRegistrations(): CommandRegistration[] {
  return [
    {
      name: "octotask",
      description: "Run an OctoClaw task anchor fallback command such as details <task_id> or queue",
      acceptsArgs: true,
      handler: async (ctx) => {
        const commandText = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!commandText) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octotask <details|queue|artifacts|stop|retry|approve|reject> [task_id]", "error");
          return;
        }
        const result = await executeTaskAnchorCommand(commandText, "text", ctxCwd(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(result.summary);
          ui.notify?.("OctoClaw task action completed", "info");
        }
      },
    },
    {
      name: "octostatus",
      description: "Show OctoClaw status; default task anchors, with compact/table/lanes available when explicitly requested",
      acceptsArgs: true,
      handler: async (ctx) => {
        const format = asString(ctx.args, "anchors");
        const output = buildNativeStatusOutput(format);
        const ui = ctxUi(ctx);
        if (hasUi(ctx)) {
          ui.notify?.(`OctoClaw status (${format})`);
          ui.setEditorText?.(output);
        }
      },
    },
    {
      name: "octoroute",
      description: "Show the current Node-side OctoClaw route decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octoroute <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octopolicy",
      description: "Show the structured OctoClaw runtime policy decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octopolicy <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octospawn",
      description: "Register a validated OctoClaw spawn task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octospawn <task>", "error");
          return;
        }
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeSpawnPayload({
            task,
            route: "spawn_single",
            decision: {},
            metadata: buildPolicyMetadata(ctx),
          });
        } catch (error) {
          const candidate = asRecord(error);
          if (!isRecord(candidate.payload)) {
            throw error;
          }
          payload = asRecord(candidate.payload);
        }
        const workflowDecision = buildDecision(task, payload.policy_decision as UnknownRecord | undefined, buildPolicyMetadata(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify({ ...payload, workflow_decision: workflowDecision }, null, 2));
          ui.notify?.(`OctoClaw spawn registered: ${asString(payload.task_id)}`);
        }
      },
    },
  ];
}
