import { describe, expect, it } from "vitest";
import { evaluateAdmission } from "./index.js";

describe("admission policy", () => {
  it("rejects when capability is not satisfied", () => {
    expect(evaluateAdmission({
      route: "delegate.single",
      queueBudget: 2,
      inflightCount: 0,
      capabilitySatisfied: false,
      workspaceMode: "shared_workspace",
      writeConflict: false,
    }).admission).toBe("reject");
  });

  it("defers when queue budget is exceeded", () => {
    expect(evaluateAdmission({
      route: "delegate.single",
      queueBudget: 1,
      inflightCount: 1,
      capabilitySatisfied: true,
      workspaceMode: "shared_workspace",
      writeConflict: false,
      maxWorkers: 1,
    })).toMatchObject({
      admission: "defer",
      reason: "queueBudget_exhausted",
    });
  });

  it("allows the normal case", () => {
    expect(evaluateAdmission({
      route: "reply",
      queueBudget: 0,
      inflightCount: 0,
      capabilitySatisfied: true,
      workspaceMode: "shared_workspace",
      writeConflict: false,
    })).toMatchObject({
      admission: "allow",
      reason: "admission_allowed",
    });
  });
});
