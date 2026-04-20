import { describe, expect, it } from "vitest";
import { decideRoute, isLiveRoute } from "./index.js";

describe("route policy", () => {
  it("chooses reply by default", () => {
    expect(decideRoute({ workspaceMode: "shared_workspace" })).toEqual({
      route: "reply",
      workspaceMode: "shared_workspace",
      routeReason: "default_main_reply",
    });
  });

  it("chooses delegate for delegable work", () => {
    expect(decideRoute({
      requiresDelegation: true,
      capabilitySatisfied: true,
      workspaceMode: "isolated_worktree",
    })).toEqual({
      route: "delegate",
      workspaceMode: "isolated_worktree",
      routeReason: "deliverable_or_capability_bound_work",
    });
  });

  it("chooses delegate for observation work", () => {
    expect(decideRoute({
      requiresObservation: true,
      capabilitySatisfied: true,
      workspaceMode: "read_only",
    })).toEqual({
      route: "delegate",
      workspaceMode: "read_only",
      routeReason: "hard_boundary_or_probe",
    });
  });

  it("handles invalid routes", () => {
    expect(isLiveRoute("reply")).toBe(true);
    expect(isLiveRoute("invalid")).toBe(false);
    expect(() => decideRoute({ requestedRoute: "invalid", workspaceMode: "shared_workspace" })).toThrow(
      "Unsupported live route: invalid",
    );
  });
});
