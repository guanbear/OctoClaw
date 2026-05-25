import type { BudgetedMainState } from "../budgeted-main.js";
import { stringValue } from "../extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { evaluateReplyToolBudgetGate, type ReplyToolBudgetGateResult } from "./budgeted-main-gate.js";
import type { ToolGateResult } from "./tool-gate-types.js";

export type ReplyDirectToolRunnerResult =
  | { kind: "allow" }
  | { kind: "handled"; state: UnknownRecord | null }
  | { kind: "block"; result: ToolGateResult; state: UnknownRecord | null };

export interface ReplyDirectToolRunnerDeps {
  now: () => number;
  escalateBudgetedMainForTool: (input: {
    stateKey: string;
    ctx: UnknownRecord;
    state: UnknownRecord;
    decision: UnknownRecord;
    budgetState: BudgetedMainState;
    reason: string;
    logger: unknown;
  }) => Promise<{ state: UnknownRecord | null; decision: UnknownRecord }>;
  updateBudgetedMainForContext: (input: {
    stateKey: string;
    ctx: UnknownRecord;
    state: UnknownRecord;
    budgetState: BudgetedMainState;
  }) => UnknownRecord | null;
  scheduleBudgetedMainTimeout: (input: {
    stateKey: string;
    ctx: UnknownRecord;
    state: UnknownRecord;
    decision: UnknownRecord;
    budgetState: BudgetedMainState;
    logger: unknown;
  }) => void;
  updateAckTrackingState: (stateKey: string, patch: UnknownRecord) => void;
  maybeSendLatencyAck: (
    decision: UnknownRecord,
    metadata: UnknownRecord,
    stateKey: string,
    state: UnknownRecord,
    ctx: UnknownRecord,
    logger: unknown,
    toolName: string,
  ) => Promise<unknown>;
  updatePolicyState: (stateKey: string, updater: (current: UnknownRecord) => UnknownRecord) => void;
  recordAckReplay: (options: UnknownRecord) => Promise<void>;
  recordPolicyReplay: (
    event: string,
    payload: UnknownRecord,
    logger: unknown,
    decision?: UnknownRecord,
  ) => Promise<void>;
}

function shouldHandleReplyDirectTool(input: {
  toolName: string;
  decision: UnknownRecord;
  isControlObserverDecision: boolean;
  isSessionControlDecision: boolean;
}): boolean {
  return stringValue(asRecord(input.decision.route_decision).route) === "reply"
    && !input.isControlObserverDecision
    && !input.isSessionControlDecision
    && Boolean(input.toolName)
    && !input.toolName.startsWith("octoclaw_");
}

export async function runReplyDirectToolGate(input: {
  toolName: string;
  toolParams: UnknownRecord;
  decision: UnknownRecord;
  state: UnknownRecord;
  stateKey: string;
  ctx: UnknownRecord;
  metadata: UnknownRecord;
  logger: unknown;
  budgetedMainHandledTool: boolean;
  isControlObserverDecision?: boolean;
  isSessionControlDecision?: boolean;
}, deps: ReplyDirectToolRunnerDeps): Promise<ReplyDirectToolRunnerResult> {
  if (!shouldHandleReplyDirectTool({
    toolName: input.toolName,
    decision: input.decision,
    isControlObserverDecision: Boolean(input.isControlObserverDecision),
    isSessionControlDecision: Boolean(input.isSessionControlDecision),
  })) {
    return { kind: "allow" };
  }

  let state: UnknownRecord | null = input.state;
  const replyBudgetGate: ReplyToolBudgetGateResult = evaluateReplyToolBudgetGate({
    toolName: input.toolName,
    toolParams: input.toolParams,
    state: input.state,
    decision: input.decision,
    budgetedMainHandledTool: input.budgetedMainHandledTool,
    stateKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    now: deps.now(),
  });
  if (replyBudgetGate.kind === "block" && replyBudgetGate.reason && replyBudgetGate.budgetState) {
    const escalated = await deps.escalateBudgetedMainForTool({
      stateKey: input.stateKey,
      ctx: input.ctx,
      state: input.state,
      decision: input.decision,
      budgetState: replyBudgetGate.budgetState,
      reason: replyBudgetGate.reason,
      logger: input.logger,
    });
    return { kind: "block", result: replyBudgetGate, state: escalated.state };
  }
  if (replyBudgetGate.kind === "observe" && replyBudgetGate.budgetState) {
    state = deps.updateBudgetedMainForContext({
      stateKey: input.stateKey,
      ctx: input.ctx,
      state: input.state,
      budgetState: replyBudgetGate.budgetState,
    });
    if (replyBudgetGate.scheduleTimeout) {
      deps.scheduleBudgetedMainTimeout({
        stateKey: input.stateKey,
        ctx: input.ctx,
        state: input.state,
        decision: input.decision,
        budgetState: replyBudgetGate.budgetState,
        logger: input.logger,
      });
    }
  }

  deps.updateAckTrackingState(input.stateKey, { tool_active: true });
  const latencyAck = await deps.maybeSendLatencyAck(input.decision, input.metadata, input.stateKey, asRecord(state), input.ctx, input.logger ?? {}, input.toolName);
  deps.updatePolicyState(input.stateKey, (current) => ({
    ...current,
    directToolsSeen: Array.from(new Set([...(Array.isArray(current?.directToolsSeen) ? current.directToolsSeen : []), input.toolName])),
  }));
  await deps.recordAckReplay({
    decision: input.decision,
    stateKey: input.stateKey,
    ctx: input.ctx,
    logger: input.logger,
    kind: "latency",
    phase: "direct_tool",
    result: latencyAck,
    toolName: input.toolName,
  });
  const replayPayload = {
    sessionKey: input.stateKey || "",
    sessionId: stringValue(input.ctx.sessionId),
    route: stringValue(asRecord(input.decision.route_decision).route),
    taskClass: stringValue(asRecord(input.decision.route_decision).task_class),
    protectedLane: stringValue(asRecord(input.decision.route_decision).protected_lane),
    toolName: input.toolName,
    latencyAckRequired: Boolean(asRecord(input.decision.latency_ack).required),
    latencyAckSent: Boolean(asRecord(latencyAck).sent),
    latencyAckReason: stringValue(asRecord(latencyAck).reason),
  };
  void deps.recordPolicyReplay("direct_tool_called", replayPayload, input.logger, input.decision).catch(() => {});
  void deps.recordPolicyReplay("tool_used", replayPayload, input.logger, input.decision).catch(() => {});
  return { kind: "handled", state };
}
