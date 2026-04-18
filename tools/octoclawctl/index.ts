import type { RuntimeStateSurfaceRecord } from "../../extensions/octoclaw-runtime/src/adapter/state-surface.ts";
import { runStatusSurfaceOperator, type StatusSurfaceFormat } from "../../extensions/octoclaw-status-surface/src/index.ts";
import type { StatusSurfaceAction } from "../../extensions/octoclaw-status-surface/src/index.ts";

export function runOctoClawCtl(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
  format: StatusSurfaceFormat = "text",
) {
  return runStatusSurfaceOperator(action, record, format);
}
