export type SlackAcceptanceFormat = "markdown" | "json";
export type SlackAcceptanceCaseKind =
  | "plain_chat"
  | "fresh_lookup"
  | "delegated_work"
  | "status_panel"
  | "provenance_followup"
  | "route_objection_correction"
  | "route_flip_no_stale_projection"
  | "no_lie_materialized_no_spawn";
export type AssertionStatus = "pass" | "fail" | "unknown" | "skipped";
export type AcceptanceGate = "pass" | "fail" | "unknown";

export interface SlackAcceptanceTarget {
  channel?: string;
  user?: string;
  threadTs?: string;
  allowDm?: boolean;
  allowProductionTarget?: boolean;
}

export interface SlackAcceptanceIsolationConfig {
  enabled?: boolean;
  runId?: string;
  markerPrefix?: string;
  allowUserToken?: boolean;
}

export interface SlackAcceptanceCaseConfig {
  id?: string;
  kind: SlackAcceptanceCaseKind;
  prompt?: string;
  enabled?: boolean;
  ackRequired?: boolean;
  neutralAckRequired?: boolean;
  finalRequired?: boolean;
  noSpawnExpected?: boolean;
  ackTimeoutMs?: number;
  neutralAckTimeoutMs?: number;
  finalTimeoutMs?: number;
  pollIntervalMs?: number;
  expectNeutralAck?: string[];
  expectNeutralAckAll?: string[];
  expectNeutralReaction?: string[];
  rejectNeutralAck?: string[];
  expectAck?: string[];
  expectAckAll?: string[];
  rejectAck?: string[];
  expectFinal?: string[];
  expectFinalAll?: string[];
  rejectFinal?: string[];
  requiresFixture?: boolean;
  fixtureKey?: string;
}

export interface SlackAcceptanceConfig {
  schemaVersion?: string;
  botTokenEnv?: string;
  userTokenEnv?: string;
  sessionKey?: string;
  target?: SlackAcceptanceTarget;
  outputLabel?: string;
  cases?: SlackAcceptanceCaseConfig[];
  replayPath?: string;
  exposedTools?: string[];
  ackTimeoutMs?: number;
  neutralAckTimeoutMs?: number;
  finalTimeoutMs?: number;
  pollIntervalMs?: number;
  maxTranscriptMessages?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  fixtures?: Record<string, string | boolean | number>;
  isolation?: SlackAcceptanceIsolationConfig;
}

export interface SlackAcceptanceResolvedConfig {
  botToken: string;
  botTokenEnv: string;
  userToken?: string;
  userTokenEnv?: string;
  sessionKey: string;
  target: Required<Pick<SlackAcceptanceTarget, "channel">> & SlackAcceptanceTarget;
  outputLabel: string;
  cases: SlackAcceptanceCaseConfig[];
  replayPath?: string;
  exposedTools: string[];
  ackTimeoutMs: number;
  neutralAckTimeoutMs: number;
  finalTimeoutMs: number;
  pollIntervalMs: number;
  maxTranscriptMessages: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  fixtures: Record<string, string | boolean | number>;
  acceptanceRunId: string;
  isolation: Required<Pick<SlackAcceptanceIsolationConfig, "enabled" | "markerPrefix" | "allowUserToken">>;
}

export interface SlackMessageRecord {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  threadTs?: string;
  reactions?: SlackMessageReactionRecord[];
}

export interface SlackMessageReactionRecord {
  name: string;
  count?: number;
  users?: string[];
}

export interface SlackPostMessageResult {
  ok: boolean;
  ts: string;
  threadTs?: string;
  channel: string;
  error?: string;
}

export interface SlackAcceptanceClient {
  postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult>;
  fetchReplies(params: { channel: string; threadTs: string; oldestTs?: string; limit?: number }): Promise<SlackMessageRecord[]>;
  fetchMessage?(params: { channel: string; ts: string }): Promise<SlackMessageRecord | null>;
}

export interface AssertionResult {
  status: AssertionStatus;
  reason: string;
  matchedText?: string;
}

export interface SlackAcceptanceProgressEvent {
  at: string;
  event: string;
  elapsedMs: number;
  detail?: string;
}

export interface SlackAcceptanceCaseResult {
  id: string;
  kind: SlackAcceptanceCaseKind;
  prompt: string;
  sentPrompt?: string;
  acceptanceRunId?: string;
  status: AcceptanceGate;
  sentAt?: string;
  threadTs?: string;
  ackMs?: number;
  neutralAckMs?: number;
  acceptedAckMs?: number;
  finalMs?: number;
  neutralAck?: AssertionResult;
  ack: AssertionResult;
  final: AssertionResult;
  noSpawn: AssertionResult;
  transcript: SlackMessageRecord[];
  errors: string[];
  elapsedMs?: number;
  progress?: SlackAcceptanceProgressEvent[];
}

export interface SlackToolExposureAuditResult {
  status: AcceptanceGate;
  exposedTools: string[];
  blockedTools: string[];
}

export interface SlackAcceptanceReport {
  schemaVersion: "octoclaw.slack_acceptance.report/v1";
  reportId: string;
  generatedAt: string;
  acceptanceRunId?: string;
  sessionKey: string;
  isolation?: {
    enabled: boolean;
    markerPrefix: string;
    userTokenAllowed: boolean;
  };
  target: { channel: string; threadTs?: string; user?: string };
  overallGate: AcceptanceGate;
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  skipped: number;
  toolExposureAudit: SlackToolExposureAuditResult;
  cases: SlackAcceptanceCaseResult[];
}
