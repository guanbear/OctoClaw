export const CASE_PACK_SCHEMA_VERSION = "octoclaw.stability_smoke.case_pack/v2" as const;
export const REPORT_SCHEMA_VERSION = "octoclaw.stability_smoke.report/v2" as const;

export type StabilityGate = "pass" | "fail" | "unknown";
export type StabilitySeverity = "blocker" | "major" | "minor" | "observe";
export type StabilityCaseMode = "live_slack" | "synthetic" | "replay" | "router_model" | "wizard" | "provider";
export type StabilityRunKind = "post_deploy" | "nightly" | "full_3d" | "manual";
export type StabilityGeneratedBy = "catalog" | "glm-5.1" | "gpt-5.5" | "manual";

export interface StabilityCase {
  id: string;
  mode: StabilityCaseMode;
  severity: StabilitySeverity;
  tags: string[];
  prompt?: string;
  maxRuntimeMs?: number;
  expect: Record<string, unknown>;
}

export interface StabilityCasePack {
  schemaVersion: typeof CASE_PACK_SCHEMA_VERSION;
  generatedAt: string;
  generatedBy: StabilityGeneratedBy;
  runKind: StabilityRunKind;
  cases: StabilityCase[];
}

export interface StabilityFailurePacket {
  code: string;
  severity: StabilitySeverity;
  caseId: string;
  mode: StabilityCaseMode;
  classification?: "runtime_bug" | "smoke_spec_bug" | "environment_issue" | "unknown";
  threadTs?: string;
  promptHash?: string;
  route?: string;
  model?: string;
  footerVia?: string;
  workContractId?: string;
  spawnIntentId?: string;
  runId?: string;
  childSessionKey?: string;
  replayEventIds?: string[];
  stageMs?: Record<string, number>;
  relatedCommits?: string[];
  artifactPaths?: Record<string, string>;
}

export interface StabilityLaneResult {
  name: string;
  gate: StabilityGate;
  caseIds: string[];
  failureCodes: string[];
}

export interface StabilityReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  runKind: StabilityRunKind;
  overallGate: StabilityGate;
  lanes: StabilityLaneResult[];
  failures: StabilityFailurePacket[];
  artifactDir: string;
}

export interface BuildCatalogOptions {
  generatedAt?: string;
}

export interface ValidateCasePackOptions {
  maxLiveCases?: number;
  allowLiveProviderProbe?: boolean;
}

export type ValidateCasePackResult =
  | { ok: true; pack: StabilityCasePack; errors: [] }
  | { ok: false; errors: string[]; pack?: undefined };
