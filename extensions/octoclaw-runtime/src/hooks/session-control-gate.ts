import {
  isControlObserverDecision,
  isSessionControlDecision,
} from "../replay/policy-utils.js";
import { isNativeAnnounceBlockedState, isNativeAnnounceDeliveryState } from "../resolve/native-announce-state.js";
import { NATIVE_ANNOUNCE_BLOCKED_TOOLS } from "../resolve/native-announce-types.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { gateAllow, gateBlock, gateObserve, type ToolGateResult } from "./tool-gate-types.js";

function appendBlockedToolPatch(toolName: string): UnknownRecord {
  return { blockedTools: [toolName].filter(Boolean) };
}

export function evaluateNativeAnnounceDeliveryGate(input: {
  toolName: string;
  state: unknown;
  stateKey?: string;
  sessionId?: string;
}): ToolGateResult {
  const state = asRecord(input.state);
  if (isNativeAnnounceBlockedState(state) && input.toolName === "octoclaw_dispatch") {
    return gateObserve({
      stop: true,
      replayEvents: [{
        event: "native_announce_blocker_redispatch_allowed",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          toolName: input.toolName,
          workContractId: stringValue(state.workContractId || state.work_contract_id),
          blocker: stringValue(state.nativeAnnounceBlocker || state.native_announce_blocker),
        },
      }],
    });
  }

  if (isNativeAnnounceDeliveryState(state) && NATIVE_ANNOUNCE_BLOCKED_TOOLS.has(input.toolName)) {
    return gateBlock(
      "OctoClaw is delivering an existing native subagent completion; do not dispatch or spawn new work for this inter-session announce.",
      {
        statePatch: appendBlockedToolPatch(input.toolName),
        replayEvents: [{
          event: "tool_blocked_native_announce_completion",
          payload: {
            sessionKey: input.stateKey || "",
            sessionId: input.sessionId || "",
            toolName: input.toolName,
            workContractId: stringValue(state.workContractId || state.work_contract_id),
            reason: "native_announce_completion_delivery",
          },
        }],
      },
    );
  }

  return gateAllow();
}

export function evaluateSessionControlGate(input: {
  toolName: string;
  decision: UnknownRecord;
  allowedObserverTools: Set<string>;
  allowedSessionTools: Set<string>;
  stateKey?: string;
  sessionId?: string;
}): ToolGateResult {
  const route = stringValue(asRecord(input.decision.route_decision).route);
  if (isControlObserverDecision(input.decision)) {
    if (input.allowedObserverTools.has(input.toolName)) return gateAllow({ stop: true });
    return gateBlock(`OctoClaw control/observer request must use control tools only: ${[...input.allowedObserverTools].join(", ")}.`, {
      statePatch: appendBlockedToolPatch(input.toolName),
      replayEvents: [{
        event: "tool_blocked_control_observer",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route,
          toolName: input.toolName,
          allowedTools: [...input.allowedObserverTools],
        },
      }],
    });
  }

  if (isSessionControlDecision(input.decision)) {
    if (input.allowedSessionTools.has(input.toolName)) return gateAllow({ stop: true });
    return gateBlock(`OctoClaw current-session control request must use session control tools only: ${[...input.allowedSessionTools].join(", ")}.`, {
      statePatch: appendBlockedToolPatch(input.toolName),
      replayEvents: [{
        event: "tool_blocked_session_control",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route,
          toolName: input.toolName,
          allowedTools: [...input.allowedSessionTools],
        },
      }],
    });
  }

  return gateAllow();
}
