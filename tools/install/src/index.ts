#!/usr/bin/env node

// @ts-ignore missing Node type package in this workspace
import { lstat as lstatSync, readlink as readlinkSync, realpath as realpathSync, rename as renameSync, symlink as symlinkSync } from "node:fs";
// @ts-ignore missing Node type package in this workspace
import { access, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
// @ts-ignore missing Node type package in this workspace
import { spawn } from "node:child_process";
// @ts-ignore missing Node type package in this workspace
import { createInterface } from "node:readline/promises";
// @ts-ignore missing Node type package in this workspace
import { stdin, stdout, stderr, argv, env, cwd, exit } from "node:process";
// @ts-ignore missing Node type package in this workspace
import { promisify } from "node:util";
import os from "node:os";
// @ts-ignore missing Node type package in this workspace
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConcreteModelId, ModelProfile, ModelProfileMapping } from "@octoclaw/contracts/schemas";
import { V1_MODEL_PROFILE_MAP } from "@octoclaw/policy/model";

const CONFIG_FILE_NAME = "octoclaw-config.json";
const MODEL_CONFIG_FILE_NAME = "octoclaw-model-config.json";
const AGENTS_FILE_NAME = "AGENTS.md";
const OCTOCLAW_RULES_VERSION = "v1.7.0";
const RULE_BLOCK_START = `<!-- octoclaw:core-rules ${OCTOCLAW_RULES_VERSION} -->`;
const RULE_BLOCK_END = "<!-- /octoclaw:core-rules -->";
const DEFAULT_WORKSPACE_DIRNAME = ".octoclaw";
const DEFAULT_OPENCLAW_DIRNAME = ".openclaw";
const EXTENSION_NAME = "octoclaw-runtime";

const MODEL_PROFILES = Object.keys(V1_MODEL_PROFILE_MAP) as ModelProfile[];

const AGENTS_RULES_BODY = `${RULE_BLOCK_START}
## 🐙 OctoClaw core rules

### Core guardrails

- Prefer OctoClaw-native routing and runtime tools when they are available.
- Use direct replies only for low-risk, low-context tasks that can be completed cleanly in one turn.
- Route tool-heavy, long-running, multi-step, or code-changing work through delegated runtime paths.
- Keep same-file writes serialized and respect upstream task dependencies.
- When delegated work returns an artifact or report path, inspect the artifact before presenting the final answer.

### Routing defaults

- Treat \`direct\` as an allowlist, not the universal default.
- Prefer runtime status surfaces as the source of truth for delegated work.
- Preserve complete status output when the operator explicitly asks for status.
- Avoid bypassing the runtime once routing has selected a delegated path.

### Model policy

- Resolve worker models from policy-first profile mapping.
- Use stronger profiles for deep code and review work.
- Keep custom overrides in workspace model config rather than ad-hoc prompt changes.

### Runtime discipline

- Persist task lifecycle state before and after delegated execution.
- Favor artifact-first outputs for large results.
- Reconcile missing runtime files rather than assuming manual fixes.
${RULE_BLOCK_END}`;

export interface InstallConfigFile {
  defaultChannel: "direct";
  defaultNotifyPolicy: "silent";
  defaultRuntime: "subagent";
  modelAliasMap: Record<string, ConcreteModelId>;
}

export interface ModelConfigFile {
  mode: "auto" | "custom";
  updatedAt: string;
  mappings: ModelProfileMapping[];
  overrides: Partial<Record<ModelProfile, ConcreteModelId>>;
}

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

export interface ReconcileOptions {
  workspace?: string;
  openclawHome?: string;
  octoclawRoot?: string;
  skipBuild?: boolean;
}

export interface DeployOptions {
  workspace?: string;
  openclawHome?: string;
  octoclawRoot?: string;
  skipBuild?: boolean;
  restart?: boolean;
}

interface ResolvedPaths {
  octoclawRoot: string;
  workspaceRoot: string;
  openclawHome: string;
}

type CliCommand = "install" | "reconcile" | "config" | "model" | "deploy";

