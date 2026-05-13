import type { JudgeInput, JudgeOutput } from "../semantic/judge-schema.js";
import { fallbackRoute } from "../semantic/fallback.js";

export interface AgentModelApplication {
  actualModel: string;
  suggestedModel?: string;
  applied: boolean;
}

export function renderModelFooter(model: string): string {
  return `Model: ${model}`;
}

export function applyRouterRecommendationForAgent(input: {
  agentRole: "main" | "subagent";
  currentModel: string;
  recommendedModel?: string;
}): AgentModelApplication {
  if (!input.recommendedModel || input.recommendedModel === input.currentModel) {
    return { actualModel: input.currentModel, applied: false };
  }
  if (input.agentRole === "main") {
    return { actualModel: input.currentModel, suggestedModel: input.recommendedModel, applied: false };
  }
  return { actualModel: input.recommendedModel, applied: true };
}

export function isolateShadowFailure<T>(liveDecision: T, emitShadow: () => void): T {
  try {
    emitShadow();
  } catch {
    return liveDecision;
  }
  return liveDecision;
}

export function recoverFromJudgeFailure(input: JudgeInput, _error: unknown): JudgeOutput {
  return fallbackRoute(input);
}

export function hotPathAllowsNetworkCall(target: string): boolean {
  return target === "local_judge_endpoint";
}

export function isRouterDataPathLocal(pathValue: string): boolean {
  return pathValue.startsWith("~/.openclaw/") || pathValue.startsWith(".openclaw/") || pathValue.startsWith("/tmp/") || pathValue.startsWith("/");
}
