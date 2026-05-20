import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";

type JudgeType = NonNullable<WizardState["judgeModel"]>["type"];

interface JudgeChoice {
  name: string;
  value: JudgeType;
}

const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1";
const GPT_5_4_MINI_MODEL_ID = "gpt-5.4-mini";

export async function runStepJudgeModel(state: WizardState, opts: WizardOpts): Promise<void> {
  if (opts.autoRemoteJudge) {
    const discovered = await discoverOpenClawProvider(opts.openclawHome);
    if (discovered) {
      state.judgeModel = {
        type: "remote-gpt-5-4-mini",
        modelId: GPT_5_4_MINI_MODEL_ID,
        baseUrl: discovered.baseUrl,
        apiKey: discovered.apiKey,
      };
      return;
    }
    if (opts.nonInteractive) {
      state.judgeModel = null;
      return;
    }
  }

  if (opts.nonInteractive) {
    state.judgeModel = null;
    return;
  }

  const type = await select<JudgeType>({
    message: opts.lang === "zh" ? "选择轻量 Judge 模型" : "Choose a lightweight judge model",
    choices: judgeChoices(opts.lang),
    default: "ollama-qwen3",
  });

  if (type === "skip") {
    state.judgeModel = null;
    return;
  }

  if (type === "ollama-qwen3") {
    const result = spawnSync("ollama", ["list"], { timeout: 3000, encoding: "utf8" });
    if (result.status !== 0 || !(result.stdout || "").includes("qwen3:0.6b")) {
      console.warn(opts.lang === "zh"
        ? "⚠️ 未检测到 qwen3:0.6b。可稍后运行：ollama pull qwen3:0.6b"
        : "⚠️ qwen3:0.6b was not detected. You can run later: ollama pull qwen3:0.6b");
    }
    state.judgeModel = { type, modelId: "qwen3:0.6b", baseUrl: "http://localhost:11434/v1", apiKey: "" };
    return;
  }

  if (type === "ollama-custom") {
    const modelId = await input({ message: opts.lang === "zh" ? "Ollama 模型 ID" : "Ollama model ID", default: "qwen3:0.6b" });
    state.judgeModel = { type, modelId, baseUrl: "http://localhost:11434/v1", apiKey: "" };
    return;
  }

  if (type === "remote-groq") {
    const apiKey = await input({ message: opts.lang === "zh" ? "Groq API Key（可留空稍后配置）" : "Groq API key (optional; configure later if blank)" });
    state.judgeModel = { type, modelId: DEFAULT_GROQ_MODEL, baseUrl: DEFAULT_GROQ_URL, apiKey };
    return;
  }

  if (type === "remote-gpt-5-4-mini") {
    const discovered = await discoverOpenClawProvider(opts.openclawHome);
    if (discovered) {
      state.judgeModel = {
        type,
        modelId: GPT_5_4_MINI_MODEL_ID,
        baseUrl: discovered.baseUrl,
        apiKey: discovered.apiKey,
      };
    } else {
      const baseUrl = await input({
        message: opts.lang === "zh" ? "OpenAI-compatible Base URL" : "OpenAI-compatible base URL",
      });
      const apiKey = await input({
        message: opts.lang === "zh" ? "API Key（可选）" : "API key (optional)",
      });
      state.judgeModel = {
        type,
        modelId: GPT_5_4_MINI_MODEL_ID,
        baseUrl,
        apiKey,
      };
    }
    return;
  }

  const baseUrl = await input({ message: opts.lang === "zh" ? "OpenAI-compatible Base URL" : "OpenAI-compatible base URL" });
  const modelId = await input({ message: opts.lang === "zh" ? "模型 ID" : "Model ID" });
  const apiKey = await input({ message: opts.lang === "zh" ? "API Key（可选）" : "API key (optional)" });
  state.judgeModel = { type, modelId, baseUrl, apiKey };
}

export function judgeChoices(lang: WizardOpts["lang"]): JudgeChoice[] {
  if (lang === "zh") {
    return [
      { value: "ollama-qwen3", name: "本地 Ollama — Qwen3 0.6B（免费，毫秒级，推荐）" },
      { value: "ollama-custom", name: "本地 Ollama — 自定义模型" },
      { value: "remote-gpt-5-4-mini", name: "远端 OpenAI-compatible — gpt-5.4-mini（便宜、快速、无推理，默认）；可按评测改填 glm-4.5-air、xiaomi/mimo-v2-flash 或 deepseek/deepseek-v4-flash" },
      { value: "remote-groq", name: "远端 endpoint — Groq（免费额度）" },
      { value: "remote-custom", name: "远端 endpoint — 自定义 OpenAI-compatible URL" },
      { value: "skip", name: "跳过（稍后配置）" },
    ];
  }
  return [
    { value: "ollama-qwen3", name: "Local Ollama — Qwen3 0.6B (free, ms-level, recommended)" },
    { value: "ollama-custom", name: "Local Ollama — Custom model" },
    { value: "remote-gpt-5-4-mini", name: "Remote OpenAI-compatible — gpt-5.4-mini default (cheap, fast, no reasoning); evaluated alternatives: glm-4.5-air, xiaomi/mimo-v2-flash, deepseek/deepseek-v4-flash" },
    { value: "remote-groq", name: "Remote endpoint — Groq (free tier)" },
    { value: "remote-custom", name: "Remote endpoint — Custom OpenAI-compatible URL" },
    { value: "skip", name: "Skip (configure later)" },
  ];
}

export async function discoverOpenClawProvider(
  openclawHome: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const openclawConfigPath = path.join(openclawHome, "openclaw.json");
  let raw: string;
  try {
    raw = await fs.readFile(openclawConfigPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const models = asRecord(parsed.models);
  if (!models) return null;

  const providers = asRecord(models.providers);
  if (!providers) return null;

  interface ProviderCandidate {
    providerId: string;
    baseUrl: string;
    apiKey: string;
  }

  const candidates: ProviderCandidate[] = [];

  for (const [providerId, providerValue] of Object.entries(providers)) {
    if (!isRecord(providerValue)) continue;

    const baseUrl = typeof providerValue.baseUrl === "string" ? providerValue.baseUrl.trim() : "";
    if (!baseUrl) continue;

    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) continue;
    if (!looksOpenAICompatible(providerId, baseUrl)) continue;

    const apiKey = typeof providerValue.apiKey === "string" ? providerValue.apiKey.trim() : "";

    candidates.push({ providerId: providerId.toLowerCase(), baseUrl, apiKey });
  }

  if (candidates.length === 0) return null;

  const cliproxyCandidate = candidates.find(
    (c) => c.providerId.includes("cliproxyapi") || c.baseUrl.toLowerCase().includes("cliproxyapi"),
  );
  if (cliproxyCandidate) {
    return { baseUrl: cliproxyCandidate.baseUrl, apiKey: cliproxyCandidate.apiKey };
  }

  if (candidates.length === 1) {
    return { baseUrl: candidates[0].baseUrl, apiKey: candidates[0].apiKey };
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function looksOpenAICompatible(providerId: string, baseUrl: string): boolean {
  const key = `${providerId} ${baseUrl}`.toLowerCase();
  return key.includes("openai")
    || key.includes("cliproxyapi")
    || key.includes("groq")
    || key.includes("litellm")
    || /\/v1\/?$/u.test(baseUrl);
}
