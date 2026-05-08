import { DELEGATED_ROUTE_NAMES } from "../resolve/route-helpers.js";
import { parseSessionRoute as canonicalParseSessionRoute } from "../resolve/session.js";
import { asString, isRecord, type UnknownRecord } from "../util/type-coercion.js";
import { type AckRoutePhase } from "./ack-timing.js";

const OBSERVE_ROUTE_NAMES = new Set(["observe", "observer", "status", "inspect", "probe", "scan"]);

export interface AckTarget {
  target: string;
  threadId: string;
}

export function resolveRoutePhase(decision: UnknownRecord, options: UnknownRecord = {}): AckRoutePhase {
  const explicit = asString(options.routePhase || options.route_phase).toLowerCase();
  if (explicit === "delegate" || explicit === "observe" || explicit === "reply" || explicit === "pre_route") {
    return explicit;
  }

  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  const workContract = isRecord(decision.work_contract) ? decision.work_contract : {};
  const explicitRoute = asString(options.route || workContract.route || routeDecision.route);
  if (!explicitRoute && Object.keys(decision).length === 0) {
    return "pre_route";
  }

  const route = explicitRoute.toLowerCase();
  if (DELEGATED_ROUTE_NAMES.has(route)) {
    return "delegate";
  }
  if (OBSERVE_ROUTE_NAMES.has(route)) {
    return "observe";
  }
  if (route === "reply" || route === "direct") {
    return "reply";
  }
  return "pre_route";
}

export function threadKeyFromSessionKey(sessionKey: string, stateKey = ""): string {
  const parsed = canonicalParseSessionRoute(sessionKey);
  if (parsed.threadKey) return parsed.threadKey;
  if (parsed.bindingKey) return `${parsed.bindingKey}:${parsed.threadId || "root"}`;
  return asString(parsed.threadId || parsed.target || stateKey);
}

export function resolveAckTargetFromSessionKey(sessionKey: string): AckTarget {
  const parsed = canonicalParseSessionRoute(sessionKey);
  return {
    target: parsed.target,
    threadId: parsed.threadId,
  };
}
