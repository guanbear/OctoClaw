import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileSync = vi.fn();

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
    readFileSync.mockReset();
  });

  it("resets debounce and runs an immediate watchdog tick", async () => {
    const now = new Date("2026-05-16T08:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    readFileSync.mockReturnValue(JSON.stringify({ tasks: [] }));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const { watchdogStartupReconcile, watchdogTick } = await import("../ack-watchdog.js");

    await watchdogTick(logger);
    await watchdogStartupReconcile(logger);

    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  it("does not throw when task-state read fails", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("fs error");
    });
    const logger = { warn: vi.fn() };

    const { watchdogStartupReconcile } = await import("../ack-watchdog.js");

    await expect(watchdogStartupReconcile(logger)).resolves.toBeUndefined();
  });
});
