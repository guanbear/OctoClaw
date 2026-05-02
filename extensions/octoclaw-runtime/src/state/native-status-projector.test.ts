import { describe, expect, it, vi } from "vitest";
import { projectNativeStatus } from "./native-status-projector.js";

function ctxWithNative(options: {
  run?: unknown;
  flow?: unknown;
  latestRun?: unknown;
  latestFlow?: unknown;
  runError?: Error;
} = {}) {
  const runResolve = vi.fn(async () => {
    if (options.runError) throw options.runError;
    return options.run ?? null;
  });
  const flowResolve = vi.fn(async () => options.flow ?? null);
  const runFindLatest = vi.fn(async () => options.latestRun ?? null);
  const flowFindLatest = vi.fn(async () => options.latestFlow ?? null);
  return {
    runResolve,
    flowResolve,
    runFindLatest,
    flowFindLatest,
    ctx: {
      runtime: {
        tasks: {
          runs: {
            fromToolContext: () => ({ resolve: runResolve, findLatest: runFindLatest }),
          },
          flows: {
            fromToolContext: () => ({ resolve: flowResolve, findLatest: flowFindLatest }),
          },
        },
      },
    },
  };
}

describe("native status projector", () => {
  it("resolves status by openclawRunId", async () => {
    const runtime = ctxWithNative({ run: { runId: "run-1", status: "running", taskId: "task-1" } });

    const projected = await projectNativeStatus({ ctx: runtime.ctx, openclawRunId: "run-1" });

    expect(projected).toMatchObject({
      status: "running",
      rawStatus: "running",
      source: "run",
      reason: "resolved_by_openclaw_run_id",
      runId: "run-1",
      taskId: "task-1",
      found: true,
      degraded: false,
    });
    expect(runtime.runResolve).toHaveBeenCalledWith("run-1");
  });

  it("falls back to flow status when run is missing", async () => {
    const runtime = ctxWithNative({ flow: { flowId: "flow-1", status: "succeeded", revision: 4 } });

    const projected = await projectNativeStatus({ ctx: runtime.ctx, openclawRunId: "run-missing", openclawFlowId: "flow-1" });

    expect(projected).toMatchObject({
      status: "completed",
      rawStatus: "succeeded",
      source: "flow",
      reason: "resolved_by_openclaw_flow_id",
      flowId: "flow-1",
      revision: 4,
    });
    expect(runtime.flowResolve).toHaveBeenCalledWith("flow-1");
  });

  it("uses findLatest only as a UI fallback", async () => {
    const runtime = ctxWithNative({ latestRun: { runId: "latest-run", status: "queued" } });

    const projected = await projectNativeStatus({
      ctx: runtime.ctx,
      sessionKey: "session-1",
      workContractId: "wc-1",
      childSessionKey: "child-1",
    });

    expect(projected).toMatchObject({
      status: "queued",
      source: "latest",
      reason: "ui_fallback_find_latest_run",
      runId: "latest-run",
    });
    expect(runtime.runFindLatest).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session-1",
      workContractId: "wc-1",
      childSessionKey: "child-1",
    }));
  });

  it("reports known native ids missing from registry as lost instead of success", async () => {
    const runtime = ctxWithNative();

    const projected = await projectNativeStatus({ ctx: runtime.ctx, openclawRunId: "run-lost", childSessionKey: "child-1" });

    expect(projected).toMatchObject({
      status: "lost",
      rawStatus: "missing",
      source: "none",
      reason: "native_id_known_but_registry_missing",
      found: false,
      degraded: true,
      runId: "run-lost",
      childSessionKey: "child-1",
    });
  });

  it("treats corrupt task-state cache as degraded display", async () => {
    const runtime = ctxWithNative({ run: { runId: "run-1", status: "completed" } });

    const projected = await projectNativeStatus({
      ctx: runtime.ctx,
      openclawRunId: "run-1",
      cache: { corrupt: true, status: "completed" },
    });

    expect(projected).toMatchObject({
      status: "degraded",
      rawStatus: "completed",
      source: "cache",
      reason: "task_state_cache_degraded",
      degraded: true,
    });
    expect(runtime.runResolve).not.toHaveBeenCalled();
  });

  it("does not trust cached running state when native registry API is unavailable", async () => {
    const projected = await projectNativeStatus({
      ctx: {},
      openclawRunId: "run-unavailable",
      cache: { status: "running", summary: "cached running" },
    });

    expect(projected).toMatchObject({
      status: "degraded",
      rawStatus: "native_registry_unavailable",
      source: "none",
      reason: "native_registry_unavailable",
      found: false,
      degraded: true,
      runId: "run-unavailable",
      summary: "cached running",
    });
  });

  it("does not use findLatest when disabled for non-UI callers", async () => {
    const runtime = ctxWithNative({ latestRun: { runId: "latest-run", status: "running" } });

    const projected = await projectNativeStatus({
      ctx: runtime.ctx,
      sessionKey: "session-1",
      allowFindLatest: false,
      cache: { status: "queued" },
    });

    expect(projected).toMatchObject({
      status: "queued",
      source: "cache",
      reason: "cache_only_no_native_id",
    });
    expect(runtime.runFindLatest).not.toHaveBeenCalled();
  });
});
