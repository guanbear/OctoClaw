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
            aider: JSON.stringify({
              leaderboard: [{
                model: "openai/gpt-5-mini",
                pass_rate_2: 0.72,
                exercises: 20,
                date: new Date().toISOString(),
              }],
            }),
            bfcl: {
              unexpected: true,
            },
            sweBenchVerified: [{
              modelId: "OpenAI/GPT-5-mini",
              value: 80,
              total_count: 500,
              last_updated: new Date().toISOString(),
            }],
            sweBenchPro: [{
              modelId: "openai/gpt-5-mini",
              value: 70,
              total_count: 100,
              last_updated: new Date().toISOString(),
            }],
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      expect(snapshot.schemaVersion).toBe("1.0");
      expect(snapshot.sources).toEqual(expect.arrayContaining(["openrouter", "pinchbench"]));
      expect(snapshot.sourceStatus.openrouter).toMatchObject({
        ok: true,
        health: 1,
        class: "catalog_metadata",
      });
      expect(snapshot.sourceStatus.aider).toMatchObject({
        ok: true,
        rows: 1,
        health: 1,
        class: "capability_benchmark",
      });
      expect(snapshot.sourceStatus.bfcl).toMatchObject({
        ok: false,
        rows: 0,
        health: 0,
        reason: "schema_mismatch_or_empty",
      });
      expect(snapshot.sourceStatus.swe_bench_verified).toMatchObject({
        ok: true,
        rows: 1,
        health: 1,
        class: "capability_benchmark",
      });
      expect(snapshot.sourceStatus.swe_bench_pro).toMatchObject({
        ok: true,
        rows: 1,
        health: 1,
        class: "capability_benchmark",
      });
      expect(snapshot.models["openai/gpt-5-mini"]).toMatchObject({
        tier: "mini",
        price: 1.75,
        scores: {
          coding_worker: { score: 64, confidence: "high" },
        },
        capabilityScore: {
          confidence: "high",
          sources: ["aider", "pinchbench", "swe_bench_pro", "swe_bench_verified"],
          evidenceCount: 4,
        },
      });
      expect(snapshot.models["openai/gpt-5-mini"].capabilityScore.sources).not.toContain("openrouter");
      expect(snapshot.models["openai/gpt-5-mini"].scoreByScenario.coding_worker.contributions).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "swe_bench_verified", rawScore: 80 }),
        expect.objectContaining({ source: "swe_bench_pro", rawScore: 70 }),
      ]));
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

  it("keeps compact and older sibling evidence from outranking stronger same-family variants", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            sweBenchVerified: [
              { modelId: "deepseek-ai/DeepSeek-V4-Pro", value: 80 },
              { modelId: "deepseek-ai/DeepSeek-V4-Flash", value: 90 },
              { modelId: "zai-org/GLM-5.1", value: 88 },
              { modelId: "zai-org/GLM-5", value: 95 },
              { modelId: "MiniMaxAI/MiniMax-M2.7", value: 70 },
              { modelId: "MiniMaxAI/MiniMax-M2.5", value: 90 },
            ],
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const pro = snapshot.models["deepseek/deepseek-v4-pro"].capabilityScore.score;
      const flash = snapshot.models["deepseek/deepseek-v4-flash"].capabilityScore;
      const glm51 = snapshot.models["zhipu/glm-5.1"].capabilityScore.score;
      const glm5 = snapshot.models["zhipu/glm-5"].capabilityScore;
      const m27 = snapshot.models["minimax/minimax-m2.7"].capabilityScore.score;
      const m25 = snapshot.models["minimax/minimax-m2.5"].capabilityScore;

      expect(flash.score).toBeLessThan(pro);
      expect(flash.reasonCodes).toContain("higher_role_ceiling:deepseek/deepseek-v4-pro");
      expect(glm5.score).toBeLessThan(glm51);
      expect(glm5.reasonCodes).toContain("newer_version_ceiling:zhipu/glm-5.1");
      expect(m25.score).toBeLessThan(m27);
      expect(m25.reasonCodes).toContain("newer_version_ceiling:minimax/minimax-m2.7");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses source families so SWE-bench variants alone do not create cross-source high confidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            sweBenchVerified: [{ modelId: "moonshotai/Kimi-K2.6", value: 80 }],
            sweBenchPro: [{ modelId: "moonshotai/Kimi-K2.6", value: 58 }],
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const kimi = snapshot.models["moonshotai/kimi-k2.6"].capabilityScore;

      expect(kimi.sources).toEqual(["swe_bench_pro", "swe_bench_verified"]);
      expect(kimi.evidenceCount).toBe(2);
      expect(kimi.evidenceFamilyCount).toBe(1);
      expect(kimi.confidence).toBe("medium");
      expect(kimi.reasonCodes).toContain("fusion_source_families:1");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses LM Arena latest rows as research evidence without requiring parquet dependencies", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            lmarenaText: {
              rows: [
                { row: { model_name: "claude-opus-4-7-thinking", organization: "anthropic", rating: 1500, vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "kimi-k2.6", organization: "moonshotai", rating: 1450, vote_count: 900, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "minimax-m2.7", organization: "minimax", rating: 1400, vote_count: 700, leaderboard_publish_date: "2026-05-21" } },
              ],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));

      expect(snapshot.sourceStatus.lmarena_text).toMatchObject({
        ok: true,
        rows: 3,
        health: 1,
      });
      expect(snapshot.models["anthropic/claude-opus-4.7"].scoreByScenario.research.contributions).toContainEqual(expect.objectContaining({
        source: "lmarena_text",
      }));
      expect(snapshot.models["moonshotai/kimi-k2.6"].capabilityScore.sources).toContain("lmarena_text");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses only LM Arena overall rows for global evidence and deduplicates one source vote per model", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            lmarenaText: {
              rows: [
                { row: { model_name: "gpt-5.5", organization: "openai", rating: 1400, rank: 10, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "gpt-5.5", organization: "openai", rating: 1700, rank: 1, category: "creative_writing", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "claude-opus-4-7", organization: "anthropic", rating: 1500, rank: 1, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
              ],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const gptResearch = snapshot.models["openai/gpt-5.5"].scoreByScenario.research;

      expect(snapshot.sourceStatus.lmarena_text).toMatchObject({
        ok: true,
        rows: 2,
      });
      expect(gptResearch.contributions.filter((entry: { source: string }) => entry.source === "lmarena_text")).toHaveLength(1);
      expect(gptResearch.contributions).toContainEqual(expect.objectContaining({
        source: "lmarena_text",
        sourceRows: 2,
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps task-specific LM Arena variants from lifting an older base model above a newer sibling", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            lmarenaText: {
              rows: [
                { row: { model_name: "claude-opus-4-6-thinking", organization: "anthropic", rating: 1700, rank: 1, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "claude-opus-4-7", organization: "anthropic", rating: 1500, rank: 2, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "gpt-5.5", organization: "openai", rating: 1450, rank: 3, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
              ],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const opus46 = snapshot.models["anthropic/claude-opus-4.6"].capabilityScore;
      const opus47 = snapshot.models["anthropic/claude-opus-4.7"].capabilityScore;

      expect(opus46.score).toBeLessThan(opus47.score);
      expect(opus46.reasonCodes).toContain("variant_auxiliary_evidence:lmarena_text");
      expect(opus46.reasonCodes).toContain("newer_version_ceiling:anthropic/claude-opus-4.7");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let coding-only evidence dominate global capability over broad evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            lmarenaText: {
              rows: [
                { row: { model_name: "gpt-5.5", organization: "openai", rating: 1600, rank: 1, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "kimi-k2.6", organization: "moonshotai", rating: 1300, rank: 2, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
              ],
            },
            sweBenchVerified: [
              { modelId: "openai/GPT-5.5", value: 72 },
              { modelId: "moonshotai/Kimi-K2.6", value: 98 },
            ],
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const gpt = snapshot.models["openai/gpt-5.5"].capabilityScore;
      const kimi = snapshot.models["moonshotai/kimi-k2.6"].capabilityScore;

      expect(gpt.score).toBeGreaterThan(kimi.score);
      expect(gpt.reasonCodes).toContain("global_missing_scenario_prior:agentic");
      expect(kimi.reasonCodes).toContain("global_missing_scenario_prior:agentic");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps compact coding-heavy variants below broad stronger non-compact models on global score", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            lmarenaText: {
              rows: [
                { row: { model_name: "frontier-reference", organization: "example", rating: 1600, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "gpt-5.4", organization: "openai", rating: 1300, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "deepseek-v4-flash", organization: "deepseek", rating: 1200, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "filler-a", organization: "example", rating: 1100, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
                { row: { model_name: "filler-b", organization: "example", rating: 1000, category: "overall", vote_count: 1000, leaderboard_publish_date: "2026-05-21" } },
              ],
            },
            sweBenchVerified: [
              { modelId: "openai/GPT-5.4", value: 76 },
              { modelId: "deepseek-ai/DeepSeek-V4-Flash", value: 96 },
            ],
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const gpt = snapshot.models["openai/gpt-5.4"];
      const flash = snapshot.models["deepseek/deepseek-v4-flash"];

      expect(flash.capabilityScore.score).toBeLessThan(gpt.capabilityScore.score);
      expect(flash.capabilityScore.reasonCodes).toContain("compact_global_broad_ceiling:openai/gpt-5.4");
      expect(flash.scoreByScenario.coding_worker.score).toBeGreaterThan(gpt.scoreByScenario.coding_worker.score);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers balanced overall capability over a single high scenario spike", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            artificialAnalysis: {
              data: [{
                model_name: "Balanced Overall",
                artificial_analysis_intelligence_index: 80,
                artificial_analysis_coding_index: 80,
              }, {
                model_name: "Coding Spike",
                artificial_analysis_intelligence_index: 72,
                artificial_analysis_coding_index: 98,
              }],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const balanced = snapshot.models["balanced-overall"].capabilityScore;
      const spike = snapshot.models["coding-spike"].capabilityScore;

      expect(balanced.score).toBeGreaterThan(spike.score);
      expect(spike.reasonCodes).toContain("global_single_scenario_spike_penalty");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Artificial Analysis overall as the primary global capability anchor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: {
              leaderboard: [{
                model: "coding-spike",
                best_score_percentage: 0.98,
                average_cost_usd: 10,
                best_cost_usd: 4,
                average_execution_time_seconds: 120,
                best_execution_time_seconds: 80,
                submission_count: 8,
              }],
            },
            aider: "[]",
            bfcl: [],
            artificialAnalysis: {
              data: [{
                model_name: "Broad Winner",
                artificial_analysis_intelligence_index: 90,
                artificial_analysis_coding_index: 72,
              }, {
                model_name: "Coding Spike",
                artificial_analysis_intelligence_index: 70,
                artificial_analysis_coding_index: 98,
              }],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));
      const broad = snapshot.models["broad-winner"].capabilityScore;
      const spike = snapshot.models["coding-spike"].capabilityScore;

      expect(broad.score).toBeGreaterThan(spike.score);
      expect(broad.sources).toContain("artificial_analysis");
      expect(broad.reasonCodes).toContain("global_anchor:artificial_analysis");
      expect(spike.reasonCodes).toContain("global_anchor:artificial_analysis");
      expect(snapshot.models["coding-spike"].benchmarkEfficiency).toMatchObject({
        sources: ["pinchbench"],
      });
      expect(snapshot.models["coding-spike"].benchmarkEfficiency.valueScore).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses current BFCL CSV rows as agentic evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [
              "Rank,Overall Acc,Model,Model Link,Organization",
              "1,77.47%,Claude-Opus-4-5-20251101 (FC),https://example.test,Anthropic",
            ].join("\n"),
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));

      expect(snapshot.sourceStatus.bfcl).toMatchObject({
        ok: true,
        rows: 1,
        health: 1,
      });
      expect(snapshot.models["anthropic/claude-opus-4.5-20251101-fc"].scoreByScenario.agentic.contributions).toContainEqual(expect.objectContaining({
        source: "bfcl",
        rawScore: 77.47,
      }));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Artificial Analysis when an API-key backed source is provided and marks missing auth otherwise", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-"));
    const output = path.join(tempDir, "leaderboard-snapshot.json");
    try {
      await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", output], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
            openrouter: { data: [] },
            pinchbench: { leaderboard: [] },
            aider: "[]",
            bfcl: [],
            artificialAnalysis: {
              data: [{
                model_name: "Claude Opus 4.7",
                artificial_analysis_intelligence_index: 78,
                artificial_analysis_coding_index: 72,
                pricing: { price_1m_blended_3_to_1: 15 },
              }],
            },
          }),
        },
      });

      const snapshot = JSON.parse(await fs.readFile(output, "utf8"));

      expect(snapshot.sourceStatus.artificial_analysis).toMatchObject({
        ok: true,
        rows: 2,
        health: 1,
      });
      expect(snapshot.models["anthropic/claude-opus-4.7"].capabilityScore.sources).toContain("artificial_analysis");
      expect(JSON.stringify(snapshot)).not.toContain("aa_");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const missingOutput = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "octoclaw-refresh-leaderboard-")), "leaderboard-snapshot.json");
    await execFileAsync("node", ["scripts/refresh-leaderboard-snapshot.mjs", "--output", missingOutput], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ARTIFICIAL_ANALYSIS_API_KEY: "",
        OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON: JSON.stringify({
          openrouter: { data: [] },
          pinchbench: { leaderboard: [] },
          aider: "[]",
          bfcl: [],
        }),
      },
    });
    const missingSnapshot = JSON.parse(await fs.readFile(missingOutput, "utf8"));
    expect(missingSnapshot.sourceStatus.artificial_analysis).toMatchObject({
      ok: false,
      health: 0,
      reason: "missing_auth",
    });
  });
});
