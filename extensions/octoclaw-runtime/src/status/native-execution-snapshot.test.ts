import { describe, expect, it } from "vitest";

import { buildNativeExecutionSnapshot, isNativeLifecycleAuthoritative } from "./native-execution-snapshot.js";

describe("native execution snapshot", () => {
  it("treats native run projection as lifecycle-authoritative accepted execution", () => {
    const snapshot = buildNativeExecutionSnapshot({
      status: "running",
      rawStatus: "running",
      source: "run",
      reason: "resolved_by_openclaw_run_id",
      found: true,
      degraded: false,
      runId: "run-accepted",
    });

    expect(snapshot).toMatchObject({
      runAccepted: true,
      status: "running",
      source: "run",
      runId: "run-accepted",
    });
    expect(isNativeLifecycleAuthoritative(snapshot)).toBe(true);
  });

  it("keeps cache and missing projections out of lifecycle authority", () => {
    const cacheSnapshot = buildNativeExecutionSnapshot({
      status: "completed",
      rawStatus: "completed",
      source: "cache",
      reason: "cache_only_no_native_id",
      found: true,
      degraded: true,
    });
    const missingSnapshot = buildNativeExecutionSnapshot({
      status: "lost",
      rawStatus: "missing",
      source: "none",
      reason: "native_id_known_but_registry_missing",
      found: false,
      degraded: true,
      runId: "run-missing",
    });

    expect(cacheSnapshot.runAccepted).toBe(false);
    expect(isNativeLifecycleAuthoritative(cacheSnapshot)).toBe(false);
    expect(missingSnapshot.runAccepted).toBe(false);
    expect(isNativeLifecycleAuthoritative(missingSnapshot)).toBe(false);
  });
});
