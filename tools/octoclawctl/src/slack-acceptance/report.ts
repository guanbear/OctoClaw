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
  lines.push("| Case | Status | ACK | Final | No Spawn | ACK ms | Final ms | Elapsed ms |");
  lines.push("|------|--------|-----|-------|----------|--------|----------|------------|");
  for (const item of report.cases) {
    lines.push(`| ${item.kind} | ${item.status} | ${item.ack.status} | ${item.final.status} | ${item.noSpawn.status} | ${item.ackMs ?? "N/A"} | ${item.finalMs ?? "N/A"} | ${item.elapsedMs ?? "N/A"} |`);
  }
  lines.push("");
  for (const item of report.cases) {
    lines.push(`## ${item.kind}`);
    lines.push("");
    lines.push(`- status: \`${item.status}\``);
    lines.push(`- ack: ${item.ack.status} — ${item.ack.reason}`);
    lines.push(`- final: ${item.final.status} — ${item.final.reason}`);
    lines.push(`- noSpawn: ${item.noSpawn.status} — ${item.noSpawn.reason}`);
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
