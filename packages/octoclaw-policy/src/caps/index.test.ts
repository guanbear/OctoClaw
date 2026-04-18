import { describe, expect, it } from "vitest";
import { decidePolicyCaps } from "./index.js";

describe("caps", () => {
  it("uses zero worker budget for main reply", () => {
    expect(decidePolicyCaps({ role: "main_reply", queueBudget: 3 })).toMatchObject({
      workerPool: "octoclaw-main",
      maxWorkers: 0,
      queueBudget: 0,
    });
  });

  it("uses observer limits for observer probe", () => {
    expect(decidePolicyCaps({ role: "observer_probe", queueBudget: 0 })).toMatchObject({
      workerPool: "octoclaw-observer",
      maxWorkers: 1,
      latencyTarget: "interactive",
      queueBudget: 1,
    });
  });

  it("uses background worker limits for delegated roles", () => {
    expect(decidePolicyCaps({ role: "worker_research", queueBudget: 0 })).toMatchObject({
      workerPool: "octoclaw-research",
      maxWorkers: 1,
      latencyTarget: "background",
      queueBudget: 1,
    });
    expect(decidePolicyCaps({ role: "worker_code", queueBudget: 2 })).toMatchObject({
      workerPool: "octoclaw-code",
      maxWorkers: 1,
      latencyTarget: "background",
      queueBudget: 2,
    });
  });
});
