import {
  CASE_PACK_SCHEMA_VERSION,
  type StabilityCase,
  type StabilityCaseMode,
  type StabilityGeneratedBy,
  type StabilityRunKind,
  type StabilitySeverity,
  type ValidateCasePackOptions,
  type ValidateCasePackResult,
} from "./types.js";

const CASE_MODES = new Set<StabilityCaseMode>(["live_slack", "synthetic", "replay", "router_model", "wizard", "provider"]);
const SEVERITIES = new Set<StabilitySeverity>(["blocker", "major", "minor", "observe"]);
const RUN_KINDS = new Set<StabilityRunKind>(["post_deploy", "nightly", "full_3d", "manual"]);
const GENERATED_BY = new Set<StabilityGeneratedBy>(["catalog", "glm-5.1", "gpt-5.5", "manual"]);

export function validateStabilityCasePack(raw: unknown, options: ValidateCasePackOptions = {}): ValidateCasePackResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["case pack must be an object"] };
  }

  if (raw.schemaVersion !== CASE_PACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CASE_PACK_SCHEMA_VERSION}`);
  }
  if (typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt))) {
    errors.push("generatedAt must be an ISO timestamp");
  }
  if (typeof raw.generatedBy !== "string" || !GENERATED_BY.has(raw.generatedBy as StabilityGeneratedBy)) {
    errors.push("unknown generatedBy");
  }
  if (typeof raw.runKind !== "string" || !RUN_KINDS.has(raw.runKind as StabilityRunKind)) {
    errors.push("unknown runKind");
  }
  if (!Array.isArray(raw.cases)) {
    errors.push("cases must be an array");
  }

  const cases = Array.isArray(raw.cases) ? raw.cases : [];
  const validatedCases: StabilityCase[] = [];
  let liveCases = 0;

  cases.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`cases[${index}] must be an object`);
      return;
    }

    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id.length === 0) {
      errors.push(`cases[${index}] id is required`);
    }

    const mode = item.mode;
    if (typeof mode !== "string" || !CASE_MODES.has(mode as StabilityCaseMode)) {
      errors.push(`cases[${index}] unknown mode`);
    }

    const severity = item.severity;
    if (typeof severity !== "string" || !SEVERITIES.has(severity as StabilitySeverity)) {
      errors.push(`cases[${index}] unknown severity`);
    }

    const tags = Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string") ? item.tags : undefined;
    if (!tags) {
      errors.push(`cases[${index}] tags must be string[]`);
    }

    if (!isRecord(item.expect)) {
      errors.push(`cases[${index}] expect must be an object`);
    }

    if (mode === "live_slack") {
      liveCases += 1;
      if (typeof item.prompt !== "string" || item.prompt.trim().length === 0) {
        errors.push(`cases[${index}] live_slack requires prompt`);
      }
      if (typeof item.maxRuntimeMs !== "number" || !Number.isFinite(item.maxRuntimeMs) || item.maxRuntimeMs <= 0) {
        errors.push(`cases[${index}] live_slack requires positive maxRuntimeMs`);
      }
    }

    if (mode === "provider" && isRecord(item.expect) && item.expect.providerProbe === "live" && options.allowLiveProviderProbe !== true) {
      errors.push(`cases[${index}] live provider probe requires allowLiveProviderProbe=true`);
    }

    if (errors.length === 0) {
      validatedCases.push({
        id,
        mode: mode as StabilityCaseMode,
        severity: severity as StabilitySeverity,
        tags: tags ? [...tags] : [],
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
        ...(typeof item.maxRuntimeMs === "number" ? { maxRuntimeMs: item.maxRuntimeMs } : {}),
        expect: { ...(item.expect as Record<string, unknown>) },
      });
    }
  });

  const maxLiveCases = options.maxLiveCases ?? 8;
  if (liveCases > maxLiveCases) {
    errors.push(`live case cap exceeded: ${liveCases} > ${maxLiveCases}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    pack: {
      schemaVersion: CASE_PACK_SCHEMA_VERSION,
      generatedAt: raw.generatedAt as string,
      generatedBy: raw.generatedBy as StabilityGeneratedBy,
      runKind: raw.runKind as StabilityRunKind,
      cases: validatedCases,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
