import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
import type { DelegateProgressEvent } from "@octoclaw/contracts/delegate";
import {
  type RuntimeStateDetailsSurface,
  type RuntimeStateSurfaceRecord,
} from "@octoclaw/runtime/state-surface";
import {
  buildDetailsProjection,
  buildQueueProjection,
  buildStatusProjection,
} from "../read-model/index.js";

export interface RuntimeQueueSurface {
  taskId: string;
  flowId: string;
  queuePosition?: number;
  workerPool: string;
  substrateSummary: string;
  claimOwner: string;
}

export interface RuntimeTimelinePlaceholder {
  taskId: string;
  flowId: string;
  available: true;
  summary: string;
  events: Array<{
    timestamp: string;
    phase: string;
    summary: string;
  }>;
}

export function buildQueueSurface(
  record: RuntimeStateSurfaceRecord,
  queuePosition = 1,
): RuntimeQueueSurface {
  return buildQueueProjection({ record, queuePosition });
}

export function buildTimelinePlaceholder(
  record: RuntimeStateSurfaceRecord,
  progressEvents?: DelegateProgressEvent[],
): RuntimeTimelinePlaceholder {
  const statusView = buildStatusProjection({ record, progressEvents });
  const timelineEvents = Array.isArray(statusView.timelinePreview)
    ? statusView.timelinePreview.map((entry) => ({
        timestamp: String(entry.eventAt ?? "").trim(),
        phase: String(entry.eventType ?? "").trim(),
        summary: String(entry.summary ?? "").trim(),
      })).filter((entry) => entry.timestamp || entry.phase || entry.summary)
    : [];
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    available: true,
    summary: timelineEvents.length > 0
      ? `${timelineEvents.length} timeline event${timelineEvents.length === 1 ? "" : "s"} available for ${record.truth.taskId}`
      : `timeline placeholder for ${record.truth.taskId}`,
    events: timelineEvents,
  };
}

export function buildStatusSurface(record: RuntimeStateSurfaceRecord): StatusSurfaceViewModel {
  return buildStatusProjection({ record });
}

export function buildDetailsSurface(record: RuntimeStateSurfaceRecord): RuntimeStateDetailsSurface {
  return buildDetailsProjection({ record });
}
