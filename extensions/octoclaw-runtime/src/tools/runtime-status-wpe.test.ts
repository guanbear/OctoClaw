import { describe, expect, it } from "vitest";

import { buildRuntimeStatusTaskView } from "./runtime-status.js";

describe("runtime status WP-E projections", () => {
  it("projects dispatch reject with bounded main fallback as main_fallback", () => {
    const view = buildRuntimeStatusTaskView({
      id: "wc-main-fallback",
      route: "delegate",
      status: "rejected",
      summary: "Dispatch admission rejected; main completed bounded fallback.",
      updated_at: "2026-05-16T00:00:00.000Z",
      dispatchRejected: true,
      mainFallbackExecuted: true,
      metadata: {
        dispatch_rejected: true,
        main_fallback_executed: true,
      },
    }, Date.parse("2026-05-16T00:00:05.000Z"));

    expect(view.status).toBe("main_fallback");
    expect(view.statusReason).toBe("dispatch_rejected_main_fallback");
  });
});
