export const INTENT_CLASS_VALUES = [
  "plain_chat",
  "local_surface_lookup",
  "fresh_live_lookup",
  "execution_followup",
  "delegated_work",
  "undetermined",
] as const;

export type IntentClass = (typeof INTENT_CLASS_VALUES)[number];

export interface IntentHints {
  intentClass?: IntentClass;
  surfaceBound?: boolean;
  requiresFreshLookup?: boolean;
  executionFollowup?: boolean;
  delegatedWork?: boolean;
}

export interface IntentPacket {
  intentClass: IntentClass;
  confidence: number;
  evidence: string[];
}

export function isIntentClass(value: string): value is IntentClass {
  return INTENT_CLASS_VALUES.includes(value as IntentClass);
}

export function buildIntentPacket(input: IntentHints = {}): IntentPacket {
  if (input.intentClass) {
    return {
      intentClass: input.intentClass,
      confidence: 1,
      evidence: ["explicit_intent_class"],
    };
  }

  if (input.surfaceBound) {
    return {
      intentClass: "local_surface_lookup",
      confidence: 0.9,
      evidence: ["surface_bound"],
    };
  }

  if (input.requiresFreshLookup) {
    return {
      intentClass: "fresh_live_lookup",
      confidence: 0.85,
      evidence: ["fresh_lookup_required"],
    };
  }

  if (input.executionFollowup) {
    return {
      intentClass: "execution_followup",
      confidence: 0.85,
      evidence: ["execution_followup"],
    };
  }

  if (input.delegatedWork) {
    return {
      intentClass: "delegated_work",
      confidence: 0.8,
      evidence: ["delegated_work_required"],
    };
  }

  return {
    intentClass: "undetermined",
    confidence: 0.3,
    evidence: ["no_structured_intent_signal"],
  };
}
