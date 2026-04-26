import type {
  ReplayEvent,
  RouteVerdict,
  ExecutionTransitionKind,
  LaneSample,
  RouteQualityLane,
  RouteCommitAckLane,
  ExecutionTransitionLane,
  DelegationHealthLane,
  DeliveryLane,
  EvaluationLaneResult,
  NightlyReport,
  RecommendationStatus,
  GateResult,
} from "./types.js";

const MAX_SAMPLES_PER_LANE = 20;
const FORBIDDEN_SAMPLE_KEYS = new Set([
  "prompt",
  "ackMessage",
  "transcript",
  "childTranscript",
  "rawTranscript",
  "workerChainOfThought",
  "executionLog",
]);

const TRANSITION_KINDS: readonly ExecutionTransitionKind[] = [
  "dispatch_materialized",
  "materialized_no_spawn",
  "spawn_started",
  "spawn_failed",
  "queued_stale",
  "heartbeat_stale",
  "timed_out",
  "result_ready",
  "delivery_failed",
];

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stripForbidden(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripForbidden);
  if (obj === null || typeof obj !== "object") return obj;
  const rec = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (FORBIDDEN_SAMPLE_KEYS.has(k)) continue;
    out[k] = stripForbidden(v);
  }
  return out;
}

export function sanitizeSample(sample: LaneSample): LaneSample {
  const details = sample.details ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_SAMPLE_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length > 200) {
      cleaned[key] = `${value.slice(0, 200)}…`;
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = stripForbidden(value);
    } else {
      cleaned[key] = value;
    }
  }
  return { ...sample, details: cleaned };
}

function capSamples<T extends LaneSample>(samples: T[]): T[] {
  return samples.slice(0, MAX_SAMPLES_PER_LANE);
}

