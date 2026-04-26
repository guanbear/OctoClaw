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
