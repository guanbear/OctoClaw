import type { RouterWizardButtonAction } from "./buttons.js";

export type RouterWizardStepId =
  | "step-1-greeting"
  | "step-2-models"
  | "step-3-budget"
  | "step-4-privacy"
  | "step-5-restricted-models"
  | "step-6-same-provider"
  | "step-7-done";

export interface RouterWizardState {
  schemaVersion: "octoclaw.router_wizard_state/v1";
  thread?: { channel: string; ts: string };
  step: RouterWizardStepId;
  configuredModels: string[];
  remainingModels: string[];
  sameProviderCandidates: string[];
  answers: {
    models: Record<string, { planType: "subscription" | "pay_as_you_go" | "unknown" }>;
    budget: { range: string; monthlyUsd?: number } | null;
    privacy: "standard" | "local_only" | "custom" | null;
    restrictedModels: string[];
    sameProviderCandidates: string[];
  };
  answeredSteps: RouterWizardStepId[];
  lastAction?: { step: number; value: string; at: string; targetModel?: string };
  nudgedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RouterWizardMessage {
  text: string;
  blocks?: Array<Record<string, unknown>>;
}

export type WizardActionResultKind = "advanced" | "duplicate" | "out_of_order" | "invalid" | "cancelled";
export interface WizardActionResult {
  kind: WizardActionResultKind;
  state: RouterWizardState;
  messages: RouterWizardMessage[];
}

const STEP_BY_NUMBER: Record<number, RouterWizardStepId> = {
  1: "step-1-greeting",
  2: "step-2-models",
  3: "step-3-budget",
  4: "step-4-privacy",
  5: "step-5-restricted-models",
  6: "step-6-same-provider",
  7: "step-7-done",
};

const STEP_ORDER: RouterWizardStepId[] = [
  "step-1-greeting",
  "step-2-models",
  "step-3-budget",
  "step-4-privacy",
  "step-5-restricted-models",
  "step-6-same-provider",
  "step-7-done",
];

function cloneState(state: RouterWizardState): RouterWizardState {
  return JSON.parse(JSON.stringify(state)) as RouterWizardState;
}

function stepIndex(step: RouterWizardStepId): number {
  return STEP_ORDER.indexOf(step);
}

function elapsedMs(from: string | undefined, to: string): number {
  const left = Date.parse(from ?? "");
  const right = Date.parse(to);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return right - left;
}

function shouldShowRestrictedStep(state: RouterWizardState): boolean {
  return state.answers.privacy === "custom" || state.configuredModels.length > 6;
}

function nextAfterPrivacy(state: RouterWizardState): RouterWizardStepId {
  return shouldShowRestrictedStep(state) ? "step-5-restricted-models" : "step-6-same-provider";
}

function setUpdated(state: RouterWizardState, now: string, action?: RouterWizardButtonAction, targetModel?: string): void {
  state.updatedAt = now;
  if (action) state.lastAction = { step: action.step, value: action.value, at: now, ...(targetModel ? { targetModel } : {}) };
}

function markAnswered(state: RouterWizardState, step: RouterWizardStepId): void {
  if (!state.answeredSteps.includes(step)) state.answeredSteps.push(step);
}

function defaultModelPlan(model: string): "subscription" | "pay_as_you_go" | "unknown" {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("glm") || lower.includes("chatgpt") || lower.includes("codex")) {
    return "subscription";
  }
  return "pay_as_you_go";
}

function budgetFromValue(value: string): RouterWizardState["answers"]["budget"] {
  if (value === "skip" || value === "unlimited") return null;
  const lowerBounds: Record<string, number> = {
    "<20": 20,
    "20-100": 20,
    "100-500": 100,
    "500+": 500,
  };
  return { range: value, monthlyUsd: lowerBounds[value] };
}

