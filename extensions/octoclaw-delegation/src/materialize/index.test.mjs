import assert from "node:assert/strict";

const { materializeDelegatedWork } = await import("./index.ts");

const result = materializeDelegatedWork({
  role: "worker_code",
  objective: "Implement guarded delegation",
  readScope: [{ resource: "repo:docs", access: "read" }],
  writeScope: [{ resource: "repo:src/runtime", access: "write" }],
  workspaceMode: "shared_workspace",
  requestId: "req-1",
  taskId: "task-1",
  flowId: "flow-1",
  claimOwner: "worker-alpha",
  leaseDurationMs: 60_000,
  deliveryId: "delivery-1",
  deliveryReceiptId: "receipt-1",
  requestIdempotencyKey: "idem-1",
  queueBudget: 2,
  inflightCount: 0,
  capabilitySatisfied: true,
  writeConflict: false,
});

assert.equal(result.requestIdempotencyKey, "idem-1");
assert.equal(result.deliveryReceiptId, "receipt-1");
assert.equal(result.claimOwner, "worker-alpha");
assert.ok(result.claimToken, "delegation should include claim token");
assert.ok(result.leaseExpiresAt, "delegation should include lease expiry");
assert.equal(result.workspaceMode, "shared_workspace");
assert.equal(result.admission.admission, "allow");
assert.ok(
  result.brief.constraints.some((constraint) => constraint.includes("delivery receipt") || constraint.includes("claim ownership")),
  "worker brief should mention delivery or ownership obligations",
);
