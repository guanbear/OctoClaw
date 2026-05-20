import { generateNightlyReport, type EvaluationLaneResult, type NightlyReport, type ReplayEvent } from "../nightly/index.js";
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
      kind: "provider_status";
      statusCode: number;
      slackText: string;
      fallbackAvailable: boolean;
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

  const nightlyReport = generateNightlyReport(events);
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
    case "provider_status":
      return isBareProviderError(fixture.statusCode, fixture.slackText)
        ? [
            failure("provider_bare_error", fixture.id, "provider", {
              stageMs: { statusCode: fixture.statusCode },
            }),
          ]
        : [];
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
  if (fixture.kind === "provider_status") {
    return {
      statusCode: fixture.statusCode,
      fallbackAvailable: fixture.fallbackAvailable,
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
