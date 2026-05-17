import { beforeEach, describe, expect, it, vi } from "vitest";

const writeRebuiltTaskState = vi.fn();
const readFileSync = vi.fn();

vi.mock("../../runtime-ledger/projection-rebuild.js", () => ({
  writeRebuiltTaskState,
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync,
    writeFileSync: vi.fn(),
  },
}));

vi.mock("../../resolve/env.js", () => ({
  resolveTaskStatePath: () => "/tmp/octoclaw-task-state.json",
}));

vi.mock("../execution-transition-notifier.js", () => ({
  emitExecutionTransitionNotification: vi.fn(),
}));

describe("watchdogStartupReconcile", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    writeRebuiltTaskState.mockReset();
    readFileSync.mockReset();
  });

  it("rebuilds projection and runs an immediate watchdog tick through debounce", async () => {
    const now = new Date("2026-05-16T08:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    readFileSync.mockReturnValue(JSON.stringify({ tasks: [] }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const { watchdogStartupReconcile, watchdogTick } = await import("../ack-watchdog.js");

    await watchdogTick(logger);
    await watchdogStartupReconcile(logger);

    expect(writeRebuiltTaskState).toHaveBeenCalledOnce();
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  it("catches rebuild errors and logs without throwing", async () => {
    writeRebuiltTaskState.mockImplementation(() => {
      throw new Error("ledger offline");
    });
    const logger = { warn: vi.fn() };

    const { watchdogStartupReconcile } = await import("../ack-watchdog.js");

    await expect(watchdogStartupReconcile(logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("watchdog startup reconcile failed"));
  });
});
