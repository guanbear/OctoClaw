#!/usr/bin/env node

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PINCHBENCH_LEADERBOARD_URL = "https://api.pinchbench.com/api/leaderboard?official=true&limit=200";
const PINCHBENCH_SUBMISSION_URL = "https://api.pinchbench.com/api/submissions";
const DEFAULT_BASELINE_MODEL = "z-ai/glm-5.1";
const DEFAULT_MODEL_IDS = [
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "z-ai/glm-5.1",
  "z-ai/glm-5-turbo",
  "z-ai/glm-5",
  "z-ai/glm-4.7",
  "z-ai/glm-4.7-flash",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5-mini",
  "openai/gpt-4o-mini",
  "anthropic/claude-sonnet-4.6",
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5-pro",
];

function parseArgs(argv) {
  const args = {
    baseline: DEFAULT_BASELINE_MODEL,
    format: "markdown",
    includeSubmissions: true,
    models: DEFAULT_MODEL_IDS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") {
      args.baseline = argv[++i] ?? args.baseline;
    } else if (arg === "--format") {
      args.format = argv[++i] ?? args.format;
    } else if (arg === "--models") {
      args.models = (argv[++i] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--no-submissions") {
      args.includeSubmissions = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/router-lite-model-intel-prototype.mjs [options]

Options:
  --baseline <model>   Price ratio baseline. Default: ${DEFAULT_BASELINE_MODEL}
  --models <csv>       Comma-separated OpenRouter model ids to compare.
  --format <format>    markdown or json. Default: markdown
  --no-submissions     Skip PinchBench best-submission category fetches.
`);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "accept": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function round(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pricePerMTok(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed * 1_000_000;
}

function blendedPrice(inputUsdPerMTok, outputUsdPerMTok) {
  if (inputUsdPerMTok == null && outputUsdPerMTok == null) return null;
  return ((inputUsdPerMTok ?? 0) * 3 + (outputUsdPerMTok ?? 0)) / 4;
}

function supportedParameters(model) {
  return Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
}

function categoryPct(submission, category) {
  const tasks = Array.isArray(submission?.tasks) ? submission.tasks : [];
  const matching = tasks.filter((task) => task?.category === category);
  const score = matching.reduce((sum, task) => sum + (Number(task?.score) || 0), 0);
  const max = matching.reduce((sum, task) => sum + (Number(task?.max_score) || 0), 0);
  return max > 0 ? Math.round((score / max) * 100) : null;
}

function weightedScore(inputs) {
  const valid = inputs.filter(([value]) => typeof value === "number" && Number.isFinite(value));
  const weight = valid.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  if (weight <= 0) return null;
  return Math.round(valid.reduce((sum, [value, itemWeight]) => sum + value * itemWeight, 0) / weight);
}

function scenarioScores(overall, categories) {
  return {
    codingWorker: weightedScore([
      [categories.coding, 0.55],
      [categories.skills, 0.15],
      [categories.analysis, 0.10],
      [overall, 0.20],
    ]),
    researchLookup: weightedScore([
      [categories.research, 0.45],
      [categories.analysis, 0.20],
      [categories.memory, 0.15],
      [overall, 0.20],
    ]),
    dataLogAnalysis: weightedScore([
      [categories.csv_analysis, 0.35],
      [categories.log_analysis, 0.35],
      [categories.analysis, 0.20],
      [overall, 0.10],
    ]),
    mainReasoning: weightedScore([
      [categories.analysis, 0.35],
      [categories.meeting_analysis, 0.20],
      [categories.writing, 0.15],
      [overall, 0.30],
    ]),
    toolAgent: weightedScore([
      [categories.productivity, 0.25],
      [categories.integrations, 0.20],
      [categories.skills, 0.20],
      [categories.memory, 0.15],
      [overall, 0.20],
    ]),
  };
}

async function submissionSummary(entry, includeSubmissions) {
  if (!entry) return null;
  const bestPct = pct(entry.best_score_percentage);
  const summary = {
    bestPct,
    avgPct: pct(entry.average_score_percentage),
    submissionCount: entry.submission_count ?? null,
    latestSubmission: entry.latest_submission ?? null,
    bestCostUsd: round(entry.best_cost_usd, 3),
    avgCostUsd: round(entry.average_cost_usd, 3),
    bestExecutionSeconds: round(entry.best_execution_time_seconds, 0),
    avgExecutionSeconds: round(entry.average_execution_time_seconds, 0),
    categories: {},
  };
  if (!includeSubmissions || !entry.best_submission_id) return summary;
  try {
    const detail = await fetchJson(`${PINCHBENCH_SUBMISSION_URL}/${entry.best_submission_id}`);
    const submission = detail.submission ?? detail;
    summary.categories = {
      coding: categoryPct(submission, "coding"),
      analysis: categoryPct(submission, "analysis"),
      csv_analysis: categoryPct(submission, "csv_analysis"),
      log_analysis: categoryPct(submission, "log_analysis"),
      meeting_analysis: categoryPct(submission, "meeting_analysis"),
      productivity: categoryPct(submission, "productivity"),
      skills: categoryPct(submission, "skills"),
      research: categoryPct(submission, "research"),
      memory: categoryPct(submission, "memory"),
      writing: categoryPct(submission, "writing"),
      integrations: categoryPct(submission, "integrations"),
    };
    summary.scenarioScores = scenarioScores(bestPct, summary.categories);
  } catch (error) {
    summary.categories = { error: error instanceof Error ? error.message : String(error) };
  }
  return summary;
}

function toMarkdown(snapshot) {
  const lines = [
    `Baseline: ${snapshot.priceBaseline.modelKey} = 1.00x, blended price uses 3 input : 1 output.`,
    "",
    "| model | API in/out $/M | ratio vs GLM 5.1 | Pinch best/avg | coding worker | research | data/log | main reasoning | submissions | note |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const model of snapshot.models) {
    const price = model.apiPrice.inputUsdPerMTok == null
      ? "unknown"
      : `${round(model.apiPrice.inputUsdPerMTok, 3)} / ${round(model.apiPrice.outputUsdPerMTok, 3)}`;
    const pinch = model.pinchbench
      ? `${model.pinchbench.bestPct ?? "-"} / ${model.pinchbench.avgPct ?? "-"}`
      : "-";
    const note = model.notes.join("; ");
    lines.push([
      model.modelKey,
      price,
      model.apiPrice.ratioToBaseline == null ? "-" : `${round(model.apiPrice.ratioToBaseline, 3)}x`,
      pinch,
      model.pinchbench?.scenarioScores?.codingWorker ?? "-",
      model.pinchbench?.scenarioScores?.researchLookup ?? "-",
      model.pinchbench?.scenarioScores?.dataLogAnalysis ?? "-",
      model.pinchbench?.scenarioScores?.mainReasoning ?? "-",
      model.pinchbench?.submissionCount ?? "-",
      note || "-",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [openRouter, pinchbench] = await Promise.all([
    fetchJson(OPENROUTER_MODELS_URL),
    fetchJson(PINCHBENCH_LEADERBOARD_URL),
  ]);
  const openRouterById = new Map((openRouter.data ?? []).map((model) => [model.id, model]));
  const pinchByModel = new Map((pinchbench.leaderboard ?? []).map((entry) => [entry.model, entry]));
  const baselineModel = openRouterById.get(args.baseline);
  const baselineInput = pricePerMTok(baselineModel?.pricing?.prompt);
  const baselineOutput = pricePerMTok(baselineModel?.pricing?.completion);
  const baselineBlended = blendedPrice(baselineInput, baselineOutput);

  const models = [];
  for (const modelKey of args.models) {
    const model = openRouterById.get(modelKey);
    const entry = pinchByModel.get(modelKey);
    const input = pricePerMTok(model?.pricing?.prompt);
    const output = pricePerMTok(model?.pricing?.completion);
    const blended = blendedPrice(input, output);
    const parameters = supportedParameters(model);
    const notes = [];
    if (!model) notes.push("missing_openrouter");
    if (!entry) notes.push("missing_pinchbench");
    if (entry && Number(entry.submission_count ?? 0) < 8) notes.push("low_sample");
    if (modelKey.endsWith("-pro") && entry && Number(entry.best_score_percentage ?? 0) < 0.7) notes.push("benchmark_anomaly");
    models.push({
      modelKey,
      name: model?.name ?? null,
      contextWindow: model?.context_length ?? null,
      apiPrice: {
        inputUsdPerMTok: round(input, 4),
        outputUsdPerMTok: round(output, 4),
        blendedUsdPerMTok: round(blended, 4),
        ratioBaselineModel: args.baseline,
        ratioToBaseline: baselineBlended && blended != null ? round(blended / baselineBlended, 4) : null,
        source: model ? "openrouter_api_live" : null,
      },
      hardCaps: {
        toolUse: parameters.includes("tools"),
        structuredOutput: parameters.includes("structured_outputs"),
        reasoning: parameters.includes("reasoning"),
      },
      pinchbench: await submissionSummary(entry, args.includeSubmissions),
      health: {
        source: "octoclaw_scheduled_probe_pending",
        p50FirstTokenMs: null,
        p50OutputTokensPerSecond: null,
        recentFailureRate: null,
      },
      notes,
      sources: [
        ...(model ? ["openrouter_api_live"] : []),
        ...(entry ? ["pinchbench_api_official_v2"] : []),
      ],
    });
  }

  const snapshot = {
    schemaVersion: "octoclaw.router_lite.external_model_intel_prototype/v0",
    generatedAt: new Date().toISOString(),
    priceBaseline: {
      modelKey: args.baseline,
      inputUsdPerMTok: round(baselineInput, 4),
      outputUsdPerMTok: round(baselineOutput, 4),
      blendedUsdPerMTok: round(baselineBlended, 4),
      blend: "3_input_to_1_output",
    },
    sources: {
      openrouter: OPENROUTER_MODELS_URL,
      pinchbench: PINCHBENCH_LEADERBOARD_URL,
    },
    models: models.sort((a, b) => (a.apiPrice.ratioToBaseline ?? Number.POSITIVE_INFINITY) - (b.apiPrice.ratioToBaseline ?? Number.POSITIVE_INFINITY)),
  };

  if (args.format === "json") {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(toMarkdown(snapshot));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
