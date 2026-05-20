import { filterNightlyReplayEvents, generateNightlyReport, type EvaluationLaneResult, type NightlyReport, type ReplayEvent } from "../nightly/index.js";
import type { StabilityCaseMode, StabilityFailurePacket, StabilityGate, StabilityLaneResult } from "./types.js";

export type SyntheticFixture =
  | {
      id: string;
      kind: "escaped_spawn_json";
      expectedSpawnArgs: unknown;
      observedSpawnArgsText: string;
    }
  | {
      id: string;
      kind: "late_ack";
      ackMs: number;
      ackDeadlineMs: number;
      finalDelivered: boolean;
      threadTs?: string;
    }
  | {
      id: string;
      kind: "ack_thread";
      expectedThreadTs: string;
      observedThreadTs: string;
      ackText?: string;
    }
  | {
      id: string;
      kind: "provider_status";
      statusCode: number;
      slackText: string;
      fallbackAvailable: boolean;
    }
  | {
      id: string;
      kind: "delegate_footer";
      footerRoute: string;
      footerDifficulty?: string;
      hasSpawnIntent: boolean;
      hasChildSession: boolean;
    }
  | {
      id: string;
      kind: "main_tool_guard";
      route: string;
      escalationReason?: string;
      attemptedToolName: string;
      ordinaryToolRanAfterEscalation: boolean;
      dispatchCalled: boolean;
    }
  | {
      id: string;
      kind: "native_spawn_recovery";
      mismatchBlocked: boolean;
      redispatchAfterMismatch: boolean;
      terminalError?: string;
      finalSpawnAllowed: boolean;
    }
  | {
      id: string;
      kind: "native_final_delivery";
      nativeFinalDelivered: boolean;
      parentEchoAfterNativeFinalCount: number;
      duplicateFinalCount: number;
    }
  | {
      id: string;
      kind: "restart_shutdown";
      slackText: string;
      restartWindowMs?: number;
    }
  | {
      id: string;
      kind: "wizard_start";
      nextState: string;
    };

export interface SyntheticFixtureResult {
  caseId: string;
  gate: StabilityGate;
  lanes: StabilityLaneResult[];
  failures: StabilityFailurePacket[];
  evidence: Record<string, unknown>;
}

export interface NightlyReplayStabilityResult {
  gate: StabilityGate;
  lanes: StabilityLaneResult[];
  failures: StabilityFailurePacket[];
  nightlyReport?: NightlyReport;
}

const NIGHTLY_LANES = ["route_quality", "route_commit_ack", "execution_transition", "delegation_health", "delivery"] as const;

export function runSyntheticStabilityFixture(fixture: SyntheticFixture): SyntheticFixtureResult {
  const failures = syntheticFailures(fixture);
  return {
    caseId: fixture.id,
    gate: failures.length > 0 ? "fail" : "pass",
    lanes: [
      {
        name: `synthetic:${fixture.kind}`,
        gate: failures.length > 0 ? "fail" : "pass",
        caseIds: [fixture.id],
        failureCodes: failures.map((item) => item.code),
      },
    ],
    failures,
    evidence: syntheticEvidence(fixture),
  };
}

export function runNightlyReplayStabilityLane(events: ReplayEvent[] | undefined): NightlyReplayStabilityResult {
  if (!events) {
    return {
      gate: "unknown",
      lanes: NIGHTLY_LANES.map((lane) => ({
        name: `nightly:${lane}`,
        gate: "unknown",
        caseIds: ["nightly_replay"],
        failureCodes: ["replay_missing"],
      })),
      failures: [
        failure("replay_missing", "nightly_replay", "replay", {
          severity: "major",
        }),
      ],
    };
  }

  const filtered = filterNightlyReplayEvents(events);
  const nightlyReport = generateNightlyReport(filtered.events, filtered.metadata);
  return {
    gate: nightlyReport.overallGate,
    lanes: nightlyReport.lanes.map(nightlyLaneToStabilityLane),
    failures: nightlyReport.lanes
      .filter((lane) => lane.fail > 0 || lane.unknown > 0)
      .map((lane) => failure(`nightly_${lane.lane}_${lane.fail > 0 ? "fail" : "unknown"}`, "nightly_replay", "replay")),
    nightlyReport,
  };
}

