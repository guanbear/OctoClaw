import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import {
  main,
  parseCliArgs,
  resolveRuntimeStateSurfaceRecord,
  runOctoClawCtl,
} from "./cli.js";

function createRuntimeEnv(): Record<string, string> {
  return {
    OCTOCLAW_TASK_ID: "task-123",
    OCTOCLAW_FLOW_ID: "flow-456",
    OCTOCLAW_SUBSTRATE_STATE: "running",
    OCTOCLAW_SUBSTRATE_REVISION: "7",
    OCTOCLAW_CLAIM_OWNER: "worker-alpha",
    OCTOCLAW_WORKSPACE_MODE: "isolated_worktree",
    OCTOCLAW_WRITE_SCOPE_SUMMARY: "repo:src",
    OCTOCLAW_PROJECTION_STATUS: "projection-stale",
  };
}

function createRecord(): RuntimeStateSurfaceRecord {
  const record = resolveRuntimeStateSurfaceRecord(createRuntimeEnv());
  if (!record) {
    throw new Error("expected runtime record");
  }

  return record;
}

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => {
        stdout.push(message);
      },
      stderr: (message: string) => {
        stderr.push(message);
      },
    },
  };
}

describe("octoclawctl cli", () => {
  it("parses supported actions", () => {
    expect(parseCliArgs(["status"]).command).toBe("status");
    expect(parseCliArgs(["details"]).command).toBe("details");
    expect(parseCliArgs(["queue"]).command).toBe("queue");
    expect(parseCliArgs(["timeline"]).command).toBe("timeline");
  });

  it("valid actions produce output", async () => {
    for (const action of ["status", "details", "queue", "timeline"] as const) {
      const capture = createIo();
      const exitCode = await main([action], createRuntimeEnv(), capture.io);

      expect(exitCode).toBe(0);
      expect(capture.stdout[0]).toContain(action === "timeline" ? "Timeline:" : `${action[0].toUpperCase()}${action.slice(1)}:`);
      expect(capture.stderr).toEqual([]);
    }
  });

  it("unknown action returns error", async () => {
    const capture = createIo();
    const exitCode = await main(["bogus"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("Unknown action: bogus");
  });

  it("help prints usage", async () => {
    const capture = createIo();
    const exitCode = await main(["--help"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Usage: octoclawctl");
  });

  it("format json produces JSON output", async () => {
    const capture = createIo();
    const exitCode = await main(["status", "--format", "json"], createRuntimeEnv(), capture.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout[0] ?? "")).toMatchObject({
      kind: "status_card",
      title: "task-123",
      state: "running",
    });
  });

  it("runOctoClawCtl library function still works", () => {
    const output = runOctoClawCtl("status", createRecord(), "text");

    expect(output).toContain("Status: task-123");
  });

  it("prints fallback message when no runtime data is available", async () => {
    const capture = createIo();
    const exitCode = await main(["status"], {}, capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.length).toBeGreaterThan(0);
  });

  it("parses nightly command with required args", () => {
    const parsed = parseCliArgs(["nightly", "--input", "/tmp/replay.jsonl", "--output-dir", "/tmp/reports"]);
    expect(parsed.command).toBe("nightly");
    expect(parsed.input).toBe("/tmp/replay.jsonl");
    expect(parsed.outputDir).toBe("/tmp/reports");
    expect(parsed.nightlyFormat).toBe("markdown");
  });

  it("parses nightly command with --format json", () => {
    const parsed = parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "json"]);
    expect(parsed.command).toBe("nightly");
    expect(parsed.nightlyFormat).toBe("json");
  });

  it("nightly requires --input", () => {
    expect(() => parseCliArgs(["nightly", "--output-dir", "/tmp"])).toThrow("--input");
  });

  it("nightly requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl"])).toThrow("--output-dir");
  });

  it("nightly accepts --format markdown explicitly", () => {
    const parsed = parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "markdown"]);
    expect(parsed.nightlyFormat).toBe("markdown");
  });

  it("nightly rejects --format compact", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "compact"])).toThrow("Unknown format: compact");
  });

  it("nightly rejects --format table", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "table"])).toThrow("Unknown format: table");
  });

  it("nightly rejects --format lanes", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "lanes"])).toThrow("Unknown format: lanes");
  });

  it("nightly rejects --format anchors", () => {
    expect(() => parseCliArgs(["nightly", "--input", "in.jsonl", "--output-dir", "out/", "--format", "anchors"])).toThrow("Unknown format: anchors");
  });

  it("non-nightly commands still accept --format compact", () => {
    const parsed = parseCliArgs(["status", "--format", "compact"]);
    expect(parsed.format).toBe("compact");
  });

  it("non-nightly commands still accept --format json", () => {
    const parsed = parseCliArgs(["status", "--format", "json"]);
    expect(parsed.format).toBe("json");
  });

  it("non-nightly commands reject --format markdown", () => {
    expect(() => parseCliArgs(["status", "--format", "markdown"])).toThrow("Unknown format: markdown");
  });

  it("parses slack-acceptance command with required args", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "acceptance.json", "--output-dir", "/tmp/reports"]);
    expect(parsed.command).toBe("slack-acceptance");
    expect(parsed.config).toBe("acceptance.json");
    expect(parsed.outputDir).toBe("/tmp/reports");
    expect(parsed.slackAcceptanceFormat).toBe("markdown");
  });

  it("slack-acceptance accepts --format json", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "json"]);
    expect(parsed.slackAcceptanceFormat).toBe("json");
  });

  it("slack-acceptance accepts --format markdown", () => {
    const parsed = parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "markdown"]);
    expect(parsed.slackAcceptanceFormat).toBe("markdown");
  });

  it("slack-acceptance rejects --format compact", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--config", "cfg.json", "--output-dir", "out/", "--format", "compact"])).toThrow("Unknown format: compact");
  });

  it("slack-acceptance requires --config", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--output-dir", "/tmp"])).toThrow("--config");
  });

  it("slack-acceptance requires --output-dir", () => {
    expect(() => parseCliArgs(["slack-acceptance", "--config", "cfg.json"])).toThrow("--output-dir");
  });
});

