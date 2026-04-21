import {
  AckWriterInputSchema,
  AckWriterOutputSchema,
  ANTI_REPLY_BIAS_RULES,
  DECISION_RUBRIC,
  IRON_LAWS,
  JudgeOutputSchema,
  POLICY_LABELS,
  RemoteJudgeOutputSchema,
  VALIDATOR_DEFAULT_RULES,
} from "./decision-policy-spec.js";

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderPolicyLabels(): string {
  return [
    "## Policy labels",
    ...Object.entries(POLICY_LABELS).map(([key, labels]) => `- ${key}: ${labels.map((label) => `\"${label}\"`).join(" | ")}`),
  ].join("\n");
}

function renderRouteDefinitions(): string {
  return [
    "## Route definitions",
    "- route=reply: stay on the main thread because no new execution work unit is needed. This includes direct answers and safe clarification questions.",
    "- route=delegate: create or hand off a new execution work unit because tools, probing, inspection, verification, or longer-running work are needed.",
    "- reply_mode=answer: the main thread can answer now without new tooling or guessing.",
    "- reply_mode=clarify: ask for missing scope / target / critical slot before answering or delegating.",
    "- delegate_role=observer: read-only observation / snapshot work.",
    "- delegate_role=default: generic delegated work when no more specific role fits.",
    "- delegate_role=code: implementation / editing / fix / build work.",
    "- delegate_role=research: investigation / lookup / comparison / synthesis work.",
    "- delegate_role=review: audit / QA / validation / critique work.",
    "",
    "Examples:",
    "- 'Explain what this TypeScript type means' -> likely reply + reply_mode=answer.",
    "- 'Which version is installed on this machine?' -> delegate, because this is a fresh environment lookup.",
    "- 'Check repo status and summarize' -> delegate, because this requires workspace inspection.",
    "- 'Do you mean package A or package B?' when target is unclear -> reply + reply_mode=clarify.",
    "- 'Run tests, inspect failures, and fix them' -> delegate, because this is a new execution work unit and likely long-running.",
  ].join("\n");
}

function renderIronLaws(): string {
  return [
    "## Iron laws",
    ...IRON_LAWS.map((law, index) => `${index + 1}. ${law.id}: ${law.rule}`),
  ].join("\n");
}

function renderAntiReplyBiasRules(): string {
  return [
    "## Anti-reply-bias rules",
    ...ANTI_REPLY_BIAS_RULES.map((rule, index) => `${index + 1}. ${rule.rule}`),
  ].join("\n");
}

function renderDecisionRubric(): string {
  return [
    "## Decision rubric",
    "### reply (§10.1)",
    ...DECISION_RUBRIC.reply.map((item, index) => `${index + 1}. ${item}`),
    "### delegate (§10.2)",
    ...DECISION_RUBRIC.delegate.map((item, index) => `${index + 1}. ${item}`),
    "### clarify (§10.3)",
    ...DECISION_RUBRIC.clarify.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function renderValidatorDefaultRules(): string {
  return [
    "## Validator default rules",
    ...VALIDATOR_DEFAULT_RULES.map((rule, index) => `${index + 1}. if ${rule.if}, then ${rule.then}`),
  ].join("\n");
}

function renderCriticalRules(): string {
  return [
    "## CRITICAL defaults",
    "- Questions ≠ reply. 问句不等于reply.",
    "- Tool/probe/command → delegate. 新工具调用默认委派.",
    "- Expected >1min → delegate. 预计超过1分钟默认委派.",
    "- Scope unknown → clarify. scope不明优先clarify.",
    "- check version/status/environment → delegate. 查版本/查状态/查环境 → delegate.",
  ].join("\n");
}

function renderLocalJudgeInstructions(): string {
  return [
    "## Local judge instructions",
    "- You are the hot-path authority for route selection.",
    "- Top-level route options are ONLY \"reply\" or \"delegate\".",
    "- Do not invent other route labels.",
    "- If route=reply, set reply_mode to \"answer\" or \"clarify\".",
    "- If route=delegate, set delegate_role to the best matching role; otherwise use null.",
    "- coordination_mode_hint, complexity, scope, tool_need_hint, and duration_hint must use only canonical labels.",
    "- reason_codes should be concise machine-readable strings explaining the decision.",
    "- Output JSON only. No prose before or after JSON.",
  ].join("\n");
}

function renderRemoteJudgeInstructions(): string {
  return [
    "## Remote judge instructions",
    "- You are escalation / adjudication only.",
    "- Review the local candidate against the same canonical policy.",
    "- Keep the local decision when it is policy-compliant and safe.",
    "- Override only when the local decision is materially unsafe, materially wrong, or conflicts with the canonical policy defaults.",
    "- Output JSON only. No prose before or after JSON.",
  ].join("\n");
}

export function buildLocalJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw local_judge. You are the hot-path routing authority.",
    "Implement exactly the canonical decision policy spec. Do not improvise. Do not redesign abstractions.",
    renderCriticalRules(),
    renderRouteDefinitions(),
    renderPolicyLabels(),
    renderIronLaws(),
    renderAntiReplyBiasRules(),
    renderDecisionRubric(),
    renderValidatorDefaultRules(),
    renderLocalJudgeInstructions(),
    "## Output JSON schema",
    renderJson(JudgeOutputSchema),
  ].join("\n\n");
}

export function buildLocalJudgeUserPrompt(
  userMessage: string,
  contextPacket?: unknown,
  sessionBinding?: string,
  recentLedgerSummary?: string,
): string {
  const sections = [
    "Evaluate the following turn under the canonical policy spec and return JSON only.",
    `user_message: ${renderJson(userMessage)}`,
  ];

  if (contextPacket !== undefined) {
    sections.push(`context_packet: ${renderJson(contextPacket)}`);
  }
  if (sessionBinding !== undefined) {
    sections.push(`session_binding: ${renderJson(sessionBinding)}`);
  }
  if (recentLedgerSummary !== undefined) {
    sections.push(`recent_ledger_summary: ${renderJson(recentLedgerSummary)}`);
  }

  return sections.join("\n\n");
}

export function buildRemoteJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw remote_judge. You are escalation / adjudication only.",
    "Implement exactly the canonical decision policy spec. Do not improvise. Do not redesign abstractions.",
    renderCriticalRules(),
    renderRouteDefinitions(),
    renderPolicyLabels(),
    renderIronLaws(),
    renderAntiReplyBiasRules(),
    renderDecisionRubric(),
    renderValidatorDefaultRules(),
    renderRemoteJudgeInstructions(),
    "## Output JSON schema",
    renderJson(RemoteJudgeOutputSchema),
  ].join("\n\n");
}

