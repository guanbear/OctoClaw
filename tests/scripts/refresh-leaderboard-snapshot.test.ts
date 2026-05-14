// @ts-ignore Node types are intentionally not installed in this workspace.
import { execFile } from "node:child_process";
// @ts-ignore Node types are intentionally not installed in this workspace.
import fs from "node:fs/promises";
// @ts-ignore Node types are intentionally not installed in this workspace.
import os from "node:os";
// @ts-ignore Node types are intentionally not installed in this workspace.
import path from "node:path";
// @ts-ignore Node types are intentionally not installed in this workspace.
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("refresh-leaderboard-snapshot script", () => {
  it("generates a leaderboard snapshot from injected external sources", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs"], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SNAPSHOT_OUT: output,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: {
              data: [{
                id: "openai/gpt-5-mini",
                pricing: { prompt: "0.000001", completion: "0.000004" },
              }, {
                id: "z-ai/glm-4.7",
                pricing: { prompt: "0.000002", completion: "0.000006" },
              }],
            },
            pinchbench: {
              leaderboard: [{
                model: "openai/gpt-5-mini",
                best_score_percentage: 0.64,
                submission_count: 12,
              }, {
                model: "z-ai/glm-4.7",
                best_score_percentage: 0.71,
                submission_count: 6,
              }],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      expect(snapshot.schemaVersion).toBe("1.0");
      expect(snapshot.sources).toEqual(expect.arrayContaining(["openrouter", "pinchbench"]));
      expect(snapshot.models["openai/gpt-5-mini"]).toMatchObject({
        tier: "mini",
        price: 1.75,
        scores: {
          coding_worker: { score: 64, confidence: "high" },
        },
      });
      expect(snapshot.models["zhipu/glm-4.7"]).toMatchObject({
        tier: "strong",
        price: 3,
        scores: {
          coding_worker: { score: 71, confidence: "medium" },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
