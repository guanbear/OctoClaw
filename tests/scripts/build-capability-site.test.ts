// @ts-ignore Node types are intentionally not installed in this workspace.
import { execFile } from "node:child_process";
// @ts-ignore Node types are intentionally not installed in this workspace.
import { createHash } from "node:crypto";
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

describe("build-capability-site script", () => {
  it("publishes snapshot, summary, and manifest files for GitHub Pages", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-capability-site-"));
    const snapshotPath = path.join(tempDir, "leaderboard-snapshot.json");
    const outDir = path.join(tempDir, "public");
    const snapshot = {
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "official-test",
      generatedAt: "2026-05-24T00:00:00.000Z",
      sourceStatus: [
        { source: "artificial_analysis", status: "ok" },
        { source: "lmarena_text", status: "ok" },
      ],
      models: [
        { modelKey: "openai/gpt-5.5", capability: { codingTier: "frontier", capabilityScore: { score: 86.28, confidence: "high", sources: ["artificial_analysis"] } } },
        { modelKey: "google/gemini-3.5-flash", capability: { codingTier: "strong", capabilityScore: { score: 78.5, confidence: "medium", sources: ["lmarena_text"] } } },
        { modelKey: "zhipu/glm-5.1", capability: { codingTier: "strong", capabilityScore: { score: 80, confidence: "medium", sources: ["artificial_analysis"] } }, benchmarkEfficiency: { valueScore: 76, sources: ["pinchbench"] } },
      ],
    };
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    try {
      await execFileAsync("node", [
        "scripts/build-capability-site.mjs",
        "--input",
        snapshotPath,
        "--out-dir",
        outDir,
        "--base-url",
        "https://octoclaw.github.io/OctoClaw",
      ], { cwd: path.resolve(".") });

      const publishedSnapshotText = await fs.readFile(path.join(outDir, "capability", "leaderboard-snapshot.json"), "utf8");
      const manifest = JSON.parse(await fs.readFile(path.join(outDir, "capability", "leaderboard-manifest.json"), "utf8"));
      const summary = JSON.parse(await fs.readFile(path.join(outDir, "capability", "leaderboard-summary.json"), "utf8"));
      const index = await fs.readFile(path.join(outDir, "capability", "index.html"), "utf8");

      expect(JSON.parse(publishedSnapshotText)).toMatchObject({ snapshotId: "official-test" });
      expect(manifest).toMatchObject({
        schemaVersion: "octoclaw.capability_manifest/v1",
        generatedAt: "2026-05-24T00:00:00.000Z",
        snapshotUrl: "https://octoclaw.github.io/OctoClaw/capability/leaderboard-snapshot.json",
        summaryUrl: "https://octoclaw.github.io/OctoClaw/capability/leaderboard-summary.json",
        modelCount: 3,
        minOctoClawVersion: "0.6.0",
      });
      expect(manifest.snapshotSha256).toBe(createHash("sha256").update(publishedSnapshotText).digest("hex"));
      expect(summary).toMatchObject({
        snapshotId: "official-test",
        modelCount: 3,
        sourceStatus: snapshot.sourceStatus,
        topModels: [
          { modelKey: "openai/gpt-5.5", score: 86.28, confidence: "high" },
          { modelKey: "zhipu/glm-5.1", score: 80, confidence: "medium" },
          { modelKey: "google/gemini-3.5-flash", score: 78.5, confidence: "medium" },
        ],
      });
      expect(summary.watchedModels).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelKey: "openai/gpt-5.5", tier: "frontier", sources: ["artificial_analysis"] }),
        expect.objectContaining({ modelKey: "zhipu/glm-5.1", tier: "strong", valueScore: 76 }),
      ]));
      expect(summary.models).toHaveLength(3);
      expect(index).toContain("OctoClaw Capability Snapshot");
      expect(index).toContain("Watched Models");
      expect(index).toContain("leaderboard-manifest.json");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
