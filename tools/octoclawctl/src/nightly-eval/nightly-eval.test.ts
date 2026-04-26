import { describe, expect, it, vi } from "vitest";
import type { NightlyReport } from "../nightly/types.js";
import type { SlackAcceptanceCaseResult, SlackAcceptanceReport } from "../slack-acceptance/types.js";
import type { CalibrationGateReport, GateCheckResult } from "../calibration/types.js";
import type { EvalStepResult, LaunchAgentConfig, NightlyEvalAggregateReport } from "./types.js";
import {
  computeEvalOverallGate,
  computeEvalRecommendationStatus,
  parseNightlyEvalConfig,
  runNightlyEval,
  sanitizeAggregateReport,
} from "./runner.js";
import { generateLaunchAgentPlist, validateScheduleHour } from "./plist.js";
import { renderNightlyEvalMarkdown } from "./report.js";

describe("nightly eval config", () => {
  it("parseNightlyEvalConfig requires replayPath", () => {
    expect(() => parseNightlyEvalConfig({})).toThrow("replayPath is required");
  });

  it("parseNightlyEvalConfig accepts minimal config", () => {
    expect(parseNightlyEvalConfig({ replayPath: "/tmp/replay.jsonl" })).toEqual({ replayPath: "/tmp/replay.jsonl" });
  });

  it("parseNightlyEvalConfig rejects baseline without candidate", () => {
    expect(() => parseNightlyEvalConfig({ replayPath: "/tmp/replay.jsonl", baseline: "nightly" })).toThrow("calibration requires both");
  });

  it("parseNightlyEvalConfig rejects candidate without baseline", () => {
    expect(() => parseNightlyEvalConfig({ replayPath: "/tmp/replay.jsonl", candidate: "nightly" })).toThrow("calibration requires both");
  });

  it("parseNightlyEvalConfig accepts full config", () => {
    const config = parseNightlyEvalConfig({
      replayPath: "/tmp/replay.jsonl",
      slackAcceptanceConfig: "/tmp/slack.json",
      baseline: "/tmp/baseline.json",
      candidate: "/tmp/candidate.json",
    });
    expect(config).toEqual({
      replayPath: "/tmp/replay.jsonl",
      slackAcceptanceConfig: "/tmp/slack.json",
      baseline: "/tmp/baseline.json",
      candidate: "/tmp/candidate.json",
    });
  });
});

describe("nightly eval overall gate", () => {
  it("computeEvalOverallGate: all pass → pass", () => {
    expect(computeEvalOverallGate(makeSteps("pass", "pass", "pass"))).toBe("pass");
  });

  it("computeEvalOverallGate: any fail → fail", () => {
    expect(computeEvalOverallGate(makeSteps("pass", "fail", "pass"))).toBe("fail");
  });

  it("computeEvalOverallGate: any unknown → unknown", () => {
    expect(computeEvalOverallGate(makeSteps("pass", "unknown", "skipped"))).toBe("unknown");
  });

  it("computeEvalOverallGate: all skipped → unknown", () => {
    expect(computeEvalOverallGate(makeSteps("skipped", "skipped", "skipped"))).toBe("unknown");
  });

  it("computeEvalOverallGate: pass + skipped → pass", () => {
    expect(computeEvalOverallGate(makeSteps("pass", "skipped", "skipped"))).toBe("pass");
  });

  it("computeEvalOverallGate: unknown never equals pass", () => {
    expect(computeEvalOverallGate(makeSteps("unknown", "skipped", "skipped"))).not.toBe("pass");
  });
});

