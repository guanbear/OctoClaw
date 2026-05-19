import type { WizardState } from "./init/wizard-state.js";
import type { WizardOpts } from "./init/wizard-opts.js";
import { runStepOpenClawCheck } from "./init/steps/step-openclaw-check.js";
import { runStepJudgeModel } from "./init/steps/step-judge-model.js";
import { runStepImChannel } from "./init/steps/step-im-channel.js";
import { runStepImToken } from "./init/steps/step-im-token.js";
import { runStepDoctorVerify } from "./init/steps/step-doctor-verify.js";
import { readConfig, writeConfig } from "../config.js";
import { generateReadinessReport, redactReadinessReport, formatReadinessSummary } from "../readiness.js";

export interface InitWizardOpts {
  nonInteractive: boolean;
  lang: "zh" | "en";
  openclawHome: string;
}

export async function runInitWizard(opts: InitWizardOpts): Promise<string> {
  const lang = opts.lang;
  const state: WizardState = {
    openclawVersion: null,
    judgeModel: null,
    imChannels: [],
    imTokens: {},
    doctorResults: [],
  };
  const wizardOpts: WizardOpts = { nonInteractive: opts.nonInteractive, lang, openclawHome: opts.openclawHome };
  const lines: string[] = [];

  // Step 1: OpenClaw detection (design.md §3)
  try {
    const result = await runStepOpenClawCheck(state, wizardOpts);
    lines.push(`✅ OpenClaw ${result.version}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "OPENCLAW_NOT_FOUND") {
      lines.push(`❌ ${error instanceof Error ? error.message : String(error)}`);
      return lines.join("\n");
    }
    throw error;
  }

  // Step 2: Judge model (design.md §4)
  await runStepJudgeModel(state, wizardOpts);

  // Step 3: IM channels (design.md §5)
  await runStepImChannel(state, wizardOpts);

  // Step 4: IM tokens (design.md §6)
  await runStepImToken(state, wizardOpts);

  // Persist config
  const config = await readConfig(opts.openclawHome);
  if (state.judgeModel) {
    config.judge.enabled = true;
    config.judge.modelId = state.judgeModel.modelId;
    config.judge.baseUrl = state.judgeModel.baseUrl;
    if (state.judgeModel.apiKey) config.judge.apiKey = state.judgeModel.apiKey;
    config.judge.local = state.judgeModel.type.startsWith("ollama");
  }
  // IM tokens stored in pluginConfig.channels; do not clear existing keys
  if (Object.keys(state.imTokens).length > 0) {
    const existing = (config.pluginConfig.channels ?? {}) as Record<string, unknown>;
    config.pluginConfig = { ...config.pluginConfig, channels: { ...existing, ...state.imTokens } };
  }
  await writeConfig(opts.openclawHome, config);

  // Step 5: Doctor verification (design.md §7)
  const doctorLines = await runStepDoctorVerify(state, wizardOpts);
  lines.push("", ...doctorLines);

  // Step 6: Readiness summary after init
  try {
    const report = redactReadinessReport(await generateReadinessReport(opts.openclawHome));
    lines.push("", formatReadinessSummary(report, lang));
  } catch {
    // Readiness is observational — never fail init
  }

  return lines.join("\n");
}
