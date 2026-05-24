#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: "packages/octoclaw-router/src/data/leaderboard-snapshot.json",
    outDir: "public",
    baseUrl: "https://octoclaw.github.io/OctoClaw",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      args.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function modelEntries(snapshot) {
  if (Array.isArray(snapshot.models)) return snapshot.models;
  if (snapshot.models && typeof snapshot.models === "object") {
    return Object.entries(snapshot.models).map(([modelKey, value]) => ({ modelKey, ...value }));
  }
  throw new Error("snapshot has no models");
}

function capabilityScore(model) {
  const score = model?.capability?.capabilityScore?.score ?? model?.capabilityScore?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function capabilityConfidence(model) {
  return model?.capability?.capabilityScore?.confidence ?? model?.capabilityScore?.confidence ?? model?.capability?.confidence ?? "unknown";
}

function buildSummary(snapshot, models) {
  const scored = models
    .flatMap((model) => {
      const score = capabilityScore(model);
      if (score === undefined) return [];
      return [{ modelKey: model.modelKey, score, confidence: capabilityConfidence(model) }];
    })
    .sort((a, b) => b.score - a.score || a.modelKey.localeCompare(b.modelKey));
  return {
    schemaVersion: "octoclaw.capability_summary/v1",
    snapshotId: snapshot.snapshotId ?? "leaderboard-snapshot",
    generatedAt: snapshot.generatedAt,
    modelCount: models.length,
    sourceStatus: snapshot.sourceStatus ?? {},
    topModels: scored.slice(0, 20),
  };
}

function html(summary) {
  const rows = summary.topModels.map((model) =>
    `<tr><td>${escapeHtml(model.modelKey)}</td><td>${model.score}</td><td>${escapeHtml(model.confidence)}</td></tr>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OctoClaw Capability Snapshot</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.5; color: #17202a; }
    table { border-collapse: collapse; width: 100%; max-width: 960px; }
    th, td { border-bottom: 1px solid #d8dee4; padding: 0.5rem; text-align: left; }
    code { background: #f6f8fa; padding: 0.1rem 0.25rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>OctoClaw Capability Snapshot</h1>
  <p>Generated at <code>${escapeHtml(summary.generatedAt ?? "unknown")}</code>. Models: <code>${summary.modelCount}</code>.</p>
  <p>
    <a href="./leaderboard-manifest.json">leaderboard-manifest.json</a>
    <a href="./leaderboard-summary.json">leaderboard-summary.json</a>
    <a href="./leaderboard-snapshot.json">leaderboard-snapshot.json</a>
  </p>
  <table>
    <thead><tr><th>Model</th><th>Score</th><th>Confidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capabilityDir = path.join(args.outDir, "capability");
  const rawSnapshot = await fs.readFile(args.input, "utf8");
  const snapshot = JSON.parse(rawSnapshot);
  const models = modelEntries(snapshot);
  if (!snapshot.generatedAt) throw new Error("snapshot generatedAt is required");
  if (models.length === 0) throw new Error("snapshot must include at least one model");

  await fs.mkdir(capabilityDir, { recursive: true });
  const formattedSnapshot = `${JSON.stringify(snapshot, null, 2)}\n`;
  const summary = buildSummary(snapshot, models);
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const normalizedBaseUrl = args.baseUrl.replace(/\/+$/u, "");
  const manifest = {
    schemaVersion: "octoclaw.capability_manifest/v1",
    generatedAt: snapshot.generatedAt,
    snapshotUrl: `${normalizedBaseUrl}/capability/leaderboard-snapshot.json`,
    summaryUrl: `${normalizedBaseUrl}/capability/leaderboard-summary.json`,
    snapshotSha256: crypto.createHash("sha256").update(formattedSnapshot).digest("hex"),
    modelCount: models.length,
    minOctoClawVersion: "0.6.0",
  };

  await fs.writeFile(path.join(capabilityDir, "leaderboard-snapshot.json"), formattedSnapshot);
  await fs.writeFile(path.join(capabilityDir, "leaderboard-summary.json"), summaryText);
  await fs.writeFile(path.join(capabilityDir, "leaderboard-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(capabilityDir, "index.html"), html(summary));
  console.log(`[capability-site] wrote ${capabilityDir} models=${models.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