function eventTimeMs(event: ReplayEvent): number | null {
  const raw = typeof event.occurredAt === "string" ? event.occurredAt : event.at;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventCorrelationKey(event: ReplayEvent): string {
  return event.taskId
    ?? event.attemptId
    ?? event.workContractId
    ?? event.routeCommitId
    ?? event.turnId
    ?? event.deliveryId
    ?? "";
}

function routeCommitKey(event: ReplayEvent): string {
  return event.routeCommitId ?? event.workContractId ?? event.turnId ?? "";
}

function makeSample(event: ReplayEvent, verdict: string, reason: string): LaneSample {
  return {
    eventId: `${event.at}:${event.event}:${event.turnId ?? ""}:${event.taskId ?? ""}`,
    at: event.at,
    sessionKey: event.sessionKey,
    turnId: event.turnId,
    taskId: event.taskId,
    route: event.route ?? event.finalRoute,
    verdict,
    reason,
    details: {
      decisionSource: event.routerDecisionSource ?? event.decisionSource,
      workerPool: event.workerPool,
      taskClass: event.taskClass,
      confidence: event.confidence ?? event.policyJudgeConfidence,
    },
  };
}

function classifyRouteVerdict(event: ReplayEvent): RouteVerdict {
  const route = event.route ?? event.finalRoute ?? "";
  const systemPreferred = event.systemPreferredRoute ?? "";
  const confidence = event.confidence ?? event.policyJudgeConfidence;
  const routerValid = event.routerDecisionValid;
  const fallback = event.fallbackTaken;

  if (fallback) return "unclear";
  if (route === "delegate" && routerValid === false) return "false_delegate";
  if (route === "reply" && systemPreferred === "delegate") return "false_reply";
  if (event.validationOutcome === "rejected") return "protected_lane_misroute";

  const kind = event.routerRequestKind ?? event.trigger ?? "";
  if ((kind.includes("status") || kind.includes("provenance") || kind.includes("followup")) && route === "delegate") {
    return "status_respawn_risk";
  }

  if (route === "reply" && (event.actualLatency ?? 0) > 30000) return "direct_path_latency";
  if (confidence !== undefined && confidence < 0.4) return "unclear";
  if (routerValid === undefined && confidence === undefined) return "unknown";
  return "pass";
}

export function classifyRouteQuality(events: ReplayEvent[]): RouteQualityLane {
  const policyEvents = events.filter(
    (e) => e.event === "policy_resolved" || e.event === "policy_judged" || e.event === "route_validated" || e.event === "agent_end",
  );

  let pass = 0;
  let fail = 0;
  let unknown = 0;
  let falseDelegate = 0;
  let falseReply = 0;
  let unclear = 0;
  let protectedLaneMisroute = 0;
  let statusRespawnRisk = 0;
  let directPathLatency = 0;
  const routeSourceDistribution: Record<string, number> = {};
  let judgeTimeoutCount = 0;
  let judgeFallbackCount = 0;
  const samples: LaneSample[] = [];

  for (const event of policyEvents) {
    const verdict = classifyRouteVerdict(event);
    const source = event.routerDecisionSource ?? event.decisionSource ?? "unknown";
    routeSourceDistribution[source] = (routeSourceDistribution[source] ?? 0) + 1;

    if (event.policyJudgeInvoked === false && event.event === "policy_judged") judgeTimeoutCount++;
    if (event.fallbackTaken) judgeFallbackCount++;

    switch (verdict) {
      case "pass": pass++; break;
      case "false_delegate": falseDelegate++; fail++; break;
      case "false_reply": falseReply++; fail++; break;
      case "protected_lane_misroute": protectedLaneMisroute++; fail++; break;
      case "status_respawn_risk": statusRespawnRisk++; fail++; break;
      case "direct_path_latency": directPathLatency++; break;
      case "unclear": unclear++; break;
      case "unknown": unknown++; break;
    }

    if (verdict !== "pass") {
      samples.push(makeSample(event, verdict, verdict));
    }
  }

  return {
    lane: "route_quality",
    total: policyEvents.length,
    pass, fail, unknown,
    falseDelegate, falseReply, unclear,
    protectedLaneMisroute, statusRespawnRisk, directPathLatency,
    routeSourceDistribution,
    judgeTimeoutCount, judgeFallbackCount,
    samples: capSamples(samples).map(sanitizeSample),
  };
}

export function classifyRouteCommitAck(events: ReplayEvent[]): RouteCommitAckLane {
  const ackEvents = events.filter((e) => e.event === "route_commit_ack");
  const routedEvents = events.filter(
    (e) => e.event === "policy_resolved" || e.event === "route_validated",
  );

  let ackSent = 0;
  let ackSkipped = 0;
  let ackFailed = 0;
  let ackDuplicate = 0;
  let ackNoTarget = 0;
  const seenAckKeys = new Set<string>();
  const ackTimings: number[] = [];
  const routedTimes = new Map<string, number>();
  const samples: LaneSample[] = [];

  for (const event of routedEvents) {
    const key = routeCommitKey(event);
    const timestamp = eventTimeMs(event);
    if (key && timestamp !== null && !routedTimes.has(key)) {
      routedTimes.set(key, timestamp);
    }
  }

  for (const event of ackEvents) {
    const ackKey = event.ackKey ?? `${event.turnId ?? ""}:${event.routeCommitId ?? ""}`;

    if (seenAckKeys.has(ackKey)) {
      ackDuplicate++;
      samples.push({
        eventId: `${event.at}:route_commit_ack:${ackKey}`,
        at: event.at,
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        taskId: event.taskId,
        route: event.route,
        verdict: "duplicate",
        reason: event.reason ?? "duplicate",
        details: { ackKey, routeCommitId: event.routeCommitId },
      });
      continue;
    }
    seenAckKeys.add(ackKey);

    const sent = event.ackSent === true;
    const deliveryState = event.ack_delivery_state ?? "";
    const targetState = event.ack_target_resolution_state ?? "";
    const reason = event.reason ?? "";

    if (sent && deliveryState === "sent") {
      ackSent++;
      const explicitLatency = typeof event.actualLatency === "number" && Number.isFinite(event.actualLatency)
        ? event.actualLatency
        : null;
      const routeStart = routedTimes.get(routeCommitKey(event));
      const ackAt = eventTimeMs(event);
      const derivedLatency = routeStart !== undefined && ackAt !== null ? Math.max(0, ackAt - routeStart) : null;
      const ackLatency = explicitLatency ?? derivedLatency;
      if (ackLatency !== null) ackTimings.push(ackLatency);
    } else if (deliveryState === "failed") {
      ackFailed++;
      samples.push({
        eventId: `${event.at}:route_commit_ack:${ackKey}`,
        at: event.at,
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        taskId: event.taskId,
        route: event.route,
        verdict: "failed",
        reason: reason || "send_failed",
        details: { ackKey, routeCommitId: event.routeCommitId, ack_delivery_state: deliveryState },
      });
    } else if (reason === "duplicate") {
      ackDuplicate++;
      samples.push({
        eventId: `${event.at}:route_commit_ack:${ackKey}`,
        at: event.at,
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        taskId: event.taskId,
        route: event.route,
        verdict: "duplicate",
        reason: "duplicate",
        details: { ackKey, routeCommitId: event.routeCommitId },
      });
    } else if (targetState.includes("no_valid_thread") || targetState.includes("target_resolution_failed") || targetState.includes("missing_route_commit")) {
      ackNoTarget++;
      samples.push({
        eventId: `${event.at}:route_commit_ack:${ackKey}`,
        at: event.at,
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        taskId: event.taskId,
        route: event.route,
        verdict: "no_target_skipped",
        reason: reason || targetState,
        details: { ackKey, routeCommitId: event.routeCommitId, ack_target_resolution_state: targetState },
      });
    } else if (reason === "reply_already_visible" || targetState === "suppressed_reply_visible") {
      ackSkipped++;
    } else {
      ackSkipped++;
    }
  }

  const routedSeen = new Set<string>();
  for (const event of routedEvents) {
    const commitId = routeCommitKey(event);
    if (commitId) routedSeen.add(commitId);
  }

  const ackMissing = routedSeen.size > 0
    ? [...routedSeen].filter((id) => !ackEvents.some((e) => routeCommitKey(e) === id)).length
    : 0;

  ackTimings.sort((a, b) => a - b);

  const total = ackEvents.length + ackMissing;
  const passCount = ackSent;
  const failCount = ackFailed + ackMissing + ackDuplicate;
  const coverage = total > 0 ? ackSent / total : 0;

  return {
    lane: "route_commit_ack",
    total,
    pass: passCount,
    fail: failCount,
    unknown: ackSkipped + ackNoTarget,
    ackSent,
    ackSkipped,
    ackFailed,
    ackDuplicate,
    ackMissing,
    ackNoTarget,
    ackMsP50: percentile(ackTimings, 50),
    ackMsP95: percentile(ackTimings, 95),
    ackMsP99: percentile(ackTimings, 99),
    coverage,
    samples: capSamples(samples).map(sanitizeSample),
  };
}

export function classifyExecutionTransition(events: ReplayEvent[]): ExecutionTransitionLane {
  const transitionEvents = events.filter((e) => e.event === "execution_transition" && typeof e.transitionKind === "string");

  const counts: Record<string, { sent: number; skipped: number }> = {};
  for (const kind of TRANSITION_KINDS) {
    counts[kind] = { sent: 0, skipped: 0 };
  }

  const samples: LaneSample[] = [];
  const dispatchTimes = new Map<string, number>();
  const spawnLatencies: number[] = [];
  const resultReadyTimes = new Map<string, number>();
  const resultDeliveryLatencies: number[] = [];

  for (const event of transitionEvents) {
    const kind = event.transitionKind as string;
    if (!counts[kind]) {
      counts[kind] = { sent: 0, skipped: 0 };
    }

    const sent = event.sent === true;
    const skipped = event.skipped === true;
    const timestamp = eventTimeMs(event);
    const key = eventCorrelationKey(event);

    if (sent) {
      counts[kind].sent++;
    } else if (skipped) {
      counts[kind].skipped++;
    } else {
      counts[kind].skipped++;
    }

    if (timestamp !== null && key) {
      if (kind === "dispatch_materialized" && !dispatchTimes.has(key)) {
        dispatchTimes.set(key, timestamp);
      } else if (kind === "spawn_started") {
        const dispatchAt = dispatchTimes.get(key);
        if (dispatchAt !== undefined) spawnLatencies.push(Math.max(0, timestamp - dispatchAt));
      } else if (kind === "result_ready" && !resultReadyTimes.has(key)) {
        resultReadyTimes.set(key, timestamp);
      }
    }

    const isAnomaly = [
      "materialized_no_spawn",
      "spawn_failed",
      "queued_stale",
      "heartbeat_stale",
      "timed_out",
      "delivery_failed",
    ].includes(kind);

    if (isAnomaly || !sent) {
      samples.push({
        eventId: `${event.at}:execution_transition:${event.taskId ?? ""}:${kind}`,
        at: event.at,
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        taskId: event.taskId,
        route: event.route,
        verdict: sent ? "pass" : "skipped",
        reason: `${kind} sent=${sent} skipped=${skipped}`,
        details: {
          transitionKind: kind,
          projectionStatus: event.projectionStatus,
          dispatchExecuted: event.dispatchExecuted,
          spawnExecuted: event.spawnExecuted,
          resultMaterialized: event.resultMaterialized,
          ack_delivery_state: event.ack_delivery_state,
          compactParentPacket: event.compactParentPacket,
        },
      });
    }
  }

  for (const event of events) {
    if (event.event !== "delivery_observed" && event.event !== "delivery_reconciled_delivered") continue;
    const key = eventCorrelationKey(event);
    const deliveredAt = eventTimeMs(event);
    const resultReadyAt = key ? resultReadyTimes.get(key) : undefined;
    if (deliveredAt !== null && resultReadyAt !== undefined) {
      resultDeliveryLatencies.push(Math.max(0, deliveredAt - resultReadyAt));
    }
  }

  spawnLatencies.sort((a, b) => a - b);
  resultDeliveryLatencies.sort((a, b) => a - b);

  const c = counts;
  const failKinds = ["materialized_no_spawn", "spawn_failed", "queued_stale", "heartbeat_stale", "timed_out", "delivery_failed"];
  const failCount = failKinds.reduce((sum, k) => sum + (c[k]?.sent ?? 0), 0);
  const passCount = (c["dispatch_materialized"]?.sent ?? 0) + (c["spawn_started"]?.sent ?? 0) + (c["result_ready"]?.sent ?? 0);

  return {
    lane: "execution_transition",
    total: transitionEvents.length,
    pass: passCount,
    fail: failCount,
    unknown: transitionEvents.length - passCount - failCount,
    dispatchedSent: c["dispatch_materialized"]?.sent ?? 0,
    dispatchedSkipped: c["dispatch_materialized"]?.skipped ?? 0,
    materializedNoSpawnSent: c["materialized_no_spawn"]?.sent ?? 0,
    materializedNoSpawnSkipped: c["materialized_no_spawn"]?.skipped ?? 0,
    spawnStartedSent: c["spawn_started"]?.sent ?? 0,
    spawnStartedSkipped: c["spawn_started"]?.skipped ?? 0,
    spawnFailedSent: c["spawn_failed"]?.sent ?? 0,
    spawnFailedSkipped: c["spawn_failed"]?.skipped ?? 0,
    queuedStaleSent: c["queued_stale"]?.sent ?? 0,
    queuedStaleSkipped: c["queued_stale"]?.skipped ?? 0,
    heartbeatStaleSent: c["heartbeat_stale"]?.sent ?? 0,
    heartbeatStaleSkipped: c["heartbeat_stale"]?.skipped ?? 0,
    timedOutSent: c["timed_out"]?.sent ?? 0,
    timedOutSkipped: c["timed_out"]?.skipped ?? 0,
    resultReadySent: c["result_ready"]?.sent ?? 0,
    resultReadySkipped: c["result_ready"]?.skipped ?? 0,
    deliveryFailedSent: c["delivery_failed"]?.sent ?? 0,
    deliveryFailedSkipped: c["delivery_failed"]?.skipped ?? 0,
    dispatchToSpawnLatencyP50: percentile(spawnLatencies, 50),
    dispatchToSpawnLatencyP95: percentile(spawnLatencies, 95),
    resultReadyToDeliveryLatencyP50: percentile(resultDeliveryLatencies, 50),
    resultReadyToDeliveryLatencyP95: percentile(resultDeliveryLatencies, 95),
    samples: capSamples(samples).map(sanitizeSample),
  };
}

export function classifyDelegationHealth(events: ReplayEvent[]): DelegationHealthLane {
  const delegateEvents = events.filter(
    (e) => (e.route === "delegate" || e.finalRoute === "delegate") &&
      (e.event === "dispatch_called" || e.event === "agent_end" || e.event === "policy_resolved"),
  );

  let noSpawnCount = 0;
  let spawnFailedCount = 0;
  let staleCount = 0;
  let timedOutCount = 0;
  let resultOrphanCount = 0;
  let contextPollutionCount = 0;
  const parentTokens: number[] = [];
  const resultTokens: number[] = [];
  const samples: LaneSample[] = [];

  for (const event of delegateEvents) {
    const parentCtx = event.parentContextTokensAdded;
    const resultPkt = event.resultPacketTokens;
    if (parentCtx != null && typeof parentCtx === "number") parentTokens.push(parentCtx);
    if (resultPkt != null && typeof resultPkt === "number") resultTokens.push(resultPkt);

    if (parentCtx != null && parentCtx > 2000) {
      contextPollutionCount++;
      samples.push(makeSample(event, "context_pollution", `parent_context_tokens=${parentCtx} > 2000`));
    }
  }

  const transitionEvents = events.filter((e) => e.event === "execution_transition");
  for (const event of transitionEvents) {
    const kind = event.transitionKind;
    if (kind === "materialized_no_spawn") noSpawnCount++;
    if (kind === "spawn_failed") spawnFailedCount++;
    if (kind === "queued_stale") staleCount++;
    if (kind === "heartbeat_stale") staleCount++;
    if (kind === "timed_out") timedOutCount++;
  }

  const deliveryEvents = events.filter((e) => e.event === "delivery_failed" || (e.event === "execution_transition" && e.transitionKind === "delivery_failed"));
  for (const event of deliveryEvents) {
    if (event.spawnExecuted === true && event.resultMaterialized === true) resultOrphanCount++;
  }

  parentTokens.sort((a, b) => a - b);
  resultTokens.sort((a, b) => a - b);

  const total = delegateEvents.length;
  const fail = noSpawnCount + spawnFailedCount + staleCount + timedOutCount + resultOrphanCount + contextPollutionCount;
  const pass = Math.max(0, total - fail);

  return {
    lane: "delegation_health",
    total, pass, fail,
    unknown: 0,
    noSpawnCount, spawnFailedCount, staleCount, timedOutCount, resultOrphanCount, contextPollutionCount,
    parentContextTokensAddedMax: parentTokens.length > 0 ? parentTokens[parentTokens.length - 1] : null,
    parentContextTokensAddedP95: percentile(parentTokens, 95),
    resultPacketTokensMax: resultTokens.length > 0 ? resultTokens[resultTokens.length - 1] : null,
    samples: capSamples(samples).map(sanitizeSample),
  };
}

export function classifyDelivery(events: ReplayEvent[]): DeliveryLane {
  const deliveryEvents = events.filter(
    (e) => e.event === "delivery_observed" || e.event === "delivery_failed" ||
      e.event === "delivery_retry_deferred" || e.event === "delivery_compensated" ||
      e.event === "delivery_reconciled_delivered" || e.event === "delivery_pending",
  );

  let deliveryFailedCount = 0;
  let retryDeferredCount = 0;
  let compensatedCount = 0;
  const samples: LaneSample[] = [];

  for (const event of deliveryEvents) {
    switch (event.event) {
      case "delivery_failed":
        deliveryFailedCount++;
        samples.push(makeSample(event, "delivery_failed", "delivery_failed event"));
        break;
      case "delivery_retry_deferred": retryDeferredCount++; break;
      case "delivery_compensated":
        compensatedCount++;
        samples.push(makeSample(event, "compensated", "delivery_compensated event"));
        break;
    }
  }

  const pass = deliveryEvents.filter((e) => e.event === "delivery_reconciled_delivered" || e.event === "delivery_observed").length;

  return {
    lane: "delivery",
    total: deliveryEvents.length,
    pass,
    fail: deliveryFailedCount,
    unknown: retryDeferredCount + compensatedCount,
    deliveryFailedCount, retryDeferredCount, compensatedCount,
    samples: capSamples(samples).map(sanitizeSample),
  };
}

const REQUIRED_LANES: readonly string[] = [
  "route_quality",
  "route_commit_ack",
  "execution_transition",
  "delegation_health",
  "delivery",
];

export function computeOverallGate(lanes: EvaluationLaneResult[]): GateResult {
  if (lanes.length === 0) return "unknown";
  if (lanes.some((l) => l.fail > 0)) return "fail";
  if (lanes.some((l) => l.unknown > 0)) return "unknown";
  if (REQUIRED_LANES.some((required) => !lanes.some((l) => l.lane === required && l.total > 0))) return "unknown";
  return "pass";
}

export function computeRecommendationStatus(gate: GateResult): RecommendationStatus {
  if (gate === "pass") return "recommend_only";
  if (gate === "fail") return "blocked";
  return "unknown";
}

export function validateReplayEvents(events: unknown[]): asserts events is ReplayEvent[] {
  if (!Array.isArray(events)) {
    throw new Error("Nightly harness: malformed input — expected array of replay events");
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`Nightly harness: malformed event at index ${i} — expected object`);
    }
    const rec = e as Record<string, unknown>;
    if (typeof rec.at !== "string") {
      throw new Error(`Nightly harness: malformed event at index ${i} — missing or non-string "at" field`);
    }
    if (typeof rec.event !== "string") {
      throw new Error(`Nightly harness: malformed event at index ${i} — missing or non-string "event" field`);
    }
    if (!Number.isFinite(Date.parse(rec.at))) {
      throw new Error(`Nightly harness: malformed event at index ${i} — non-parseable "at" timestamp: "${rec.at}"`);
    }
  }
}

