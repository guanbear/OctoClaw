import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type { DetailsSurfaceProjection, QueueSurfaceProjection } from "../../read-model/index.js";
import type { RuntimeTimelinePlaceholder } from "../../view-model/index.js";

export function renderStatusRich(view: StatusSurfaceViewModel) {
  return {
    kind: "status_card",
    title: view.taskId,
    state: view.state,
    route: view.route,
    workerPool: view.workerPool,
    substrateSummary: view.substrateSummary,
    actions: view.actionAvailability,
  };
}

export function renderDetailsRich(view: DetailsSurfaceProjection) {
  return {
    kind: "details_card",
    title: view.taskId,
    flowId: view.flowId,
    state: view.substrateState,
    revision: view.substrateRevision,
    runtime: view.runtime,
    summary: view.summary,
    actions: view.actionAvailability,
  };
}

export function renderQueueRich(view: QueueSurfaceProjection) {
  return {
    kind: "queue_card",
    taskId: view.taskId,
    flowId: view.flowId,
    queuePosition: view.queuePosition,
    substrateSummary: view.substrateSummary,
    conflictQueued: view.conflictQueued,
  };
}

export function renderTimelineRich(view: RuntimeTimelinePlaceholder) {
  return {
    kind: "timeline_card",
    taskId: view.taskId,
    flowId: view.flowId,
    summary: view.summary,
    available: view.available,
    events: view.events,
  };
}
