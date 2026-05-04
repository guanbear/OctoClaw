import type { SlackAcceptanceReport } from "./types.js";

export function renderSlackAcceptanceMarkdown(report: SlackAcceptanceReport): string {
  const lines: string[] = [];
  lines.push("# Slack Acceptance Report");
  lines.push("");
  lines.push(`- **Report ID**: ${report.reportId}`);
  lines.push(`- **Generated**: ${report.generatedAt}`);
  lines.push(`- **Session Key**: ${report.sessionKey}`);
  lines.push(`- **Target**: ${report.target.channel}${report.target.threadTs ? ` thread=${report.target.threadTs}` : ""}`);
  lines.push(`- **Overall Gate**: \`${report.overallGate}\``);
  lines.push(`- **Cases**: pass=${report.pass} fail=${report.fail} unknown=${report.unknown} skipped=${report.skipped}`);
  lines.push(`- **Tool Exposure**: \`${report.toolExposureAudit.status}\` blocked=${report.toolExposureAudit.blockedTools.join(", ") || "none"}`);
  lines.push("");
  lines.push("| Case | Status | Neutral ACK | Accepted ACK | Final | No Spawn | Neutral ms | Accepted ms | Final ms | Elapsed ms |");
  lines.push("|------|--------|-------------|--------------|-------|----------|------------|-------------|----------|------------|");
  for (const item of report.cases) {
    lines.push(`| ${item.kind} | ${item.status} | ${item.neutralAck?.status ?? "skipped"} | ${item.ack.status} | ${item.final.status} | ${item.noSpawn.status} | ${item.neutralAckMs ?? "N/A"} | ${item.acceptedAckMs ?? item.ackMs ?? "N/A"} | ${item.finalMs ?? "N/A"} | ${item.elapsedMs ?? "N/A"} |`);
  }
  lines.push("");
  for (const item of report.cases) {
    lines.push(`## ${item.kind}`);
    lines.push("");
    lines.push(`- status: \`${item.status}\``);
    lines.push(`- neutralAck: ${item.neutralAck?.status ?? "skipped"} — ${item.neutralAck?.reason ?? "neutral ACK assertion not configured"}`);
    lines.push(`- ack: ${item.ack.status} — ${item.ack.reason}`);
    lines.push(`- final: ${item.final.status} — ${item.final.reason}`);
    lines.push(`- noSpawn: ${item.noSpawn.status} — ${item.noSpawn.reason}`);
    if (item.replayEvidence) {
      lines.push(`- replayEvidence: ${item.replayEvidence.status} — ${item.replayEvidence.reason}`);
      lines.push(`- replayIds: workContract=${item.replayEvidence.workContractId ?? "N/A"} spawnIntent=${item.replayEvidence.spawnIntentId ?? "N/A"} runId=${item.replayEvidence.runId ?? "N/A"} childSession=${item.replayEvidence.childSessionKey ?? "N/A"}`);
      lines.push(`- neutralAnchor: source=${item.replayEvidence.anchorSource ?? "N/A"} fallback=${item.replayEvidence.fallbackUsed === true ? "true" : "false"} completion_file_timeout=${item.replayEvidence.completionFileTimeoutCount ?? 0}`);
      lines.push(`- routeBudget: decision_bucket=${item.replayEvidence.decisionBucket ?? "N/A"} budgetEvent=${item.replayEvidence.budgetEvent ?? "N/A"} budgetElapsedMs=${item.replayEvidence.budgetElapsedMs ?? "N/A"} budgetEscalationReason=${item.replayEvidence.budgetEscalationReason ?? "N/A"} visibleElapsedMs=${item.replayEvidence.visibleElapsedMs ?? "N/A"}`);
      lines.push(`- finalDelivery: footerVia=${item.replayEvidence.footerVia ?? "N/A"} delivery_transport=${item.replayEvidence.deliveryTransport ?? "N/A"} target_source=${item.replayEvidence.targetSource ?? "N/A"} footer_source=${item.replayEvidence.footerSource ?? "N/A"} duplicateFinal=${item.replayEvidence.duplicateFinalCount ?? "N/A"}`);
      const stageEntries = Object.entries(item.replayEvidence.stageMs ?? {});
      if (stageEntries.length > 0) {
        lines.push(`- stageMs: ${stageEntries.map(([name, ms]) => `${name}=${ms}`).join(", ")}`);
      }
    }
    if (item.errors.length > 0) lines.push(`- errors: ${item.errors.join("; ")}`);
    const progress = item.progress ?? [];
    if (progress.length > 0) {
      lines.push("- progress:");
      for (const event of progress) {
        lines.push(`  - ${event.event} at ${event.elapsedMs}ms${event.detail ? ` (${event.detail})` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
