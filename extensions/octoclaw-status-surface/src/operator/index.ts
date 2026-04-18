import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { executeStatusSurfaceAction, type StatusSurfaceAction } from "../actions/index.js";
import { renderDetailsText, renderQueueText, renderStatusText, renderTimelineText } from "../renderers/text/index.js";
import { renderDetailsRich, renderQueueRich, renderStatusRich, renderTimelineRich } from "../renderers/rich/index.js";

export type StatusSurfaceFormat = "text" | "rich";

export function runStatusSurfaceOperator(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
  format: StatusSurfaceFormat = "text",
) {
  const surface = executeStatusSurfaceAction(action, record);
  if (format === "rich") {
    switch (action) {
      case "status":
        return renderStatusRich(surface as Parameters<typeof renderStatusRich>[0]);
      case "details":
        return renderDetailsRich(surface as Parameters<typeof renderDetailsRich>[0]);
      case "queue":
        return renderQueueRich(surface as Parameters<typeof renderQueueRich>[0]);
      case "timeline":
        return renderTimelineRich(surface as Parameters<typeof renderTimelineRich>[0]);
    }
  }

  switch (action) {
    case "status":
      return renderStatusText(surface as Parameters<typeof renderStatusText>[0]);
    case "details":
      return renderDetailsText(surface as Parameters<typeof renderDetailsText>[0]);
    case "queue":
      return renderQueueText(surface as Parameters<typeof renderQueueText>[0]);
    case "timeline":
      return renderTimelineText(surface as Parameters<typeof renderTimelineText>[0]);
  }
}
