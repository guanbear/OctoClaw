#!/usr/bin/env node

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code?: number): never;
};

// @ts-ignore missing Node type package in this workspace
import { spawn } from "node:child_process";
// @ts-ignore missing Node type package in this workspace
import { readFileSync } from "node:fs";
// @ts-ignore missing Node type package in this workspace
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
// @ts-ignore missing Node type package in this workspace
import os from "node:os";
// @ts-ignore missing Node type package in this workspace
import path from "node:path";
// @ts-ignore missing Node type package in this workspace
import { pathToFileURL } from "node:url";

export interface SourceManifest {
  type: "git";
  commit: string;
  branch: string;
  installedAt: string;
  octoclawRoot: string;
}

export interface ManageConfig {
  repoUrl: string;
  ref: string;
  installDir: string;
  openclawHome: string;
}

export interface StatusOutput {
  ref: string;
  commit: string;
  installed: boolean;
  extensionPresent: boolean;
}

interface ParsedArgs {
  command: string;
  repoUrl?: string;
  branch?: string;
  openclawHome?: string;
  help: boolean;
}

interface DeployStatus {
  runtimeExtensionPresent: boolean;
  missingExtensions: string[];
  expectedPackages: string[];
  missingPackages: string[];
}

interface RunCommandOptions {
  cwd?: string;
  captureStdout?: boolean;
}

interface DirectoryEntryLike {
  name: string;
  isDirectory(): boolean;
}

interface StreamLike {
  on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
}

interface ChildProcessLike {
  stdout?: StreamLike;
  stderr?: StreamLike;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
}

const MANIFEST_FILENAME = "octoclaw-source-manifest.json";
const RUNTIME_EXTENSION_NAME = "octoclaw-runtime";

export const DEFAULT_REPO_URL = "https://github.com/guanbear/OctoClaw.git";
export const DEFAULT_REF = "release/0.3.0-ts-rebuild";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  octoclaw-manage <install|update|check|status|uninstall> [options]",
      "",
      "Options:",
      "  --repo-url URL       Git repository URL",
      "  --branch NAME        Branch to install/update (alias: --ref)",
      "  --openclaw-home DIR  OpenClaw home directory (default: ~/.openclaw)",
      "  -h, --help           Show this help",
    ].join("\n") + "\n",
  );
}

function resolveOpenClawHome(openclawHome?: string): string {
  return path.resolve(openclawHome ?? process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"));
}

function resolveOctoclawRoot(openclawHome: string): string {
  return path.join(openclawHome, "repos", "octoclaw");
}

function manifestPath(openclawHome: string): string {
  return path.join(openclawHome, MANIFEST_FILENAME);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

async function listDirectories(parentDir: string, predicate?: (name: string) => boolean): Promise<string[]> {
  if (!(await pathExists(parentDir))) {
    return [];
  }

  const entries = await readdir(parentDir, { withFileTypes: true });
  return entries
    .filter((entry: DirectoryEntryLike) => entry.isDirectory())
    .map((entry: DirectoryEntryLike) => entry.name)
    .filter((name: string) => (predicate ? predicate(name) : true))
    .sort((left: string, right: string) => left.localeCompare(right));
}

async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<string> {
  const { cwd, captureStdout = false } = options;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: captureStdout ? ["inherit", "pipe", "pipe"] : "inherit",
      env: process.env,
    }) as ChildProcessLike;

    let stdout = "";
    let stderr = "";

    if (captureStdout) {
      child.stdout?.on("data", (chunk: string | Uint8Array) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: string | Uint8Array) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error: Error) => {
      reject(error);
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const renderedArgs = [command, ...args].join(" ");
      const suffix = captureStdout && stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";
      reject(new Error(`Command failed (${code}): ${renderedArgs}${suffix}`));
    });
  });
}

async function readGitOutput(octoclawRoot: string, args: string[]): Promise<string> {
  return await runCommand("git", args, { cwd: octoclawRoot, captureStdout: true });
}

async function getGitCommit(octoclawRoot: string): Promise<string> {
  return await readGitOutput(octoclawRoot, ["rev-parse", "HEAD"]);
}

async function getGitBranch(octoclawRoot: string): Promise<string> {
  return await readGitOutput(octoclawRoot, ["branch", "--show-current"]);
}

async function getGitOriginUrl(octoclawRoot: string): Promise<string> {
  return await readGitOutput(octoclawRoot, ["remote", "get-url", "origin"]);
}

