import type { JudgeInput, JudgeOutput } from "./judge-schema.js";

export function fallbackRoute(input: JudgeInput): JudgeOutput {
  const signals = input.runtimeSignals ?? {};
  if (signals.statusOrProvenanceRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (signals.sessionControlRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (signals.explicitDelegate) {
    return { route: "delegate", confidence: 0.9, complexity: "normal" };
  }
  return { route: "reply", confidence: 0.5, complexity: "normal" };
}

export function applyJudgeConfidenceFallback(input: JudgeInput, result: JudgeOutput, minConfidence = 0.65): JudgeOutput {
  return result.confidence < minConfidence ? fallbackRoute(input) : result;
}
