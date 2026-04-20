import { describe, expect, it } from "vitest";
import { judgeFast, judgePolicy } from "./index.js";

describe("judge policy", () => {
  it("applies decision order route -> role -> backend -> workspace_mode -> model_profile", () => {
    const decision = judgePolicy({
      requiresDelegation: true,
      workType: "code",
      workspaceMode: "shared_workspace",
      queueBudget: 2,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
    });

    expect(decision.route).toBe("delegate");
    expect(decision.role).toBe("worker_code");
    expect(decision.backend).toBe("openclaw-native");
    expect(decision.executionProfile).toBe("worker");
    expect(decision.workspaceMode).toBe("shared_workspace");
    expect(decision.modelProfile).toBe("worker_code_deep");
    expect(decision.decisionStack).toEqual([
      "route",
      "role",
      "coordination_mode",
      "backend",
      "workspace_mode",
      "model_profile",
      "caps",
    ]);
  });

  it("builds a fast judgment packet", () => {
    const result = judgeFast({
      intent: { surfaceBound: true },
      requiresObservation: true,
      workspaceMode: "read_only",
      queueBudget: 1,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
    });

    expect(result.intent.intentClass).toBe("local_surface_lookup");
    expect(result.decision.route).toBe("delegate");
    expect(result.decision.role).toBe("observer_probe");
    expect(result.decision.backend).toBe("openclaw-native");
    expect(result.decision.executionProfile).toBe("observer");
    expect(result.decision.coordinationMode).toBeUndefined();
    expect(result.decision.modelProfile).toBe("observer_probe");
  });
});
