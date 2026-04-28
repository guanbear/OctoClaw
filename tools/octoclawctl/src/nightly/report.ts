import type { NightlyReport, EvaluationLaneResult } from "./types.js";

export function renderMarkdownReport(report: NightlyReport): string {
  const lines: string[] = [];
  lines.push(`# Nightly Evaluation Report`);
  lines.push("");
  lines.push(`- **Report ID**: ${report.reportId}`);
  lines.push(`- **Generated**: ${report.generatedAt}`);
  lines.push(`- **Input Events**: ${report.inputEventCount}`);
  lines.push(`- **Date Range**: ${report.inputDateRange.earliest ?? "N/A"} → ${report.inputDateRange.latest ?? "N/A"}`);
  lines.push(`- **Overall Gate**: \`${report.overallGate}\``);
  lines.push(`- **Recommendation Status**: \`${report.recommendationStatus}\``);
  lines.push(`- **Recommendation**: ${report.recommendation}`);
  lines.push("");

  lines.push(`## Cost/Speed Baseline`);
  lines.push("");
  lines.push(`- **Source Events**: ${report.costSpeedBaseline.sourceEventCount}`);
  lines.push("");
  lines.push(`| Lane | Requests | Success | ACK p50/p95/p99 | Total p50/p95/p99 | Actual Cost | Cost Status | Cost/Req | Cost/Success | Fallback | Retry | Missing Cost | Context p95 | Result Tokens p95 |`);
  lines.push(`|------|----------|---------|-----------------|-------------------|-------------|-------------|----------|--------------|----------|-------|--------------|-------------|-------------------|`);
  for (const lane of report.costSpeedBaseline.lanes) {
    lines.push([
      `| ${lane.lane}`,
      lane.requestCount,
      lane.successCount,
      formatMetric(lane.ackMs),
      formatMetric(lane.totalLatencyMs),
      formatMoney(lane.actualCostUsd),
      lane.actualCostStatus,
      formatMoney(lane.costPerRequest),
      formatMoney(lane.costPerSuccess),
      lane.fallbackCount,
      lane.retryCount,
      lane.missingActualCostCount,
      lane.parentContextTokensAdded.p95 ?? "N/A",
      lane.resultPacketTokens.p95 ?? "N/A",
    ].join(" | ") + " |");
  }
  lines.push("");

  lines.push(`## Model Shadow Comparison`);
  lines.push("");
  lines.push(`- **Mode**: ${report.modelShadowComparison.mode}`);
  lines.push(`- **Compared**: ${report.modelShadowComparison.comparedCount}`);
  lines.push(`- **Changed Recommendations**: ${report.modelShadowComparison.changedRecommendationCount}`);
  lines.push(`- **Promotion Allowed**: ${report.modelShadowComparison.promotionAllowedCount}`);
  lines.push(`- **Rollback Targets**: ${report.modelShadowComparison.rollbackTargets.join(", ") || "N/A"}`);
  lines.push("");
  if (report.modelShadowComparison.samples.length > 0) {
    lines.push(`| Lane | Live Profile | Shadow Profile | Matched | Reason |`);
    lines.push(`|------|--------------|----------------|---------|--------|`);
    for (const sample of report.modelShadowComparison.samples.slice(0, 10)) {
      lines.push(`| ${sample.lane} | ${sample.liveProfile} | ${sample.recommendedProfile} | ${sample.matchedRecommendation} | ${sample.reason} |`);
    }
    lines.push("");
  }

  for (const lane of report.lanes) {
    lines.push(`## ${laneTitle(lane.lane)}`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total | ${lane.total} |`);
    lines.push(`| Pass | ${lane.pass} |`);
    lines.push(`| Fail | ${lane.fail} |`);
    lines.push(`| Unknown | ${lane.unknown} |`);
    lines.push(renderLaneDetails(lane));
    lines.push("");

    if (lane.samples.length > 0) {
      lines.push(`### Samples (capped at ${lane.samples.length})`);
      lines.push("");
      for (const sample of lane.samples) {
        lines.push(`- **${sample.verdict}** at ${sample.at || "unknown"} — ${sample.reason}`);
        if (sample.taskId) lines.push(`  - taskId: ${sample.taskId}`);
        if (sample.turnId) lines.push(`  - turnId: ${sample.turnId}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatMetric(metric: { p50: number | null; p95: number | null; p99: number | null }): string {
  return `${metric.p50 ?? "N/A"}/${metric.p95 ?? "N/A"}/${metric.p99 ?? "N/A"}`;
}

function formatMoney(value: number | null): string {
  if (value === null) return "N/A";
  return `$${value.toFixed(6)}`;
}

function laneTitle(lane: string): string {
  const titles: Record<string, string> = {
    route_quality: "Route Quality",
    route_commit_ack: "Route Commit ACK",
    execution_transition: "Execution Transitions",
    delegation_health: "Delegation Health",
    delivery: "Delivery",
  };
  return titles[lane] ?? lane;
}

function renderLaneDetails(lane: EvaluationLaneResult): string {
  switch (lane.lane) {
    case "route_quality":
      return [
        `| False Delegate | ${lane.falseDelegate} |`,
        `| False Reply | ${lane.falseReply} |`,
        `| Unclear | ${lane.unclear} |`,
        `| Protected Lane Misroute | ${lane.protectedLaneMisroute} |`,
        `| Status Respawn Risk | ${lane.statusRespawnRisk} |`,
        `| Direct Path Latency | ${lane.directPathLatency} |`,
        `| Judge Timeout | ${lane.judgeTimeoutCount} |`,
        `| Judge Fallback | ${lane.judgeFallbackCount} |`,
        `| Route Sources | ${Object.entries(lane.routeSourceDistribution).map(([k, v]) => `${k}=${v}`).join(", ")} |`,
      ].join("\n");
    case "route_commit_ack":
      return [
        `| ACK Sent | ${lane.ackSent} |`,
        `| ACK Skipped | ${lane.ackSkipped} |`,
        `| ACK Failed | ${lane.ackFailed} |`,
        `| ACK Duplicate | ${lane.ackDuplicate} |`,
        `| ACK Missing | ${lane.ackMissing} |`,
        `| ACK No Target | ${lane.ackNoTarget} |`,
        `| ACK ms P50 | ${lane.ackMsP50 ?? "N/A"} |`,
        `| ACK ms P95 | ${lane.ackMsP95 ?? "N/A"} |`,
        `| ACK ms P99 | ${lane.ackMsP99 ?? "N/A"} |`,
        `| Coverage | ${(lane.coverage * 100).toFixed(1)}% |`,
      ].join("\n");
    case "execution_transition":
      return [
        `| dispatch_materialized sent/skipped | ${lane.dispatchedSent} / ${lane.dispatchedSkipped} |`,
        `| materialized_no_spawn sent/skipped | ${lane.materializedNoSpawnSent} / ${lane.materializedNoSpawnSkipped} |`,
        `| spawn_started sent/skipped | ${lane.spawnStartedSent} / ${lane.spawnStartedSkipped} |`,
        `| spawn_failed sent/skipped | ${lane.spawnFailedSent} / ${lane.spawnFailedSkipped} |`,
        `| queued_stale sent/skipped | ${lane.queuedStaleSent} / ${lane.queuedStaleSkipped} |`,
        `| heartbeat_stale sent/skipped | ${lane.heartbeatStaleSent} / ${lane.heartbeatStaleSkipped} |`,
        `| timed_out sent/skipped | ${lane.timedOutSent} / ${lane.timedOutSkipped} |`,
        `| result_ready sent/skipped | ${lane.resultReadySent} / ${lane.resultReadySkipped} |`,
        `| delivery_failed sent/skipped | ${lane.deliveryFailedSent} / ${lane.deliveryFailedSkipped} |`,
        `| Dispatch→Spawn ms P50 | ${lane.dispatchToSpawnLatencyP50 ?? "N/A"} |`,
        `| Dispatch→Spawn ms P95 | ${lane.dispatchToSpawnLatencyP95 ?? "N/A"} |`,
        `| Result→Delivery ms P50 | ${lane.resultReadyToDeliveryLatencyP50 ?? "N/A"} |`,
        `| Result→Delivery ms P95 | ${lane.resultReadyToDeliveryLatencyP95 ?? "N/A"} |`,
      ].join("\n");
    case "delegation_health":
      return [
        `| No Spawn | ${lane.noSpawnCount} |`,
        `| Spawn Failed | ${lane.spawnFailedCount} |`,
        `| Stale | ${lane.staleCount} |`,
        `| Timed Out | ${lane.timedOutCount} |`,
        `| Result Orphan | ${lane.resultOrphanCount} |`,
        `| Context Pollution | ${lane.contextPollutionCount} |`,
        `| Parent Tokens Max | ${lane.parentContextTokensAddedMax ?? "N/A"} |`,
        `| Parent Tokens P95 | ${lane.parentContextTokensAddedP95 ?? "N/A"} |`,
        `| Result Packet Tokens Max | ${lane.resultPacketTokensMax ?? "N/A"} |`,
      ].join("\n");
    case "delivery":
      return [
        `| Delivery Failed | ${lane.deliveryFailedCount} |`,
        `| Retry Deferred | ${lane.retryDeferredCount} |`,
        `| Compensated | ${lane.compensatedCount} |`,
      ].join("\n");
  }
}
