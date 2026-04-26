import type { EvalStepResult, NightlyEvalAggregateReport } from "./types.js";

export function renderNightlyEvalMarkdown(report: NightlyEvalAggregateReport): string {
  return `# Nightly Evaluation Report

- **Report ID**: ${report.reportId}
- **Generated**: ${report.generatedAt}
- **Output Dir**: ${report.artifactDir}
- **Overall Gate**: \`${report.overallGate}\`
- **Recommendation Status**: \`${report.recommendationStatus}\`
- **Recommendation**: ${report.recommendation}

## Configuration

- Replay Path: ${report.config.replayPath}
- Slack Acceptance: ${report.config.slackAcceptanceEnabled ? "enabled" : "disabled"}
- Calibration Gate: ${report.config.calibrationEnabled ? "enabled" : "disabled"}

## Steps

### Nightly Report
- Status: ${report.steps.nightly.status}
- Reason: ${report.steps.nightly.reason}
- Artifacts: ${formatArtifacts(report.steps.nightly)}

### Slack Acceptance
- Status: ${report.steps.slackAcceptance.status}
- Reason: ${report.steps.slackAcceptance.reason}
- Artifacts: ${formatArtifacts(report.steps.slackAcceptance)}

### Calibration Gate
- Status: ${report.steps.calibration.status}
- Reason: ${report.steps.calibration.reason}
- Artifacts: ${formatArtifacts(report.steps.calibration)}
`;
}

function formatArtifacts(step: EvalStepResult<unknown>): string {
  const json = step.artifactPaths?.json;
  const markdown = step.artifactPaths?.markdown;
  if (json === undefined && markdown === undefined) {
    return "N/A";
  }

  return `json: ${json ?? "N/A"} / markdown: ${markdown ?? "N/A"}`;
}

export function renderNightlyEvalSlackSummary(report: NightlyEvalAggregateReport, reportPath?: string): string {
  const lines = [
    `🧪 OctoClaw Nightly Eval ${formatGeneratedAt(report.generatedAt)}`,
    `Overall: ${formatGate(report.overallGate)}`,
    `Replay: ${report.steps.nightly.status} — ${truncateReason(report.steps.nightly.reason)}`,
    `Slack acceptance: ${report.steps.slackAcceptance.status} — ${truncateReason(report.steps.slackAcceptance.reason)}`,
    `Calibration: ${report.steps.calibration.status} — ${truncateReason(report.steps.calibration.reason)}`,
    `Recommendation: ${truncateReason(report.recommendation)}`,
  ];

  const highlights = collectHighlights(report);
  if (highlights.length > 0) {
    lines.push("", "Highlights:", ...highlights.map((item) => `- ${item}`));
  }

  if (reportPath) {
    lines.push("", `Report: ${reportPath}`);
  }

  return lines.join("\n");
}

function formatGeneratedAt(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, "Z");
}

function formatGate(value: string): string {
  if (value === "pass") return "✅ pass";
  if (value === "fail") return "❌ fail";
  return `⚠️ ${value}`;
}

function truncateReason(value: string | undefined): string {
  const text = (value || "n/a").replace(/\s+/gu, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function collectHighlights(report: NightlyEvalAggregateReport): string[] {
  const highlights: string[] = [];
  const nightlyReport = report.steps.nightly.report;
  if (nightlyReport) {
    for (const lane of nightlyReport.lanes.slice(0, 5)) {
      const status = "status" in lane ? String(lane.status) : "";
      if (status && status !== "pass") {
        highlights.push(`${lane.lane}: ${status}`);
      }
    }
  }
  const slackReport = report.steps.slackAcceptance.report;
  if (slackReport && slackReport.fail + slackReport.unknown > 0) {
    highlights.push(`slack acceptance: pass=${slackReport.pass} fail=${slackReport.fail} unknown=${slackReport.unknown}`);
  }
  return highlights.slice(0, 6);
}
