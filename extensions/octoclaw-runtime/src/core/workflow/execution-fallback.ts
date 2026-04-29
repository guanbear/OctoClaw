/**
 * Reserved interface for Phase 3 runner-absent fallback.
 * When execution backend is unavailable, converts execution path
 * to on-demand materialization without changing route semantics.
 */

export type FallbackReason = "runner_absent" | "backend_unavailable" | "queue_full" | "capability_unsatisfied";

export interface FallbackDecision {
  fallback: boolean;
  reason?: FallbackReason;
  originalRoute: string;
  fallbackPath: "on_demand" | "queued" | "blocked";
  retryAfterMs?: number;
  message?: string;
}

export interface ExecutionFallbackResolver {
  resolve(backendAvailable: boolean, queueCapacity: number, currentInflight: number): FallbackDecision;
}

/** Phase 1 default: no fallback, always proceed */
export function createNoOpFallbackResolver(): ExecutionFallbackResolver {
  return {
    resolve: () => ({
      fallback: false,
      originalRoute: "",
      fallbackPath: "on_demand",
    }),
  };
}