async function ensureGitCheckout(options: {
  octoclawRoot: string;
  repoUrl: string;
  branch: string;
}): Promise<void> {
  const { octoclawRoot, repoUrl, branch } = options;
  const gitDir = path.join(octoclawRoot, ".git");

  await ensureDirectory(path.dirname(octoclawRoot));

  if (!(await pathExists(gitDir))) {
    await runCommand("git", ["clone", "--branch", branch, "--single-branch", repoUrl, octoclawRoot]);
    return;
  }

  await runCommand("git", ["remote", "set-url", "origin", repoUrl], { cwd: octoclawRoot });
  await runCommand("git", ["fetch", "origin", branch], { cwd: octoclawRoot });

  const branchExists = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: octoclawRoot,
  })
    .then(() => true)
    .catch(() => false);

  if (branchExists) {
    await runCommand("git", ["checkout", branch], { cwd: octoclawRoot });
  } else {
    await runCommand("git", ["checkout", "-B", branch, "FETCH_HEAD"], { cwd: octoclawRoot });
  }

  await runCommand("git", ["pull", "--ff-only", "origin", branch], { cwd: octoclawRoot });
}

async function buildWorkspace(octoclawRoot: string): Promise<void> {
  await runCommand("pnpm", ["install"], { cwd: octoclawRoot });
  await runCommand("pnpm", ["-r", "run", "build"], { cwd: octoclawRoot });
}

async function syncRuntimeExtension(octoclawRoot: string, openclawHome: string): Promise<void> {
  const sourceDir = path.join(octoclawRoot, "extensions", RUNTIME_EXTENSION_NAME);
  const targetDir = path.join(openclawHome, "extensions", RUNTIME_EXTENSION_NAME);

  if (!(await pathExists(sourceDir))) {
    throw new Error(`Runtime extension source not found: ${sourceDir}`);
  }

  await ensureDirectory(path.dirname(targetDir));
  await runCommand(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude",
      ".git",
      "--exclude",
      ".DS_Store",
      "--exclude",
      "__pycache__",
      "--exclude",
      "node_modules",
      `${sourceDir}/`,
      `${targetDir}/`,
    ],
    { cwd: octoclawRoot },
  );
}

async function syncPackages(octoclawRoot: string, openclawHome: string): Promise<string[]> {
  const packagesSourceDir = path.join(octoclawRoot, "packages");
  const packagesTargetDir = path.join(openclawHome, "packages");
  const packageNames = await listDirectories(packagesSourceDir, (name) => name.startsWith("octoclaw-"));

  await ensureDirectory(packagesTargetDir);

  const existingTargetPackages = await listDirectories(packagesTargetDir, (name) => name.startsWith("octoclaw-"));
  for (const existingPackage of existingTargetPackages) {
    if (!packageNames.includes(existingPackage)) {
      await rm(path.join(packagesTargetDir, existingPackage), { recursive: true, force: true });
    }
  }

  for (const packageName of packageNames) {
    const sourceDir = path.join(packagesSourceDir, packageName);
    const targetDir = path.join(packagesTargetDir, packageName);
    await runCommand(
      "rsync",
      [
        "-a",
        "--delete",
        "--prune-empty-dirs",
        "--include",
        "package.json",
        "--include",
        "README.md",
        "--include",
        "LICENSE*",
        "--include",
        "dist/***",
        "--exclude",
        "*",
        `${sourceDir}/`,
        `${targetDir}/`,
      ],
      { cwd: octoclawRoot },
    );
  }

  return packageNames;
}

async function getExpectedPackageNames(octoclawRoot: string): Promise<string[]> {
  return await listDirectories(path.join(octoclawRoot, "packages"), (name) => name.startsWith("octoclaw-"));
}

async function collectDeployStatus(openclawHome: string, octoclawRoot?: string): Promise<DeployStatus> {
  const runtimeExtensionPath = path.join(openclawHome, "extensions", RUNTIME_EXTENSION_NAME);
  const runtimeExtensionPresent = await pathExists(runtimeExtensionPath);

  let expectedPackages: string[] = [];
  if (octoclawRoot && (await pathExists(path.join(octoclawRoot, "packages")))) {
    expectedPackages = await getExpectedPackageNames(octoclawRoot);
  } else {
    expectedPackages = await listDirectories(path.join(openclawHome, "packages"), (name) => name.startsWith("octoclaw-"));
  }

  const missingPackages: string[] = [];
  for (const packageName of expectedPackages) {
    const packageDir = path.join(openclawHome, "packages", packageName);
    const packageJsonPath = path.join(packageDir, "package.json");
    const distPath = path.join(packageDir, "dist");
    if (!(await pathExists(packageJsonPath)) || !(await pathExists(distPath))) {
      missingPackages.push(packageName);
    }
  }

  return {
    runtimeExtensionPresent,
    missingExtensions: runtimeExtensionPresent ? [] : [RUNTIME_EXTENSION_NAME],
    expectedPackages,
    missingPackages,
  };
}