function fillDefaults(state: RouterWizardState): void {
  for (const model of state.configuredModels) {
    state.answers.models[model] ??= { planType: "unknown" };
  }
  state.answers.budget ??= null;
  state.answers.privacy ??= "standard";
  state.remainingModels = [];
}

function finalize(state: RouterWizardState, now: string): void {
  fillDefaults(state);
  state.step = "step-7-done";
  state.completedAt = now;
  setUpdated(state, now);
  markAnswered(state, "step-7-done");
}

export function createRouterWizardState(input: {
  models: string[];
  sameProviderCandidates?: string[];
  now?: string;
  thread?: RouterWizardState["thread"];
}): RouterWizardState {
  const now = input.now ?? new Date().toISOString();
  const models = Array.from(new Set(input.models.map((model) => model.trim()).filter(Boolean)));
  return {
    schemaVersion: "octoclaw.router_wizard_state/v1",
    ...(input.thread ? { thread: input.thread } : {}),
    step: "step-1-greeting",
    configuredModels: models,
    remainingModels: [...models],
    sameProviderCandidates: Array.from(new Set((input.sameProviderCandidates ?? []).map((model) => model.trim()).filter(Boolean))),
    answers: {
      models: {},
      budget: null,
      privacy: null,
      restrictedModels: [],
      sameProviderCandidates: [],
    },
    answeredSteps: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyWizardAction(
  inputState: RouterWizardState,
  action: RouterWizardButtonAction,
  options: { now?: string } = {},
): WizardActionResult {
  const now = options.now ?? new Date().toISOString();
  const expectedStep = STEP_BY_NUMBER[action.step];
  const state = cloneState(inputState);

  if (!expectedStep || state.completedAt || state.cancelledAt) {
    return { kind: "invalid", state: inputState, messages: [] };
  }

  const duplicateTargetModel = state.step === "step-2-models" ? state.remainingModels[0] : undefined;
  if (
    state.lastAction?.step === action.step
    && state.lastAction.value === action.value
    && (!state.lastAction.targetModel || state.lastAction.targetModel === duplicateTargetModel)
    && elapsedMs(state.lastAction.at, now) <= 30_000
  ) {
    return { kind: "duplicate", state: inputState, messages: [] };
  }

  if (expectedStep !== state.step) {
    const alreadyAnswered = state.answeredSteps.includes(expectedStep) || stepIndex(expectedStep) < stepIndex(state.step);
    return {
      kind: alreadyAnswered ? "out_of_order" : "invalid",
      state: inputState,
      messages: alreadyAnswered ? [{ text: "这一步已经回答过，要修改请用 `/octoclaw wizard reset step-N`." }] : [],
    };
  }

  if (state.step === "step-1-greeting") {
    if (action.value === "cancel") {
      state.cancelledAt = now;
      setUpdated(state, now, action);
      markAnswered(state, state.step);
      return { kind: "cancelled", state, messages: [{ text: "已取消 Auto Router 配置向导。" }] };
    }
    markAnswered(state, state.step);
    state.step = "step-2-models";
    setUpdated(state, now, action);
    return { kind: "advanced", state, messages: [] };
  }

  if (state.step === "step-2-models") {
    const model = state.remainingModels[0];
    if (!model) {
      state.step = "step-3-budget";
    } else {
      const planType = action.value === "subscription" || action.value === "pay_as_you_go" || action.value === "unknown"
        ? action.value
        : action.value === "skip" ? defaultModelPlan(model) : "unknown";
      state.answers.models[model] = { planType };
      state.remainingModels = state.remainingModels.slice(1);
      if (state.remainingModels.length === 0) {
        markAnswered(state, "step-2-models");
        state.step = "step-3-budget";
      }
    }
    setUpdated(state, now, action, model);
    const messages = action.value === "unknown"
      ? [{ text: "我会按按量付费来对待，路由的时候不会把它当免费。" }]
      : [];
    return { kind: "advanced", state, messages };
  }

  if (state.step === "step-3-budget") {
    state.answers.budget = budgetFromValue(action.value);
    markAnswered(state, state.step);
    state.step = "step-4-privacy";
    setUpdated(state, now, action);
    return { kind: "advanced", state, messages: [] };
  }

  if (state.step === "step-4-privacy") {
    state.answers.privacy = action.value === "local_only" ? "local_only" : action.value === "pick" ? "custom" : "standard";
    markAnswered(state, state.step);
    state.step = nextAfterPrivacy(state);
    setUpdated(state, now, action);
    return { kind: "advanced", state, messages: [] };
  }

  if (state.step === "step-5-restricted-models") {
    state.answers.restrictedModels = action.value.startsWith("ban:")
      ? action.value.slice(4).split(",").map((model) => model.trim()).filter(Boolean)
      : [];
    markAnswered(state, state.step);
    state.step = "step-6-same-provider";
    setUpdated(state, now, action);
    return { kind: "advanced", state, messages: [] };
  }

  if (state.step === "step-6-same-provider") {
    state.answers.sameProviderCandidates = action.value === "all"
      ? [...state.sameProviderCandidates]
      : action.value.startsWith("only:")
        ? state.sameProviderCandidates.filter((model) => model === action.value.slice(5))
        : [];
    markAnswered(state, state.step);
    finalize(state, now);
    if (!shouldShowRestrictedStep(state)) markAnswered(state, "step-5-restricted-models");
    return { kind: "advanced", state, messages: [] };
  }

  return { kind: "invalid", state: inputState, messages: [] };
}

export function handleWizardIdle(
  inputState: RouterWizardState,
  options: { now?: string } = {},
): { kind: "noop" | "nudge" | "finalized"; state: RouterWizardState; messages: RouterWizardMessage[] } {
  const now = options.now ?? new Date().toISOString();
  if (inputState.completedAt || inputState.cancelledAt) return { kind: "noop", state: inputState, messages: [] };
  const state = cloneState(inputState);
  const lastUserActivityAt = state.lastAction?.at ?? state.createdAt;
  if (elapsedMs(lastUserActivityAt, now) >= 7 * 24 * 60 * 60 * 1000) {
    finalize(state, now);
    return { kind: "finalized", state, messages: [{ text: "7 天没有操作，向导已使用默认值完成。" }] };
  }
  if (!state.nudgedAt && elapsedMs(lastUserActivityAt, now) >= 24 * 60 * 60 * 1000) {
    state.nudgedAt = now;
    setUpdated(state, now);
    return { kind: "nudge", state, messages: [{ text: "向导还没完成，要继续吗？[继续] [放弃]" }] };
  }
  return { kind: "noop", state: inputState, messages: [] };
}

export function resetWizardStep(
  inputState: RouterWizardState,
  step: RouterWizardStepId,
  options: { now?: string } = {},
): { state: RouterWizardState; messages: RouterWizardMessage[] } {
  const now = options.now ?? new Date().toISOString();
  const state = cloneState(inputState);
  const resetFrom = stepIndex(step);
  state.step = step;
  state.completedAt = undefined;
  state.cancelledAt = undefined;
  state.answeredSteps = state.answeredSteps.filter((answered) => stepIndex(answered) < resetFrom);
  if (resetFrom <= stepIndex("step-2-models")) {
    state.remainingModels = [...state.configuredModels];
    state.answers.models = {};
  }
  if (resetFrom <= stepIndex("step-3-budget")) state.answers.budget = null;
  if (resetFrom <= stepIndex("step-4-privacy")) state.answers.privacy = null;
  if (resetFrom <= stepIndex("step-5-restricted-models")) state.answers.restrictedModels = [];
  if (resetFrom <= stepIndex("step-6-same-provider")) state.answers.sameProviderCandidates = [];
  setUpdated(state, now);
  return { state, messages: [{ text: `已重置 ${step}，可以继续配置。` }] };
}
