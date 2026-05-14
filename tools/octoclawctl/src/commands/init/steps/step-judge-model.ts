import { spawnSync } from "node:child_process";
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

export async function runStepJudgeModel(state: WizardState, opts: WizardOpts): Promise<void> {
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

  const baseUrl = await input({ message: opts.lang === "zh" ? "OpenAI-compatible Base URL" : "OpenAI-compatible base URL" });
  const modelId = await input({ message: opts.lang === "zh" ? "模型 ID" : "Model ID" });
  const apiKey = await input({ message: opts.lang === "zh" ? "API Key（可选）" : "API key (optional)" });
  state.judgeModel = { type, modelId, baseUrl, apiKey };
}

function judgeChoices(lang: WizardOpts["lang"]): JudgeChoice[] {
  if (lang === "zh") {
    return [
      { value: "ollama-qwen3", name: "本地 Ollama — Qwen3 0.6B（免费，毫秒级，推荐）" },
      { value: "ollama-custom", name: "本地 Ollama — 自定义模型" },
      { value: "remote-groq", name: "远端 endpoint — Groq（免费额度）" },
      { value: "remote-custom", name: "远端 endpoint — 自定义 OpenAI-compatible URL" },
      { value: "skip", name: "跳过（稍后配置）" },
    ];
  }
  return [
    { value: "ollama-qwen3", name: "Local Ollama — Qwen3 0.6B (free, ms-level, recommended)" },
    { value: "ollama-custom", name: "Local Ollama — Custom model" },
    { value: "remote-groq", name: "Remote endpoint — Groq (free tier)" },
    { value: "remote-custom", name: "Remote endpoint — Custom OpenAI-compatible URL" },
    { value: "skip", name: "Skip (configure later)" },
  ];
}
