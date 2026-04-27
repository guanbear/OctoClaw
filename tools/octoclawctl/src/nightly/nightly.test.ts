import { describe, expect, it } from "vitest";
import type { ReplayEvent, LaneSample } from "./types.js";
import {
  classifyRouteQuality,
  classifyRouteCommitAck,
  classifyExecutionTransition,
  classifyDelegationHealth,
  classifyDelivery,
  computeOverallGate,
  computeRecommendationStatus,
  generateNightlyReport,
  filterNightlyReplayEvents,
  validateReplayEvents,
  percentile,
  sanitizeSample,
} from "./classifier.js";
import { renderMarkdownReport } from "./report.js";

function makeEvent(overrides: Partial<ReplayEvent> & { event: string; at: string }): ReplayEvent {
  return {
    schema_version: "octoclaw.runtime_policy.replay_event/v1",
    sessionKey: "slack:channel:C123:thread:456",
    sessionId: "sess-test",
    ...overrides,
  };
}

function routeCommitAck(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return makeEvent({
    event: "route_commit_ack",
    at: "2026-04-26T10:00:01.000Z",
    ackKind: "route_commit_ack",
    ackSent: true,
    ackMode: "channel_message",
    ack_delivery_state: "sent",
    ack_target_resolution_state: "resolved",
    reason: "channel_message_sent",
    routeCommitId: "wc-001",
    routeSealId: "rs-001",
    ackKey: "route_commit_ack:slack:channel:C123:thread:456:turn-1:wc-001",
    route: "delegate",
    routeSource: "policy_judge",
    turnId: "turn-1",
    taskId: "task-001",
    ...overrides,
  });
}

function policyResolved(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return makeEvent({
    event: "policy_resolved",
    at: "2026-04-26T10:00:00.000Z",
    route: "delegate",
    systemPreferredRoute: "delegate",
    routerDecisionValid: true,
    confidence: 0.9,
    routerDecisionSource: "local_judge",
    routeCommitId: "wc-001",
    turnId: "turn-1",
    ...overrides,
  });
}

function executionTransition(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return makeEvent({
    event: "execution_transition",
    at: "2026-04-26T10:00:05.000Z",
    transitionKind: "dispatch_materialized",
    notificationKey: "exec_transition:task-001:attempt-1:dispatch_materialized",
    taskId: "task-001",
    attemptId: "attempt-1",
    workContractId: "wc-001",
    projectionStatus: "queued",
    projectionStatusReason: "dispatch_executed_without_spawn_evidence",
    dispatchExecuted: true,
    spawnExecuted: false,
    resultMaterialized: false,
    sent: true,
    skipped: false,
    ack_delivery_state: "sent",
    ack_target_resolution_state: "resolved",
    reason: "dispatch_materialized",
    occurredAt: "2026-04-26T10:00:05.000Z",
    ...overrides,
  });
}

function agentEnd(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return makeEvent({
    event: "agent_end",
    at: "2026-04-26T10:00:30.000Z",
    route: "delegate",
    finalRoute: "delegate",
    delegated: true,
    executed: true,
    spawnExecuted: true,
    ...overrides,
  });
}


describe("route quality", () => {
  it("classifies pass for correct delegate routing", () => {
    const events = [policyResolved({ route: "delegate", systemPreferredRoute: "delegate", confidence: 0.9, routerDecisionValid: true })];
    const lane = classifyRouteQuality(events);
    expect(lane.pass).toBe(1);
    expect(lane.fail).toBe(0);
  });

  it("classifies false_delegate when router rejects", () => {
    const events = [policyResolved({ route: "delegate", routerDecisionValid: false })];
    const lane = classifyRouteQuality(events);
    expect(lane.falseDelegate).toBe(1);
    expect(lane.fail).toBe(1);
  });

  it("classifies false_reply when system wanted delegate but got reply", () => {
    const events = [policyResolved({ route: "reply", systemPreferredRoute: "delegate" })];
    const lane = classifyRouteQuality(events);
    expect(lane.falseReply).toBe(1);
  });

  it("classifies unknown when no confidence or validity", () => {
    const events = [policyResolved({ confidence: undefined, routerDecisionValid: undefined })];
    const lane = classifyRouteQuality(events);
    expect(lane.unknown).toBe(1);
  });

  it("tracks route source distribution", () => {
    const events = [
      policyResolved({ routerDecisionSource: "local_judge" }),
      policyResolved({ routerDecisionSource: "policy_rule" }),
    ];
    const lane = classifyRouteQuality(events);
    expect(lane.routeSourceDistribution["local_judge"]).toBe(1);
    expect(lane.routeSourceDistribution["policy_rule"]).toBe(1);
  });
});


