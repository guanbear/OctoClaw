import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { __test } from "./platform.js";

function fakeChild() {
  type Listener = (...args: unknown[]) => void;
  const listeners: Record<string, Listener[]> = {};
  const emitter = {
    on(event: string, listener: Listener): void {
      listeners[event] = [...(listeners[event] ?? []), listener];
    },
  };
  const child = {
    ...emitter,
    stdout: emitter,
    stderr: emitter,
    kill: (_signal: string) => {},
    unref: () => {},
  };
  const signals: string[] = [];
  child.kill = (signal: string) => {
    signals.push(signal);
  };
  return { child, signals };
}

describe("platform command runner", () => {
  it("escalates timed-out subprocesses after SIGTERM", async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const result = __test.tryRun("openclaw", ["gateway", "restart"], {}, 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ success: false });
    await vi.advanceTimersByTimeAsync(1000);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    vi.useRealTimers();
  });

  it("times out captureOutput instead of waiting forever", async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const result = __test.captureOutput("id", ["-u"], 10);
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe("");
    expect(signals).toEqual(["SIGTERM"]);
    vi.useRealTimers();
  });
});
