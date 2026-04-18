import type { StatusSurfaceViewModel } from "@octoclaw/contracts/results";
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

export function buildTimelinePlaceholder(record: RuntimeStateSurfaceRecord): RuntimeTimelinePlaceholder {
  const statusView = buildStatusProjection({ record });
  const events = Array.isArray(statusView.timelinePreview)
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
    summary: events.length > 0
      ? `${events.length} timeline event${events.length === 1 ? "" : "s"} available for ${record.truth.taskId}`
      : `timeline placeholder for ${record.truth.taskId}`,
    events,
  };
}

export function buildStatusSurface(record: RuntimeStateSurfaceRecord): StatusSurfaceViewModel {
  return buildStatusProjection({ record });
}

export function buildDetailsSurface(record: RuntimeStateSurfaceRecord): RuntimeStateDetailsSurface {
  return buildDetailsProjection({ record });
}
