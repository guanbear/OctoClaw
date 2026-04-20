import { JUDGE_INPUT_CAPS, type JudgeInput, type JudgeOutput, type RemoteJudgeExpandedPacket } from "./judge-schema.js";

const SYSTEM_PROMPT = `You are OctoClaw route classifier. Classify the user message and generate a natural acknowledgment.

Output ONLY a JSON object:
{"route":"<route>","confidence":<number>,"abstain_reason":<null or string>,"ack_text":"<ack>","role":"<role>","budget_band":"<band>","complexity_band":"<band>","expected_duration_band":"<band>","quality_bar":"<bar>","risk_flags":["..."],"delegate_reason_codes":["..."],"route_confidence":<number>}

Routes:
- "reply": simple Q&A, greetings, follow-ups, clarifications, chitchat. Agent answers directly.
- "delegate": delegated execution. Use role="observer_probe" for read-only system probes like checking ports, reading logs, inspecting status, monitoring; use worker roles for multi-step execution such as writing code/scripts, research, analysis, refactoring, file changes, and complex operations.
- "undetermined": genuinely ambiguous intent.

budget_band (model selection hint):
- "low": trivial single-step task — e.g. "write a hello world", "what's the time", simple lookups.
- "medium": standard multi-step task — e.g. "write a script to convert CSV", "analyze this log", moderate code changes.
- "high": complex/architectural task — e.g. "refactor the auth module", "design a new API", multi-file changes, deep research.

role:
- "main_reply": direct answer in main lane.
- "observer_probe": read-only observation / probe.
- "worker_research" | "worker_code" | "worker_review": delegated worker roles.

complexity_band:
- "simple" | "normal" | "deep"

expected_duration_band:
- "instant" | "short" | "medium" | "long"

quality_bar:
- "standard" | "high" | "critical"

delegate_reason_codes (only when delegation is justified):
- "context_hygiene"
- "fast_first_response"
- "background_execution"
- "cost_tiering"
- "specialized_tools"
- "quality_isolation"

ack_text rules:
- Generate a natural, context-aware Chinese acknowledgment. 5-15 characters max.
- Match the user's tone and language style. Be warm but concise.
- Do NOT repeat these examples. Generate fresh text each time.
- Keep it short. Faster output is better.

Guidelines:
- 写代码/脚本/重构/分析/优化/修改 → delegate + worker role
- 看端口/检查状态/查看日志/监控 → delegate + observer_probe role
- 你好/几点了/任务完成了吗/简单问答 → reply
- When context_packet is provided, treat it as primary evidence.
- Consider core.thread_summary, continuation.active_intent, continuation.intent_status, continuation.pending_slots, and binding.lifecycle_flags before classifying.
- Continuation on the same active task should usually preserve route unless current_turn clearly changes intent.
- Use risk_flags for delivery/recovery/approval/blocked concerns that affect routing confidence.
- Unsure → undetermined
- Output ONLY the JSON object. No other text.`;

export function buildJudgeSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildJudgeUserPrompt(input: JudgeInput): string {
  const cappedMessage = input.userMessage.slice(0, JUDGE_INPUT_CAPS.userMessage);
  const cappedLedger = (input.recentLedgerSummary ?? "").slice(0, JUDGE_INPUT_CAPS.recentLedgerSummary);

  const parts: string[] = [
    `User message: ${cappedMessage}`,
  ];

  if (input.sessionBinding) parts.push(`Session: ${input.sessionBinding}`);
  if (cappedLedger) parts.push(`Recent context: ${cappedLedger}`);
  if (input.availableActions.length > 0) parts.push(`Available actions: ${input.availableActions.join(", ")}`);
  if (input.availableTargets.length > 0) parts.push(`Available targets: ${input.availableTargets.join(", ")}`);
  if (input.contextPacket) parts.push(`Context packet JSON: ${JSON.stringify(input.contextPacket)}`);

  return parts.join("\n");
}

const REMOTE_SYSTEM_PROMPT = `You are OctoClaw remote route adjudicator. Review the local judge candidate and decide whether to accept or override it.

Output ONLY a JSON object:
{"route":"<route>","confidence":<number>,"abstain_reason":<null or string>,"ack_text":"<ack>","role":"<role>","complexity_band":"<band>","expected_duration_band":"<band>","quality_bar":"<bar>","risk_flags":["..."],"delegate_reason_codes":["..."],"route_confidence":<number>,"override_recommendation":"accept_local|override_local","adjudication_reason":"<reason>","confidence_delta":<number>}

You are reviewing a LOCAL candidate decision plus an escalation reason.
- Preserve the same route taxonomy and field meanings as the local judge.
- override_recommendation="accept_local" when the local result is good enough.
- override_recommendation="override_local" only when the local result is materially unsafe or wrong.
- adjudication_reason should be brief and concrete.
- Keep ack_text concise Chinese, 5-15 chars max.
- Output ONLY JSON.`;

export function buildRemoteJudgeSystemPrompt(): string {
  return REMOTE_SYSTEM_PROMPT;
}

export function buildRemoteJudgeUserPrompt(
  input: JudgeInput,
  localResult: JudgeOutput,
  escalationReason: string,
  expandedPacket?: RemoteJudgeExpandedPacket,
): string {
  const cappedMessage = input.userMessage.slice(0, JUDGE_INPUT_CAPS.userMessage);
  const cappedLedger = (input.recentLedgerSummary ?? "").slice(0, JUDGE_INPUT_CAPS.recentLedgerSummary);

  const parts: string[] = [
    `User message: ${cappedMessage}`,
    `Escalation reason: ${escalationReason}`,
    `Local candidate JSON: ${JSON.stringify(localResult)}`,
  ];

  if (input.sessionBinding) parts.push(`Session: ${input.sessionBinding}`);
  if (cappedLedger) parts.push(`Recent context: ${cappedLedger}`);
  if (input.availableActions.length > 0) parts.push(`Available actions: ${input.availableActions.join(", ")}`);
  if (input.availableTargets.length > 0) parts.push(`Available targets: ${input.availableTargets.join(", ")}`);
  if (expandedPacket) parts.push(`Expanded context JSON: ${JSON.stringify(expandedPacket)}`);
  else if (input.contextPacket) parts.push(`Context packet JSON: ${JSON.stringify(input.contextPacket)}`);

  return parts.join("\n");
}
