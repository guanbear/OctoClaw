import { buildCatalogCasePack } from "./catalog.js";
import { sanitizeStabilityArtifact } from "./sanitize.js";
import { validateStabilityCasePack } from "./validation.js";
import type { StabilityCasePack, StabilityFailurePacket } from "./types.js";

export type StabilityFailureClassification = NonNullable<StabilityFailurePacket["classification"]>;

export interface AiPrompt {
  model: "zhipu/GLM-5.1" | "cliproxyapi/gpt-5.5";
  prompt: string;
}

export interface AiCaseSelectionPromptInput {
  recentReportSummaries: string[];
  modelListSummary: string;
  recentCommitSummary?: string;
}

export interface AiCaseSelectionOptions {
  generatedAt?: string;
  maxLiveCases: number;
}

export interface AiCaseSelectionResult {
  pack: StabilityCasePack;
  fallbackUsed: boolean;
  failureCode?: string;
  errors: string[];
  escalationModel?: "cliproxyapi/gpt-5.5";
}

export interface FixDraftGuardInput {
  filesChanged: number;
  linesChanged: number;
  touchesHotPath: boolean;
  validationPassed: boolean;
  attemptedCommands: string[];
  mutatesOpenClawConfig: boolean;
}

export interface FixDraftGuardResult {
  allowed: boolean;
  needsHumanReview: boolean;
  reasonCodes: string[];
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const BLOCKED_COMMANDS: Array<[RegExp, string]> = [
  [/\bgit\s+commit\b/iu, "blocked_command:commit"],
  [/\bgit\s+push\b/iu, "blocked_command:push"],
  [/\bdeploy\b/iu, "blocked_command:deploy"],
  [/\brestart\b/iu, "blocked_command:restart"],
];

export function buildAiCaseSelectionPrompt(input: AiCaseSelectionPromptInput): AiPrompt {
  return {
    model: "zhipu/GLM-5.1",
    prompt: [
      "Select a schema-valid OctoClaw Stability Smoke v2 nightly case pack.",
      "Return JSON only with fields: confidence, casePack, rationale.",
      "Do not include raw transcripts, credentials, or extra live Slack volume.",
      `Recent reports: ${input.recentReportSummaries.join(" | ") || "(none)"}`,
      `Models: ${input.modelListSummary}`,
      `Recent commits: ${input.recentCommitSummary ?? "(not provided)"}`,
    ].join("\n"),
  };
}

export function selectStabilityCasePackFromAi(raw: unknown, options: AiCaseSelectionOptions): AiCaseSelectionResult {
  const fallback = buildCatalogCasePack("nightly", { generatedAt: options.generatedAt });
  const parsed = parseAiJson(raw);
  if (!isRecord(parsed)) {
    return { pack: fallback, fallbackUsed: true, failureCode: "smoke_spec_mismatch", errors: ["AI output is not valid JSON object"] };
  }

  const casePack = isRecord(parsed.casePack) ? parsed.casePack : parsed;
  const validation = validateStabilityCasePack(casePack, { maxLiveCases: options.maxLiveCases });
  if (!validation.ok) {
    return { pack: fallback, fallbackUsed: true, failureCode: "smoke_spec_mismatch", errors: validation.errors };
  }

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 1;
  return {
    pack: validation.pack,
    fallbackUsed: false,
    errors: [],
    ...(confidence < LOW_CONFIDENCE_THRESHOLD ? { escalationModel: "cliproxyapi/gpt-5.5" as const } : {}),
  };
}

export function buildAiReviewPrompt(failures: StabilityFailurePacket[]): AiPrompt {
  const sanitized = sanitizeStabilityArtifact(failures);
  return {
    model: "zhipu/GLM-5.1",
    prompt: [
      "Review these OctoClaw Stability Smoke v2 failure packets.",
      "Classify each group as runtime_bug, smoke_spec_bug, environment_issue, or unknown.",
      "Use only structured failure packet evidence; do not ask for raw transcripts.",
      JSON.stringify(sanitized, null, 2),
    ].join("\n"),
  };
}

export function classifyStabilityFailure(packet: StabilityFailurePacket): StabilityFailurePacket {
  return {
    ...packet,
    classification: packet.classification ?? classificationForCode(packet.code),
  };
}

export function shouldRunFixDraft(failures: StabilityFailurePacket[]): boolean {
  return failures
    .map(classifyStabilityFailure)
    .some((packet) => packet.classification === "runtime_bug" && (packet.severity === "blocker" || packet.severity === "major"));
}

export function evaluateFixDraftGuard(input: FixDraftGuardInput): FixDraftGuardResult {
  const reasonCodes = [
    ...input.attemptedCommands.flatMap((command) => blockedCommandReason(command)),
    ...(input.mutatesOpenClawConfig ? ["blocked_openclaw_config_mutation"] : []),
    ...(input.filesChanged > 5 ? ["too_many_files"] : []),
    ...(input.linesChanged > 300 ? ["too_many_lines"] : []),
    ...(input.touchesHotPath ? ["hot_path_touched"] : []),
    ...(!input.validationPassed ? ["validation_failed"] : []),
  ];
  return {
    allowed: reasonCodes.length === 0,
    needsHumanReview: reasonCodes.length > 0,
    reasonCodes,
  };
}

function classificationForCode(code: string): StabilityFailureClassification {
  if (code === "smoke_spec_mismatch" || code.startsWith("nightly_")) return "smoke_spec_bug";
  if (code === "gateway_restart_drop" || code === "replay_missing") return "environment_issue";
  if (
    code === "delegate_footer_without_spawn"
    || code === "ack_misleading_text"
    || code === "provider_bare_error"
    || code === "wizard_flow_stuck"
    || code === "parent_echo_after_native_final"
  ) {
    return "runtime_bug";
  }
  return "unknown";
}

function parseAiJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function blockedCommandReason(command: string): string[] {
  return BLOCKED_COMMANDS
    .filter(([pattern]) => pattern.test(command))
    .map(([, reason]) => reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
