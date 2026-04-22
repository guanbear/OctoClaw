export const POLICY_LABELS = {
  route: ["reply", "delegate"] as const,
  reply_mode: ["answer", "clarify"] as const,
  delegate_role: ["observer", "default", "code", "research", "review"] as const,
  coordination_mode_hint: ["solo_worker", "advisor_assisted", "multi_agent_controlled"] as const,
  complexity: ["simple", "normal", "deep"] as const,
  scope: ["local", "remote", "both", "unknown"] as const,
  tool_need_hint: ["none", "maybe", "required"] as const,
  duration_hint: ["short", "medium", "long"] as const,
} as const;

export type PolicyRoute = typeof POLICY_LABELS.route[number];
export type ReplyMode = typeof POLICY_LABELS.reply_mode[number];
export type DelegateRole = typeof POLICY_LABELS.delegate_role[number];
export type CoordinationModeHint = typeof POLICY_LABELS.coordination_mode_hint[number];
export type PolicyComplexity = typeof POLICY_LABELS.complexity[number];
export type PolicyScope = typeof POLICY_LABELS.scope[number];
export type ToolNeedHint = typeof POLICY_LABELS.tool_need_hint[number];
export type DurationHint = typeof POLICY_LABELS.duration_hint[number];

export const IRON_LAWS = [
  {
    id: "delegate_on_required_tooling",
    rule:
      "If new tooling, probing, command execution, workspace access, or environment lookup is required, default to delegate rather than reply.",
  },
  {
    id: "delegate_on_long_running_work",
    rule:
      "If the work is likely to exceed one minute or clearly exceed main-thread fast-response budget, default to delegate rather than reply.",
  },
  {
    id: "clarify_before_guessing_scope",
    rule: "If scope or target is unclear, prefer clarify rather than guessing and executing in the wrong place.",
  },
  {
    id: "main_thread_exception_only",
    rule:
      "Only keep work on the main thread when direct reply is truly part of the user-facing response and no new execution work unit is needed.",
  },
] as const;

export const DECISION_RUBRIC = {
  reply: [
    "No new execution work unit is needed.",
    "The main thread can answer safely now.",
    "Or the most reasonable next step is to ask a clarifying question.",
    "No new tooling, commands, environment probing, or file writes are needed.",
    "Any needed state can be answered from existing truth, summaries, or artifact references.",
  ],
  delegate: [
    "A new execution work unit is needed.",
    "Workspace access, environment probing, command execution, log reading, verification, or a longer processing flow is needed.",
    "A forced main-thread reply would rely on guessing or stuff execution work into the main lane.",
    "The task is worth isolating from the main agent context.",
  ],
  clarify: [
    "Current information is insufficient for a safe direct answer.",
    "Scope, target, or another critical slot is unclear.",
    "It is also not yet appropriate to start delegated execution directly.",
  ],
} as const;

export const ANTI_REPLY_BIAS_RULES = [
  {
    id: "questions_not_equal_reply",
    rule: "Questions do not automatically mean reply.",
  },
  {
    id: "fresh_state_lookups_delegate",
    rule:
      "Fresh state lookup such as version/latest/status/local-machine/remote/release comparison should default toward delegate.",
  },
  {
    id: "real_probing_delegate",
    rule: "Any real probe, environment read, workspace inspection, or command execution should default toward delegate.",
  },
  {
    id: "execution_truth_and_provenance_delegate",
    rule:
      "Execution truth follow-up such as task status, who handled it, whether it was delegated, or what actually ran should default toward delegate.",
  },
  {
    id: "scope_unknown_clarify",
    rule: "If scope is unknown, prefer clarify.",
  },
  {
    id: "no_guessing_scope_to_force_answer",
    rule: "Do not guess scope or target just to force reply.answer.",
  },
] as const;

export const VALIDATOR_DEFAULT_RULES = [
  {
    if: "tool_need_hint == required",
    then: "prefer delegate",
  },
  {
    if: "duration_hint == long",
    then: "prefer delegate",
  },
  {
    if: "tool_need_hint == required && scope == unknown",
    then: "reply_mode = clarify before delegate",
  },
  {
    if: "tool_need_hint == none && duration_hint == short",
    then: "reply remains eligible",
  },
] as const;

export const JudgeOutputSchema = {
  route: "reply | delegate (REQUIRED)",
  confidence: "0.0-1.0 float (REQUIRED, your certainty about this routing decision)",
  reply_mode: "answer | clarify | null",
  delegate_role: "observer | default | code | research | review | null",
  coordination_mode_hint: "solo_worker | advisor_assisted | multi_agent_controlled | null",
  complexity: "simple | normal | deep | null",
  scope: "local | remote | both | unknown (REQUIRED)",
  tool_need_hint: "none | maybe | required (REQUIRED)",
  duration_hint: "short | medium | long (REQUIRED)",
  reason_codes: [] as string[],
} as const;

export const RemoteJudgeOutputSchema = {
  ...JudgeOutputSchema,
  adjudication_reason: "",
  override_recommendation: "accept_local | override_local",
  confidence_delta: 0.0,
} as const;

export const AckWriterOutputSchema = {
  ack_text: "",
  tone: "neutral | warm | concise",
  suppression_hint: "send | suppress",
} as const;

export const AckWriterInputSchema = {
  current_turn: "",
  route: "reply | delegate",
  reply_mode: "answer | clarify | null",
  delegate_role: "observer | default | code | research | review | null",
  scope: "local | remote | both | unknown",
  status_phase: "",
  reason_codes: [] as string[],
} as const;
