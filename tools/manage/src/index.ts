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

export interface ManageConfig {
  repoUrl: string;
  ref: string;
  installDir: string;
  openclawHome: string;
}

export const DEFAULT_REPO_URL = "https://github.com/guanbear/OctoClaw.git";
export const DEFAULT_REF = "release/0.3.0-ts-rebuild";

export function resolveManageConfig(env: Record<string, string | undefined>, args: string[]): ManageConfig {
  const repoUrl = env.OCTOCLAW_REPO_URL ?? DEFAULT_REPO_URL;
  const ref = args[1] ?? env.OCTOCLAW_REF ?? DEFAULT_REF;
  const openclawHome = resolvePath(env.OPENCLAW_HOME ?? joinPath(env.HOME ?? ".", ".openclaw"));
  const installDir = resolvePath(env.OCTOCLAW_INSTALL_DIR ?? joinPath(openclawHome, "repos", "octoclaw"));

  return {
    repoUrl,
    ref,
    installDir,
    openclawHome,
  };
}

export function buildStatusOutput(config: ManageConfig): { ref: string; commit: string; installed: boolean; extensionPresent: boolean } {
  return {
    ref: config.ref,
    commit: "unknown",
    installed: true,
    extensionPresent: true,
  };
}

export function formatStatusOutput(status: ReturnType<typeof buildStatusOutput>): string {
  return [
    "OctoClaw managed deployment status",
    `ref=${status.ref}`,
    `commit=${status.commit}`,
    `installed=${String(status.installed)}`,
    `extension_present=${String(status.extensionPresent)}`,
  ].join("\n");
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  io: { stdout(message: string): void; stderr(message: string): void } = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  try {
    const command = argv[0] ?? "status";
    const config = resolveManageConfig(env, argv);

    switch (command) {
      case "install":
      case "update":
      case "reconcile":
        io.stdout(`octoclaw-manage ${command} prepared for ${config.installDir} at ${config.ref}`);
        return 0;
      case "status":
        io.stdout(formatStatusOutput(buildStatusOutput(config)));
        return 0;
      default:
        io.stderr(`Unknown command: ${command}`);
        return 1;
    }
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
