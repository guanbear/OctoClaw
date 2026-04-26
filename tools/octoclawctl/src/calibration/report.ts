import type { CalibrationGateReport, DimensionResult } from "./types.js";

export function renderCalibrationMarkdown(report: CalibrationGateReport): string {
  return `# Calibration Gate Report

- **Report ID**: ${report.reportId}
- **Generated**: ${report.generatedAt}
- **Overall Gate**: \`${report.overallGate}\`
- **Recommendation Status**: \`${report.recommendationStatus}\`
- **Recommendation**: ${report.recommendation}
- **Rollback Target**: ${report.rollbackTarget ?? "N/A"}

## Baseline
- Source: ${report.baseline.source}
- Nightly Report: ${report.baseline.nightlyReportId ?? "N/A"}
- Slack Report: ${report.baseline.slackReportId ?? "N/A"}

## Candidate
- Source: ${report.candidate.source}
- Nightly Report: ${report.candidate.nightlyReportId ?? "N/A"}
- Slack Report: ${report.candidate.slackReportId ?? "N/A"}

## Dimension Results

| Dimension | Status | Reason |
|-----------|--------|--------|
| Latency | ${report.dimensions.latency.status} | ${escapeTableCell(report.dimensions.latency.reason)} |
| Cost | ${report.dimensions.cost.status} | ${escapeTableCell(report.dimensions.cost.reason)} |
| Acceptance | ${report.dimensions.acceptance.status} | ${escapeTableCell(report.dimensions.acceptance.reason)} |
| No-Lie | ${report.dimensions.noLie.status} | ${escapeTableCell(report.dimensions.noLie.reason)} |
| Context Pollution | ${report.dimensions.contextPollution.status} | ${escapeTableCell(report.dimensions.contextPollution.reason)} |
| Fallback/Timeout | ${report.dimensions.fallbackTimeout.status} | ${escapeTableCell(report.dimensions.fallbackTimeout.reason)} |
`;
}

function escapeTableCell(value: DimensionResult["reason"]): string {
  return value.replace(/\|/g, "\\|");
}
