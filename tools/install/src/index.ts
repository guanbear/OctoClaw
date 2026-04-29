#!/usr/bin/env node
// Deprecated: use tools/octoclawctl for OctoClaw install/config/manage workflows.

// @ts-ignore missing Node type package in this workspace
import { spawn } from "node:child_process";
// @ts-ignore missing Node type package in this workspace
import os from "node:os";
// @ts-ignore missing Node type package in this workspace
import path from "node:path";
// @ts-ignore missing Node type package in this workspace
import { fileURLToPath } from "node:url";

declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
};

export interface InstallConfig {
  openclawHome: string;
  workspaceDir: string;
  extensionDir: string;
  repoRoot: string;
  dryRun?: boolean;
}

export interface InstallOptions {
  auto?: boolean;
  workspace?: string;
  openclawHome?: string;
  octoclawRoot?: string;
  skipBuild?: boolean;
}

export function resolveInstallConfig(env: Record<string, string | undefined> = process.env, options: InstallOptions = {}): InstallConfig {
  const repoRoot = path.resolve(options.octoclawRoot ?? env.PWD ?? process.cwd());
  const workspaceDir = path.resolve(options.workspace ?? repoRoot);
  const openclawHome = path.resolve(options.openclawHome ?? env.OPENCLAW_HOME ?? path.join(env.HOME ?? os.homedir(), ".openclaw"));
  return {
    openclawHome,
    workspaceDir,
    extensionDir: path.join(repoRoot, "extensions", "octoclaw-runtime"),
    repoRoot,
    dryRun: options.auto === false,
  };
}

export function buildExtensionPaths(config: InstallConfig): { src: string; dest: string } {
  return {
    src: path.join(config.extensionDir, "dist"),
    dest: path.join(config.openclawHome, "extensions", "octoclaw-runtime"),
  };
}

export function formatInstallSummary(config: InstallConfig, didInstall: boolean): string {
  const paths = buildExtensionPaths(config);
  return [
    didInstall ? "OctoClaw install completed." : "OctoClaw install planned.",
    `openclaw_home=${config.openclawHome}`,
    `repo_root=${config.repoRoot}`,
    `src=${paths.src}`,
    `dest=${paths.dest}`,
    `dry_run=${config.dryRun === true}`,
    "Deprecated: use octoclawctl install/deploy/update for live installs.",
  ].join("\n");
}

export function forwardArgs(args: string[]): string[] {
  return args.length > 0 ? args : ["install"];
}

function octoclawCtlCliPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../octoclawctl/dist/cli.js");
}

function forwardToOctoclawCtl(args: string[]): void {
  const child = spawn(process.execPath, [octoclawCtlCliPath(), ...forwardArgs(args)], { stdio: "inherit" });
  child.on("close", (code: number | null) => { process.exitCode = code ?? 1; });
  child.on("error", () => { process.exitCode = 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  forwardToOctoclawCtl(process.argv.slice(2));
}
