/**
 * Reserved interface for Phase 3 advisor consultation.
 * Provides a provider-agnostic interface for requesting
 * advisor guidance during task execution.
 */

import type { AdvisorPolicy, AdvicePacket } from "@octoclaw/contracts/artifacts";

export interface AdvisorConsultRequest {
  taskId: string;
  stage: "before_commit" | "when_stuck" | "before_done";
  context: string;
  policy: AdvisorPolicy;
}

export interface AdvisorConsultAdapter {
  consult(request: AdvisorConsultRequest): Promise<AdvicePacket | null>;
  isAvailable(): boolean;
}

/** Phase 1 no-op advisor — always returns unavailable */
export function createNoOpAdvisorAdapter(): AdvisorConsultAdapter {
  return {
    consult: async () => null,
    isAvailable: () => false,
  };
}