const DEPLOY_PACKAGE_NAMES = [
  "octoclaw-contracts",
  "octoclaw-policy",
  "octoclaw-runtime-core",
  "octoclaw-delegation",
  "octoclaw-fast-reply",
  "octoclaw-status-surface",
];

type DeploySourceKind = "packages" | "extensions";

interface DeployPackageSource {
  name: string;
  kind: DeploySourceKind;
  sourceRoot: string;
}

const DEPLOY_EXTENSION_NAMES = [EXTENSION_NAME];
const lstatAsync = promisify(lstatSync);
const readlinkAsync = promisify(readlinkSync);
const realpathAsync = promisify(realpathSync);
const renameAsync = promisify(renameSync);
const symlinkAsync = promisify(symlinkSync);

function nowIso(): string {
  return new Date().toISOString();
}

function resolveHomePath(targetPath: string): string {
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function resolveAbsolute(targetPath: string): string {
  return path.resolve(resolveHomePath(targetPath));
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

async function ensureParentDirectory(targetPath: string): Promise<void> {
  await ensureDirectory(path.dirname(targetPath));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toSortedMappings(map: Record<ModelProfile, ConcreteModelId>): ModelProfileMapping[] {
  return MODEL_PROFILES.map((profile) => ({ profile, modelId: map[profile] }));
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isSymbolicLink(targetPath: string): Promise<boolean> {
  try {
    return (await lstatAsync(targetPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function findGitRoot(startPath: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: startPath, stdio: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to locate git repo root from ${startPath}: ${result.stderr.trim() || result.stdout.trim() || "git rev-parse failed"}`);
  }
  return result.stdout.trim();
}

async function resolveOctoclawRoot(override?: string): Promise<string> {
  if (override) {
    return resolveAbsolute(override);
  }

  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const repoFromFile = await findGitRoot(currentFileDir);
  return resolveAbsolute(repoFromFile);
}

function resolveWorkspaceRoot(override?: string): string {
  const preferred = override ?? env.OCTOCLAW_WORKSPACE ?? env.WORKSPACE_ROOT ?? path.join(os.homedir(), DEFAULT_WORKSPACE_DIRNAME);
  return resolveAbsolute(preferred);
}

function resolveOpenclawHome(override?: string): string {
  const preferred = override ?? env.OPENCLAW_HOME ?? path.join(os.homedir(), DEFAULT_OPENCLAW_DIRNAME);
  return resolveAbsolute(preferred);
}

async function resolvePaths(options: { workspace?: string; openclawHome?: string; octoclawRoot?: string }): Promise<ResolvedPaths> {
  return {
    octoclawRoot: await resolveOctoclawRoot(options.octoclawRoot),
    workspaceRoot: resolveWorkspaceRoot(options.workspace),
    openclawHome: resolveOpenclawHome(options.openclawHome),
  };
}

function createInstallConfig(paths: ResolvedPaths): InstallConfig {
  return {
    openclawHome: paths.openclawHome,
    workspaceDir: paths.workspaceRoot,
    extensionDir: path.join(paths.octoclawRoot, "extensions", EXTENSION_NAME),
    repoRoot: paths.octoclawRoot,
    dryRun: false,
  };
}

export function detectOpenClawInstallation(environment: Record<string, string | undefined>): string {
  const preferred = environment.OPENCLAW_HOME ?? (environment.HOME ? path.join(environment.HOME, DEFAULT_OPENCLAW_DIRNAME) : undefined);
  if (!preferred) {
    throw new Error("Unable to resolve OpenClaw installation: HOME or OPENCLAW_HOME is required.");
  }
  return resolveAbsolute(preferred);
}

export function detectWorkspace(environment: Record<string, string | undefined>): string {
  const preferred = environment.WORKSPACE ?? environment.OCTOCLAW_WORKSPACE ?? environment.WORKSPACE_ROOT ?? environment.PWD;
  if (!preferred) {
    throw new Error("Unable to resolve workspace path: set WORKSPACE, OCTOCLAW_WORKSPACE, WORKSPACE_ROOT, or PWD.");
  }
  return resolveAbsolute(preferred);
}

export function resolveInstallConfig(environment: Record<string, string | undefined>): InstallConfig {
  const repoRoot = detectWorkspace(environment);
  const workspaceDir = detectWorkspace(environment);
  const openclawHome = detectOpenClawInstallation(environment);
  return {
    openclawHome,
    workspaceDir,
    extensionDir: path.join(repoRoot, "extensions", EXTENSION_NAME),
    repoRoot,
    dryRun: environment.OCTOCLAW_INSTALL_DRY_RUN === "1" || environment.OCTOCLAW_INSTALL_DRY_RUN === "true",
  };
}

export function buildExtensionPaths(config: InstallConfig): { src: string; dest: string } {
  return {
    src: path.join(config.extensionDir, "dist"),
    dest: path.join(config.openclawHome, "extensions", EXTENSION_NAME),
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

function defaultInstallConfig(): InstallConfigFile {
  return {
    defaultChannel: "direct",
    defaultNotifyPolicy: "silent",
    defaultRuntime: "subagent",
    modelAliasMap: {},
  };
}

export async function generateConfig(workspaceRoot: string): Promise<void> {
  const targetFile = path.join(workspaceRoot, CONFIG_FILE_NAME);
  const existing = await readJsonFile<Partial<InstallConfigFile>>(targetFile);
  const nextConfig: InstallConfigFile = {
    ...defaultInstallConfig(),
    ...existing,
    modelAliasMap: existing?.modelAliasMap ?? {},
  };
  await writeJsonFile(targetFile, nextConfig);
}

async function promptForOverrides(defaults: Record<ModelProfile, ConcreteModelId>): Promise<Partial<Record<ModelProfile, ConcreteModelId>>> {
  const rl = createInterface({ input: stdin, output: stdout });
  const overrides: Partial<Record<ModelProfile, ConcreteModelId>> = {};
  try {
    stdout.write("OctoClaw custom model configuration\n");
    stdout.write("Press Enter to keep the default model for a profile.\n\n");
    for (const profile of MODEL_PROFILES) {
      const answer = await rl.question(`${profile} [${defaults[profile]}]: `);
      const trimmed = answer.trim();
      if (trimmed.length > 0) {
        overrides[profile] = trimmed;
      }
    }
  } finally {
    rl.close();
  }
  return overrides;
}

function buildModelConfig(
  mode: "auto" | "custom",
  overrides: Partial<Record<ModelProfile, ConcreteModelId>>,
): ModelConfigFile {
  const resolvedMap = { ...V1_MODEL_PROFILE_MAP, ...overrides };
  return {
    mode,
    updatedAt: nowIso(),
    mappings: toSortedMappings(resolvedMap),
    overrides,
  };
}

export async function selectModel(workspaceRoot: string, auto: boolean): Promise<void> {
  await ensureDirectory(workspaceRoot);
  const modelConfigPath = path.join(workspaceRoot, MODEL_CONFIG_FILE_NAME);
  const overrides = auto ? {} : await promptForOverrides(V1_MODEL_PROFILE_MAP);
  const mode = auto ? "auto" : "custom";
  const config = buildModelConfig(mode, overrides);
  await writeJsonFile(modelConfigPath, config);
}

async function copyFileIfPresent(sourceFile: string, targetFile: string): Promise<void> {
  if (!(await pathExists(sourceFile))) {
    throw new Error(`Required file not found: ${sourceFile}`);
  }
  await ensureParentDirectory(targetFile);
  await copyFile(sourceFile, targetFile);
}

function packageNameToWorkspaceDir(name: string): string {
  return name;
}

export function deploySourceCandidatesForPackage(octoclawRoot: string, packageName: string): Array<{ kind: DeploySourceKind; root: string }> {
  return [
    { kind: "packages", root: path.join(octoclawRoot, "packages", packageNameToWorkspaceDir(packageName)) },
    { kind: "extensions", root: path.join(octoclawRoot, "extensions", packageNameToWorkspaceDir(packageName)) },
  ];
}

async function resolveDeployPackageSource(octoclawRoot: string, packageName: string): Promise<DeployPackageSource | null> {
  const candidateRoots = deploySourceCandidatesForPackage(octoclawRoot, packageName);

  for (const candidate of candidateRoots) {
    const packageJson = path.join(candidate.root, "package.json");
    const distDir = path.join(candidate.root, "dist");
    if ((await pathExists(packageJson)) && (await isDirectory(distDir))) {
      return {
        name: packageName,
        kind: candidate.kind,
        sourceRoot: candidate.root,
      };
    }
  }

  return null;
}

async function deployPackageDirectory(sourceRoot: string, targetDir: string): Promise<void> {
  const distDir = path.join(sourceRoot, "dist");
  const packageJson = path.join(sourceRoot, "package.json");

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await cp(distDir, path.join(targetDir, "dist"), { recursive: true, force: true });
  await copyFileIfPresent(packageJson, path.join(targetDir, "package.json"));
}

async function validateDeployedPackageGraph(openclawHome: string): Promise<void> {
  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const deployedRoot = path.join(openclawHome, "packages", packageName);
    const packageJsonPath = path.join(deployedRoot, "package.json");
    const distDir = path.join(deployedRoot, "dist");

    if (!(await pathExists(packageJsonPath))) {
      throw new Error(`Deployed package missing package.json: ${packageJsonPath}`);
    }
    if (!(await isDirectory(distDir))) {
      throw new Error(`Deployed package missing dist directory: ${distDir}`);
    }
  }
}

async function validateDeployedExtensionLoad(openclawHome: string): Promise<void> {
  const extensionRoot = path.join(openclawHome, "extensions", EXTENSION_NAME);
  const pluginManifestPath = path.join(extensionRoot, "openclaw.plugin.json");
  const pluginManifest = await readJsonFile<{ main?: string; extensions?: string[] }>(pluginManifestPath);
  if (!pluginManifest) {
    throw new Error(`Unable to read deployed plugin manifest: ${pluginManifestPath}`);
  }

  const mainEntry = pluginManifest.main || pluginManifest.extensions?.[0];
  if (!mainEntry) {
    throw new Error(`Deployed plugin manifest does not declare a main entry: ${pluginManifestPath}`);
  }

  const entryPath = path.join(extensionRoot, mainEntry.replace(/^\.\//, ""));
  if (!(await pathExists(entryPath))) {
    throw new Error(`Deployed plugin entrypoint missing: ${entryPath}`);
  }

  try {
    await import(new URL(`file://${entryPath}`).href);
  } catch (error) {
    throw new Error(`Deployed plugin entrypoint failed to load: ${entryPath}\n${String(error)}`);
  }
}

async function buildMonorepo(octoclawRoot: string): Promise<void> {
  const result = await runCommand("pnpm", ["-r", "run", "build"], { cwd: octoclawRoot, stdio: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`Monorepo build failed with exit code ${result.exitCode}.`);
  }
}

export async function deployExtensions(octoclawRoot: string, openclawHome: string): Promise<void> {
  const extensionRoot = path.join(octoclawRoot, "extensions", EXTENSION_NAME);
  const sourceDist = path.join(extensionRoot, "dist");
  const targetRoot = path.join(openclawHome, "extensions", EXTENSION_NAME);

  if (!(await isDirectory(sourceDist))) {
    throw new Error(`Extension dist directory does not exist: ${sourceDist}`);
  }

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(sourceDist, path.join(targetRoot, "dist"), { recursive: true, force: true });
  await copyFileIfPresent(path.join(extensionRoot, "openclaw.plugin.json"), path.join(targetRoot, "openclaw.plugin.json"));
  await copyFileIfPresent(path.join(extensionRoot, "package.json"), path.join(targetRoot, "package.json"));
}

export async function deployPackages(octoclawRoot: string, openclawHome: string): Promise<void> {
  const targetPackagesRoot = path.join(openclawHome, "packages");
  await ensureDirectory(targetPackagesRoot);

  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const source = await resolveDeployPackageSource(octoclawRoot, packageName);
    if (!source) {
      throw new Error(`Deploy package source not found or not built: ${packageName}`);
    }

    const targetDir = path.join(targetPackagesRoot, packageName);
    await deployPackageDirectory(source.sourceRoot, targetDir);
  }
}

async function moveDirectoryToBackup(targetPath: string): Promise<void> {
  if (!(await isDirectory(targetPath)) || (await isSymbolicLink(targetPath))) {
    return;
  }
  const backupDir = path.join(path.dirname(targetPath), "..", "backups");
  await mkdir(backupDir, { recursive: true });
  const backupName = `${path.basename(targetPath)}.bak.${timestampForBackup()}`;
  await renameAsync(targetPath, path.join(backupDir, backupName));
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

async function ensureSymlink(linkPath: string, targetPath: string): Promise<void> {
  await ensureParentDirectory(linkPath);
  try {
    const existingStat = await lstatAsync(linkPath);
    if (existingStat.isSymbolicLink()) {
      const existingTarget = await readlinkAsync(linkPath);
      const resolvedTarget = path.resolve(path.dirname(linkPath), existingTarget);
      if (resolvedTarget === targetPath) {
        return;
      }
    }
    await rm(linkPath, { recursive: true, force: true });
  } catch {
    // intentionally empty
  }
  await symlinkAsync(targetPath, linkPath, "dir");
}

async function resolveOpenclawNodeModulesRoot(): Promise<string | null> {
  const whichResult = await runCommand("which", ["openclaw"], { stdio: "pipe" });
  if (whichResult.exitCode !== 0) {
    return null;
  }

  const openclawBinaryPath = whichResult.stdout.trim();
  if (!openclawBinaryPath) {
    return null;
  }

  let resolvedBinaryPath = openclawBinaryPath;
  try {
    resolvedBinaryPath = await realpathAsync(openclawBinaryPath);
  } catch {
    resolvedBinaryPath = openclawBinaryPath;
  }

  const candidateNodeModules = path.join(path.dirname(path.dirname(resolvedBinaryPath)), "node_modules");
  return (await isDirectory(candidateNodeModules)) ? candidateNodeModules : null;
}

async function linkOctoclawModules(linkRoot: string, openclawHome: string, includeExtension: boolean): Promise<void> {
  const scopedRoot = path.join(linkRoot, "@octoclaw");
  await ensureDirectory(scopedRoot);

  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const aliasName = packageName.replace(/^octoclaw-/, "");
    await ensureSymlink(path.join(scopedRoot, aliasName), path.join(openclawHome, "packages", packageName));
  }

  if (includeExtension) {
    for (const extensionName of DEPLOY_EXTENSION_NAMES) {
      const aliasName = extensionName.replace(/^octoclaw-/, "");
      await ensureSymlink(path.join(scopedRoot, aliasName), path.join(openclawHome, "extensions", extensionName));
    }
  }
}

async function setupDeploySymlinks(openclawHome: string): Promise<void> {
  await linkOctoclawModules(path.join(openclawHome, "extensions", EXTENSION_NAME, "node_modules"), openclawHome, false);

  const openclawNodeModules = await resolveOpenclawNodeModulesRoot();
  if (openclawNodeModules) {
    await linkOctoclawModules(openclawNodeModules, openclawHome, true);
  }

  await linkOctoclawModules(path.join(openclawHome, "node_modules"), openclawHome, true);
}

async function cleanupOldBackups(openclawHome: string, keepCount = 3): Promise<void> {
  const backupDir = path.join(openclawHome, "backups");
  if (!(await isDirectory(backupDir))) {
    return;
  }

  for (const extensionName of DEPLOY_EXTENSION_NAMES) {
    const backupPrefix = `${extensionName}.bak.`;
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backups = entries
      .filter((entry) => entry.name.startsWith(backupPrefix))
      .map((entry) => path.join(backupDir, entry.name))
      .sort();

    if (backups.length <= keepCount) {
      continue;
    }

    for (const backupPath of backups.slice(0, backups.length - keepCount)) {
      await rm(backupPath, { recursive: true, force: true });
    }
  }
}

async function syncJudgeFastEnv(openclawHome: string): Promise<void> {
  const configPath = path.join(openclawHome, "judge-fast.json");
  if (!(await pathExists(configPath))) return;
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw);
    const json = JSON.stringify(config);
    await runCommand("launchctl", ["setenv", "OCTOCLAW_JUDGE_FAST", json], { stdio: "pipe" });
    await runCommand("launchctl", ["setenv", "OCTOCLAW_DELEGATION_ENABLED", "true"], { stdio: "pipe" });
    stdout.write(`✅ Judge config synced: model=${config.modelId ?? "?"}\n`);
  } catch (e) {
    stdout.write(`⚠️  judge-fast.json parse failed: ${String(e)}\n`);
  }
}

async function restartGateway(openclawHome: string): Promise<void> {
  const restartResult = await runCommand("openclaw", ["gateway", "restart"], { stdio: "pipe" });
  if (restartResult.exitCode !== 0) {
    stderr.write(restartResult.stderr || restartResult.stdout);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 4000));
  const gatewayLogPath = path.join(openclawHome, "logs", "gateway.log");
  if (!(await pathExists(gatewayLogPath))) {
    stdout.write("⚠️  Check gateway log manually; log file not found yet.\n");
    return;
  }

  const logContent = await readFile(gatewayLogPath, "utf8");
  const recentLines = logContent.trimEnd().split(/\r?\n/).slice(-20).join("\n");
  const errorLogPath = path.join(openclawHome, "logs", "gateway.err.log");
  const errorContent = (await pathExists(errorLogPath)) ? await readFile(errorLogPath, "utf8") : "";
  const recentErrorLines = errorContent.trimEnd().split(/\r?\n/).slice(-50).join("\n");

  if (recentErrorLines.includes(`${EXTENSION_NAME} failed to load`)) {
    throw new Error(`Gateway restarted but ${EXTENSION_NAME} failed to load. Check ${errorLogPath}`);
  }

  if (recentLines.includes(EXTENSION_NAME)) {
    stdout.write(`✅ ${EXTENSION_NAME} plugin loaded successfully\n`);
    return;
  }

  throw new Error(`Gateway restarted but ${EXTENSION_NAME} did not appear in recent log lines. Check ${gatewayLogPath}`);
}

export async function deploy(options: DeployOptions): Promise<number> {
  const paths = await resolvePaths(options);
  await ensureDirectory(paths.openclawHome);

  if (!options.skipBuild) {
    await buildMonorepo(paths.octoclawRoot);
  }

  await moveDirectoryToBackup(path.join(paths.openclawHome, "extensions", EXTENSION_NAME));
  await deployPackages(paths.octoclawRoot, paths.openclawHome);
  await deployExtensions(paths.octoclawRoot, paths.openclawHome);
  await setupDeploySymlinks(paths.openclawHome);
  await validateDeployedPackageGraph(paths.openclawHome);
  await validateDeployedExtensionLoad(paths.openclawHome);
  await cleanupOldBackups(paths.openclawHome, 3);
  await syncJudgeFastEnv(paths.openclawHome);

  if (options.restart) {
    await restartGateway(paths.openclawHome);
  }

  return 0;
}

function upsertRuleBlock(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const withoutRules = normalized
    .replace(/\n?<!-- octo(?:claw|pus):core-rules[^>]*>[\s\S]*?<!-- \/octo(?:claw|pus):core-rules -->\n?/g, "\n")
    .trimEnd();
  const base = withoutRules.length > 0 ? `${withoutRules}\n\n` : "# Workspace instructions\n\n";
  return `${base}${AGENTS_RULES_BODY}\n`;
}

export async function injectAgentsMd(openclawHome: string): Promise<void> {
  const agentsFile = path.join(openclawHome, AGENTS_FILE_NAME);
  const existing = (await pathExists(agentsFile)) ? await readFile(agentsFile, "utf8") : "";
  const nextContent = upsertRuleBlock(existing);
  await ensureParentDirectory(agentsFile);
  await writeFile(agentsFile, nextContent, "utf8");
}

async function ensureModelConfig(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, MODEL_CONFIG_FILE_NAME);
  if (!(await pathExists(filePath))) {
    await selectModel(workspaceRoot, true);
  }
}

async function reconcileExtension(octoclawRoot: string, openclawHome: string): Promise<void> {
  const extensionRoot = path.join(openclawHome, "extensions", EXTENSION_NAME);
  const requiredPaths = [
    extensionRoot,
    path.join(extensionRoot, "openclaw.plugin.json"),
    path.join(extensionRoot, "package.json"),
  ];

  const missing = await Promise.all(requiredPaths.map(async (entry) => !(await pathExists(entry))));
  if (missing.some(Boolean)) {
    await deployExtensions(octoclawRoot, openclawHome);
  }
}

async function reconcilePackages(octoclawRoot: string, openclawHome: string): Promise<void> {
  let needsDeploy = false;

  for (const packageName of DEPLOY_PACKAGE_NAMES) {
    const source = await resolveDeployPackageSource(octoclawRoot, packageName);
    if (!source) {
      throw new Error(`Reconcile failed, deploy package source missing: ${packageName}`);
    }
    const targetDir = path.join(openclawHome, "packages", packageName);
    const targetPackageJson = path.join(targetDir, "package.json");
    const targetDist = path.join(targetDir, "dist");
    if (!(await isDirectory(targetDir)) || !(await isDirectory(targetDist)) || !(await pathExists(targetPackageJson))) {
      needsDeploy = true;
      break;
    }
  }

  if (needsDeploy) {
    await deployPackages(octoclawRoot, openclawHome);
  }
}

async function verifyRequiredFiles(paths: ResolvedPaths): Promise<void> {
  const checks = [
    path.join(paths.workspaceRoot, CONFIG_FILE_NAME),
    path.join(paths.workspaceRoot, MODEL_CONFIG_FILE_NAME),
    path.join(paths.openclawHome, AGENTS_FILE_NAME),
    path.join(paths.openclawHome, "extensions", EXTENSION_NAME, "openclaw.plugin.json"),
    path.join(paths.openclawHome, "extensions", EXTENSION_NAME, "package.json"),
  ];

  for (const checkPath of checks) {
    if (!(await pathExists(checkPath))) {
      throw new Error(`Verification failed, required file missing: ${checkPath}`);
    }
  }

  await validateDeployedPackageGraph(paths.openclawHome);
  await validateDeployedExtensionLoad(paths.openclawHome);
}

export async function install(options: InstallOptions): Promise<number> {
  const paths = await resolvePaths(options);
  await ensureDirectory(paths.workspaceRoot);
  await ensureDirectory(paths.openclawHome);

  await generateConfig(paths.workspaceRoot);
  await selectModel(paths.workspaceRoot, options.auto ?? false);

  if (!options.skipBuild) {
    await buildMonorepo(paths.octoclawRoot);
  }

  await deployExtensions(paths.octoclawRoot, paths.openclawHome);
  await deployPackages(paths.octoclawRoot, paths.openclawHome);
  await injectAgentsMd(paths.openclawHome);
  await verifyRequiredFiles(paths);

  stdout.write(`${formatInstallSummary(createInstallConfig(paths), true)}\n`);
  return 0;
}

export async function reconcile(options: ReconcileOptions): Promise<number> {
  const paths = await resolvePaths(options);
  await ensureDirectory(paths.workspaceRoot);
  await ensureDirectory(paths.openclawHome);

  await generateConfig(paths.workspaceRoot);
  await ensureModelConfig(paths.workspaceRoot);

  if (!options.skipBuild) {
    await buildMonorepo(paths.octoclawRoot);
  }

  await reconcileExtension(paths.octoclawRoot, paths.openclawHome);
  await reconcilePackages(paths.octoclawRoot, paths.openclawHome);
  await injectAgentsMd(paths.openclawHome);
  await verifyRequiredFiles(paths);

  stdout.write(`${formatInstallSummary(createInstallConfig(paths), true)}\n`);
  return 0;
}

interface RunCommandOptions {
  cwd?: string;
  stdio?: "inherit" | "pipe";
}

interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio === "inherit" ? "inherit" : "pipe",
      env,
    });

    let commandStdout = "";
    let commandStderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk: { toString(): string } | string) => {
        commandStdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: { toString(): string } | string) => {
        commandStderr += chunk.toString();
      });
    }

    child.on("error", (error: Error) => reject(error));
    child.on("close", (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        stdout: commandStdout,
        stderr: commandStderr,
      });
    });
  });
}

