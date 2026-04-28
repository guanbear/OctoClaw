// D3 constraints: output only, no live mutation. Recommendations are recommend_only/unknown/blocked. Fail closed on malformed. unknown ≠ pass.

export const REPLAY_EVENT_SCHEMA_VERSION = "octoclaw.runtime_policy.replay_event/v1" as const;

export type ExecutionTransitionKind =
  | "dispatch_materialized"
  | "materialized_no_spawn"
  | "spawn_started"
  | "spawn_failed"
  | "queued_stale"
  | "heartbeat_stale"
  | "timed_out"
  | "result_ready"
  | "delivery_failed";

export interface CompactParentPacket {
  taskId: string;
  status: string;
  modelId?: string;
  backend?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  artifactRefIds: string[];
  childSessionKey?: string;
  runId?: string;
  childRunId?: string;
  latestAnomalyNotice?: {
    kind: string;
    severity: string;
    taskId: string;
    message: string;
    createdAt: string;
  };
}

export interface RouteOutcome {
  event?: string;
  route?: string;
  taskClass?: string;
  workerPool?: string;
  requestKind?: string;
  delegated?: boolean;
  executed?: boolean;
}

export interface ReplayEvent {
  schema_version: string;
  event: string;
  at: string;
  sessionKey?: string;
  sessionId?: string;
  turnId?: string;
  decisionId?: string;
  deliveryId?: string;
  runnerJobId?: string;
  taskId?: string;
  trigger?: string;
  route?: string;
  systemPreferredRoute?: string;
  workerPool?: string;
  taskClass?: string;
  protectedLane?: string;
  prompt?: string;
  toolName?: string;
  finalRoute?: string;
  delegated?: boolean;
  executed?: boolean;
  confidence?: number;
  reason?: string;
  ackKind?: string;
  ackMode?: string;
  ackMessage?: string;
  reviewRequired?: boolean;
  ackSent?: boolean;
  usedCachedPolicy?: boolean;
  routeHintRequired?: boolean;
  routeHintSubmitted?: boolean;
  stickyApplied?: boolean;
  policyJudgeSelected?: string;
  policyJudgeInvoked?: boolean;
  policyJudgeApplied?: boolean;
  policyJudgeConfidence?: number;
  validationOutcome?: string;
  routerRequestKind?: string;
  routerDecisionValid?: boolean;
  routerDecisionSource?: string;
  actualCost?: number | null;
  actualLatency?: number | null;
  parentContextTokensAdded?: number;
  resultPacketTokens?: number;
  fallbackTaken?: boolean;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  resultMaterialized?: boolean;
  deliveryStatus?: string;
  workContractId?: string;
  decisionSource?: string;
  rolloutFlags?: Record<string, unknown>;
  routeOutcome?: RouteOutcome;
  flowId?: string;
  telemetryId?: string;
  role?: string;
  modelProfile?: string;
  backend?: string;
  terminalState?: string;
  ackMs?: number;
  routeDecisionMs?: number;
  taskMaterializeMs?: number;
  queueWaitMs?: number;
  firstProgressMs?: number;
  finalDeliveryMs?: number;
  totalLatencyMs?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  retryCount?: number;
  fallbackCount?: number;
  artifactReopenCount?: number;
  allowedTools?: string[];
  blockedTools?: string[];
  routeLanguagePacks?: string[];
  // D1 route_commit_ack specific fields
  routeCommitId?: string;
  routeSealId?: string;
  ackKey?: string;
  ack_target_resolution_state?: string;
  ack_delivery_state?: string;
  stateKey?: string;
  channelTone?: string;
  routeSource?: string;
  // D2 execution_transition specific fields
  transitionKind?: string;
  attemptId?: string;
  projectionStatus?: string;
  projectionStatusReason?: string;
  sent?: boolean;
  skipped?: boolean;
  occurredAt?: string;
  notificationKey?: string;
  compactParentPacket?: CompactParentPacket;
  [key: string]: unknown;
}

export type EvaluationLane =
  | "route_quality"
  | "route_commit_ack"
  | "execution_transition"
  | "delegation_health"
  | "delivery";

export type RouteVerdict =
  | "pass"
  | "false_delegate"
  | "false_reply"
  | "protected_lane_misroute"
  | "status_respawn_risk"
  | "direct_path_latency"
  | "unclear"
  | "unknown";

export type AckVerdict =
  | "pass"
  | "missing"
  | "late"
  | "duplicate"
  | "misleading"
  | "no_target_skipped"
  | "unknown";

export type DelegationVerdict =
  | "pass"
  | "no_spawn"
  | "spawn_failed"
  | "stale"
  | "timed_out"
  | "result_orphan"
  | "context_pollution"
  | "unknown";

export type DeliveryVerdict =
  | "pass"
  | "delivery_failed"
  | "retry_deferred"
  | "compensated"
  | "unknown";

export type RecommendationStatus = "recommend_only" | "unknown" | "blocked";

export type GateResult = "pass" | "fail" | "unknown";

