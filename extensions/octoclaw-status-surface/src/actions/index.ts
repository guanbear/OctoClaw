import type { RuntimeStateSurfaceRecord } from "../../../octoclaw-runtime/src/adapter/state-surface.ts";
import {
  buildDetailsSurface,
  buildQueueSurface,
  buildStatusSurface,
  buildTimelinePlaceholder,
} from "../view-model/index.ts";

export type StatusSurfaceAction = "status" | "details" | "queue" | "timeline";

export function executeStatusSurfaceAction(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
): ReturnType<typeof buildStatusSurface> | ReturnType<typeof buildDetailsSurface> | ReturnType<typeof buildQueueSurface> | ReturnType<typeof buildTimelinePlaceholder> {
  switch (action) {
    case "status":
      return buildStatusSurface(record);
    case "details":
      return buildDetailsSurface(record);
    case "queue":
      return buildQueueSurface(record);
    case "timeline":
      return buildTimelinePlaceholder(record);
  }
}
