import type { ContractEnvelope, ScopeMetadata } from "./schemas.js";
import type { TaskIdentity } from "./events.js";

export interface QueueDeadlineTelemetry {
  queueDeadlineAt?: string;
  startDeadlineAt?: string;
  progressDeadlineAt?: string;
  runtimeDeadlineAt?: string;
  deliveryDeadlineAt?: string;
}

export interface OptimizationTelemetry extends ContractEnvelope, ScopeMetadata, TaskIdentity, QueueDeadlineTelemetry {
  telemetryId: string;
  queueBudget: number;
  concurrencyBudget: number;
  capabilityBudget: string[];
  routeLatencyMs?: number;
  modelProfile: string;
  backend: string;
}

export interface PolicyTelemetry extends ContractEnvelope, ScopeMetadata {
  telemetryId: string;
  requestId: string;
  selectedRoute: "reply" | "delegate.single" | "observe";
  selectedRole: string;
  backend: string;
  modelProfile: string;
  reasonCodes: string[];
}
