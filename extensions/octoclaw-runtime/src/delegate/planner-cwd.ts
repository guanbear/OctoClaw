import { envOverrides } from "../resolve/env.js";

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
}

export function isOpenClawManagedOctoClawRepoPath(value: unknown): boolean {
  const normalized = normalizePath(asString(value));
  if (!normalized) return false;
  return normalized.endsWith("/.openclaw/workspace/openclaw/repos/octoclaw");
}

function isOpenClawWorkspaceRootPath(value: unknown): boolean {
  const normalized = normalizePath(asString(value));
  if (!normalized) return false;
  return normalized.endsWith("/.openclaw/workspace");
}

export function resolvePlannerNativeCwd(value: unknown): string {
  const cwd = asString(value);
  const configuredRoot = asString(envOverrides.octoclawRoot || process.env.OCTOCLAW_ROOT);
  if (
    cwd
    && configuredRoot
    && (
      isOpenClawManagedOctoClawRepoPath(cwd)
      || (cwd === asString(envOverrides.workspaceRoot) && isOpenClawWorkspaceRootPath(cwd))
    )
    && !isOpenClawManagedOctoClawRepoPath(configuredRoot)
  ) {
    return configuredRoot;
  }
  return cwd;
}
