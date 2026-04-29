/**
 * Reserved interface for Phase 3 summary snapshot and context budget hooks.
 */

import type { ActiveContextBudget, SummarySnapshotMetadata } from "@octoclaw/contracts/artifacts";

export interface SummarySnapshot extends SummarySnapshotMetadata {
  summaryKind: "thread" | "task" | "flow";
  content: string;
}

export interface ContextBudgetHook {
  computeBudget(totalBudget: number, priorities: ActiveContextBudget["priorityOrder"]): ActiveContextBudget;
  buildSummarySnapshot(kind: SummarySnapshot["summaryKind"], content: string): SummarySnapshot;
}

/** Phase 1 default implementation */
export function createDefaultContextBudgetHook(): ContextBudgetHook {
  return {
    computeBudget: (totalBudget, priorities) => ({
      maxTokens: totalBudget,
      usedTokens: 0,
      priorityOrder: priorities,
    }),
    buildSummarySnapshot: (kind, content) => ({
      snapshotId: "",
      summaryKind: kind,
      content,
      tokenCount: 0,
      createdAt: new Date().toISOString(),
    }),
  };
}
