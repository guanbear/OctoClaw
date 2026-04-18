import { buildContractEnvelope } from "./schemas.js";
import type { AcceptanceCriterion, CapabilityDescriptor, ScopeMetadata } from "./schemas.js";
import type { DeliveryEnvelope } from "./deliveries.js";
import type { OwnershipMetadata, TaskIdentity } from "./events.js";
import type { StatusSurfaceViewModel, WorkerResult } from "./results.js";

const FIXTURE_SCOPE: ScopeMetadata = {
  readScope: [{ resource: "docs", access: "read" }],
  writeScope: [{ resource: "workspace", access: "write" }],
  workspaceMode: "shared_workspace",
  writeScopeSummary: "workspace",
};

const FIXTURE_OWNERSHIP: OwnershipMetadata = {
  claimOwner: "octoclaw-runtime",
  claimToken: "claim-fixture-1",
  leaseExpiresAt: "2026-04-15T00:00:30.000Z",
  lastHeartbeatAt: "2026-04-15T00:00:00.000Z",
};

const FIXTURE_IDENTITY: TaskIdentity = {
  taskId: "task-fixture-1",
  flowId: "flow-fixture-1",
};

export const TASK_PACKET_ACCEPTANCE_FIXTURE: AcceptanceCriterion[] = [
  {
    id: "criterion-summary",
    description: "Return a concise worker result summary.",
    required: true,
  },
  {
    id: "criterion-artifacts",
    description: "Attach artifact references for produced evidence.",
    required: true,
  },
];

export const CAPABILITY_DESCRIPTOR_FIXTURE: CapabilityDescriptor = {
  capabilityId: "runtime.native-taskflow",
  level: "supported",
  summary: "Native task/flow materialization through OpenClaw runtime seam.",
  constraints: ["Requires runtime-owned claim lease."],
  notes: ["Preferred over legacy Python bridge on the live path."],
};

export const WORKER_RESULT_FIXTURE: WorkerResult = {
  ...buildContractEnvelope("artifact", "2026-04-15T00:00:00.000Z"),
  ...FIXTURE_OWNERSHIP,
  ...FIXTURE_SCOPE,
  ...FIXTURE_IDENTITY,
  resultId: "result-fixture-1",
  status: "success",
  summary: "Worker finished the delegated task with artifacts attached.",
  details: "Validation completed and evidence was attached.",
  artifactRefs: ["artifact://octoclaw/result-fixture-1/report"],
  acceptanceResults: TASK_PACKET_ACCEPTANCE_FIXTURE.map((criterion) => ({
    criterion,
    satisfied: true,
    evidence: "fixture",
  })),
};

export const DELIVERY_ENVELOPE_FIXTURE: DeliveryEnvelope = {
  ...buildContractEnvelope("artifact", "2026-04-15T00:00:00.000Z"),
  ...FIXTURE_OWNERSHIP,
  ...FIXTURE_SCOPE,
  ...FIXTURE_IDENTITY,
  requestIdempotencyKey: "req-fixture-1",
  taskIdempotencyKey: "task-fixture-1",
  flowIdempotencyKey: "flow-fixture-1",
  deliveryId: "delivery-fixture-1",
  deliveryReceiptId: "receipt-fixture-1",
  outboxId: "outbox-fixture-1",
  status: "queued",
  channel: "slack",
  queuedAt: "2026-04-15T00:00:00.000Z",
};

export const STATUS_SURFACE_FIXTURE: StatusSurfaceViewModel = {
  ...buildContractEnvelope("projection", "2026-04-15T00:00:00.000Z"),
  taskId: "task-fixture-1",
  flowId: "flow-fixture-1",
  state: "running",
  route: "delegate.single",
  workerPool: "octoclaw-worker",
  substrateSummary: "Native taskflow task is running with an active lease.",
  actionAvailability: ["status", "details", "queue"],
  queuePosition: 1,
  modelSummary: "worker_default",
  costEstimate: "$0.02",
  claimOwner: "octoclaw-runtime",
  leaseState: "active",
  workspaceMode: "shared_workspace",
  writeScopeSummary: "workspace",
  timelinePreview: [
    {
      eventType: "checkpoint_emitted",
      eventAt: "2026-04-15T00:00:05.000Z",
      summary: "Worker emitted its first checkpoint.",
    },
  ],
};
