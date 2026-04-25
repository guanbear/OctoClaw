import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const envOverrides = {
  octoclawRoot: "",
  workspaceRoot: "",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function stableHash(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export function stableId(prefix: string, parts: string[]): string {
  return `${prefix}-${stableHash(parts.map((part) => String(part || "")).join("\u001f"))}`;
}

export function firstExistingPath(
  candidates: string[],
  matcher?: (candidatePath: string) => boolean,
): string {
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw) {
      continue;
    }

    const resolved = path.resolve(raw);
    try {
      if (!fsSync.existsSync(resolved)) {
        continue;
      }
      if (matcher && !matcher(resolved)) {
        continue;
      }
      return resolved;
    } catch {
      continue;
    }
  }

  return "";
}

export function resolveHomeDir(): string {
  return String(process.env.HOME || os.homedir() || "").trim() || os.homedir();
}

export function resolveOpenClawConfigDir(): string {
  const homeDir = resolveHomeDir();
  const explicitHome = String(process.env.OPENCLAW_HOME || "").trim();
  const explicitCandidates = explicitHome
    ? [explicitHome, path.join(explicitHome, ".openclaw")]
    : [];

  const resolved = firstExistingPath(
    [
      ...explicitCandidates,
      path.join(homeDir, ".openclaw"),
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "openclaw.json")),
  );

  if (resolved) {
    return resolved;
  }
  if (explicitHome) {
    return path.resolve(explicitHome);
  }
  return path.join(homeDir, ".openclaw");
}

export function resolveOctoClawRoot(): string {
  const configDir = resolveOpenClawConfigDir();
  const fallback = path.resolve(__dirname, "..", "..", "..", "..");
  const resolved = firstExistingPath(
    [
      envOverrides.octoclawRoot,
      process.env.OCTOCLAW_ROOT || "",
      path.join(configDir, "workspace", "openclaw", "skills", "octopus"),
      fallback,
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "lib")),
  );
  return resolved || fallback;
}

export function resolveRuntimeOctoClawRoot(): string {
  const configDir = resolveOpenClawConfigDir();
  const fallback = path.resolve(__dirname, "..", "..", "..", "..");
  const resolved = firstExistingPath(
    [
      path.join(configDir, "workspace", "openclaw", "skills", "octopus"),
      path.join(configDir, "workspace", "openclaw", "repos", "octoclaw"),
      envOverrides.octoclawRoot,
      process.env.OCTOCLAW_ROOT || "",
      fallback,
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "lib")),
  );
  return resolved || resolveOctoClawRoot();
}

export function resolveWorkspaceRoot(): string {
  const root = resolveOctoClawRoot();
  const configDir = resolveOpenClawConfigDir();
  const explicit = firstExistingPath([
    envOverrides.workspaceRoot,
    process.env.WORKSPACE || "",
  ]);

  if (explicit) {
    return explicit;
  }

  let inferredFromRoot = "";
  const normalizedRoot = String(root || "").trim();
  if (/[/\\]openclaw[/\\]skills[/\\]octopus$/.test(normalizedRoot)) {
    inferredFromRoot = path.resolve(root, "..", "..", "..");
  } else if (/[/\\]skills[/\\]octopus$/.test(normalizedRoot)) {
    inferredFromRoot = path.resolve(root, "..", "..");
  }

  const resolved = firstExistingPath(
    [
      path.join(configDir, "workspace"),
      inferredFromRoot,
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "tmp")),
  );

  return resolved || process.env.WORKSPACE || "/workspace";
}

export function resolveReplayLogPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "runtime-policy-replay.jsonl");
}

export function resolveDeliveryRelayPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "delivery-relay.jsonl");
}

export function resolveTaskStatePath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "task-state.json");
}

export function resolveTaskStateArchivePath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "task-state.archive.jsonl");
}

export function resolveTaskStateRetentionPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "task-state-retention.json");
}

export function resolveRouteStickinessPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "route-stickiness.json");
}

export function resolvePolicyStateLedgerPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "runtime-policy-state.json");
}

export function resolveRootSessionsPath(): string {
  return path.join(resolveOpenClawConfigDir(), "sessions.json");
}

export function resolveMainAgentSessionsPath(): string {
  return path.join(resolveOpenClawConfigDir(), "agents", "main", "sessions", "sessions.json");
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        WORKSPACE: resolveWorkspaceRoot(),
        OCTOCLAW_ROOT: resolveOctoClawRoot(),
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
    const timer: ReturnType<typeof setTimeout> | null = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // no-op
              }
            }, 500);
          } catch {
            // no-op
          }
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Uint8Array | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Uint8Array | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });

    child.on("close", (code: number | null) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: stdout.trim(),
        stderr: (timedOut ? (stderr || `command timed out after ${timeoutMs}ms`) : stderr).trim(),
        timedOut,
      });
    });
  });
}

export function truncateText(value: unknown, limit: number = 320): string {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}
