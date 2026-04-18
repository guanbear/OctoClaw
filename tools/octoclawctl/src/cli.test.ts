import { describe, expect, it } from "vitest";
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
});
