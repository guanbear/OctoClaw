export type HealthEventSource = "runtime" | "probe";

export interface HealthEventEvidence {
  sessionKey?: string;
  turnId?: string;
  agentId?: string;
  httpStatus?: number;
  command?: string;
}

export interface HealthEvent {
  schemaVersion: "octoclaw.router.health_event/v1";
  ts: number;
  modelKey: string;
  source: HealthEventSource;
  success: boolean;
  latencyMs?: number;
  errorCode?: string;
  timeout?: boolean;
  toolCallFailed?: boolean;
  evidence?: HealthEventEvidence;
}

export type HealthEventInput = Omit<HealthEvent, "schemaVersion" | "ts"> & {
  ts?: number;
  schemaVersion?: HealthEvent["schemaVersion"];
};

const SCHEMA_VERSION: HealthEvent["schemaVersion"] = "octoclaw.router.health_event/v1";

export function normalizeHealthEvent(input: HealthEventInput, now: number): HealthEvent {
  const event: HealthEvent = {
    schemaVersion: SCHEMA_VERSION,
    ts: Number.isFinite(input.ts) ? Number(input.ts) : now,
    modelKey: String(input.modelKey),
    source: input.source,
    success: Boolean(input.success),
  };

  if (typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)) {
    event.latencyMs = Math.max(0, Math.round(input.latencyMs));
  }
  if (typeof input.errorCode === "string" && input.errorCode.trim().length > 0) {
    event.errorCode = sanitizeToken(input.errorCode);
  }
  if (input.timeout === true) event.timeout = true;
  if (input.toolCallFailed === true) event.toolCallFailed = true;
  if (input.evidence) {
    const evidence = sanitizeEvidence(input.evidence);
    if (Object.keys(evidence).length > 0) event.evidence = evidence;
  }

  return event;
}

export function parseHealthEvent(value: unknown): HealthEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof candidate.ts !== "number" || !Number.isFinite(candidate.ts)) return undefined;
  if (typeof candidate.modelKey !== "string" || candidate.modelKey.length === 0) return undefined;
  if (candidate.source !== "runtime" && candidate.source !== "probe") return undefined;
  if (typeof candidate.success !== "boolean") return undefined;

  return normalizeHealthEvent(candidate as HealthEventInput, candidate.ts);
}

function sanitizeEvidence(input: HealthEventEvidence): HealthEventEvidence {
  const output: HealthEventEvidence = {};
  for (const key of ["sessionKey", "turnId", "agentId", "command"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      output[key] = sanitizeToken(value);
    }
  }
  if (typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)) {
    output.httpStatus = Math.trunc(input.httpStatus);
  }
  return output;
}

function sanitizeToken(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 160);
}
