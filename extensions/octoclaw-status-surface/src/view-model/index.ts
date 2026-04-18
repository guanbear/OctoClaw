import type { StatusSurfaceViewModel } from "../../../../packages/octoclaw-contracts/src/results.ts";
import {
  type RuntimeStateDetailsSurface,
  type RuntimeStateSurfaceRecord,
} from "../../../octoclaw-runtime/src/adapter/state-surface.ts";
import {
  buildDetailsProjection,
  buildQueueProjection,
  buildStatusProjection,
} from "../read-model/index.ts";

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
}

export function buildQueueSurface(
  record: RuntimeStateSurfaceRecord,
  queuePosition = 1,
): RuntimeQueueSurface {
  return buildQueueProjection({ record, queuePosition });
}

export function buildTimelinePlaceholder(record: RuntimeStateSurfaceRecord): RuntimeTimelinePlaceholder {
  return {
    taskId: record.truth.taskId,
    flowId: record.truth.flowId,
    available: true,
    summary: `timeline placeholder for ${record.truth.taskId}`,
  };
}

export function buildStatusSurface(record: RuntimeStateSurfaceRecord): StatusSurfaceViewModel {
  return buildStatusProjection({ record });
}

export function buildDetailsSurface(record: RuntimeStateSurfaceRecord): RuntimeStateDetailsSurface {
  return buildDetailsProjection({ record });
}