function syntheticFailures(fixture: SyntheticFixture): StabilityFailurePacket[] {
  switch (fixture.kind) {
    case "escaped_spawn_json": {
      const observed = parseObservedJson(fixture.observedSpawnArgsText);
      return canonicalize(observed) === canonicalize(fixture.expectedSpawnArgs)
        ? []
        : [failure("spawn_missing", fixture.id, "synthetic")];
    }
    case "late_ack":
      return fixture.ackMs > fixture.ackDeadlineMs
        ? [
            failure("ack_late", fixture.id, "synthetic", {
              threadTs: fixture.threadTs,
              stageMs: { ackMs: fixture.ackMs, ackDeadlineMs: fixture.ackDeadlineMs },
            }),
          ]
        : [];
    case "ack_thread":
      return fixture.expectedThreadTs !== fixture.observedThreadTs
        ? [
            failure("ack_wrong_thread", fixture.id, "synthetic", {
              threadTs: fixture.observedThreadTs,
            }),
          ]
        : [];
    case "provider_status":
      if (!isBareProviderError(fixture.statusCode, fixture.slackText)) {
        return [];
      }
      return [
        failure(fixture.fallbackAvailable ? "provider_bare_error" : "provider_no_fallback", fixture.id, "provider", {
          stageMs: { statusCode: fixture.statusCode },
        }),
      ];
    case "delegate_footer":
      return [
        fixture.footerRoute === "delegate" && (!fixture.hasSpawnIntent || !fixture.hasChildSession)
          ? failure("delegate_footer_without_spawn", fixture.id, "synthetic")
          : null,
        fixture.footerRoute === "delegate" && !fixture.footerDifficulty
          ? failure("delegate_footer_missing_difficulty", fixture.id, "synthetic")
          : null,
      ].filter((item): item is StabilityFailurePacket => item !== null);
    case "main_tool_guard":
      return fixture.route === "reply"
        && fixture.escalationReason
        && fixture.ordinaryToolRanAfterEscalation
        && !fixture.dispatchCalled
        ? [
            failure("main_tool_after_escalation", fixture.id, "synthetic", {
              classification: "runtime_bug",
              errors: [`${fixture.attemptedToolName} ran after budget escalation ${fixture.escalationReason}`],
            }),
          ]
        : [];
    case "native_spawn_recovery":
      if (!fixture.mismatchBlocked) return [];
      if (fixture.redispatchAfterMismatch || fixture.terminalError?.includes("ticket_used")) {
        return [
          failure("native_spawn_redispatch_after_mismatch", fixture.id, "synthetic", {
            classification: "runtime_bug",
            errors: ["native spawn mismatch recovery redispatched and hit ticket_used instead of retrying sessions_spawn"],
          }),
        ];
      }
      return fixture.finalSpawnAllowed ? [] : [failure("native_spawn_retry_not_allowed", fixture.id, "synthetic")];
    case "native_final_delivery": {
      const failures: StabilityFailurePacket[] = [];
      if (fixture.nativeFinalDelivered && fixture.parentEchoAfterNativeFinalCount > 0) {
        failures.push(failure("parent_echo_after_native_final", fixture.id, "synthetic"));
      }
      if (fixture.duplicateFinalCount > 0) {
        failures.push(failure("duplicate_final", fixture.id, "synthetic"));
      }
      return failures;
    }
    case "restart_shutdown":
      return fixture.slackText.includes("Previous run is still shutting down")
        ? [
            failure("gateway_restart_drop", fixture.id, "synthetic", {
              stageMs: { restartWindowMs: fixture.restartWindowMs ?? 0 },
            }),
          ]
        : [];
    case "wizard_start":
      return fixture.nextState === "completed"
        ? [failure("wizard_flow_stuck", fixture.id, "wizard")]
        : [];
  }
}

function syntheticEvidence(fixture: SyntheticFixture): Record<string, unknown> {
  if (fixture.kind === "late_ack") {
    return {
      ackMs: fixture.ackMs,
      ackDeadlineMs: fixture.ackDeadlineMs,
      finalDelivered: fixture.finalDelivered,
    };
  }
  if (fixture.kind === "ack_thread") {
    return {
      expectedThreadTs: fixture.expectedThreadTs,
      observedThreadTs: fixture.observedThreadTs,
      ackText: fixture.ackText,
    };
  }
  if (fixture.kind === "provider_status") {
    return {
      statusCode: fixture.statusCode,
      fallbackAvailable: fixture.fallbackAvailable,
    };
  }
  if (fixture.kind === "delegate_footer") {
    return {
      footerRoute: fixture.footerRoute,
      footerDifficulty: fixture.footerDifficulty,
      hasSpawnIntent: fixture.hasSpawnIntent,
      hasChildSession: fixture.hasChildSession,
    };
  }
  if (fixture.kind === "main_tool_guard") {
    return {
      route: fixture.route,
      escalationReason: fixture.escalationReason,
      attemptedToolName: fixture.attemptedToolName,
      ordinaryToolRanAfterEscalation: fixture.ordinaryToolRanAfterEscalation,
      dispatchCalled: fixture.dispatchCalled,
    };
  }
  if (fixture.kind === "native_spawn_recovery") {
    return {
      mismatchBlocked: fixture.mismatchBlocked,
      redispatchAfterMismatch: fixture.redispatchAfterMismatch,
      terminalError: fixture.terminalError,
      finalSpawnAllowed: fixture.finalSpawnAllowed,
    };
  }
  if (fixture.kind === "native_final_delivery") {
    return {
      nativeFinalDelivered: fixture.nativeFinalDelivered,
      parentEchoAfterNativeFinalCount: fixture.parentEchoAfterNativeFinalCount,
      duplicateFinalCount: fixture.duplicateFinalCount,
    };
  }
  return {};
}

function nightlyLaneToStabilityLane(lane: EvaluationLaneResult): StabilityLaneResult {
  return {
    name: `nightly:${lane.lane}`,
    gate: lane.fail > 0 ? "fail" : lane.unknown > 0 ? "unknown" : "pass",
    caseIds: ["nightly_replay"],
    failureCodes: lane.samples.map((sample) => sample.verdict).filter((verdict) => verdict !== "pass"),
  };
}

function failure(
  code: string,
  caseId: string,
  mode: StabilityCaseMode,
  overrides: Partial<StabilityFailurePacket> = {},
): StabilityFailurePacket {
  return {
    code,
    severity: overrides.severity ?? "major",
    caseId,
    mode,
    ...overrides,
  };
}

function parseObservedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isBareProviderError(statusCode: number, slackText: string): boolean {
  return /status code \(no body\)/iu.test(slackText) && (statusCode === 402 || statusCode === 429);
}
