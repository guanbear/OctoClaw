/**
 * Reserved interface for Phase 3 one-level thread hierarchy.
 * Not active in Phase 1 — provides type contracts and no-op defaults.
 */

import type { SessionThreadMetadata } from "@octoclaw/contracts/artifacts";

export interface ThreadSnapshot extends Pick<SessionThreadMetadata, "threadId" | "taskId" | "role"> {
  parentTaskId: string;
  state: string;
  summary?: string;
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadAwareStateAggregator {
  aggregateThreads(parentTaskId: string): Promise<ThreadSnapshot[]>;
  getThreadSnapshot(threadId: string): Promise<ThreadSnapshot | null>;
}

/** Phase 1 no-op placeholder */
export function createNoOpThreadAggregator(): ThreadAwareStateAggregator {
  return {
    aggregateThreads: async () => [],
    getThreadSnapshot: async () => null,
  };
}