export function buildRemoteJudgeUserPrompt(
  userMessage: string,
  localCandidate: unknown,
  escalationReason: string,
  expandedPacket?: unknown,
): string {
  const sections = [
    "Adjudicate the local candidate under the canonical policy spec and return JSON only.",
    `user_message: ${renderJson(userMessage)}`,
    `local_candidate: ${renderJson(localCandidate)}`,
    `escalation_reason: ${renderJson(escalationReason)}`,
  ];

  if (expandedPacket !== undefined) {
    sections.push(`expanded_packet: ${renderJson(expandedPacket)}`);
  }

  return sections.join("\n\n");
}

export function buildAckWriterSystemPrompt(): string {
  return [
    "You are OctoClaw ack_writer.",
    "You are NOT a route classifier. Do NOT output route, role, or complexity.",
    "Only ask yourself for ack_text, tone, suppression_hint. Only output those fields.",
    "You may use route / reply_mode / delegate_role / scope only as passive context for wording.",
    "Do not override routing, role selection, complexity, scope, or any judge decision.",
    "Write a short Chinese ACK or nudge only when helpful.",
    "Prefer concise, natural wording. Do not repeat the user message.",
    "Output JSON only. No prose before or after JSON.",
    "## Input packet schema",
    renderJson(AckWriterInputSchema),
    "## Output JSON schema",
    renderJson(AckWriterOutputSchema),
  ].join("\n\n");
}

export function buildAckWriterUserPrompt(
  userMessage: string,
  route: string,
  replyMode: string | null,
  delegateRole: string | null,
  scope: string,
): string {
  return [
    "Write ack_writer output JSON only.",
    renderJson({
      current_turn: userMessage,
      route,
      reply_mode: replyMode,
      delegate_role: delegateRole,
      scope,
    }),
  ].join("\n\n");
}

export function buildLocalJudgePromptView(): string {
  return buildLocalJudgeSystemPrompt();
}

export function buildRemoteJudgePromptView(): string {
  return buildRemoteJudgeSystemPrompt();
}

export function buildAckWriterPromptView(): string {
  return buildAckWriterSystemPrompt();
}