interface ParsedCli {
  command: CliCommand;
  options: {
    auto?: boolean;
    workspace?: string;
    openclawHome?: string;
    octoclawRoot?: string;
    skipBuild?: boolean;
    restart?: boolean;
  };
}

function printUsage(): void {
  stdout.write(`Usage:\n  octoclaw-install <command> [options]\n\nCommands:\n  install [--auto] [--workspace PATH] [--openclaw-home PATH] [--octoclaw-root PATH]\n  reconcile [--workspace PATH] [--openclaw-home PATH] [--octoclaw-root PATH]\n  deploy [--workspace PATH] [--openclaw-home PATH] [--octoclaw-root PATH] [--skip-build] [--restart]\n  config [--workspace PATH]\n  model [--auto] [--workspace PATH]\n\nOptions:\n  --auto                 Use V1_MODEL_PROFILE_MAP without prompts\n  --workspace PATH       Override workspace root (default: ~/.octoclaw)\n  --openclaw-home PATH   Override OpenClaw home (default: ~/.openclaw or OPENCLAW_HOME)\n  --octoclaw-root PATH   Override OctoClaw repo root\n  --skip-build           Skip pnpm -r run build\n  --restart              Restart OpenClaw gateway after deploy\n  -h, --help             Show this help\n`);
}

