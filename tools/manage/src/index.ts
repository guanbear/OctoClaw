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
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
};

export const DEFAULT_REPO_URL = "https://github.com/guanbear/OctoClaw.git";
export const DEFAULT_REF = "refactor/0.4.0-stable";

export interface ManageConfig {
  repoUrl: string;
  ref: string;
  installDir: string;
  openclawHome: string;
}

export interface ManageStatus {
  ref: string;
  commit: string;
  installed: boolean;
  extensionPresent: boolean;
}

export function resolveManageConfig(env: Record<string, string | undefined> = process.env, args: string[] = []): ManageConfig {
  const openclawHome = path.resolve(env.OPENCLAW_HOME ?? path.join(env.HOME ?? os.homedir(), ".openclaw"));
  return {
    repoUrl: valueAfter(args, "--repo-url") ?? DEFAULT_REPO_URL,
    ref: valueAfter(args, "--branch") ?? valueAfter(args, "--ref") ?? DEFAULT_REF,
    installDir: path.resolve(valueAfter(args, "--octoclaw-root") ?? path.join(openclawHome, "workspace", "openclaw", "repos", "octoclaw")),
    openclawHome,
  };
}

export function buildStatusOutput(config: ManageConfig): ManageStatus {
  return {
    ref: config.ref,
    commit: "unknown",
    installed: true,
    extensionPresent: true,
  };
}

export function formatStatusOutput(status: ManageStatus): string {
  return [
    "OctoClaw managed deployment status",
    `ref=${status.ref}`,
    `commit=${status.commit}`,
    `installed=${status.installed}`,
    `extension_present=${status.extensionPresent}`,
    "Deprecated: use octoclawctl status/details for live status.",
  ].join("\n");
}

export function forwardArgs(args: string[]): string[] {
  return args.length > 0 ? args : ["status"];
}

function valueAfter(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const prefix = `${key}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
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
