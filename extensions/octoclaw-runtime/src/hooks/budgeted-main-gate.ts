import {
  buildBudgetedMainState,
  budgetedMainSpawnIntentId,
  budgetedMainToolEscalationReason,
  budgetedMainVisibleStartAt,
  budgetedMainWorkContractId,
  classifyBudgetedMainTool,
  readBudgetedMainState,
  updateBudgetedMainToolState,
  type BudgetedMainState,
} from "../budgeted-main.js";
import { stringValue } from "../extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import {
  gateAllow,
  gateBlock,
  gateObserve,
  type ToolGateAllowResult,
  type ToolGateBlockResult,
  type ToolGateObserveResult,
  type ToolGateReplayEvent,
} from "./tool-gate-types.js";

export type ActiveBudgetedMainGateResult =
  | (ToolGateAllowResult & {
      budgetedMainHandledTool: boolean;
      budgetState?: BudgetedMainState;
    })
  | (ToolGateObserveResult & {
      block: false;
      budgetedMainHandledTool: boolean;
      budgetState: BudgetedMainState;
    })
  | (ToolGateBlockResult & {
      budgetedMainHandledTool: boolean;
      budgetState: BudgetedMainState;
      reason: string;
    })
  | {
      kind: "escalate_dispatch";
      block: false;
      budgetedMainHandledTool: boolean;
      budgetState: BudgetedMainState;
      reason: string;
    };

export type ReplyToolBudgetGateResult =
  | ToolGateAllowResult
  | (ToolGateObserveResult & {
      block: false;
      budgetState: BudgetedMainState;
      scheduleTimeout: boolean;
      replayEvents: ToolGateReplayEvent[];
    })
  | (ToolGateBlockResult & {
      budgetState: BudgetedMainState;
      reason: string;
    });

function blockedToolsPatch(toolName: string): UnknownRecord {
  return { blockedTools: [toolName].filter(Boolean) };
}

export function evaluateActiveBudgetedMainGate(input: {
  toolName: string;
  toolParams: UnknownRecord;
  budgetState: BudgetedMainState;
  now: number;
}): ActiveBudgetedMainGateResult {
  if (input.toolName === "octoclaw_dispatch") {
    const reason = input.budgetState.escalatedPending || input.now - input.budgetState.startedAt >= input.budgetState.maxWallMs
      ? "wall_time_over_budget"
      : "main_agent_called_dispatch";
    return {
      kind: "escalate_dispatch",
      block: false,
      budgetedMainHandledTool: false,
      budgetState: input.budgetState,
      reason,
    };
  }

  const classification = classifyBudgetedMainTool(input.toolName, input.toolParams);
  if (!classification.counted) {
    return { ...gateAllow(), budgetedMainHandledTool: false };
  }

  const updatedBudget = updateBudgetedMainToolState(input.budgetState, classification);
  const escalationReason = budgetedMainToolEscalationReason(updatedBudget, classification);
  if (!escalationReason) {
    return {
      ...gateObserve(),
      block: false,
      budgetedMainHandledTool: true,
      budgetState: updatedBudget,
    };
  }

  return {
    ...gateBlock(`OctoClaw budgeted main execution escalated (${escalationReason}). This tool call did not execute. Call octoclaw_dispatch with the original task; do not use ordinary tools or claim the task has started before dispatch_confirm.`, {
      statePatch: blockedToolsPatch(input.toolName),
    }),
    budgetedMainHandledTool: true,
    budgetState: updatedBudget,
    reason: escalationReason,
  };
}

export function evaluateReplyToolBudgetGate(input: {
  toolName: string;
  toolParams: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  budgetedMainHandledTool: boolean;
  stateKey?: string;
  sessionId?: string;
  now: number;
}): ReplyToolBudgetGateResult {
  if (input.budgetedMainHandledTool) return gateAllow();
  if (stringValue(asRecord(input.decision.route_decision).route) !== "reply") return gateAllow();
  const classification = classifyBudgetedMainTool(input.toolName, input.toolParams);
  if (!classification.counted) return gateAllow();

  const existingBudget = readBudgetedMainState(input.state);
  const startedBudget = existingBudget?.active && !existingBudget.completedAt && !existingBudget.escalatedAt
    ? existingBudget
    : {
        ...buildBudgetedMainState({
          now: input.now,
          decision: input.decision,
          visibleStartAt: budgetedMainVisibleStartAt(input.state, input.now),
          budgetStartSource: "main_reply_tool_guard",
          workContractId: budgetedMainWorkContractId(input.state, input.decision),
          spawnIntentId: budgetedMainSpawnIntentId(input.state),
        }),
        reason: "main_reply_tool_observed",
        decisionBucket: stringValue(asRecord(input.decision.route_decision).decision_bucket || input.decision._decision_bucket || "main_reply_tool_guard"),
      };
  const updatedBudget = updateBudgetedMainToolState(startedBudget, classification);
  const escalationReason = budgetedMainToolEscalationReason(updatedBudget, classification);
  if (escalationReason) {
    return {
      ...gateBlock(`OctoClaw main reply tool budget escalated (${escalationReason}). This tool call did not execute. Call octoclaw_dispatch with the original task; do not continue ordinary tool execution in the main agent.`, {
        statePatch: blockedToolsPatch(input.toolName),
      }),
      budgetState: updatedBudget,
      reason: escalationReason,
    };
  }

  return {
    kind: "observe",
    replayEvents: [{
        event: "main_reply_tool_guard_observed",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(asRecord(input.decision.route_decision).route),
          decision_bucket: updatedBudget.decisionBucket,
          toolName: input.toolName,
          toolCount: updatedBudget.toolCount,
          readOnlyToolCount: updatedBudget.readOnlyToolCount,
          budgetStartSource: updatedBudget.budgetStartSource,
        },
      }],
    block: false,
    budgetState: updatedBudget,
    scheduleTimeout: true,
  };
}
