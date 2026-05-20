import { buildRecommendation, type ModelIntelLite, type RouterLiteRecommendation, type RouterLiteRequest } from "@octoclaw/router";

export interface RouterModelExpectationInput {
  complexity: RouterLiteRequest["judge"]["complexity"];
  models: ModelIntelLite[];
  nativeFallbackOrder?: string[];
  restrictedModels?: string[];
}

export interface RouterModelExpectationResult {
  expectedModel?: string;
  qualityFloor: RouterLiteRecommendation["qualityFloor"];
  outputBudget: RouterLiteRecommendation["outputBudget"];
  eligibleModels: string[];
  rejectedModels: RouterLiteRecommendation["rejectedModels"];
  proposalCandidates: string[];
  reasonCodes: string[];
  mode: RouterLiteRecommendation["mode"];
}

export interface WizardStabilityClick {
  step: number;
  value: string;
  atMs: number;
}

export interface WizardStabilityStateInput {
  currentStep: number;
  answeredSteps: number[];
  click: WizardStabilityClick;
  previousClickAtMs?: number;
}

export interface WizardStabilityStateResult {
  gate: "pass" | "fail";
  nextStep: number;
  message: string;
  failureCode?: string;
}

export function resolveRouterModelExpectation(input: RouterModelExpectationInput): RouterModelExpectationResult {
  const recommendation = buildRecommendation(input.models, {
    complexity: input.complexity,
    allModels: input.models,
    runtimeSignals: {},
    userBans: bansForAllComplexities(input.restrictedModels ?? []),
    userDispreferred: {},
    scoreOverrides: {},
    nativeFallbackOrder: input.nativeFallbackOrder,
  });

  return {
    expectedModel: recommendation.recommendedModel,
    qualityFloor: recommendation.qualityFloor,
    outputBudget: recommendation.outputBudget,
    eligibleModels: recommendation.eligibleModels,
    rejectedModels: recommendation.rejectedModels,
    proposalCandidates: input.models
      .filter((model) => model.proposalOnly || !model.configured)
      .map((model) => model.modelKey),
    reasonCodes: recommendation.reasonCodes,
    mode: recommendation.mode,
  };
}

export function evaluateWizardStabilityState(input: WizardStabilityStateInput): WizardStabilityStateResult {
  const isDuplicateClick = input.previousClickAtMs !== undefined && input.click.atMs - input.previousClickAtMs <= 30_000;
  if (input.answeredSteps.includes(input.click.step) || (isDuplicateClick && input.click.step < input.currentStep)) {
    return {
      gate: "pass",
      nextStep: input.currentStep,
      message: "这一步已经回答过",
    };
  }
  if (input.click.step !== input.currentStep) {
    return {
      gate: "fail",
      nextStep: input.currentStep,
      message: "步骤顺序不匹配",
      failureCode: "wizard_out_of_order",
    };
  }
  return {
    gate: "pass",
    nextStep: input.currentStep + 1,
    message: "ok",
  };
}

function bansForAllComplexities(models: string[]): Record<string, RouterLiteRequest["judge"]["complexity"][]> {
  return Object.fromEntries(models.map((model) => [model, ["simple", "normal", "complex", "deep"]]));
}
