import type { WorkspaceMode } from "../../../octoclaw-contracts/src/schemas";

export const LIVE_PHASE_TWO_ROUTES = ["reply", "delegate.single", "observe"] as const;
export type LiveRoute = (typeof LIVE_PHASE_TWO_ROUTES)[number];

export interface RouteInput {
  requestedRoute?: string;
  hardBoundaryControl?: boolean;
  requiresObservation?: boolean;
  requiresDelegation?: boolean;
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
      route: "observe",
      workspaceMode: input.workspaceMode,
      routeReason: "hard_boundary_or_probe",
    };
  }

  if (input.requiresDelegation) {
    return {
      route: "delegate.single",
      workspaceMode: input.workspaceMode,
      routeReason: "deliverable_or_capability_bound_work",
    };
  }

  return {
    route: "reply",
    workspaceMode: input.workspaceMode,
    routeReason: "default_main_reply",
  };
}
