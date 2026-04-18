#!/usr/bin/env node
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { runStatusSurfaceOperator, type StatusSurfaceAction } from "@octoclaw/status-surface";

type CliFormat = "text" | "json";
type SubstrateState = RuntimeStateSurfaceRecord["substrateState"];
type WorkspaceMode = RuntimeStateSurfaceRecord["scope"]["workspaceMode"];

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): never;
};

const VALID_ACTIONS: StatusSurfaceAction[] = ["status", "details", "queue", "timeline"];
const VALID_FORMATS: CliFormat[] = ["text", "json"];
const FALLBACK_MESSAGE = "No active OctoClaw runtime detected. Ensure the extension is installed and a task has been created.";

export function runOctoClawCtl(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
  format: CliFormat = "text",
): string {
  if (format === "json") {
    return JSON.stringify(runStatusSurfaceOperator(action, record, "rich"), null, 2);
  }

  return String(runStatusSurfaceOperator(action, record, "text"));
}

export function printUsage(): string {
  return [
    "Usage: octoclawctl <status|details|queue|timeline> [--format text|json] [--help]",
    "",
    "Options:",
    "  --format <text|json>  Output format (default: text)",
    "  --help                Show this help message",
  ].join("\n");
}

export interface ParsedCliArgs {
  action?: StatusSurfaceAction;
  format: CliFormat;
  help: boolean;
}

function normalizeSubstrateState(value: string | undefined): SubstrateState {
  switch (value) {
    case "planned":
    case "running":
    case "waiting":
    case "completed":
    case "failed":
      return value;
    default:
      return "planned";
  }
}

function normalizeWorkspaceMode(value: string | undefined): WorkspaceMode {
  switch (value) {
    case "isolated_workspace":
    case "shared_workspace":
    case "read_only_workspace":
      return value;
    default:
      return "isolated_workspace";
  }
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let action: StatusSurfaceAction | undefined;
  let format: CliFormat = "text";
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (argument === "--format") {
      const nextValue = argv[index + 1];
      if (!nextValue || !VALID_FORMATS.includes(nextValue as CliFormat)) {
        throw new Error(`Unknown format: ${nextValue ?? "(missing)"}. Expected one of: ${VALID_FORMATS.join(", ")}`);
      }
      format = nextValue as CliFormat;
      index += 1;
      continue;
    }

    if (argument.startsWith("--format=")) {
      const [, rawFormat] = argument.split("=", 2);
      if (!rawFormat || !VALID_FORMATS.includes(rawFormat as CliFormat)) {
        throw new Error(`Unknown format: ${rawFormat ?? "(missing)"}. Expected one of: ${VALID_FORMATS.join(", ")}`);
      }
      format = rawFormat as CliFormat;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (action) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    if (!VALID_ACTIONS.includes(argument as StatusSurfaceAction)) {
      throw new Error(`Unknown action: ${argument}. Expected one of: ${VALID_ACTIONS.join(", ")}`);
    }

    action = argument as StatusSurfaceAction;
  }

  return { action, format, help };
}

export function resolveRuntimeStateSurfaceRecord(
  env: Record<string, string | undefined>,
): RuntimeStateSurfaceRecord | undefined {
  const taskId = env.OCTOCLAW_TASK_ID;
  const flowId = env.OCTOCLAW_FLOW_ID;

  if (!taskId || !flowId) {
    return undefined;
  }

  const substrateRevision = Number.parseInt(env.OCTOCLAW_SUBSTRATE_REVISION ?? "1", 10);
  const claimOwner = env.OCTOCLAW_CLAIM_OWNER ?? "octoclawctl";
  const workspaceMode = normalizeWorkspaceMode(env.OCTOCLAW_WORKSPACE_MODE);
  const writeScopeSummary = env.OCTOCLAW_WRITE_SCOPE_SUMMARY ?? "repo:workspace";
  const substrateState = normalizeSubstrateState(env.OCTOCLAW_SUBSTRATE_STATE);
  const syncMode = env.OCTOCLAW_SYNC_MODE === "mirrored" ? "mirrored" : "managed";
  const resolvedRevision = Number.isNaN(substrateRevision) ? 1 : substrateRevision;

  return {
    taskId,
    flowId,
    runtime: "openclaw-native",
    syncMode,
    substrateState,
    substrateRevision: resolvedRevision,
    ownership: {
      claimOwner,
      claimToken: env.OCTOCLAW_CLAIM_TOKEN ?? "octoclawctl-claim-token",
      controllerId: env.OCTOCLAW_CONTROLLER_ID ?? "octoclawctl-controller",
    },
    scope: {
      readScope: [{ resource: env.OCTOCLAW_READ_SCOPE_RESOURCE ?? "repo:workspace", access: "read" }],
      writeScope: [{ resource: writeScopeSummary, access: "write" }],
      workspaceMode,
      writeScopeSummary,
    },
    truth: {
      schemaVersion: "octoclaw.truth/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "truth",
      sessionKey: env.OCTOCLAW_SESSION_KEY ?? `${taskId}-session`,
      requestId: env.OCTOCLAW_REQUEST_ID ?? `${taskId}-request`,
      flowId,
      taskId,
      runtime: "openclaw-native",
      syncMode,
      substrateState,
      substrateRevision: resolvedRevision,
      managedDisposition: syncMode,
      ownership: {
        claimOwner,
        claimToken: env.OCTOCLAW_CLAIM_TOKEN ?? "octoclawctl-claim-token",
        controllerId: env.OCTOCLAW_CONTROLLER_ID ?? "octoclawctl-controller",
      },
      scope: {
        workspaceMode,
        readScopeCount: 1,
        writeScopeCount: 1,
        writeScopeSummary,
      },
    },
    projection: {
      schemaVersion: "octoclaw.projection/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "projection",
      status: env.OCTOCLAW_PROJECTION_STATUS ?? substrateState,
      runtime: "openclaw-native",
      flowId,
      taskId,
      substrateState,
      substrateRevision: resolvedRevision,
      workspaceMode,
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "artifact",
      taskPacketRef: env.OCTOCLAW_TASK_PACKET_REF ?? `${taskId}-packet`,
      schemaPlanes: ["truth", "projection"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "telemetry",
      substrateRevision: resolvedRevision,
      syncMode,
      claimOwner,
    },
  };
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  io: CliIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);

    if (parsed.help) {
      io.stdout(printUsage());
      return 0;
    }

    if (!parsed.action) {
      io.stderr(`Unknown action: (missing). Expected one of: ${VALID_ACTIONS.join(", ")}`);
      return 1;
    }

    const record = resolveRuntimeStateSurfaceRecord(env);
    if (!record) {
      io.stdout(FALLBACK_MESSAGE);
      return 0;
    }

    io.stdout(runOctoClawCtl(parsed.action, record, parsed.format));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void main().then((exitCode) => {
    process.exit(exitCode);
  });
}