export function generateNightlyReport(events: ReplayEvent[]): NightlyReport {
  validateReplayEvents(events);

  const timestamps = events.map((e) => Date.parse(e.at));
  const earliest = timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
  const latest = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;

  const lanes: EvaluationLaneResult[] = [
    classifyRouteQuality(events),
    classifyRouteCommitAck(events),
    classifyExecutionTransition(events),
    classifyDelegationHealth(events),
    classifyDelivery(events),
  ];

  const overallGate = computeOverallGate(lanes);
  const recommendationStatus = computeRecommendationStatus(overallGate);

  return {
    reportId: `nightly:${latest ?? new Date().toISOString()}`,
    generatedAt: new Date().toISOString(),
    inputEventCount: events.length,
    inputDateRange: { earliest, latest },
    lanes,
    overallGate,
    recommendationStatus,
    recommendation: buildRecommendationText(overallGate, lanes),
    rollbackTarget: null,
  };
}

function buildRecommendationText(gate: GateResult, lanes: EvaluationLaneResult[]): string {
  if (gate === "pass") return "All lanes pass. No action required.";
  const failedLanes = lanes.filter((l) => l.fail > 0);
  const laneNames = failedLanes.map((l) => l.lane).join(", ");
  if (gate === "fail") return `Blocked: ${laneNames} have failures. Do not promote. Review samples for concrete IDs.`;
  return `Unknown: insufficient evidence in ${laneNames || "all lanes"}. Cannot promote.`;
}
