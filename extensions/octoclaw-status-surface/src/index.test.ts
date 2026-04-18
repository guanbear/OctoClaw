import { describe, expect, it } from "vitest";
import * as statusSurface from "./index.js";
import * as readModel from "./read-model/index.js";
import * as viewModel from "./view-model/index.js";
import * as textRenderer from "./renderers/text/index.js";
import * as richRenderer from "./renderers/rich/index.js";
import * as actions from "./actions/index.js";
import * as operator from "./operator/index.js";

describe("index exports", () => {
  it("re-exports all sub-modules", () => {
    expect(statusSurface.buildStatusProjection).toBe(readModel.buildStatusProjection);
    expect(statusSurface.buildQueueProjection).toBe(readModel.buildQueueProjection);
    expect(statusSurface.buildDetailsProjection).toBe(readModel.buildDetailsProjection);

    expect(statusSurface.buildStatusSurface).toBe(viewModel.buildStatusSurface);
    expect(statusSurface.buildQueueSurface).toBe(viewModel.buildQueueSurface);
    expect(statusSurface.buildTimelinePlaceholder).toBe(viewModel.buildTimelinePlaceholder);
    expect(statusSurface.buildDetailsSurface).toBe(viewModel.buildDetailsSurface);

    expect(statusSurface.renderStatusText).toBe(textRenderer.renderStatusText);
    expect(statusSurface.renderDetailsText).toBe(textRenderer.renderDetailsText);
    expect(statusSurface.renderQueueText).toBe(textRenderer.renderQueueText);
    expect(statusSurface.renderTimelineText).toBe(textRenderer.renderTimelineText);

    expect(statusSurface.renderStatusRich).toBe(richRenderer.renderStatusRich);
    expect(statusSurface.renderDetailsRich).toBe(richRenderer.renderDetailsRich);
    expect(statusSurface.renderQueueRich).toBe(richRenderer.renderQueueRich);
    expect(statusSurface.renderTimelineRich).toBe(richRenderer.renderTimelineRich);

    expect(statusSurface.executeStatusSurfaceAction).toBe(actions.executeStatusSurfaceAction);
    expect(statusSurface.runStatusSurfaceOperator).toBe(operator.runStatusSurfaceOperator);
  });
});
