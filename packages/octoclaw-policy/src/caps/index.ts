import type { PolicyRole } from "../roles/index.ts";

export type LatencyTarget = "interactive" | "background";
export type WorkerPool = "octoclaw-main" | "octoclaw-observer" | "octoclaw-research" | "octoclaw-code" | "octoclaw-review";

export interface PolicyCaps {
  workerPool: WorkerPool;
  maxWorkers: number;
  latencyTarget: LatencyTarget;
  queueBudget: number;
}

export interface CapsDecision extends PolicyCaps {
  capReason: string;
}

export interface CapsInput {
  role: PolicyRole;
  queueBudget: number;
}

export function decidePolicyCaps(input: CapsInput): CapsDecision {
  if (input.role === "main_reply") {
    return {
      workerPool: "octoclaw-main",
      maxWorkers: 0,
      latencyTarget: "interactive",
      queueBudget: 0,
      capReason: "main_reply_interactive_no_worker_budget",
    };
  }

  if (input.role === "observer_probe") {
    return {
      workerPool: "octoclaw-observer",
      maxWorkers: 1,
      latencyTarget: "interactive",
      queueBudget: Math.max(1, input.queueBudget),
      capReason: "observer_probe_single_worker_interactive_budget",
    };
  }

  if (input.role === "worker_code") {
    return {
      workerPool: "octoclaw-code",
      maxWorkers: 1,
      latencyTarget: "background",
      queueBudget: Math.max(1, input.queueBudget),
      capReason: "worker_code_single_worker_background_budget",
    };
  }

  if (input.role === "worker_review") {
    return {
      workerPool: "octoclaw-review",
      maxWorkers: 1,
      latencyTarget: "background",
      queueBudget: Math.max(1, input.queueBudget),
      capReason: "worker_review_single_worker_background_budget",
    };
  }

  return {
    workerPool: "octoclaw-research",
    maxWorkers: 1,
    latencyTarget: "background",
    queueBudget: Math.max(1, input.queueBudget),
    capReason: "worker_research_single_worker_background_budget",
  };
}
