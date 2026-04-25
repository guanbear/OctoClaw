import type { LiveRoute } from "@octoclaw/policy/route";

export const LIVE_ROUTE_NAMES = new Set<LiveRoute>(["reply", "delegate"]);
export const DELEGATED_ROUTE_NAMES = new Set<string>(["delegate"]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeLiveRoute(route: unknown, fallback: LiveRoute): LiveRoute {
  const normalized = String(route ?? "").trim();
  if (normalized === "direct") return "reply";
  if (normalized === "delegate.single" || normalized === "observe") return "delegate";
  if (normalized === "spawn_single" || normalized === "spawn_multi") return "delegate";
  if (normalized === "runner") return "delegate";
  if (LIVE_ROUTE_NAMES.has(normalized as LiveRoute)) return normalized as LiveRoute;
  return fallback;
}

export function isDelegatedRoute(route: unknown): boolean {
  return normalizeLiveRoute(route, "reply") === "delegate";
}

function decisionSignalsDelegate(decision: UnknownRecord): boolean {
  const routeDecision = asRecord(decision.route_decision);
  const toolPolicy = asRecord(decision.tool_policy);

  return normalizeLiveRoute(asString(decision.route), "reply") === "delegate"
    || normalizeLiveRoute(asString(routeDecision.route), "reply") === "delegate"
    || normalizeLiveRoute(asString(routeDecision.system_preferred_route), "reply") === "delegate"
    || normalizeLiveRoute(asString(routeDecision.judge_route ?? decision._judge_route), "reply") === "delegate"
    || asString(toolPolicy.must_delegate_via ?? decision.must_delegate_via).length > 0
    || toolPolicy.delegate_first === true
    || routeDecision.dispatch_required === true;
}

export function authoritativeDecisionRoute(decision: unknown, fallback: LiveRoute = "reply"): LiveRoute {
  const record = asRecord(decision);
  // Prefer sealed WorkContract route when present and valid (WP3)
  const workContract = asRecord(record.work_contract);
  const workContractRoute = asString(workContract.route);
  if (workContractRoute === "reply" || workContractRoute === "delegate") {
    return workContractRoute as LiveRoute;
  }

  if (decisionSignalsDelegate(record)) {
    return "delegate";
  }

  const routeDecision = asRecord(record.route_decision);
  for (const candidate of [
    asString(routeDecision.route),
    asString(record.route),
    asString(routeDecision.system_preferred_route),
    asString(routeDecision.judge_route ?? record._judge_route),
  ]) {
    if (!candidate) continue;
    return normalizeLiveRoute(candidate, fallback);
  }

  return fallback;
}

export function canonicalizeDecisionForPolicyState(decision: unknown): UnknownRecord {
  const current = asRecord(decision);
  if (Object.keys(current).length === 0) {
    return {};
  }

  const { pre_dispatch_ack: _legacyPreDispatchAck, ...currentSansPreDispatchAck } = current;
  const route = authoritativeDecisionRoute(current, "reply");
  const routeDecision = asRecord(current.route_decision);
  const toolPolicy = asRecord(current.tool_policy);
  const routerDecision = asRecord(current.router_decision_v2);
  const latencyAck = asRecord(current.latency_ack);
  const stateGrounding = asRecord(current.state_grounding);
  const currentTaskClass = asString(routeDecision.task_class);
  const nextTaskClass = route === "delegate"
    ? (currentTaskClass === "control_observer" ? "control_observer" : currentTaskClass || "delegated_single")
    : (currentTaskClass || "main_direct");

  return {
    ...currentSansPreDispatchAck,
    route,
    route_decision: {
      ...routeDecision,
      route,
      system_preferred_route: route,
      task_class: nextTaskClass,
      dispatch_required: route === "delegate",
    },
    tool_policy: {
      ...toolPolicy,
      must_delegate_via: route === "delegate" ? asString(toolPolicy.must_delegate_via) || "octoclaw_dispatch" : "",
      delegate_first: route === "delegate",
      allowed_control_tools: route === "delegate"
        ? (Array.isArray(toolPolicy.allowed_control_tools) && toolPolicy.allowed_control_tools.length > 0
            ? toolPolicy.allowed_control_tools
            : ["octoclaw_dispatch", "octoclaw_status", "octoclaw_route_hint"])
        : (Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools : []),
    },
    router_decision_v2: {
      ...routerDecision,
      compatibility_view: true,
      request_kind: route === "delegate" ? "delegated_task" : asString(routerDecision.request_kind) || "reply",
    },
    latency_ack: {
      ...latencyAck,
      required: route === "reply" && latencyAck.required !== false,
    },
    state_grounding: {
      ...stateGrounding,
      required: route === "delegate" ? true : stateGrounding.required === true,
      source: route === "delegate" ? (asString(stateGrounding.source) || "policy_state") : asString(stateGrounding.source),
    },
  };
}

export function isObserveMode(role?: string, executionProfile?: string): boolean {
  return role === "observer_probe" || executionProfile === "observer";
}
