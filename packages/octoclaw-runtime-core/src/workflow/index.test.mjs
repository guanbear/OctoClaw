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