describe("calibration-gate CLI parsing", () => {
  it("parses calibration-gate with all required args", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out"]);
    expect(result.command).toBe("calibration-gate");
    expect(result.baseline).toBe("b.json");
    expect(result.candidate).toBe("c.json");
    expect(result.outputDir).toBe("/tmp/out");
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("parses calibration-gate with --format json", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "json"]);
    expect(result.calibrationFormat).toBe("json");
  });

  it("parses calibration-gate with --format markdown", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "markdown"]);
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("rejects --format compact for calibration-gate", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json", "--output-dir", "/tmp/out", "--format", "compact"]))
      .toThrow("Unknown format: compact");
  });

  it("requires --baseline", () => {
    expect(() => parseCliArgs(["calibration-gate", "--candidate", "c.json", "--output-dir", "/tmp/out"]))
      .toThrow("calibration-gate command requires --baseline");
  });

  it("requires --candidate", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--output-dir", "/tmp/out"]))
      .toThrow("calibration-gate command requires --candidate");
  });

  it("requires --output-dir", () => {
    expect(() => parseCliArgs(["calibration-gate", "--baseline", "b.json", "--candidate", "c.json"]))
      .toThrow("calibration-gate command requires --output-dir");
  });

  it("supports --baseline= and --candidate= equals syntax", () => {
    const result = parseCliArgs(["calibration-gate", "--baseline=b.json", "--candidate=c.json", "--output-dir=/tmp/out"]);
    expect(result.baseline).toBe("b.json");
    expect(result.candidate).toBe("c.json");
  });
});

describe("nightly-eval CLI parsing", () => {
  it("parses nightly-eval run with all required args", () => {
    const result = parseCliArgs(["nightly-eval", "run", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.command).toBe("nightly-eval");
    expect(result.nightlyEvalSubcommand).toBe("run");
    expect(result.config).toBe("eval.json");
    expect(result.outputDir).toBe("/tmp/out");
    expect(result.calibrationFormat).toBe("markdown");
  });

  it("parses nightly-eval run with --format json", () => {
    const result = parseCliArgs(["nightly-eval", "run", "--config", "eval.json", "--output-dir", "/tmp/out", "--format", "json"]);
    expect(result.nightlyEvalSubcommand).toBe("run");
    expect(result.calibrationFormat).toBe("json");
  });

  it("parses nightly-eval install-launchagent with --schedule-hour", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour", "3"]);
    expect(result.nightlyEvalSubcommand).toBe("install-launchagent");
    expect(result.scheduleHour).toBe(3);
  });

  it("parses nightly-eval install-launchagent with --log-dir", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--log-dir", "/tmp/logs"]);
    expect(result.nightlyEvalSubcommand).toBe("install-launchagent");
    expect(result.logDir).toBe("/tmp/logs");
  });

  it("parses nightly-eval uninstall-launchagent", () => {
    const result = parseCliArgs(["nightly-eval", "uninstall-launchagent"]);
    expect(result.command).toBe("nightly-eval");
    expect(result.nightlyEvalSubcommand).toBe("uninstall-launchagent");
  });

  it("parses nightly-eval print-plist", () => {
    const result = parseCliArgs(["nightly-eval", "print-plist", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.nightlyEvalSubcommand).toBe("print-plist");
    expect(result.config).toBe("eval.json");
    expect(result.outputDir).toBe("/tmp/out");
  });

  it("parses nightly-eval deliver-slack", () => {
    const result = parseCliArgs(["nightly-eval", "deliver-slack", "--config", "slack.json", "--output-dir", "/tmp/reports"]);
    expect(result.nightlyEvalSubcommand).toBe("deliver-slack");
    expect(result.config).toBe("slack.json");
    expect(result.outputDir).toBe("/tmp/reports");
  });

  it("requires subcommand", () => {
    expect(() => parseCliArgs(["nightly-eval"]))
      .toThrow("nightly-eval requires a subcommand");
  });

  it("rejects invalid subcommand", () => {
    expect(() => parseCliArgs(["nightly-eval", "bad"]))
      .toThrow("Unknown nightly-eval subcommand");
  });

  it("run requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "run", "--output-dir", "/tmp/out"]))
      .toThrow("nightly-eval run requires --config");
  });

  it("deliver-slack requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "deliver-slack", "--output-dir", "/tmp/reports"]))
      .toThrow("nightly-eval deliver-slack requires --config");
  });

  it("deliver-slack requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "deliver-slack", "--config", "slack.json"]))
      .toThrow("nightly-eval deliver-slack requires --output-dir");
  });

  it("run requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "run", "--config", "eval.json"]))
      .toThrow("nightly-eval run requires --output-dir");
  });

  it("install-launchagent requires --config", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--output-dir", "/tmp/out"]))
      .toThrow("nightly-eval install-launchagent requires --config");
  });

  it("install-launchagent requires --output-dir", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json"]))
      .toThrow("nightly-eval install-launchagent requires --output-dir");
  });

  it("rejects --schedule-hour out of range", () => {
    expect(() => parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour", "25"]))
      .toThrow("Invalid --schedule-hour");
  });

  it("supports --schedule-hour= equals syntax", () => {
    const result = parseCliArgs(["nightly-eval", "print-plist", "--config", "eval.json", "--output-dir", "/tmp/out", "--schedule-hour=4"]);
    expect(result.scheduleHour).toBe(4);
  });

  it("default schedule hour when not specified", () => {
    const result = parseCliArgs(["nightly-eval", "install-launchagent", "--config", "eval.json", "--output-dir", "/tmp/out"]);
    expect(result.scheduleHour).toBeUndefined();
  });
});



