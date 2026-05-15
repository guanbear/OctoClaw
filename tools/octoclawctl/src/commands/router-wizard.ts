import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import {
  applyWizardAction,
  createRouterWizardState,
  renderWizardMessage,
  saveRouterWizardState,
  type RouterWizardState,
} from "@octoclaw/runtime/slack-wizard";
import { createWizardConfig } from "@octoclaw/router";

declare const process: {
  stdin: { isTTY?: boolean };
  stdout: { write(chunk: string): void };
};

export interface RouterWizardCliOptions {
  openclawHome: string;
  models: string[];
  sameProviderCandidates?: string[];
  nonInteractive?: boolean;
  resume?: boolean;
  format: "text" | "json";
  now?: string;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function routerWizardConfigPath(openclawHome: string): string {
  return path.join(openclawHome, "octoclaw", "router-wizard.json");
}

function planTypesFromState(state: RouterWizardState): Record<string, "subscription" | "pay_as_you_go" | "unknown"> {
  return Object.fromEntries(Object.entries(state.answers.models).map(([model, answer]) => [model, answer.planType]));
}

async function writeRouterWizardConfig(openclawHome: string, state: RouterWizardState): Promise<string> {
  const filePath = routerWizardConfigPath(openclawHome);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const config = createWizardConfig(state.configuredModels, {
    now: state.completedAt ?? state.updatedAt,
    budgetInput: state.answers.budget?.monthlyUsd === undefined ? undefined : String(state.answers.budget.monthlyUsd),
    privacy: state.answers.privacy === "local_only" ? "local_only" : "standard",
    restrictedModels: state.answers.restrictedModels,
    modelPlanTypes: planTypesFromState(state),
    sameProviderModels: state.answers.sameProviderCandidates,
  });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function applyOrThrow(state: RouterWizardState, step: 1 | 2 | 3 | 4 | 5 | 6, value: string, now: string): RouterWizardState {
  const result = applyWizardAction(state, { step, value }, { now });
  if (result.kind === "invalid" || result.kind === "out_of_order") {
    throw new Error(`Router wizard CLI action failed at step ${step}: ${result.kind}`);
  }
  return result.state;
}

function runDefaultWizard(models: string[], candidates: string[], now: string): RouterWizardState {
  let state = createRouterWizardState({ models, sameProviderCandidates: candidates, now });
  state = applyOrThrow(state, 1, "start", addSeconds(now, 1));
  for (let index = 0; index < models.length; index += 1) {
    state = applyOrThrow(state, 2, "unknown", addSeconds(now, 2 + index));
  }
  state = applyOrThrow(state, 3, "skip", addSeconds(now, 2 + models.length));
  state = applyOrThrow(state, 4, "cloud_ok", addSeconds(now, 3 + models.length));
  state = applyOrThrow(state, 6, "skip", addSeconds(now, 4 + models.length));
  return state;
}

async function askChoice(prompt: string, choices: string[], fallback: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt}\n${choices.join(" / ")} [${fallback}]: `)).trim();
    return choices.includes(answer) ? answer : fallback;
  } finally {
    rl.close();
  }
}

async function runInteractiveWizard(models: string[], candidates: string[], now: string): Promise<RouterWizardState> {
  let state = createRouterWizardState({ models, sameProviderCandidates: candidates, now });
  process.stdout.write(`${renderWizardMessage(state).text}\n`);
  state = applyOrThrow(state, 1, "start", addSeconds(now, 1));
  for (let index = 0; index < models.length; index += 1) {
    process.stdout.write(`${renderWizardMessage(state).text}\n`);
    const value = await askChoice("选择计费类型", ["subscription", "pay_as_you_go", "unknown", "skip"], "unknown");
    state = applyOrThrow(state, 2, value, addSeconds(now, 2 + index));
  }
  process.stdout.write(`${renderWizardMessage(state).text}\n`);
  const budget = await askChoice("选择预算", ["<20", "20-100", "100-500", "500+", "unlimited", "skip"], "skip");
  state = applyOrThrow(state, 3, budget, addSeconds(now, 2 + models.length));
  process.stdout.write(`${renderWizardMessage(state).text}\n`);
  const privacy = await askChoice("选择隐私策略", ["cloud_ok", "local_only", "pick", "skip"], "cloud_ok");
  state = applyOrThrow(state, 4, privacy, addSeconds(now, 3 + models.length));
  if (state.step === "step-5-restricted-models") {
    process.stdout.write(`${renderWizardMessage(state).text}\n`);
    state = applyOrThrow(state, 5, "skip", addSeconds(now, 4 + models.length));
  }
  process.stdout.write(`${renderWizardMessage(state).text}\n`);
  const candidateAction = await askChoice("同供应商候选", ["all", "select", "skip"], "skip");
  state = applyOrThrow(state, 6, candidateAction, addSeconds(now, 5 + models.length));
  process.stdout.write(`${renderWizardMessage(state).text}\n`);
  return state;
}

export async function runRouterWizardCli(options: RouterWizardCliOptions): Promise<string> {
  const now = options.now ?? new Date().toISOString();
  const candidates = options.sameProviderCandidates ?? [];
  const useInteractive = !options.nonInteractive && process.stdin.isTTY === true;
  const state = useInteractive
    ? await runInteractiveWizard(options.models, candidates, now)
    : runDefaultWizard(options.models, candidates, now);
  const statePath = await saveRouterWizardState(state, { openclawHome: options.openclawHome });
  const configPath = await writeRouterWizardConfig(options.openclawHome, state);
  const summary = {
    statePath,
    configPath,
    step: state.step,
    completed: Boolean(state.completedAt),
    models: state.configuredModels,
  };
  if (options.format === "json") return JSON.stringify(summary, null, 2);
  return [
    `Router wizard CLI completed: ${summary.completed ? "yes" : "no"}`,
    `state=${statePath}`,
    `config=${configPath}`,
  ].join("\n");
}
