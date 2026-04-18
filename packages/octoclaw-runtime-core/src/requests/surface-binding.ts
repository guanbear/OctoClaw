/**
 * Reserved interface for Phase 3 surface anchor binding.
 * Maps surface anchors to session/thread/task bindings.
 */

import type { SurfaceAnchor } from "@octoclaw/contracts/artifacts";

export interface SurfaceBinding {
  anchorId: string;
  sessionId: string;
  threadId?: string;
  taskId?: string;
  flowId?: string;
  boundAt: string;
}

export interface SurfaceBindingStore {
  bind(anchor: SurfaceAnchor, sessionId: string): Promise<SurfaceBinding>;
  resolve(anchorId: string): Promise<SurfaceBinding | null>;
  resolveBySession(sessionId: string): Promise<SurfaceBinding | null>;
}

/** Phase 1 no-op placeholder */
export function createNoOpSurfaceBindingStore(): SurfaceBindingStore {
  return {
    bind: async () => ({ anchorId: "", sessionId: "", boundAt: new Date().toISOString() }),
    resolve: async () => null,
    resolveBySession: async () => null,
  };
}