export interface LaneSample {
  eventId: string;
  at: string;
  sessionKey?: string;
  turnId?: string;
  taskId?: string;
  route?: string;
  verdict: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface RouteQualityLane {
  lane: "route_quality";
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  falseDelegate: number;
  falseReply: number;
  unclear: number;
  protectedLaneMisroute: number;
  statusRespawnRisk: number;
  directPathLatency: number;
  routeSourceDistribution: Record<string, number>;
  judgeTimeoutCount: number;
  judgeFallbackCount: number;
  samples: LaneSample[];
}

export interface RouteCommitAckLane {
  lane: "route_commit_ack";
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  ackSent: number;
  ackSkipped: number;
  ackFailed: number;
  ackDuplicate: number;
  ackMissing: number;
  ackNoTarget: number;
  ackMsP50: number | null;
  ackMsP95: number | null;
  ackMsP99: number | null;
  coverage: number;
  samples: LaneSample[];
}

export interface ExecutionTransitionLane {
  lane: "execution_transition";
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  dispatchedSent: number;
  dispatchedSkipped: number;
  materializedNoSpawnSent: number;
  materializedNoSpawnSkipped: number;
  spawnStartedSent: number;
  spawnStartedSkipped: number;
  spawnFailedSent: number;
  spawnFailedSkipped: number;
  queuedStaleSent: number;
  queuedStaleSkipped: number;
  heartbeatStaleSent: number;
  heartbeatStaleSkipped: number;
  timedOutSent: number;
  timedOutSkipped: number;
  resultReadySent: number;
  resultReadySkipped: number;
  deliveryFailedSent: number;
  deliveryFailedSkipped: number;
  dispatchToSpawnLatencyP50: number | null;
  dispatchToSpawnLatencyP95: number | null;
  resultReadyToDeliveryLatencyP50: number | null;
  resultReadyToDeliveryLatencyP95: number | null;
  samples: LaneSample[];
}

export interface DelegationHealthLane {
  lane: "delegation_health";
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  noSpawnCount: number;
  spawnFailedCount: number;
  staleCount: number;
  timedOutCount: number;
  resultOrphanCount: number;
  contextPollutionCount: number;
  parentContextTokensAddedMax: number | null;
  parentContextTokensAddedP95: number | null;
  resultPacketTokensMax: number | null;
  samples: LaneSample[];
}

export interface DeliveryLane {
  lane: "delivery";
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  deliveryFailedCount: number;
  retryDeferredCount: number;
  compensatedCount: number;
  samples: LaneSample[];
}

export type CostSpeedLaneName = "reply" | "delegate" | "flow";
export type MetricCompleteness = "known" | "partial" | "unknown";

export interface CostSpeedMetricSummary {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface CostSpeedLaneReport {
  lane: CostSpeedLaneName;
  requestCount: number;
  successCount: number;
  ackMs: CostSpeedMetricSummary;
  routeDecisionMs: CostSpeedMetricSummary;
  taskMaterializeMs: CostSpeedMetricSummary;
  queueWaitMs: CostSpeedMetricSummary;
  firstProgressMs: CostSpeedMetricSummary;
  finalDeliveryMs: CostSpeedMetricSummary;
  totalLatencyMs: CostSpeedMetricSummary;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  estimatedCostStatus: MetricCompleteness;
  actualCostStatus: MetricCompleteness;
  missingEstimatedCostCount: number;
  missingActualCostCount: number;
  costPerRequest: number | null;
  costPerSuccess: number | null;
  fallbackCount: number;
  retryCount: number;
  terminalStates: Record<string, number>;
  parentContextTokensAdded: CostSpeedMetricSummary;
  resultPacketTokens: CostSpeedMetricSummary;
  artifactReopenCount: CostSpeedMetricSummary;
}

export interface CostSpeedBaselineReport {
  generatedAt: string;
  sourceEventCount: number;
  lanes: CostSpeedLaneReport[];
}

export type EvaluationLaneResult =
  | RouteQualityLane
  | RouteCommitAckLane
  | ExecutionTransitionLane
  | DelegationHealthLane
  | DeliveryLane;

export interface NightlyReplayFilterMetadata {
  enabled: boolean;
  lookbackHours: number | null;
  excludeSynthetic: boolean;
  cutoffAt: string | null;
  rawInputEventCount: number;
  filteredEventCount: number;
}

export interface NightlyReplayFilterOptions {
  lookbackHours?: number;
  excludeSynthetic?: boolean;
  now?: string | number | Date;
}

export interface NightlyReplayFilterResult {
  events: ReplayEvent[];
  metadata: NightlyReplayFilterMetadata;
}

export interface NightlyReport {
  reportId: string;
  generatedAt: string;
  inputEventCount: number;
  rawInputEventCount?: number;
  filteredEventCount?: number;
  filter?: NightlyReplayFilterMetadata;
  inputDateRange: { earliest: string | null; latest: string | null };
  lanes: EvaluationLaneResult[];
  costSpeedBaseline: CostSpeedBaselineReport;
  overallGate: GateResult;
  recommendationStatus: RecommendationStatus;
  recommendation: string;
  rollbackTarget: string | null;
}