describe("octoclawctl nightly-eval integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), ".octoclawctl-test-tmp");
    tmpDir = path.join(base, `nightly-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates output directory and timestamped aggregate artifacts", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    const configPath = path.join(tmpDir, "nightly-eval.json");
    const outputDirPath = path.join(tmpDir, "nested", "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "reply", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(replayPath, `${JSON.stringify(event)}\n`, "utf8");
    await fs.writeFile(configPath, JSON.stringify({ replayPath }), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly-eval", "run", "--config", configPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Gate:");
    const entries = await fs.readdir(outputDirPath, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(fileNames.some((fileName) => /-nightly-eval\.json$/u.test(fileName))).toBe(true);
    expect(fileNames.some((fileName) => /-nightly-eval\.md$/u.test(fileName))).toBe(true);
    expect(fileNames.some((fileName) => /-nightly\.json$/u.test(fileName))).toBe(true);
  });

  it("fails closed on malformed nightly-eval config", async () => {
    const configPath = path.join(tmpDir, "bad.json");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(configPath, JSON.stringify({ baseline: "only-baseline.json" }), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly-eval", "run", "--config", configPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("Nightly eval: malformed config JSON");
  });
});

describe("octoclawctl nightly integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), ".octoclawctl-test-tmp");
    tmpDir = path.join(base, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads JSONL, writes .json and .md reports, prints paths", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, JSON.stringify(event), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout[0]).toContain("Written:");
    expect(capture.stdout[0]).toContain(".json");
    expect(capture.stdout[0]).toContain(".md");

    const entries = await fs.readdir(outputDirPath, { withFileTypes: true });
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(fileNames.some((f: string) => f.endsWith(".json"))).toBe(true);
    expect(fileNames.some((f: string) => f.endsWith(".md"))).toBe(true);
  });

  it("outputs JSON when --format json", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const event = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, JSON.stringify(event), "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath, "--format", "json"],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(capture.stdout[0]);
    expect(report.reportId).toContain("nightly:");
    expect(report.lanes).toHaveLength(5);
  });

  it("fails on malformed JSONL events", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(inputPath, '{"bad":true}\n', "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("index 0");
  });

  it("fails on malformed JSON line with line number", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const e1 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", confidence: 0.9, routerDecisionValid: true };
    await fs.writeFile(inputPath, `${JSON.stringify(e1)}\n{bad json here\n`, "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("line 2");
  });

  it("fails on malformed JSON at first line", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    await fs.writeFile(inputPath, "not json at all\n", "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr[0]).toContain("line 1");
  });

  it("handles multi-line JSONL input", async () => {
    const inputPath = path.join(tmpDir, "replay.jsonl");
    const outputDirPath = path.join(tmpDir, "reports");
    const e1 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "policy_resolved", at: "2026-04-26T10:00:00.000Z", route: "delegate", routerDecisionValid: true, confidence: 0.9 };
    const e2 = { schema_version: "octoclaw.runtime_policy.replay_event/v1", event: "delivery_observed", at: "2026-04-26T10:01:00.000Z" };
    await fs.writeFile(inputPath, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`, "utf8");

    const capture = createIo();
    const exitCode = await main(
      ["nightly", "--input", inputPath, "--output-dir", outputDirPath],
      {},
      capture.io,
    );

    expect(exitCode).toBe(0);
    const jsonPath = path.join(outputDirPath, "2026-04-26.json");
    const report = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    expect(report.inputEventCount).toBe(2);
  });
});
