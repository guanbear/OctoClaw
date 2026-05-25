import { stringValue } from "../extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { gateAllow, gateBlock, gateObserve, type ToolGateResult } from "./tool-gate-types.js";

function blockedToolsPatch(toolName: string): UnknownRecord {
  return { blockedTools: [toolName].filter(Boolean) };
}

export function shouldBindRouteHintPrompt(toolName: string, routeHintTool = "octoclaw_route_hint"): boolean {
  return toolName === routeHintTool;
}

export function evaluateRouteHintGate(input: {
  toolName: string;
  decision: UnknownRecord;
  routeHintTool: string;
  routeHintIsRequired: boolean;
  routeHintAlreadySubmitted: boolean;
  directReplyToolsAllowed: boolean;
  allowedPreHintTools: Set<string>;
  stateKey?: string;
  sessionId?: string;
}): ToolGateResult {
  if (
    !input.routeHintIsRequired
    || input.routeHintAlreadySubmitted
    || input.directReplyToolsAllowed
    || input.allowedPreHintTools.has(input.toolName)
  ) {
    return gateAllow();
  }

  if (input.toolName === "octoclaw_dispatch") {
    return gateObserve({
      stop: false,
      replayEvents: [{
        event: "route_hint_dispatch_advisory",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
          requiredTool: input.routeHintTool,
        },
      }],
    });
  }

  return gateBlock(`OctoClaw runtime policy requires ${input.routeHintTool} before using other tools.`, {
    statePatch: blockedToolsPatch(input.toolName),
    replayEvents: [{
      event: "tool_blocked_before_route_hint",
      payload: {
        sessionKey: input.stateKey || "",
        sessionId: input.sessionId || "",
        route: stringValue(asRecord(input.decision.route_decision).route),
        toolName: input.toolName,
        requiredTool: input.routeHintTool,
      },
    }],
  });
}
