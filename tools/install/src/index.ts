#!/usr/bin/env node
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): never;
};

function resolvePath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    return ".";
  }

  const absolute = filtered[0]?.startsWith("/") ?? false;
  const segments: string[] = [];

  for (const part of filtered) {
    for (const rawSegment of part.split("/")) {
      if (rawSegment === "" || rawSegment === ".") {
        continue;
      }
      if (rawSegment === "..") {
        segments.pop();
        continue;
      }
      segments.push(rawSegment);
    }
  }

  return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
}

function joinPath(...parts: string[]): string {
  return resolvePath(...parts);
}

export interface InstallConfig {
  openclawHome: string;
  workspaceDir: string;
  extensionDir: string;
  repoRoot: string;
  dryRun?: boolean;
}

export function detectOpenClawInstallation(env: Record<string, string | undefined>): string {
  const openclawHome = env.OPENCLAW_HOME;
  if (openclawHome) {
    return resolvePath(openclawHome);
  }

  const homeDir = env.HOME;
  if (!homeDir) {
    throw new Error("Unable to resolve OpenClaw installation: HOME or OPENCLAW_HOME is required.");
  }

  return joinPath(resolvePath(homeDir), ".openclaw");
}

export function detectWorkspace(env: Record<string, string | undefined>): string {
  const workspaceDir = env.WORKSPACE ?? env.OCTOCLAW_WORKSPACE ?? env.PWD;
  if (!workspaceDir) {
    throw new Error("Unable to resolve workspace path: set WORKSPACE, OCTOCLAW_WORKSPACE, or PWD.");
  }

  return resolvePath(workspaceDir);
}

export function resolveInstallConfig(env: Record<string, string | undefined>): InstallConfig {
  const repoRoot = detectWorkspace(env);
  const workspaceDir = detectWorkspace(env);
  const openclawHome = detectOpenClawInstallation(env);
  const extensionDir = joinPath(repoRoot, "extensions", "octoclaw-runtime");
  const dryRun = env.OCTOCLAW_INSTALL_DRY_RUN === "1" || env.OCTOCLAW_INSTALL_DRY_RUN === "true";

  return {
    openclawHome,
    workspaceDir,
    extensionDir,
    repoRoot,
    dryRun,
  };
}

export function buildExtensionPaths(config: InstallConfig): { src: string; dest: string } {
  return {
    src: joinPath(config.extensionDir, "dist"),
    dest: joinPath(config.openclawHome, "extensions", "octoclaw-runtime"),
  };
}

export function formatInstallSummary(config: InstallConfig, deployed: boolean): string {
  const paths = buildExtensionPaths(config);
  return [
    `OctoClaw install ${deployed ? "completed" : "planned"}.`,
    `repo_root=${config.repoRoot}`,
    `workspace_dir=${config.workspaceDir}`,
    `openclaw_home=${config.openclawHome}`,
    `extension_dir=${config.extensionDir}`,
    `src=${paths.src}`,
    `dest=${paths.dest}`,
    `dry_run=${String(Boolean(config.dryRun))}`,
  ].join("\n");
}

export function buildExtension(config: InstallConfig): string {
  return `pnpm --dir ${config.repoRoot} --filter @octoclaw/runtime run build`;
}

export function deployExtension(openclawHome: string): string {
  return joinPath(resolvePath(openclawHome), "extensions", "octoclaw-runtime");
}

export function printStatusSummary(config: InstallConfig, deployed: boolean): string {
  return formatInstallSummary(config, deployed);
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  io: { stdout(message: string): void; stderr(message: string): void } = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  try {
    const config = resolveInstallConfig(env);
    io.stdout(printStatusSummary(config, !config.dryRun));
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