describe("nightly eval runner", () => {
  it("runNightlyEval: runs nightly only when no slack/calibration", async () => {
    const nightlyRunner = vi.fn(mockNightlyRunner);
    const slackRunner = vi.fn(mockSlackRunner);
    const calibrationRunner = vi.fn(mockCalibrationRunner);
    const report = await runNightlyEval({
      config: { replayPath: "/tmp/replay.jsonl" },
      outputDir: "/tmp/out",
      env: {},
      nightlyRunner,
      slackRunner,
      calibrationRunner,
      fileWriter: async () => undefined,
    });

    expect(nightlyRunner).toHaveBeenCalledWith("/tmp/replay.jsonl");
    expect(slackRunner).not.toHaveBeenCalled();
    expect(calibrationRunner).not.toHaveBeenCalled();
    expect(report.steps.nightly.status).toBe("pass");
    expect(report.steps.slackAcceptance.status).toBe("skipped");
    expect(report.steps.calibration.status).toBe("skipped");
  });

  it("runNightlyEval: runs all three steps when configured", async () => {
    const nightlyRunner = vi.fn(mockNightlyRunner);
    const slackRunner = vi.fn(mockSlackRunner);
    const calibrationRunner = vi.fn(mockCalibrationRunner);
    const report = await runNightlyEval({
      config: { replayPath: "/tmp/replay.jsonl", slackAcceptanceConfig: "/tmp/slack.json", baseline: "/tmp/baseline.json", candidate: "/tmp/candidate.json" },
      outputDir: "/tmp/out",
      env: { SLACK_BOT_TOKEN: "secret" },
      nightlyRunner,
      slackRunner,
      calibrationRunner,
      fileWriter: async () => undefined,
    });

    expect(nightlyRunner).toHaveBeenCalledTimes(1);
    expect(slackRunner).toHaveBeenCalledWith("/tmp/slack.json", { SLACK_BOT_TOKEN: "secret" });
    expect(calibrationRunner).toHaveBeenCalledWith("/tmp/baseline.json", "/tmp/candidate.json");
    expect(report.steps.calibration.status).toBe("pass");
  });

  it("runNightlyEval: catches step failures gracefully", async () => {
    const report = await runNightlyEval({
      config: { replayPath: "/tmp/replay.jsonl" },
      outputDir: "/tmp/out",
      env: {},
      nightlyRunner: async () => { throw new Error("nightly exploded"); },
      fileWriter: async () => undefined,
    });

    expect(report.steps.nightly.status).toBe("fail");
    expect(report.steps.nightly.reason).toBe("nightly exploded");
    expect(report.overallGate).toBe("fail");
  });

  it("runNightlyEval: skipped steps marked correctly", async () => {
    const report = await runNightlyEval({
      config: { replayPath: "/tmp/replay.jsonl" },
      outputDir: "/tmp/out",
      env: {},
      nightlyRunner: mockNightlyRunner,
      fileWriter: async () => undefined,
    });

    expect(report.steps.slackAcceptance.status).toBe("skipped");
    expect(report.steps.calibration.status).toBe("skipped");
  });

  it("sanitizeAggregateReport strips secrets", () => {
    const report = makeAggregateReport();
    report.steps.nightly.reason = "keep reason";
    report.steps.nightly.report = {
      ...makeNightlyReport(),
      token: "secret-token",
      rawTranscript: "leaked transcript",
      nested: { apiKey: "key", executionLog: "log" },
    } as NightlyReport;
    const sanitized = sanitizeAggregateReport(report) as NightlyEvalAggregateReport;
    const nightly = sanitized.steps.nightly.report as unknown as Record<string, unknown>;
    const nested = nightly.nested as Record<string, unknown>;

    expect(nightly.token).toBe("[REDACTED]");
    expect(nightly.rawTranscript).toBe("[STRIPPED]");
    expect(nested.apiKey).toBe("[REDACTED]");
    expect(nested.executionLog).toBe("[STRIPPED]");
  });

  it("aggregate report has correct artifact dir", async () => {
    const report = await runNightlyEval({
      config: { replayPath: "/tmp/replay.jsonl" },
      outputDir: "/tmp/artifacts",
      env: {},
      nightlyRunner: mockNightlyRunner,
      fileWriter: async () => undefined,
    });

    expect(report.artifactDir).toBe("/tmp/artifacts");
  });
});

