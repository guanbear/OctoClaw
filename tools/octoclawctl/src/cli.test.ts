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
