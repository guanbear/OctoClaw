import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type { DetailsSurfaceProjection, QueueSurfaceProjection } from "../../read-model/index.js";
import type { RuntimeTimelinePlaceholder } from "../../view-model/index.js";

export function renderStatusText(view: StatusSurfaceViewModel): string {
  return [
    `Status: ${view.taskId}`,
    `state=${view.state}`,
    `route=${view.route}`,
    `worker_pool=${view.workerPool}`,
    `substrate=${view.substrateSummary}`,
    `actions=${(view.actionAvailability || []).join(", ")}`,
    view.queuePosition !== undefined ? `queue_position=${view.queuePosition}` : "queue_position=unknown",
    view.modelSummary ? `model=${view.modelSummary}` : null,
    view.costEstimate ? `cost=${view.costEstimate}` : null,
    view.claimOwner ? `claim_owner=${view.claimOwner}` : null,
    view.leaseState ? `lease_state=${view.leaseState}` : null,
    view.workspaceMode ? `workspace_mode=${view.workspaceMode}` : null,
    view.writeScopeSummary ? `write_scope=${view.writeScopeSummary}` : null,
  ].filter(Boolean).join("\n");
}

export function renderDetailsText(view: DetailsSurfaceProjection): string {
  return [
    `Details: ${view.taskId}`,
    `flow=${view.flowId}`,
    `state=${view.substrateState}`,
    `revision=${view.substrateRevision}`,
    `runtime=${view.runtime}`,
    `sync_mode=${view.syncMode}`,
    `claim_owner=${view.claimOwner}`,
    view.leaseState ? `lease_state=${view.leaseState}` : null,
    view.queuePosition !== undefined ? `queue_position=${view.queuePosition}` : null,
    view.modelSummary ? `model=${view.modelSummary}` : null,
    view.costEstimate ? `cost=${view.costEstimate}` : null,
    `stale=${String(view.isStale)}`,
    `conflict_queued=${String(view.conflictQueued)}`,
    `actions=${view.actionAvailability.join(", ")}`,
    `summary=${view.summary}`,
  ].filter(Boolean).join("\n");
}

export function renderQueueText(view: QueueSurfaceProjection): string {
  return [
    `Queue: ${view.taskId}`,
    `flow=${view.flowId}`,
    view.queuePosition !== undefined ? `position=${view.queuePosition}` : "position=unknown",
    `worker_pool=${view.workerPool}`,
    `substrate=${view.substrateSummary}`,
    `claim_owner=${view.claimOwner}`,
    view.leaseState ? `lease_state=${view.leaseState}` : null,
    `stale=${String(view.isStale)}`,
    `conflict_queued=${String(view.conflictQueued)}`,
  ].filter(Boolean).join("\n");
}

export function renderTimelineText(view: RuntimeTimelinePlaceholder): string {
  return `Timeline: ${view.taskId}\n${view.summary}`;
}