describe("launch agent plist", () => {
  it("generateLaunchAgentPlist produces valid plist XML", () => {
    const plist = generateLaunchAgentPlist(makeLaunchAgentConfig());
    expect(plist).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(plist).toContain("<plist version=\"1.0\">");
    expect(plist).toContain("ai.octoclaw.nightly-eval");
    expect(plist).toContain("/usr/local/bin/octoclawctl");
    expect(plist).toContain("StartCalendarInterval");
    expect(plist).toContain("/tmp/logs/nightly-eval-stdout.log");
    expect(plist).toContain("/tmp/logs/nightly-eval-stderr.log");
  });

  it("generateLaunchAgentPlist uses correct schedule hour", () => {
    const plist = generateLaunchAgentPlist(makeLaunchAgentConfig({ scheduleHour: 7 }));
    expect(plist).toContain("<key>Hour</key>\n    <integer>7</integer>");
  });

  it("generateLaunchAgentPlist arguments include config and output-dir", () => {
    const plist = generateLaunchAgentPlist(makeLaunchAgentConfig());
    expect(plist).toContain("<string>nightly-eval</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain("<string>/tmp/nightly-eval.json</string>");
    expect(plist).toContain("<string>--output-dir</string>");
    expect(plist).toContain("<string>/tmp/out</string>");
  });

  it("validateScheduleHour rejects invalid hours", () => {
    expect(() => validateScheduleHour(-1)).toThrow();
    expect(() => validateScheduleHour(24)).toThrow();
    expect(() => validateScheduleHour(1.5)).toThrow();
  });

  it("validateScheduleHour accepts 0-23", () => {
    for (let hour = 0; hour <= 23; hour += 1) {
      expect(() => validateScheduleHour(hour)).not.toThrow();
    }
  });
});

describe("markdown and recommendations", () => {
  it("markdown report contains all sections", () => {
    const markdown = renderNightlyEvalMarkdown(makeAggregateReport());
    expect(markdown).toContain("# Nightly Evaluation Report");
    expect(markdown).toContain("## Configuration");
    expect(markdown).toContain("## Steps");
    expect(markdown).toContain("### Nightly Report");
    expect(markdown).toContain("### Slack Acceptance");
    expect(markdown).toContain("### Calibration Gate");
  });

  it("recommendationStatus matches overall gate", () => {
    expect(computeEvalRecommendationStatus("pass")).toBe("recommend_only");
    expect(computeEvalRecommendationStatus("fail")).toBe("blocked");
    expect(computeEvalRecommendationStatus("unknown")).toBe("unknown");
  });
});

function makeSteps(
  nightly: EvalStepResult<unknown>["status"],
  slackAcceptance: EvalStepResult<unknown>["status"],
  calibration: EvalStepResult<unknown>["status"],
): { nightly: EvalStepResult<unknown>; slackAcceptance: EvalStepResult<unknown>; calibration: EvalStepResult<unknown> } {
  return {
    nightly: { step: "nightly", status: nightly, reason: nightly },
    slackAcceptance: { step: "slackAcceptance", status: slackAcceptance, reason: slackAcceptance },
    calibration: { step: "calibration", status: calibration, reason: calibration },
  };
}

async function mockNightlyRunner(): Promise<NightlyReport> {
  return makeNightlyReport();
}

async function mockSlackRunner(): Promise<SlackAcceptanceReport> {
  return makeSlackAcceptanceReport();
}

async function mockCalibrationRunner(): Promise<CalibrationGateReport> {
  return makeCalibrationReport();
}

function makeNightlyReport(overallGate: GateCheckResult = "pass"): NightlyReport {
  return {
    reportId: "nightly-test",
    generatedAt: "2026-04-26T00:00:00.000Z",
    inputEventCount: 1,
    inputDateRange: { earliest: "2026-04-26T00:00:00.000Z", latest: "2026-04-26T00:01:00.000Z" },
    lanes: [],
    overallGate,
    recommendationStatus: overallGate === "pass" ? "recommend_only" : overallGate === "fail" ? "blocked" : "unknown",
    recommendation: "nightly recommendation",
    rollbackTarget: null,
  };
}

function makeSlackAcceptanceReport(overallGate: GateCheckResult = "pass"): SlackAcceptanceReport {
  const acceptanceCase: SlackAcceptanceCaseResult = {
    id: "plain_chat",
    kind: "plain_chat",
    prompt: "hello",
    status: overallGate,
    sentAt: "2026-04-26T00:00:00.000Z",
    threadTs: "123.456",
    ackMs: 1,
    finalMs: 2,
    ack: { status: overallGate, reason: "ack" },
    final: { status: overallGate, reason: "final" },
    noSpawn: { status: overallGate, reason: "no spawn" },
    transcript: [],
    errors: [],
  };

  return {
    schemaVersion: "octoclaw.slack_acceptance.report/v1",
    reportId: "slack-test",
    generatedAt: "2026-04-26T00:00:00.000Z",
    sessionKey: "slack:channel:C123",
    target: { channel: "C123" },
    overallGate,
    total: 1,
    pass: overallGate === "pass" ? 1 : 0,
    fail: overallGate === "fail" ? 1 : 0,
    unknown: overallGate === "unknown" ? 1 : 0,
    skipped: 0,
    toolExposureAudit: { status: overallGate, exposedTools: [], blockedTools: [] },
    cases: [acceptanceCase],
  };
}

function makeCalibrationReport(overallGate: GateCheckResult = "pass"): CalibrationGateReport {
  const dimension = { status: overallGate, reason: "ok" };
  return {
    schemaVersion: "octoclaw.calibration.report/v1",
    reportId: "calibration-test",
    generatedAt: "2026-04-26T00:00:00.000Z",
    baseline: { source: "baseline", nightlyReportId: "nightly-test" },
    candidate: { source: "candidate", slackReportId: "slack-test" },
    dimensions: {
      latency: dimension,
      cost: dimension,
      acceptance: dimension,
      noLie: dimension,
      contextPollution: dimension,
      fallbackTimeout: dimension,
    },
    overallGate,
    recommendationStatus: overallGate === "pass" ? "recommend_only" : overallGate === "fail" ? "blocked" : "unknown",
    recommendation: "calibration recommendation",
    rollbackTarget: null,
  };
}

function makeAggregateReport(): NightlyEvalAggregateReport {
  return {
    schemaVersion: "octoclaw.nightly_eval.report/v1",
    reportId: "nightly-eval:test",
    generatedAt: "2026-04-26T00:00:00.000Z",
    config: { replayPath: "/tmp/replay.jsonl", slackAcceptanceEnabled: true, calibrationEnabled: true },
    steps: {
      nightly: { step: "nightly", status: "pass", reason: "ok", report: makeNightlyReport(), artifactPaths: { json: "/tmp/nightly.json", markdown: "/tmp/nightly.md" } },
      slackAcceptance: { step: "slackAcceptance", status: "pass", reason: "ok", report: makeSlackAcceptanceReport(), artifactPaths: { json: "/tmp/slack.json", markdown: "/tmp/slack.md" } },
      calibration: { step: "calibration", status: "pass", reason: "ok", report: makeCalibrationReport(), artifactPaths: { json: "/tmp/calibration.json", markdown: "/tmp/calibration.md" } },
    },
    overallGate: "pass",
    recommendationStatus: "recommend_only",
    recommendation: "All evaluation steps passed; keep recommend-only status.",
    artifactDir: "/tmp/out",
  };
}

function makeLaunchAgentConfig(overrides: Partial<LaunchAgentConfig> = {}): LaunchAgentConfig {
  return {
    label: "ai.octoclaw.nightly-eval",
    programPath: "/usr/local/bin/octoclawctl",
    configPath: "/tmp/nightly-eval.json",
    outputDir: "/tmp/out",
    scheduleHour: 2,
    logDir: "/tmp/logs",
    ...overrides,
  };
}