describe("route commit ack — real D1 shapes", () => {
  it("counts sent when ackSent=true and delivery_state=sent", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-1", turnId: "t1" }),
      routeCommitAck({ ackSent: true, ack_delivery_state: "sent", routeCommitId: "wc-1", turnId: "t1", reason: "channel_message_sent" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackSent).toBe(1);
    expect(lane.ackFailed).toBe(0);
    expect(lane.ackDuplicate).toBe(0);
    expect(lane.pass).toBe(1);
  });

  it("counts failed when ack_delivery_state=failed", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-2" }),
      routeCommitAck({ ackSent: false, ack_delivery_state: "failed", ack_target_resolution_state: "resolved_send_failed", reason: "channel_message_sent", routeCommitId: "wc-2" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackFailed).toBe(1);
    expect(lane.ackSent).toBe(0);
    expect(lane.fail).toBe(1);
  });

  it("counts duplicate when same ackKey seen twice", () => {
    const ackKey = "route_commit_ack:slack:C123:thread:456:turn-1:wc-dup";
    const events = [
      policyResolved({ routeCommitId: "wc-dup", turnId: "turn-1" }),
      routeCommitAck({ ackKey, ackSent: true, ack_delivery_state: "sent", routeCommitId: "wc-dup", turnId: "turn-1" }),
      routeCommitAck({ ackKey, ackSent: false, ack_delivery_state: "skipped", reason: "duplicate", routeCommitId: "wc-dup", turnId: "turn-1" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackDuplicate).toBe(1);
    expect(lane.ackSent).toBe(1);
  });

  it("duplicate counts as fail (at most one ACK per turn)", () => {
    const ackKey = "route_commit_ack:slack:C123:t:t1:wc-x";
    const events = [
      policyResolved({ routeCommitId: "wc-x", turnId: "t1" }),
      routeCommitAck({ ackKey, ackSent: true, ack_delivery_state: "sent", routeCommitId: "wc-x", turnId: "t1" }),
      routeCommitAck({ ackKey, ackSent: false, ack_delivery_state: "skipped", reason: "duplicate", routeCommitId: "wc-x", turnId: "t1" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackSent).toBe(1);
    expect(lane.ackDuplicate).toBe(1);
    expect(lane.fail).toBeGreaterThanOrEqual(1);
    expect(lane.coverage).toBeLessThan(1);
  });

  it("counts no_target when target resolution fails", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-3" }),
      routeCommitAck({ ackSent: false, ack_delivery_state: "not_attempted", ack_target_resolution_state: "no_valid_thread_anchor", reason: "no_valid_thread_anchor", routeCommitId: "wc-3" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackNoTarget).toBe(1);
    expect(lane.ackSent).toBe(0);
  });

  it("counts no_target for target_resolution_failed", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-4" }),
      routeCommitAck({ ackSent: false, ack_delivery_state: "not_attempted", ack_target_resolution_state: "target_resolution_failed", routeCommitId: "wc-4" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackNoTarget).toBe(1);
  });

  it("counts no_target for missing_route_commit_data", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-5" }),
      routeCommitAck({ ackSent: false, ack_target_resolution_state: "missing_route_commit_data", routeCommitId: "wc-5" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackNoTarget).toBe(1);
  });

  it("counts skipped for reply_already_visible", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-6" }),
      routeCommitAck({ ackSent: false, ack_delivery_state: "skipped", ack_target_resolution_state: "suppressed_reply_visible", reason: "reply_already_visible", routeCommitId: "wc-6" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackSkipped).toBe(1);
    expect(lane.ackSent).toBe(0);
  });

  it("skipped does not inflate coverage", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-skip" }),
      routeCommitAck({ ackSent: false, ack_delivery_state: "skipped", reason: "reply_already_visible", routeCommitId: "wc-skip" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackSkipped).toBe(1);
    expect(lane.ackSent).toBe(0);
    expect(lane.coverage).toBe(0);
  });

  it("detects missing ACK when route resolved but no ack event", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-missing", turnId: "t-miss" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackMissing).toBe(1);
  });

  it("counts duplicate from reason=duplicate field", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-dup2" }),
      routeCommitAck({ ackKey: "key-a", ackSent: false, ack_delivery_state: "skipped", reason: "duplicate", routeCommitId: "wc-dup2" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackDuplicate).toBe(1);
    expect(lane.ackSent).toBe(0);
    expect(lane.fail).toBeGreaterThanOrEqual(1);
  });

  it("computes ACK timing percentiles from route commit and ack timestamps", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-a", turnId: "ta", at: "2026-04-26T10:00:00.000Z" }),
      routeCommitAck({ routeCommitId: "wc-a", turnId: "ta", ackKey: "ack-wc-a", at: "2026-04-26T10:00:00.100Z", ackSent: true, ack_delivery_state: "sent" }),
      policyResolved({ routeCommitId: "wc-b", turnId: "tb", at: "2026-04-26T10:00:01.000Z" }),
      routeCommitAck({ routeCommitId: "wc-b", turnId: "tb", ackKey: "ack-wc-b", at: "2026-04-26T10:00:01.300Z", ackSent: true, ack_delivery_state: "sent" }),
      policyResolved({ routeCommitId: "wc-c", turnId: "tc", at: "2026-04-26T10:00:02.000Z" }),
      routeCommitAck({ routeCommitId: "wc-c", turnId: "tc", ackKey: "ack-wc-c", at: "2026-04-26T10:00:02.500Z", ackSent: true, ack_delivery_state: "sent" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackMsP50).toBe(300);
    expect(lane.ackMsP95).toBe(500);
    expect(lane.ackMsP99).toBe(500);
  });

  it("uses explicit ACK actualLatency when present", () => {
    const events = [
      policyResolved({ routeCommitId: "wc-latency", turnId: "tl", at: "2026-04-26T10:00:00.000Z" }),
      routeCommitAck({ routeCommitId: "wc-latency", turnId: "tl", at: "2026-04-26T10:00:10.000Z", actualLatency: 42, ackSent: true, ack_delivery_state: "sent" }),
    ];
    const lane = classifyRouteCommitAck(events);
    expect(lane.ackMsP50).toBe(42);
  });

});


describe("execution transition — real D2 shapes", () => {
  it("counts dispatch_materialized sent", () => {
    const events = [executionTransition({ transitionKind: "dispatch_materialized", sent: true, skipped: false })];
    const lane = classifyExecutionTransition(events);
    expect(lane.dispatchedSent).toBe(1);
    expect(lane.dispatchedSkipped).toBe(0);
  });

  it("counts materialized_no_spawn", () => {
    const events = [executionTransition({
      transitionKind: "materialized_no_spawn", sent: true,
      projectionStatus: "queued", dispatchExecuted: true, spawnExecuted: false,
    })];
    const lane = classifyExecutionTransition(events);
    expect(lane.materializedNoSpawnSent).toBe(1);
  });

  it("counts spawn_started", () => {
    const events = [executionTransition({ transitionKind: "spawn_started", sent: true, spawnExecuted: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.spawnStartedSent).toBe(1);
  });

  it("counts spawn_failed", () => {
    const events = [executionTransition({ transitionKind: "spawn_failed", sent: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.spawnFailedSent).toBe(1);
  });

  it("counts queued_stale", () => {
    const events = [executionTransition({ transitionKind: "queued_stale", sent: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.queuedStaleSent).toBe(1);
  });

  it("counts heartbeat_stale", () => {
    const events = [executionTransition({ transitionKind: "heartbeat_stale", sent: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.heartbeatStaleSent).toBe(1);
  });

  it("counts timed_out", () => {
    const events = [executionTransition({ transitionKind: "timed_out", sent: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.timedOutSent).toBe(1);
  });

  it("counts result_ready", () => {
    const events = [executionTransition({ transitionKind: "result_ready", sent: true, resultMaterialized: true, projectionStatus: "deliverable_ready" })];
    const lane = classifyExecutionTransition(events);
    expect(lane.resultReadySent).toBe(1);
  });

  it("counts delivery_failed", () => {
    const events = [executionTransition({ transitionKind: "delivery_failed", sent: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.deliveryFailedSent).toBe(1);
  });

  it("counts skipped when sent=false skipped=true", () => {
    const events = [executionTransition({ transitionKind: "spawn_started", sent: false, skipped: true })];
    const lane = classifyExecutionTransition(events);
    expect(lane.spawnStartedSkipped).toBe(1);
    expect(lane.spawnStartedSent).toBe(0);
  });

  it("ignores events without transitionKind", () => {
    const events = [makeEvent({ event: "execution_transition", at: "2026-04-26T10:00:00.000Z" })];
    const lane = classifyExecutionTransition(events);
    expect(lane.total).toBe(0);
  });

  it("computes dispatch-to-spawn latency percentiles", () => {
    const events = [
      executionTransition({ taskId: "task-l1", attemptId: "attempt-l1", transitionKind: "dispatch_materialized", sent: true, at: "2026-04-26T10:00:00.000Z", occurredAt: "2026-04-26T10:00:00.000Z" }),
      executionTransition({ taskId: "task-l1", attemptId: "attempt-l1", transitionKind: "spawn_started", sent: true, at: "2026-04-26T10:00:03.000Z", occurredAt: "2026-04-26T10:00:03.000Z", spawnExecuted: true }),
      executionTransition({ taskId: "task-l2", attemptId: "attempt-l2", transitionKind: "dispatch_materialized", sent: true, at: "2026-04-26T10:00:10.000Z", occurredAt: "2026-04-26T10:00:10.000Z" }),
      executionTransition({ taskId: "task-l2", attemptId: "attempt-l2", transitionKind: "spawn_started", sent: true, at: "2026-04-26T10:00:17.000Z", occurredAt: "2026-04-26T10:00:17.000Z", spawnExecuted: true }),
    ];
    const lane = classifyExecutionTransition(events);
    expect(lane.dispatchToSpawnLatencyP50).toBe(3000);
    expect(lane.dispatchToSpawnLatencyP95).toBe(7000);
  });

  it("computes result-ready-to-delivery latency percentiles", () => {
    const events = [
      executionTransition({ taskId: "task-delivery", transitionKind: "result_ready", sent: true, at: "2026-04-26T10:00:20.000Z", occurredAt: "2026-04-26T10:00:20.000Z", resultMaterialized: true }),
      makeEvent({ event: "delivery_observed", at: "2026-04-26T10:00:25.000Z", taskId: "task-delivery" }),
    ];
    const lane = classifyExecutionTransition(events);
    expect(lane.resultReadyToDeliveryLatencyP50).toBe(5000);
    expect(lane.resultReadyToDeliveryLatencyP95).toBe(5000);
  });

});


describe("delegation health", () => {
  it("detects context pollution when parent tokens exceed threshold", () => {
    const events = [agentEnd({ route: "delegate", parentContextTokensAdded: 3000 })];
    const lane = classifyDelegationHealth(events);
    expect(lane.contextPollutionCount).toBe(1);
    expect(lane.parentContextTokensAddedMax).toBe(3000);
  });

  it("has no pollution when tokens under threshold", () => {
    const events = [agentEnd({ parentContextTokensAdded: 500 })];
    const lane = classifyDelegationHealth(events);
    expect(lane.contextPollutionCount).toBe(0);
  });

  it("counts no_spawn from execution_transition materialized_no_spawn", () => {
    const events = [executionTransition({ transitionKind: "materialized_no_spawn", sent: true })];
    const lane = classifyDelegationHealth(events);
    expect(lane.noSpawnCount).toBe(1);
  });

  it("counts spawn_failed from execution_transition", () => {
    const events = [executionTransition({ transitionKind: "spawn_failed", sent: true })];
    const lane = classifyDelegationHealth(events);
    expect(lane.spawnFailedCount).toBe(1);
  });

  it("counts stale from queued_stale + heartbeat_stale", () => {
    const events = [
      executionTransition({ transitionKind: "queued_stale", sent: true }),
      executionTransition({ transitionKind: "heartbeat_stale", sent: true }),
    ];
    const lane = classifyDelegationHealth(events);
    expect(lane.staleCount).toBe(2);
  });

  it("counts timed_out from execution_transition", () => {
    const events = [executionTransition({ transitionKind: "timed_out", sent: true })];
    const lane = classifyDelegationHealth(events);
    expect(lane.timedOutCount).toBe(1);
  });
});


describe("delivery", () => {
  it("counts delivery success", () => {
    const events = [makeEvent({ event: "delivery_observed", at: "2026-04-26T10:00:06.000Z" })];
    const lane = classifyDelivery(events);
    expect(lane.pass).toBe(1);
  });

  it("counts delivery failed", () => {
    const events = [makeEvent({ event: "delivery_failed", at: "2026-04-26T10:00:07.000Z" })];
    const lane = classifyDelivery(events);
    expect(lane.deliveryFailedCount).toBe(1);
    expect(lane.fail).toBe(1);
  });

  it("counts retry deferred as unknown", () => {
    const events = [makeEvent({ event: "delivery_retry_deferred", at: "2026-04-26T10:00:08.000Z" })];
    const lane = classifyDelivery(events);
    expect(lane.retryDeferredCount).toBe(1);
    expect(lane.unknown).toBe(1);
  });
});


describe("overall gate — stricter semantics", () => {
  it("returns pass only when all required lanes have total>0, fail=0, unknown=0", () => {
    const gate = computeOverallGate([
      { lane: "route_quality", total: 10, pass: 10, fail: 0, unknown: 0, falseDelegate: 0, falseReply: 0, unclear: 0, protectedLaneMisroute: 0, statusRespawnRisk: 0, directPathLatency: 0, routeSourceDistribution: {}, judgeTimeoutCount: 0, judgeFallbackCount: 0, samples: [] },
      { lane: "route_commit_ack", total: 5, pass: 5, fail: 0, unknown: 0, ackSent: 5, ackSkipped: 0, ackFailed: 0, ackDuplicate: 0, ackMissing: 0, ackNoTarget: 0, ackMsP50: null, ackMsP95: null, ackMsP99: null, coverage: 1, samples: [] },
      { lane: "execution_transition", total: 8, pass: 8, fail: 0, unknown: 0, dispatchedSent: 2, dispatchedSkipped: 0, materializedNoSpawnSent: 0, materializedNoSpawnSkipped: 0, spawnStartedSent: 2, spawnStartedSkipped: 0, spawnFailedSent: 0, spawnFailedSkipped: 0, queuedStaleSent: 0, queuedStaleSkipped: 0, heartbeatStaleSent: 0, heartbeatStaleSkipped: 0, timedOutSent: 0, timedOutSkipped: 0, resultReadySent: 2, resultReadySkipped: 0, deliveryFailedSent: 0, deliveryFailedSkipped: 0, dispatchToSpawnLatencyP50: null, dispatchToSpawnLatencyP95: null, resultReadyToDeliveryLatencyP50: null, resultReadyToDeliveryLatencyP95: null, samples: [] },
      { lane: "delegation_health", total: 3, pass: 3, fail: 0, unknown: 0, noSpawnCount: 0, spawnFailedCount: 0, staleCount: 0, timedOutCount: 0, resultOrphanCount: 0, contextPollutionCount: 0, parentContextTokensAddedMax: null, parentContextTokensAddedP95: null, resultPacketTokensMax: null, samples: [] },
      { lane: "delivery", total: 4, pass: 4, fail: 0, unknown: 0, deliveryFailedCount: 0, retryDeferredCount: 0, compensatedCount: 0, samples: [] },
    ]);
    expect(gate).toBe("pass");
  });

  it("returns fail when any lane has failures", () => {
    const gate = computeOverallGate([
      { lane: "route_quality", total: 10, pass: 9, fail: 1, unknown: 0, falseDelegate: 1, falseReply: 0, unclear: 0, protectedLaneMisroute: 0, statusRespawnRisk: 0, directPathLatency: 0, routeSourceDistribution: {}, judgeTimeoutCount: 0, judgeFallbackCount: 0, samples: [] },
    ]);
    expect(gate).toBe("fail");
  });

  it("returns unknown when any lane has unknown>0 even if no failures", () => {
    const gate = computeOverallGate([
      { lane: "route_quality", total: 10, pass: 8, fail: 0, unknown: 2, falseDelegate: 0, falseReply: 0, unclear: 2, protectedLaneMisroute: 0, statusRespawnRisk: 0, directPathLatency: 0, routeSourceDistribution: {}, judgeTimeoutCount: 0, judgeFallbackCount: 0, samples: [] },
    ]);
    expect(gate).toBe("unknown");
  });

  it("returns unknown when a required lane has total=0", () => {
    const gate = computeOverallGate([
      { lane: "route_quality", total: 10, pass: 10, fail: 0, unknown: 0, falseDelegate: 0, falseReply: 0, unclear: 0, protectedLaneMisroute: 0, statusRespawnRisk: 0, directPathLatency: 0, routeSourceDistribution: {}, judgeTimeoutCount: 0, judgeFallbackCount: 0, samples: [] },
      { lane: "route_commit_ack", total: 0, pass: 0, fail: 0, unknown: 0, ackSent: 0, ackSkipped: 0, ackFailed: 0, ackDuplicate: 0, ackMissing: 0, ackNoTarget: 0, ackMsP50: null, ackMsP95: null, ackMsP99: null, coverage: 0, samples: [] },
    ]);
    expect(gate).toBe("unknown");
  });

  it("returns unknown for empty lanes", () => {
    expect(computeOverallGate([])).toBe("unknown");
  });

  it("mixed pass+unknown yields unknown (unknown must not count as pass)", () => {
    const gate = computeOverallGate([
      { lane: "route_quality", total: 10, pass: 10, fail: 0, unknown: 0, falseDelegate: 0, falseReply: 0, unclear: 0, protectedLaneMisroute: 0, statusRespawnRisk: 0, directPathLatency: 0, routeSourceDistribution: {}, judgeTimeoutCount: 0, judgeFallbackCount: 0, samples: [] },
      { lane: "route_commit_ack", total: 5, pass: 3, fail: 0, unknown: 2, ackSent: 3, ackSkipped: 2, ackFailed: 0, ackDuplicate: 0, ackMissing: 0, ackNoTarget: 0, ackMsP50: null, ackMsP95: null, ackMsP99: null, coverage: 0.6, samples: [] },
    ]);
    expect(gate).toBe("unknown");
  });
});

describe("recommendation status", () => {
  it("returns recommend_only for pass", () => {
    expect(computeRecommendationStatus("pass")).toBe("recommend_only");
  });
  it("returns blocked for fail", () => {
    expect(computeRecommendationStatus("fail")).toBe("blocked");
  });
  it("returns unknown for unknown", () => {
    expect(computeRecommendationStatus("unknown")).toBe("unknown");
  });
});


describe("sanitizer", () => {
  it("removes forbidden keys from sample details", () => {
    const sample: LaneSample = { eventId: "t", at: "", verdict: "pass", reason: "", details: { prompt: "s", ackMessage: "a", workerPool: "r" } };
    const sanitized = sanitizeSample(sample);
    expect(sanitized.details).not.toHaveProperty("prompt");
    expect(sanitized.details).not.toHaveProperty("ackMessage");
    expect(sanitized.details).toHaveProperty("workerPool", "r");
  });

  it("truncates long string values", () => {
    const sample: LaneSample = { eventId: "t", at: "", verdict: "pass", reason: "", details: { summary: "x".repeat(300) } };
    const sanitized = sanitizeSample(sample);
    expect((sanitized.details?.summary as string).length).toBeLessThan(300);
  });

  it("strips forbidden keys from nested objects recursively", () => {
    const sample: LaneSample = {
      eventId: "t", at: "", verdict: "fail", reason: "test",
      details: {
        compactParentPacket: {
          taskId: "t1",
          transcript: "leaked transcript",
          rawTranscript: "leaked raw",
          nested: { prompt: "deep prompt", ok: "keep" },
        },
      },
    };
    const sanitized = sanitizeSample(sample);
    const packet = sanitized.details?.compactParentPacket as Record<string, unknown>;
    expect(packet).not.toHaveProperty("transcript");
    expect(packet).not.toHaveProperty("rawTranscript");
    expect(packet).toHaveProperty("taskId", "t1");
    const nested = packet.nested as Record<string, unknown>;
    expect(nested).not.toHaveProperty("prompt");
    expect(nested).toHaveProperty("ok", "keep");
  });
});

describe("percentile", () => {
  it("returns null for empty array", () => expect(percentile([], 50)).toBeNull());
  it("computes P50", () => expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30));
});



  it("filters nightly replay to the configured recent non-synthetic window", () => {
    const events = [
      routeCommitAck({ at: "2026-04-26T00:00:00.000Z", sessionKey: "slack:channel:C_REAL:thread:old", routeCommitId: "wc-old" }),
      routeCommitAck({ at: "2026-04-27T05:48:18.441Z", sessionKey: "bogus-no-colon", turnId: "turn-789", routeCommitId: "wc-123" }),
      routeCommitAck({ at: "2026-04-27T06:00:00.000Z", sessionKey: "slack:channel:C_REAL:thread:new", routeCommitId: "wc-new" }),
    ];

    const filtered = filterNightlyReplayEvents(events, { now: "2026-04-27T07:00:00.000Z", lookbackHours: 24 });
    const report = generateNightlyReport(filtered.events, filtered.metadata);

    expect(filtered.events.map((event) => event.routeCommitId)).toEqual(["wc-new"]);
    expect(report.rawInputEventCount).toBe(3);
    expect(report.filteredEventCount).toBe(1);
    expect(report.filter?.cutoffAt).toBe("2026-04-26T07:00:00.000Z");
  });

describe("validateReplayEvents", () => {
  it("passes for well-formed events", () => {
    const events = [
      makeEvent({ event: "policy_resolved", at: "2026-04-26T10:00:00.000Z" }),
    ];
    expect(() => validateReplayEvents(events)).not.toThrow();
  });

  it("throws on non-array input", () => {
    expect(() => validateReplayEvents(null as unknown as unknown[])).toThrow("malformed input");
  });

  it("throws on string input", () => {
    expect(() => validateReplayEvents("bad" as unknown as unknown[])).toThrow("malformed input");
  });

  it("throws with index for non-object event", () => {
    expect(() => validateReplayEvents([null])).toThrow("index 0");
    expect(() => validateReplayEvents([42 as unknown])).toThrow("index 0");
  });

  it("throws with index for missing at field", () => {
    const events = [{ event: "policy_resolved" }];
    expect(() => validateReplayEvents(events)).toThrow('index 0');
  });

  it("throws with index for missing event field", () => {
    const events = [{ at: "2026-04-26T10:00:00.000Z" }];
    expect(() => validateReplayEvents(events)).toThrow("index 0");
  });

  it("throws with index for non-parseable at timestamp", () => {
    const events = [{ at: "", event: "policy_resolved" }];
    expect(() => validateReplayEvents(events)).toThrow('non-parseable "at"');
  });

  it("throws with correct index for malformed event in middle", () => {
    const events = [
      makeEvent({ event: "policy_resolved", at: "2026-04-26T10:00:00.000Z" }),
      { bad: true } as unknown,
      makeEvent({ event: "policy_resolved", at: "2026-04-26T10:00:02.000Z" }),
    ];
    expect(() => validateReplayEvents(events)).toThrow("index 1");
  });

  it("passes for empty array", () => {
    expect(() => validateReplayEvents([])).not.toThrow();
  });
});


describe("full report generation", () => {
  it("generates report from mixed real-shape events", () => {
    const events: ReplayEvent[] = [
      policyResolved({ route: "delegate", turnId: "t1", routerDecisionValid: true, confidence: 0.85, routeCommitId: "wc-r1" }),
      routeCommitAck({ turnId: "t1", routeCommitId: "wc-r1", ackSent: true, ack_delivery_state: "sent" }),
      executionTransition({ transitionKind: "dispatch_materialized", sent: true, taskId: "task-r1" }),
      executionTransition({ transitionKind: "spawn_started", sent: true, taskId: "task-r1" }),
      executionTransition({ transitionKind: "result_ready", sent: true, taskId: "task-r1" }),
      makeEvent({ event: "delivery_observed", at: "2026-04-26T10:01:00.000Z" }),
    ];
    const report = generateNightlyReport(events);
    expect(report.inputEventCount).toBe(6);
    expect(report.lanes).toHaveLength(5);
  });

  it("fails closed on malformed input — non-array", () => {
    expect(() => generateNightlyReport(null as unknown as ReplayEvent[])).toThrow("malformed input");
  });

  it("fails closed on malformed input — non-array string", () => {
    expect(() => generateNightlyReport("bad" as unknown as ReplayEvent[])).toThrow("malformed input");
  });

  it("throws on event missing at field instead of filtering", () => {
    const events = [{ event: "policy_resolved" }] as ReplayEvent[];
    expect(() => generateNightlyReport(events)).toThrow("index 0");
  });

  it("throws on event missing event field instead of filtering", () => {
    const events = [{ at: "2026-04-26T10:00:00.000Z" }] as ReplayEvent[];
    expect(() => generateNightlyReport(events)).toThrow("index 0");
  });

  it("throws on event with non-parseable at", () => {
    const events = [{ at: "", event: "policy_resolved" }] as ReplayEvent[];
    expect(() => generateNightlyReport(events)).toThrow('non-parseable "at"');
  });

  it("unknown gate never yields recommend_only", () => {
    const events: ReplayEvent[] = [makeEvent({ event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "reply" })];
    const report = generateNightlyReport(events);
    if (report.overallGate === "unknown") {
      expect(report.recommendationStatus).not.toBe("recommend_only");
    }
  });

  it("does not auto-promote", () => {
    const events: ReplayEvent[] = [policyResolved({ route: "delegate", confidence: 0.95, routerDecisionValid: true })];
    const report = generateNightlyReport(events);
    expect(["recommend_only", "blocked", "unknown"]).toContain(report.recommendationStatus);
  });

  it("no raw transcript leaks into samples", () => {
    const events: ReplayEvent[] = [
      policyResolved({ route: "delegate", routerDecisionValid: false }),
      routeCommitAck({ ackSent: true, ack_delivery_state: "sent", ackMessage: "敏感的确认文本" }),
      executionTransition({ transitionKind: "spawn_failed", sent: true }),
    ];
    const report = generateNightlyReport(events);
    const allSamples = report.lanes.flatMap((l) => l.samples);
    for (const sample of allSamples) {
      expect(sample.details).not.toHaveProperty("prompt");
      expect(sample.details).not.toHaveProperty("transcript");
      expect(sample.details).not.toHaveProperty("childTranscript");
      expect(sample.details).not.toHaveProperty("ackMessage");
    }
  });

  it("compactParentPacket in samples does not contain transcript", () => {
    const events: ReplayEvent[] = [
      executionTransition({ transitionKind: "spawn_failed", sent: true, compactParentPacket: { taskId: "task-1", status: "failed", artifactRefIds: [] } }),
    ];
    const report = generateNightlyReport(events);
    const etLane = report.lanes.find((l) => l.lane === "execution_transition")!;
    for (const sample of etLane.samples) {
      const packet = sample.details?.compactParentPacket as Record<string, unknown> | undefined;
      if (packet) {
        expect(packet).not.toHaveProperty("transcript");
        expect(packet).not.toHaveProperty("rawTranscript");
      }
    }
  });

  it("empty array produces unknown gate", () => {
    const report = generateNightlyReport([]);
    expect(report.overallGate).toBe("unknown");
    expect(report.recommendationStatus).toBe("unknown");
  });
});


describe("report rendering", () => {
  it("renders valid markdown with real D1/D2 shapes", () => {
    const events: ReplayEvent[] = [
      policyResolved({ route: "delegate", confidence: 0.9, routerDecisionValid: true, turnId: "t1", routeCommitId: "wc-md" }),
      routeCommitAck({ turnId: "t1", routeCommitId: "wc-md", ackSent: true, ack_delivery_state: "sent" }),
      executionTransition({ transitionKind: "dispatch_materialized", sent: true }),
      makeEvent({ event: "delivery_observed", at: "2026-04-26T10:01:00.000Z" }),
    ];
    const report = generateNightlyReport(events);
    const md = renderMarkdownReport(report);
    expect(md).toContain("# Nightly Evaluation Report");
    expect(md).toContain("## Route Quality");
    expect(md).toContain("## Route Commit ACK");
    expect(md).toContain("## Execution Transitions");
    expect(md).toContain("dispatch_materialized sent/skipped");
    expect(md).toContain("ACK ms P50");
    expect(md).toContain("Dispatch→Spawn ms P50");
    expect(md).toContain("Result→Delivery ms P50");
  });

  it("renders fail gate with blocked recommendation", () => {
    const events: ReplayEvent[] = [policyResolved({ route: "delegate", routerDecisionValid: false })];
    const report = generateNightlyReport(events);
    const md = renderMarkdownReport(report);
    expect(md).toContain("`fail`");
    expect(md).toContain("Blocked");
  });

  it("renders JSON-serializable report", () => {
    const events: ReplayEvent[] = [policyResolved({ route: "reply", confidence: 0.9 })];
    const report = generateNightlyReport(events);
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.lanes).toHaveLength(5);
  });
});
