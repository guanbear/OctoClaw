import type { WorkspaceMode } from "@octoclaw/contracts/schemas";

export const LIVE_PHASE_TWO_ROUTES = ["reply", "delegate"] as const;
export type LiveRoute = (typeof LIVE_PHASE_TWO_ROUTES)[number];

export interface RouteInput {
  requestedRoute?: string;
  hardBoundaryControl?: boolean;
  requiresObservation?: boolean;
  requiresDelegation?: boolean;
  capabilitySatisfied?: boolean;
  workspaceMode: WorkspaceMode;
}

export interface RouteDecision {
  route: LiveRoute;
  workspaceMode: WorkspaceMode;
  routeReason: string;
}

export function isLiveRoute(value: string): value is LiveRoute {
  return LIVE_PHASE_TWO_ROUTES.includes(value as LiveRoute);
}

export function decideRoute(input: RouteInput): RouteDecision {
  if (input.requestedRoute && !isLiveRoute(input.requestedRoute)) {
    throw new Error(`Unsupported live route: ${input.requestedRoute}`);
  }

  if (input.requestedRoute && isLiveRoute(input.requestedRoute)) {
    return {
      route: input.requestedRoute,
      workspaceMode: input.workspaceMode,
      routeReason: "explicit_live_route",
    };
  }

  if (input.hardBoundaryControl || input.requiresObservation) {
    return {
      route: input.capabilitySatisfied === false ? "reply" : "delegate",
      workspaceMode: input.workspaceMode,
      routeReason: input.capabilitySatisfied === false
        ? "capability_guard_fallback_reply"
        : "hard_boundary_or_probe",
    };
  }

  if (input.requiresDelegation) {
    return {
      route: input.capabilitySatisfied === false ? "reply" : "delegate",
      workspaceMode: input.workspaceMode,
      routeReason: input.capabilitySatisfied === false
        ? "capability_guard_fallback_reply"
        : "deliverable_or_capability_bound_work",
    };
  }

  return {
    route: "reply",
    workspaceMode: input.workspaceMode,
    routeReason: "default_main_reply",
  };
}
