import {
  applyWizardAction,
  createRouterWizardState,
  handleWizardIdle,
  resetWizardStep,
  type RouterWizardState,
  type RouterWizardStepId,
} from "./flow.js";
import { renderWizardMessage } from "./messages.js";
import { loadRouterWizardState, saveRouterWizardState } from "./state-store.js";

export * from "./buttons.js";
export * from "./flow.js";
export * from "./messages.js";
export * from "./state-store.js";

export interface WizardSlashResult {
  state: RouterWizardState;
  messages: ReturnType<typeof renderWizardMessage>[];
}

function parseResetStep(text: string): RouterWizardStepId | null {
  const match = /\breset\s+step-([1-7])\b/iu.exec(text);
  if (!match) return null;
  const step = Number(match[1]);
  return ({
    1: "step-1-greeting",
    2: "step-2-models",
    3: "step-3-budget",
    4: "step-4-privacy",
    5: "step-5-restricted-models",
    6: "step-6-same-provider",
    7: "step-7-done",
  } as Record<number, RouterWizardStepId>)[step] ?? null;
}

export async function handleRouterWizardSlashCommand(input: {
  text?: string;
  openclawHome?: string;
  models: string[];
  sameProviderCandidates?: string[];
  now?: string;
}): Promise<WizardSlashResult> {
  const loaded = await loadRouterWizardState({ openclawHome: input.openclawHome });
  const state = loaded.state ?? createRouterWizardState({
    models: input.models,
    sameProviderCandidates: input.sameProviderCandidates,
    now: input.now,
  });
  const resetStep = parseResetStep(input.text ?? "");
  if (resetStep) {
    const reset = resetWizardStep(state, resetStep, { now: input.now });
    await saveRouterWizardState(reset.state, { openclawHome: input.openclawHome });
    return { state: reset.state, messages: [renderWizardMessage(reset.state)] };
  }
  const idle = handleWizardIdle(state, { now: input.now });
  const nextState = idle.state;
  await saveRouterWizardState(nextState, { openclawHome: input.openclawHome });
  return { state: nextState, messages: idle.messages.length ? idle.messages : [renderWizardMessage(nextState)] };
}

export async function applyAndPersistRouterWizardAction(input: {
  state: RouterWizardState;
  action: Parameters<typeof applyWizardAction>[1];
  openclawHome?: string;
  now?: string;
}): Promise<WizardSlashResult & { kind: ReturnType<typeof applyWizardAction>["kind"] }> {
  const result = applyWizardAction(input.state, input.action, { now: input.now });
  if (result.kind !== "duplicate") {
    await saveRouterWizardState(result.state, { openclawHome: input.openclawHome });
  }
  return {
    kind: result.kind,
    state: result.state,
    messages: result.messages.length ? result.messages : [renderWizardMessage(result.state)],
  };
}