async function reconcileDeployment(openclawHome: string, octoclawRoot: string): Promise<void> {
  const deployStatus = await collectDeployStatus(openclawHome, octoclawRoot);
  if (!deployStatus.runtimeExtensionPresent || deployStatus.missingPackages.length > 0) {
    const fragments = [
      deployStatus.runtimeExtensionPresent ? null : `missing extension: ${RUNTIME_EXTENSION_NAME}`,
      deployStatus.missingPackages.length > 0
        ? `missing packages: ${deployStatus.missingPackages.join(", ")}`
        : null,
    ].filter((value): value is string => value !== null);
    throw new Error(`Reconcile failed: ${fragments.join("; ")}`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: args[0] ?? "status",
    help: false,
  };

  let index = 1;
  while (index < args.length) {
    const current = args[index];
    switch (current) {
      case "--repo-url":
        parsed.repoUrl = args[index + 1];
        index += 2;
        break;
      case "--branch":
      case "--ref":
        parsed.branch = args[index + 1];
        index += 2;
        break;
      case "--openclaw-home":
        parsed.openclawHome = args[index + 1];
        index += 2;
        break;
      case "-h":
      case "--help":
      case "help":
        parsed.help = true;
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${current}`);
    }
  }

  if (parsed.repoUrl === "" || parsed.branch === "" || parsed.openclawHome === "") {
    throw new Error("Option values must not be empty");
  }

  return parsed;
}

export function resolveManageConfig(
  env: Record<string, string | undefined>,
  args: string[],
): ManageConfig {
  const repoUrl = env.OCTOCLAW_REPO_URL ?? DEFAULT_REPO_URL;
  const ref = args[1] ?? env.OCTOCLAW_REF ?? DEFAULT_REF;
  const openclawHome = path.resolve(env.OPENCLAW_HOME ?? path.join(env.HOME ?? os.homedir(), ".openclaw"));
  const installDir = path.resolve(env.OCTOCLAW_INSTALL_DIR ?? path.join(openclawHome, "repos", "octoclaw"));

  return {
    repoUrl,
    ref,
    installDir,
    openclawHome,
  };
}

export function buildStatusOutput(config: ManageConfig): StatusOutput {
  return {
    ref: config.ref,
    commit: "unknown",
    installed: true,
    extensionPresent: true,
  };
}

export function formatStatusOutput(status: StatusOutput): string {
  return [
    "OctoClaw managed deployment status",
    `ref=${status.ref}`,
    `commit=${status.commit}`,
    `installed=${String(status.installed)}`,
    `extension_present=${String(status.extensionPresent)}`,
  ].join("\n");
}

export function readSourceManifest(openclawHome: string): SourceManifest | null {
  const sourceManifestPath = manifestPath(resolveOpenClawHome(openclawHome));
  try {
    const raw = requireJsonFile(sourceManifestPath);
    if (
      raw &&
      raw.type === "git" &&
      typeof raw.commit === "string" &&
      typeof raw.branch === "string" &&
      typeof raw.installedAt === "string" &&
      typeof raw.octoclawRoot === "string"
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function requireJsonFile(filePath: string): SourceManifest {
  const data = JSON.parse(readFileSync(filePath, "utf8")) as SourceManifest;
  return data;
}

export async function writeSourceManifest(openclawHome: string, manifest: SourceManifest): Promise<void> {
  const sourceManifestPath = manifestPath(resolveOpenClawHome(openclawHome));
  await ensureDirectory(path.dirname(sourceManifestPath));
  await writeFile(sourceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function installFromSource(options: {
  repoUrl?: string;
  branch?: string;
  openclawHome?: string;
}): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const octoclawRoot = resolveOctoclawRoot(openclawHome);
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
  const branch = options.branch ?? DEFAULT_REF;

  await ensureGitCheckout({ octoclawRoot, repoUrl, branch });
  await buildWorkspace(octoclawRoot);
  await syncRuntimeExtension(octoclawRoot, openclawHome);
  await syncPackages(octoclawRoot, openclawHome);

  const manifest: SourceManifest = {
    type: "git",
    commit: await getGitCommit(octoclawRoot),
    branch,
    installedAt: new Date().toISOString(),
    octoclawRoot,
  };
  await writeSourceManifest(openclawHome, manifest);
  await reconcileDeployment(openclawHome, octoclawRoot);

  process.stdout.write(`Installed OctoClaw from source at ${manifest.commit} (${branch})\n`);
  return 0;
}

export async function updateFromSource(options: { openclawHome?: string }): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const manifest = readSourceManifest(openclawHome);
  const octoclawRoot = manifest?.octoclawRoot ?? resolveOctoclawRoot(openclawHome);

  if (!(await pathExists(path.join(octoclawRoot, ".git")))) {
    throw new Error(`Managed source checkout not found: ${octoclawRoot}`);
  }

  const repoUrl = await getGitOriginUrl(octoclawRoot).catch(() => DEFAULT_REPO_URL);
  const branch = manifest?.branch || (await getGitBranch(octoclawRoot).catch(() => DEFAULT_REF)) || DEFAULT_REF;

  await ensureGitCheckout({ octoclawRoot, repoUrl, branch });
  await buildWorkspace(octoclawRoot);
  await syncRuntimeExtension(octoclawRoot, openclawHome);
  await syncPackages(octoclawRoot, openclawHome);

  const nextManifest: SourceManifest = {
    type: "git",
    commit: await getGitCommit(octoclawRoot),
    branch,
    installedAt: new Date().toISOString(),
    octoclawRoot,
  };
  await writeSourceManifest(openclawHome, nextManifest);
  await reconcileDeployment(openclawHome, octoclawRoot);

  process.stdout.write(`Updated OctoClaw source install to ${nextManifest.commit} (${branch})\n`);
  return 0;
}

export async function checkForUpdates(options: { openclawHome?: string }): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const manifest = readSourceManifest(openclawHome);

  if (!manifest) {
    process.stdout.write("managed_install=false\nupdate_available=unknown\n");
    return 1;
  }

  const repoUrl = await getGitOriginUrl(manifest.octoclawRoot).catch(() => DEFAULT_REPO_URL);
  await runCommand("git", ["fetch", "origin", manifest.branch], { cwd: manifest.octoclawRoot });
  const remoteCommit = await readGitOutput(manifest.octoclawRoot, ["rev-parse", `origin/${manifest.branch}`]);
  const localCommit = manifest.commit;
  const updateAvailable = remoteCommit !== localCommit;

  process.stdout.write(
    [
      "managed_install=true",
      `repo_url=${repoUrl}`,
      `branch=${manifest.branch}`,
      `local_commit=${localCommit}`,
      `remote_commit=${remoteCommit}`,
      `update_available=${String(updateAvailable)}`,
    ].join("\n") + "\n",
  );

  return 0;
}

export async function showStatus(options: { openclawHome?: string }): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const manifest = readSourceManifest(openclawHome);

  if (!manifest) {
    process.stdout.write("managed_install=false\nmanifest_present=false\n");
    return 1;
  }

  const deployStatus = await collectDeployStatus(openclawHome, manifest.octoclawRoot);
  const missingArtifacts = deployStatus.missingExtensions.length + deployStatus.missingPackages.length;

  process.stdout.write(
    [
      "managed_install=true",
      `manifest_present=true`,
      `commit=${manifest.commit}`,
      `branch=${manifest.branch}`,
      `installed_at=${manifest.installedAt}`,
      `octoclaw_root=${manifest.octoclawRoot}`,
      `runtime_extension_present=${String(deployStatus.runtimeExtensionPresent)}`,
      `expected_packages=${deployStatus.expectedPackages.join(",")}`,
      `missing_extensions=${deployStatus.missingExtensions.join(",")}`,
      `missing_packages=${deployStatus.missingPackages.join(",")}`,
    ].join("\n") + "\n",
  );

  return missingArtifacts === 0 ? 0 : 1;
}

export async function uninstall(options: { openclawHome?: string }): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const runtimeExtensionPath = path.join(openclawHome, "extensions", RUNTIME_EXTENSION_NAME);
  const packagesDir = path.join(openclawHome, "packages");
  const sourceManifestPath = manifestPath(openclawHome);

  await rm(runtimeExtensionPath, { recursive: true, force: true });

  const installedPackages = await listDirectories(packagesDir, (name) => name.startsWith("octoclaw-"));
  for (const packageName of installedPackages) {
    await rm(path.join(packagesDir, packageName), { recursive: true, force: true });
  }

  await rm(sourceManifestPath, { force: true });
  process.stdout.write("Uninstalled deployed OctoClaw runtime extension, packages, and source manifest\n");
  return 0;
}

export async function manage(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      printUsage();
      return 0;
    }

    switch (parsed.command) {
      case "install":
        return await installFromSource({
          repoUrl: parsed.repoUrl,
          branch: parsed.branch,
          openclawHome: parsed.openclawHome,
        });
      case "update":
        return await updateFromSource({ openclawHome: parsed.openclawHome });
      case "check":
        return await checkForUpdates({ openclawHome: parsed.openclawHome });
      case "status":
        return await showStatus({ openclawHome: parsed.openclawHome });
      case "uninstall":
        return await uninstall({ openclawHome: parsed.openclawHome });
      default:
        process.stderr.write(`Unknown command: ${parsed.command}\n`);
        printUsage();
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export const main = manage;

void (async () => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return;
  }

  if (import.meta.url === pathToFileURL(entrypoint).href) {
    process.exit(await manage(process.argv.slice(2)));
  }
})();
