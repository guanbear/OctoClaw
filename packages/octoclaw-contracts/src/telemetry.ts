import type { ContractEnvelope, ExecutionRoute, ScopeMetadata } from "./schemas.js";
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
  requestId: string;
  route: string;
  role: string;
  coordinationMode?: string;
  modelId?: string;
  queueBudget: number;
  concurrencyBudget: number;
  capabilityBudget: string[];
  ackMs?: number;
  routeDecisionMs?: number;
  taskMaterializeMs?: number;
  queueWaitMs?: number;
  ttftMs?: number;
  firstProgressMs?: number;
  finalDeliveryMs?: number;
  totalLatencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  retryCount?: number;
  fallbackCount?: number;
  failureCode?: string;
  terminalState?: string;
  routeLatencyMs?: number;
  modelProfile: string;
  backend: string;
}

export interface PolicyTelemetry extends ContractEnvelope, ScopeMetadata {
  telemetryId: string;
  requestId: string;
  selectedRoute: ExecutionRoute;
  selectedRole: string;
  backend: string;
  modelProfile: string;
  reasonCodes: string[];
}