function parseCliArguments(inputArgv: string[]): ParsedCli {
  const [, , maybeCommand, ...rest] = inputArgv;
  if (!maybeCommand || maybeCommand === "-h" || maybeCommand === "--help" || maybeCommand === "help") {
    printUsage();
    return { command: "install", options: { auto: true, skipBuild: true } };
  }

  if (!["install", "reconcile", "config", "model", "deploy"].includes(maybeCommand)) {
    throw new Error(`Unknown command: ${maybeCommand}`);
  }

  const options: ParsedCli["options"] = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    switch (token) {
      case "--auto":
        options.auto = true;
        break;
      case "--workspace":
        index += 1;
        options.workspace = rest[index];
        break;
      case "--openclaw-home":
        index += 1;
        options.openclawHome = rest[index];
        break;
      case "--octoclaw-root":
        index += 1;
        options.octoclawRoot = rest[index];
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--restart":
        options.restart = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        return { command: maybeCommand as CliCommand, options: { ...options, auto: true, skipBuild: true } };
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  return { command: maybeCommand as CliCommand, options };
}

export async function main(inputArgv: string[] = argv): Promise<number> {
  try {
    const parsed = parseCliArguments(inputArgv);
    const showedHelp = inputArgv.length < 3 || inputArgv.includes("--help") || inputArgv.includes("-h") || inputArgv.includes("help");
    if (showedHelp) {
      return 0;
    }

    switch (parsed.command) {
      case "install":
        return install(parsed.options);
      case "reconcile":
        return reconcile(parsed.options);
      case "config": {
        const paths = await resolvePaths(parsed.options);
        await generateConfig(paths.workspaceRoot);
        stdout.write(`Wrote ${path.join(paths.workspaceRoot, CONFIG_FILE_NAME)}\n`);
        return 0;
      }
      case "model": {
        const paths = await resolvePaths(parsed.options);
        await selectModel(paths.workspaceRoot, parsed.options.auto ?? (!stdin.isTTY || !stdout.isTTY));
        stdout.write(`Wrote ${path.join(paths.workspaceRoot, MODEL_CONFIG_FILE_NAME)}\n`);
        return 0;
      }
      case "deploy":
        return deploy(parsed.options);
      default:
        return 1;
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (resolveAbsolute(fileURLToPath(import.meta.url)) === resolveAbsolute(inputScriptPath())) {
  void main().then((code) => {
    exit(code);
  });
}

function inputScriptPath(): string {
  const entry = argv[1] ?? path.join(cwd(), "index.js");
  return path.isAbsolute(entry) ? entry : path.resolve(cwd(), entry);
}
