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
import { access, lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  restart: boolean;
  help: boolean;
}

interface DeployStatus {
  expectedExtensions: string[];
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
const DEPLOY_PACKAGE_NAMES = [
  "octoclaw-contracts",
  "octoclaw-policy",
  "octoclaw-runtime-core",
  "octoclaw-delegation",
  "octoclaw-fast-reply",
  "octoclaw-status-surface",
];
const DEPLOY_EXTENSION_NAMES = [
  RUNTIME_EXTENSION_NAME,
];
const NODE_MODULES_SCOPE = "@octoclaw";

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
      "  --restart            Restart OpenClaw gateway and node after install/update",
      "  -h, --help           Show this help",
    ].join("\n") + "\n",
  );
}

function resolveOpenClawHome(openclawHome?: string): string {
  return path.resolve(openclawHome ?? process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"));
}

function readOpenClawConfig(openclawHome: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(openclawHome, "openclaw.json"), "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readWorkspaceRootFromConfig(openclawHome: string): string | null {
  const config = readOpenClawConfig(openclawHome);
  const agents = config?.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;
  const defaults = (agents as Record<string, unknown>).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return null;
  const workspace = (defaults as Record<string, unknown>).workspace;
  return typeof workspace === "string" && workspace.trim().length > 0 ? path.resolve(workspace) : null;
}

function resolveOctoclawRoot(openclawHome: string): string {
  const workspaceRoot = readWorkspaceRootFromConfig(openclawHome);
  if (workspaceRoot) {
    return path.join(workspaceRoot, "openclaw", "repos", "octoclaw");
  }
  return path.join(openclawHome, "workspace", "openclaw", "repos", "octoclaw");
}

function manifestPath(openclawHome: string): string {
  return path.join(openclawHome, MANIFEST_FILENAME);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildCommandEnv(baseEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const pathEntries = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    baseEnv.PATH ?? "",
  ].filter((value) => value.length > 0);

  return {
    ...baseEnv,
    PATH: pathEntries.join(":"),
  };
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
      env: buildCommandEnv(process.env),
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
  await syncExtensions(octoclawRoot, openclawHome);
}

interface DeploySource {
  kind: "packages" | "extensions";
  sourceRoot: string;
}

async function resolveDeploySource(octoclawRoot: string, unitName: string): Promise<DeploySource | null> {
  const candidates: DeploySource[] = [
    { kind: "packages", sourceRoot: path.join(octoclawRoot, "packages", unitName) },
    { kind: "extensions", sourceRoot: path.join(octoclawRoot, "extensions", unitName) },
  ];

  for (const candidate of candidates) {
    const packageJson = path.join(candidate.sourceRoot, "package.json");
    const distDir = path.join(candidate.sourceRoot, "dist");
    if ((await pathExists(packageJson)) && (await pathExists(distDir))) {
      return candidate;
    }
  }

  return null;
}

async function syncDeployUnit(sourceDir: string, targetDir: string): Promise<void> {
  await ensureDirectory(path.dirname(targetDir));
  await runCommand(
    "rsync",
    [
      "-a",
      "--delete",
      "--prune-empty-dirs",
      "--include",
      "package.json",
      "--include",
      "openclaw.plugin.json",
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
    { cwd: sourceDir },
  );
}

async function syncExtensions(octoclawRoot: string, openclawHome: string): Promise<void> {
  const extensionsTargetDir = path.join(openclawHome, "extensions");
  await ensureDirectory(extensionsTargetDir);

  const existingExtensions = await listDirectories(extensionsTargetDir, (name) => name.startsWith("octoclaw-"));
  for (const existingExtension of existingExtensions) {
    if (!DEPLOY_EXTENSION_NAMES.includes(existingExtension)) {
      await rm(path.join(extensionsTargetDir, existingExtension), { recursive: true, force: true });
    }
  }

  for (const extensionName of DEPLOY_EXTENSION_NAMES) {
    const source = await resolveDeploySource(octoclawRoot, extensionName);
    if (!source || source.kind !== "extensions") {
      throw new Error(`Runtime extension source not found or not built: ${extensionName}`);
    }
    await syncDeployUnit(source.sourceRoot, path.join(extensionsTargetDir, extensionName));
  }
}

async function syncPackages(octoclawRoot: string, openclawHome: string): Promise<string[]> {
  const packagesTargetDir = path.join(openclawHome, "packages");
  const packageNames = [...DEPLOY_PACKAGE_NAMES];

  await ensureDirectory(packagesTargetDir);

  const existingTargetPackages = await listDirectories(packagesTargetDir, (name) => name.startsWith("octoclaw-"));
  for (const existingPackage of existingTargetPackages) {
    if (!packageNames.includes(existingPackage)) {
      await rm(path.join(packagesTargetDir, existingPackage), { recursive: true, force: true });
    }
  }

  for (const packageName of packageNames) {
    const source = await resolveDeploySource(octoclawRoot, packageName);
    if (!source) {
      throw new Error(`Deploy package source not found or not built: ${packageName}`);
    }
    await syncDeployUnit(source.sourceRoot, path.join(packagesTargetDir, packageName));
  }

  return packageNames;
}

async function getExpectedPackageNames(octoclawRoot: string): Promise<string[]> {
  const names: string[] = [];
  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const source = await resolveDeploySource(octoclawRoot, packageName);
    if (source) {
      names.push(packageName);
    }
  }
  return names;
}

async function getExpectedExtensionNames(octoclawRoot: string): Promise<string[]> {
  const names: string[] = [];
  for (const extensionName of DEPLOY_EXTENSION_NAMES) {
    const source = await resolveDeploySource(octoclawRoot, extensionName);
    if (source?.kind === "extensions") {
      names.push(extensionName);
    }
  }
  return names;
}

async function collectDeployStatus(openclawHome: string, octoclawRoot?: string): Promise<DeployStatus> {
  let expectedPackages: string[] = [];
  let expectedExtensions: string[] = [];
  if (octoclawRoot && (await pathExists(path.join(octoclawRoot, "packages")))) {
    expectedPackages = await getExpectedPackageNames(octoclawRoot);
    expectedExtensions = await getExpectedExtensionNames(octoclawRoot);
  } else {
    expectedPackages = [...DEPLOY_PACKAGE_NAMES];
    expectedExtensions = [...DEPLOY_EXTENSION_NAMES];
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

  const missingExtensions: string[] = [];
  for (const extensionName of expectedExtensions) {
    const extensionDir = path.join(openclawHome, "extensions", extensionName);
    const packageJsonPath = path.join(extensionDir, "package.json");
    const distPath = path.join(extensionDir, "dist");
    if (!(await pathExists(packageJsonPath)) || !(await pathExists(distPath))) {
      missingExtensions.push(extensionName);
    }
  }

  return {
    expectedExtensions,
    missingExtensions,
    expectedPackages,
    missingPackages,
  };
}

async function reconcileDeployment(openclawHome: string, octoclawRoot: string): Promise<void> {
  const deployStatus = await collectDeployStatus(openclawHome, octoclawRoot);
  if (deployStatus.missingExtensions.length > 0 || deployStatus.missingPackages.length > 0) {
    const fragments = [
      deployStatus.missingExtensions.length > 0 ? `missing extensions: ${deployStatus.missingExtensions.join(", ")}` : null,
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
    restart: false,
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
      case "--restart":
        parsed.restart = true;
        index += 1;
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
  const installDir = path.resolve(env.OCTOCLAW_INSTALL_DIR ?? resolveOctoclawRoot(openclawHome));

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

async function ensureSymlink(linkPath: string, targetPath: string): Promise<void> {
  await ensureDirectory(path.dirname(linkPath));
  try {
    const entry = await lstat(linkPath);
    if (entry.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath);
      const resolvedTarget = path.resolve(path.dirname(linkPath), existingTarget);
      if (resolvedTarget === targetPath) {
        return;
      }
    }
    await rm(linkPath, { recursive: true, force: true });
  } catch {
    // intentionally empty
  }
  await symlink(targetPath, linkPath, "dir");
}

async function resolveOpenClawBinary(openclawHome: string): Promise<string> {
  const candidates = [
    process.env.OPENCLAW_BIN,
    path.join(os.homedir(), ".local", "bin", "openclaw"),
    path.join(openclawHome, "bin", "openclaw"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return "openclaw";
}

async function resolveInstalledNodeModulesRoot(openclawHome: string): Promise<string | null> {
  const binary = await resolveOpenClawBinary(openclawHome);
  if (binary === "openclaw") {
    return null;
  }

  const candidates = new Set<string>([
    path.join(os.homedir(), ".local", "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ]);

  const resolvedBinaryPaths = [path.resolve(binary)];
  try {
    resolvedBinaryPaths.push(path.resolve(path.dirname(binary), await readlink(binary)));
  } catch {
    // intentionally empty
  }

  for (const resolvedBinaryPath of resolvedBinaryPaths) {
    const normalizedBinaryPath = resolvedBinaryPath.replace(/\\/g, "/");
    const nodeModulesMarker = "/node_modules/";
    const markerIndex = normalizedBinaryPath.lastIndexOf(nodeModulesMarker);
    if (markerIndex >= 0) {
      candidates.add(normalizedBinaryPath.slice(0, markerIndex + nodeModulesMarker.length - 1));
    }

    candidates.add(path.join(path.dirname(path.dirname(resolvedBinaryPath)), "node_modules"));
    candidates.add(path.join(path.dirname(path.dirname(path.dirname(resolvedBinaryPath))), "node_modules"));
    candidates.add(path.join(path.dirname(path.dirname(resolvedBinaryPath)), "lib", "node_modules"));
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function linkOctoclawPackageGraph(targetRoot: string, openclawHome: string, includeExtension = false): Promise<void> {
  const scopeRoot = path.join(targetRoot, NODE_MODULES_SCOPE);
  await ensureDirectory(scopeRoot);

  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const aliasName = packageName.replace(/^octoclaw-/, "");
    await ensureSymlink(path.join(scopeRoot, aliasName), path.join(openclawHome, "packages", packageName));
  }

  if (includeExtension) {
    for (const extensionName of DEPLOY_EXTENSION_NAMES) {
      const aliasName = extensionName.replace(/^octoclaw-/, "");
      await ensureSymlink(path.join(scopeRoot, aliasName), path.join(openclawHome, "extensions", extensionName));
    }
  }
}

async function setupDeploySymlinks(openclawHome: string): Promise<void> {
  await linkOctoclawPackageGraph(path.join(openclawHome, "extensions", RUNTIME_EXTENSION_NAME, "node_modules"), openclawHome, false);
  await linkOctoclawPackageGraph(path.join(openclawHome, "node_modules"), openclawHome, true);

  const installedNodeModulesRoot = await resolveInstalledNodeModulesRoot(openclawHome);
  if (installedNodeModulesRoot) {
    await linkOctoclawPackageGraph(installedNodeModulesRoot, openclawHome, true);
  }
}

async function validateRuntimeExtensionLoad(openclawHome: string): Promise<void> {
  const extensionRoot = path.join(openclawHome, "extensions", RUNTIME_EXTENSION_NAME);
  const manifestPathname = path.join(extensionRoot, "openclaw.plugin.json");
  const manifestRaw = JSON.parse(await readFile(manifestPathname, "utf8")) as Record<string, unknown>;
  const mainEntry = typeof manifestRaw.main === "string"
    ? manifestRaw.main
    : Array.isArray(manifestRaw.extensions) && typeof manifestRaw.extensions[0] === "string"
      ? manifestRaw.extensions[0]
      : "";

  if (!mainEntry) {
    throw new Error(`Deployed plugin manifest missing main entry: ${manifestPathname}`);
  }

  const entryPath = path.join(extensionRoot, mainEntry.replace(/^\.\//, ""));
  await import(pathToFileURL(entryPath).href);
}

async function restartService(openclawHome: string, service: "gateway" | "node"): Promise<void> {
  const binary = await resolveOpenClawBinary(openclawHome);
  try {
    await runCommand(binary, [service, "restart"]);
    return;
  } catch (error) {
    if (os.platform() !== "darwin") {
      throw error;
    }
  }

  const uid = await runCommand("id", ["-u"], { captureStdout: true });
  const label = service === "gateway" ? "ai.openclaw.gateway" : "ai.openclaw.node";
  await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
}

async function restartOpenClawServices(openclawHome: string): Promise<void> {
  await restartService(openclawHome, "gateway");
  await restartService(openclawHome, "node");
}

export async function installFromSource(options: {
  repoUrl?: string;
  branch?: string;
  openclawHome?: string;
  restart?: boolean;
}): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const octoclawRoot = resolveOctoclawRoot(openclawHome);
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
  const branch = options.branch ?? DEFAULT_REF;

  await ensureGitCheckout({ octoclawRoot, repoUrl, branch });
  await buildWorkspace(octoclawRoot);
  await syncRuntimeExtension(octoclawRoot, openclawHome);
  await syncPackages(octoclawRoot, openclawHome);
  await setupDeploySymlinks(openclawHome);
  await validateRuntimeExtensionLoad(openclawHome);

  const manifest: SourceManifest = {
    type: "git",
    commit: await getGitCommit(octoclawRoot),
    branch,
    installedAt: new Date().toISOString(),
    octoclawRoot,
  };
  await writeSourceManifest(openclawHome, manifest);
  await reconcileDeployment(openclawHome, octoclawRoot);
  if (options.restart) {
    await restartOpenClawServices(openclawHome);
  }

  process.stdout.write(`Installed OctoClaw from source at ${manifest.commit} (${branch})\n`);
  return 0;
}

export async function updateFromSource(options: { openclawHome?: string; restart?: boolean }): Promise<number> {
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
  await setupDeploySymlinks(openclawHome);
  await validateRuntimeExtensionLoad(openclawHome);

  const nextManifest: SourceManifest = {
    type: "git",
    commit: await getGitCommit(octoclawRoot),
    branch,
    installedAt: new Date().toISOString(),
    octoclawRoot,
  };
  await writeSourceManifest(openclawHome, nextManifest);
  await reconcileDeployment(openclawHome, octoclawRoot);
  if (options.restart) {
    await restartOpenClawServices(openclawHome);
  }

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
      `expected_extensions=${deployStatus.expectedExtensions.join(",")}`,
      `expected_packages=${deployStatus.expectedPackages.join(",")}`,
      `missing_extensions=${deployStatus.missingExtensions.join(",")}`,
      `missing_packages=${deployStatus.missingPackages.join(",")}`,
    ].join("\n") + "\n",
  );

  return missingArtifacts === 0 ? 0 : 1;
}

export async function uninstall(options: { openclawHome?: string }): Promise<number> {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const packagesDir = path.join(openclawHome, "packages");
  const extensionsDir = path.join(openclawHome, "extensions");
  const sourceManifestPath = manifestPath(openclawHome);

  for (const extensionName of DEPLOY_EXTENSION_NAMES) {
    await rm(path.join(extensionsDir, extensionName), { recursive: true, force: true });
  }

  const installedPackages = await listDirectories(packagesDir, (name) => name.startsWith("octoclaw-"));
  for (const packageName of installedPackages) {
    await rm(path.join(packagesDir, packageName), { recursive: true, force: true });
  }

  await rm(sourceManifestPath, { force: true });
  process.stdout.write("Uninstalled deployed OctoClaw extensions, packages, and source manifest\n");
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
          restart: parsed.restart,
        });
      case "update":
        return await updateFromSource({ openclawHome: parsed.openclawHome, restart: parsed.restart });
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
