import assert from "node:assert/strict";

const workflow = await import("./index.ts");

const scope = {
  readScope: [],
  writeScope: [],
  workspaceMode: "isolated_workspace",
};

const state = workflow.startRuntimeWorkflow({
  requestId: "r1",
  taskId: "t1",
  flowId: "f1",
  decision: {
    route: "delegate.single",
    role: "worker_research",
    backend: "worker",
    workspaceMode: "isolated_workspace",
    modelProfile: "worker_default",
    caps: {
      workerPool: "octoclaw-research",
      maxWorkers: 1,
      latencyTarget: "background",
      queueBudget: 1,
      capReason: "test",
    },
    admission: {
      admission: "allow",
      queueBudget: 1,
      maxWorkers: 1,
      latencyTarget: "background",
      reason: "admission_allowed",
    },
    decisionStack: ["route", "role", "backend", "workspace_mode", "model_profile", "caps"],
  },
  role: "worker_research",
  claimOwner: "owner-a",
  leaseDurationMs: 30_000,
  deadlineBudget: {
    queueMs: 1,
    startMs: 1,
    progressMs: 1,
    runtimeMs: 1,
    deliveryMs: 1,
  },
  scope,
});

assert.ok(state.taskMaterialization, "workflow start should materialize task ownership data");
assert.equal(state.taskMaterialization.taskId, "t1");
assert.equal(state.taskMaterialization.claimOwner, "owner-a");

const running = workflow.advanceWorkflowToRunning(state, "owner-a");

assert.equal(running.workflowOrchestration, "running");
assert.equal(running.claim?.claimOwner, "owner-a");
