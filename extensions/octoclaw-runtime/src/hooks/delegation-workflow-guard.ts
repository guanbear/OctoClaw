import {
  isDelegatedRoute,
  matchesBlockedPattern,
  workflowEnforcementRule,
} from "../replay/policy-utils.js";
import { stringArray, stringValue } from "../extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import {
  gateAllow,
  gateBlock,
  gateObserve,
  type ToolGateAllowResult,
  type ToolGateBlockResult,
  type ToolGateObserveResult,
} from "./tool-gate-types.js";

export type DelegationWorkflowGuardResult =
  | ToolGateAllowResult
  | ToolGateObserveResult
  | ToolGateBlockResult
  | {
      kind: "delegate_tool";
      delegateTool: string;
    };

function blockedToolsPatch(toolName: string): UnknownRecord {
  return { blockedTools: [toolName].filter(Boolean) };
}

export function evaluateDelegationWorkflowGuard(input: {
  toolName: string;
  paramsText: string;
  decision: UnknownRecord;
  toolPolicy: UnknownRecord;
  routeHintTool: string;
  delegationEnforcementEnabled: boolean;
  stateKey?: string;
  sessionId?: string;
  forbiddenContractTools?: Set<string>;
  isDeterministicFallbackToDelegate?: boolean;
  isBudgetedMainDispatch?: boolean;
  isExplicitDelegateDispatch?: boolean;
}): DelegationWorkflowGuardResult {
  const workContractProjection = asRecord(input.decision.work_contract);
  const forbiddenContractTools = input.forbiddenContractTools
    ?? new Set(stringArray(workContractProjection.forbiddenTools || workContractProjection.forbidden_tools));
  if (
    forbiddenContractTools.has(input.toolName)
    && !input.isDeterministicFallbackToDelegate
    && !input.isBudgetedMainDispatch
    && !input.isExplicitDelegateDispatch
  ) {
    if (input.toolName === "octoclaw_dispatch") {
      return gateObserve({
        replayEvents: [{
          event: "work_contract_forbidden_dispatch_advisory",
          payload: {
            sessionKey: input.stateKey || "",
            sessionId: input.sessionId || "",
            route: stringValue(workContractProjection.route || asRecord(input.decision.route_decision).route),
            toolName: input.toolName,
            workContractId: stringValue(workContractProjection.workContractId || workContractProjection.work_contract_id),
          },
        }],
      });
    }

    return gateBlock(`OctoClaw WorkContract forbids ${input.toolName} for this turn.`, {
      statePatch: blockedToolsPatch(input.toolName),
      replayEvents: [{
        event: "tool_blocked_work_contract_forbidden",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(workContractProjection.route || asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
          workContractId: stringValue(workContractProjection.workContractId || workContractProjection.work_contract_id),
        },
      }],
    });
  }

  const blockedPatterns = Array.isArray(input.toolPolicy.block_tool_patterns)
    ? input.toolPolicy.block_tool_patterns.map((item) => stringValue(item)).filter(Boolean)
    : [];
  const delegateTool = stringValue(input.toolPolicy.must_delegate_via || "octoclaw_dispatch");
  const isPolicyControlTool = input.toolName.startsWith("octoclaw_") || input.toolName === input.routeHintTool || input.toolName === delegateTool;
  if (isDelegatedRoute(input.decision) && !isPolicyControlTool && matchesBlockedPattern(input.paramsText, blockedPatterns)) {
    return gateBlock(`OctoClaw runtime policy blocked a manual delegation pattern. Use ${delegateTool} instead.`, {
      replayEvents: [{
        event: "tool_blocked_manual_delegation",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
        },
      }],
    });
  }

  if (!input.delegationEnforcementEnabled) return gateAllow();

  const workflowRule = workflowEnforcementRule(input.decision, input.toolName, input.routeHintTool);
  if (!workflowRule.block && workflowRule.delegateTool && input.toolName === workflowRule.delegateTool) {
    return {
      kind: "delegate_tool",
      delegateTool: input.toolName,
    };
  }
  if (!workflowRule.block) return gateAllow();

  if (input.toolName === "octoclaw_dispatch") {
    return gateObserve({
      replayEvents: [{
        event: "workflow_enforcement_dispatch_advisory",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(workflowRule.route || asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
          allowedTools: workflowRule.allowedTools,
        },
      }],
    });
  }

  const workflowRoute = stringValue(workflowRule.route || asRecord(input.decision.route_decision).route);
  const observerOnly = Boolean(asRecord(asRecord(input.decision.hook_interface).before_tool_call).observe_only);
  return gateBlock(
    observerOnly
      ? `OctoClaw runtime policy route=delegate with role=observer_probe requires the observe workflow. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed workflow tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`
      : `OctoClaw runtime policy route=${stringValue(asRecord(input.decision.route_decision).route || "reply")} requires delegation. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed control tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`,
    {
      statePatch: blockedToolsPatch(input.toolName),
      replayEvents: [{
        event: observerOnly ? "tool_blocked_runner_policy" : "tool_blocked_delegation_policy",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: workflowRoute,
          toolName: input.toolName,
          allowedTools: workflowRule.allowedTools,
        },
      }],
    },
  );
}
