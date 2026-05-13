import { JUDGE_INPUT_CAPS, type JudgeInput } from "./judge-schema.js";

export function buildJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw's semantic routing judge.",
    "Return only strict JSON with exactly 3 fields: route, confidence, complexity.",
    "route must be \"reply\" or \"delegate\".",
    "confidence must be a number from 0.0 to 1.0.",
    "complexity must be \"simple\", \"normal\", \"complex\", or \"deep\".",
    "Do not include scenario, complexity_confidence, reasoning, thought, or any other field.",
  ].join("\n");
}

export function buildJudgeUserPrompt(input: JudgeInput): string {
  const userMessage = (input.userMessage ?? input.prompt ?? "").slice(0, JUDGE_INPUT_CAPS.userMessage);
  const recentLedgerSummary = input.recentLedgerSummary?.slice(0, JUDGE_INPUT_CAPS.recentLedgerSummary);
  return JSON.stringify({
    current_turn: userMessage,
    session_binding: input.sessionBinding ?? input.sessionKey ?? "",
    recent_ledger_summary: recentLedgerSummary ?? "",
    context_packet: input.contextPacket ?? null,
    runtime_signals: input.runtimeSignals ?? {},
    output_contract: {
      required_fields: ["route", "confidence", "complexity"],
      forbidden_fields: ["scenario", "complexity_confidence", "complexityConfidence", "reasoning", "thought"],
    },
  });
}

export function buildAckWriterSystemPrompt(): string {
  return "Write a concise acknowledgement for the current routed turn.";
}
