import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHealthEventSink, readHealthEventsFromJsonl } from "../sink.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-health-sink-"));
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("createHealthEventSink", () => {
  it("appends sanitized events and skips corrupt jsonl lines", async () => {
    const jsonlPath = path.join(tempDir, "model-health.jsonl");
    const sink = createHealthEventSink({ jsonlPath, now: () => 1000 });

    sink.recordCall({
      modelKey: "cliproxyapi/gpt-5.5",
      source: "runtime",
      success: true,
      latencyMs: 42,
      evidence: { sessionKey: "s-1" },
    });
    await sink.flush();
    await fs.appendFile(jsonlPath, "not-json\n", "utf8");

    const events = await readHealthEventsFromJsonl(jsonlPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: "octoclaw.router.health_event/v1",
      ts: 1000,
      modelKey: "cliproxyapi/gpt-5.5",
      success: true,
      latencyMs: 42,
      evidence: { sessionKey: "s-1" },
    });
  });

  it("does not throw when the jsonl path is not writable", () => {
    const sink = createHealthEventSink({ jsonlPath: path.join(tempDir, "missing", "file.jsonl") });

    expect(() => sink.recordCall({ modelKey: "a/b", source: "probe", success: false })).not.toThrow();
  });

  it("prunes events outside retention while aggregating", async () => {
    const jsonlPath = path.join(tempDir, "model-health.jsonl");
    const snapshotPath = path.join(tempDir, "model-health-snapshot.json");
    const now = 10 * 24 * 60 * 60_000;
    const sink = createHealthEventSink({ jsonlPath, snapshotPath, now: () => now, retentionMs: 7 * 24 * 60 * 60_000 });

    sink.recordCall({ ts: now - 8 * 24 * 60 * 60_000, modelKey: "old/model", source: "runtime", success: true });
    sink.recordCall({ ts: now - 1000, modelKey: "new/model", source: "runtime", success: true, latencyMs: 10 });
    const snapshot = await sink.aggregate(now);

    expect(snapshot.models["old/model"]).toBeUndefined();
    expect(snapshot.models["new/model"]).toMatchObject({ sampleCount: 1, p50LatencyMs: 10 });
    const remaining = await readHealthEventsFromJsonl(jsonlPath);
    expect(remaining.map((event) => event.modelKey)).toEqual(["new/model"]);
  });
});
