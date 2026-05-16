import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHealthEventsFromJsonl } from "@octoclaw/router";
import { buildRuntimeHealthEvent, recordRuntimeHealthCall } from "./health-recorder.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-runtime-health-"));
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("buildRuntimeHealthEvent", () => {
  it("extracts model, latency, and failure signals without prompt or response bodies", () => {
    const event = buildRuntimeHealthEvent({
      event: {
        error: "child failed with full response body",
        durationMs: 1234,
        prompt: "do not persist",
        response: "do not persist",
      },
      ctx: { sessionId: "session-1", turnId: "turn-1" },
      stateKey: "state-1",
      state: {
        decision: { model_policy: { selected_model: "zai/glm-4.7" } },
      },
      toolCallFailed: true,
    });

    expect(event).toMatchObject({
      modelKey: "zai/glm-4.7",
      source: "runtime",
      success: false,
      latencyMs: 1234,
      errorCode: "RUNTIME_ERROR",
      toolCallFailed: true,
      evidence: { sessionKey: "state-1", turnId: "turn-1" },
    });
    expect(JSON.stringify(event)).not.toContain("do not persist");
  });
});

describe("recordRuntimeHealthCall", () => {
  it("writes runtime events to the shared health jsonl sink", async () => {
    const result = recordRuntimeHealthCall({
      openclawHome: tempDir,
      event: { model: "cliproxyapi/gpt-5.5", durationMs: 88 },
      ctx: { sessionKey: "session-1" },
      state: {},
    });
    await result.flush?.();

    const events = await readHealthEventsFromJsonl(path.join(tempDir, "octoclaw", "router-lite", "model-health.jsonl"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      modelKey: "cliproxyapi/gpt-5.5",
      source: "runtime",
      success: true,
      latencyMs: 88,
    });
  });

  it("never throws when no model can be resolved", () => {
    expect(() => recordRuntimeHealthCall({ openclawHome: tempDir, event: {}, ctx: {}, state: {} })).not.toThrow();
  });
});
