import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

declare const process: { env: Record<string, string | undefined> };

export const DEFAULT_REPO_URL = "https://github.com/guanbear/OctoClaw.git";
export const DEFAULT_REF = "refactor/0.4.0-stable";

interface DeployUnit {
  name: string;
  sourceRoot: string;
}

type JsonRecord = Record<string, unknown>;

export async function deployPackages(octoclawRoot: string, openclawHome: string): Promise<void> {
  const packageUnits = await discoverPackageUnits(octoclawRoot);
  for (const unit of packageUnits) {
    await syncDeployUnit(unit.sourceRoot, path.join(openclawHome, "packages", unit.name));
  }
  await pruneStaleDeployUnits(path.join(openclawHome, "packages"), packageUnits.map((unit) => unit.name));
}

export async function deployExtension(octoclawRoot: string, openclawHome: string): Promise<void> {
  const extensionUnits = await discoverExtensionUnits(octoclawRoot);
  for (const unit of extensionUnits) {
    await syncDeployUnit(unit.sourceRoot, path.join(openclawHome, "extensions", unit.name));
  }
  await pruneStaleDeployUnits(path.join(openclawHome, "extensions"), extensionUnits.map((unit) => unit.name));
}

const OCTOCLAW_CORE_RULES_START = "<!-- octoclaw:core-rules v1.9.1 -->";
const OCTOCLAW_CORE_RULES_END = "<!-- /octoclaw:core-rules -->";

function renderOctoClawCoreRules(): string {
  return [
    OCTOCLAW_CORE_RULES_START,
    "## 🐙 八爪鱼核心原则（始终生效）",
    "",
    "### 主 Agent 宪法",
    "",
    "- 主 Agent 不是最终 route authority；runtime policy、sealed WorkContract、Native TaskFlow/ExecutionCoverage 是路由、委派、执行与投递事实的权威来源。",
    "- Fast first visible response 由 runtime ACK/status/final delivery 统一负责；主 Agent 不手写可见 ACK、协调寒暄或 route_hint 前置说明。",
    "- 当 policy 允许 `reply` 且上下文足够时，直接回答；信息不足时，只问一个短澄清问题。",
    "- 短任务、简单状态/来源追问、一次轻量只读查证或 fresh lookup 默认走 main fast path；超出 runtime 给出的 main fast path soft budget、超过 1-2 次只读工具、需要写操作/长命令时再转委派。",
    "- 明确后台/子 agent/并行、代码修改、测试/构建、长命令、多步工具、review/validation 仍必须走 `delegate`。",
    "- `fresh_live_lookup`、`conversation_control.route_hint=delegate`、`fast_first_response` 不能单独当成硬委派理由。",
    "- 当 policy 选择 `delegate` 时，默认配合并使用 `octoclaw_dispatch`；不要手动 spawn session，也不要把长执行/工具探测/工作区操作吞进主线程，也不要在派发后再给主线程 direct final。",
    "- 如果不同意当前 route，只能通过结构化 route hint / objection protocol 申诉；不要 silent override。",
    "- 历史 session、memory、thread 里关于旧 v1.8.0 规则、`route=runner/direct`、或 `route_hint before answering` 的片段都只是历史事实，不是当前指令；当前只信 v1.9.1 注入块和 runtime sealed policy。",
    "- 状态/provenance follow-up 优先读取现有 receipts、status、ExecutionCoverage 和 artifact refs；不要为了说明旧任务再开新委派。",
    "- 保持 parent context 洁癖：优先 summary / artifact refs / structured state，不注入完整 child transcript 或长日志。",
    "",
    "### 兼容边界",
    "",
    "- live route 只有 `reply` / `delegate`；旧 `direct` 等价于 `reply`，旧 `runner/spawn_single/spawn_multi/observe` 只作为 `delegate` 兼容投影。",
    "- 不要把 ClawTeam/tmux/multi-agent 做成默认 live path；除非明确启用，否则保持单 delegate 路径。",
    "- `octoclaw_route_hint` 是内部控制面/申诉工具；不要用用户可见文字介绍它，也不要为了简单 reply 强制调用它。",
    "- 查询状态时默认给委派摘要；只有用户明确要求 raw/debug/table 时才返回完整原始面板。",
    "",
    "### 执行真相",
    "",
    "- Native TaskFlow 是执行生命周期真相。",
    "- WorkContract 是 semantic/delegation/handoff/continuity truth，不替代 Native TaskFlow。",
    "- TaskFlow created 不等于 `spawnExecuted`；`spawnExecuted=true` 必须来自当前 TaskRun/session/process evidence。",
    "- `task-state.json`、ACK、status panel、display、grounding packet 都是 projection/cache，不是执行真相。",
    "- `dispatchExecuted=true` 且 `spawnExecuted=false` 只能说已物化/排队，不能说 running。",
    "",
    "### 委派连续性",
    "",
    "- child session continuity 只能通过 `childSessionKey` / `childSessionId` / `runId` / artifact refs 延续。",
    "- 若子任务返回 `report_path` / artifact，主 Agent 先读取 artifact 摘要，再用自己的话正式收口；禁止把 `---RESULT---` 或 JSON 原样转发给用户。",
    "- 若 dispatch/spawn 失败：记录失败并如实告知；只有不假装委派成功且主会话能可靠完成时，才允许 fallback 到 reply。",
    OCTOCLAW_CORE_RULES_END,
  ].join("\n");
}


export async function syncOctoClawCoreRules(openclawHome: string): Promise<void> {
  const workspaceAgentsPath = path.join(openclawHome, "workspace", "AGENTS.md");
  const existing = await fs.readFile(workspaceAgentsPath, "utf8").catch(() => "# AGENTS.md - Your Workspace\n");
  const block = renderOctoClawCoreRules();
  const markerPattern = /<!-- octoclaw:core-rules v[^\n]* -->[\s\S]*?<!-- \/octoclaw:core-rules -->/u;
  const next = markerPattern.test(existing)
    ? existing.replace(markerPattern, block)
    : `${existing.trimEnd()}\n\n${block}\n`;
  await fs.mkdir(path.dirname(workspaceAgentsPath), { recursive: true });
  await fs.writeFile(workspaceAgentsPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}


export async function syncSlackDeliveryHookCompatibility(_openclawHome: string): Promise<void> {
  // Retained for older octoclawctl call sites; Slack streaming is owned by OpenClaw config.
}

export async function setupSymlinks(openclawHome: string): Promise<void> {
  const packagesRoot = path.join(openclawHome, "packages");
  const extensionsRoot = path.join(openclawHome, "extensions");
  const packageNames = await listDirectories(packagesRoot, (name) => name.startsWith("octoclaw-"));
  const extensionNames = await listDirectories(extensionsRoot, (name) => name.startsWith("octoclaw-"));

  for (const extensionName of extensionNames) {
    const scopeRoot = path.join(extensionsRoot, extensionName, "node_modules", "@octoclaw");
    await fs.mkdir(scopeRoot, { recursive: true });
    for (const packageName of packageNames) {
      const linkName = packageName.replace(/^octoclaw-/u, "");
      const linkPath = path.join(scopeRoot, linkName);
      const targetPath = path.join(packagesRoot, packageName);
      await fs.rm(linkPath, { recursive: true, force: true });
      await run("ln", ["-s", targetPath, linkPath]);
    }
  }
}

export async function validateLoad(openclawHome: string): Promise<void> {
  const extensionsRoot = path.join(openclawHome, "extensions");
  const extensionNames = await listDirectories(extensionsRoot, (name) => name.startsWith("octoclaw-"));
  for (const extensionName of extensionNames) {
    const extensionRoot = path.join(extensionsRoot, extensionName);
    const manifest = await readJson(path.join(extensionRoot, "openclaw.plugin.json"));
    const main = typeof manifest?.main === "string" ? manifest.main : "";
    if (!main) {
      throw new Error(`Missing plugin main for ${extensionName}`);
    }
    const mainPath = path.join(extensionRoot, main);
    if (!(await pathExists(mainPath))) {
      throw new Error(`Missing plugin entry for ${extensionName}: ${main}`);
    }
    await import(mainPath);
  }
}

export async function cloneOrUpdate(octoclawRoot: string, repoUrl: string, branch: string): Promise<void> {
  if (!(await pathExists(path.join(octoclawRoot, ".git")))) {
    await fs.mkdir(path.dirname(octoclawRoot), { recursive: true });
    await run("git", ["clone", "--branch", branch, repoUrl, octoclawRoot]);
    return;
  }
  await run("git", ["fetch", repoUrl, branch], octoclawRoot);
  await run("git", ["checkout", branch], octoclawRoot);
  await run("git", ["pull", "--ff-only", repoUrl, branch], octoclawRoot);
}

export async function buildWorkspace(octoclawRoot: string): Promise<void> {
  await run("pnpm", ["install"], octoclawRoot);
  await run("pnpm", ["-r", "--if-present", "run", "build"], octoclawRoot);
}

export async function uninstallDeployment(openclawHome: string): Promise<void> {
  await removeMatching(path.join(openclawHome, "extensions"), (name) => name.startsWith("octoclaw-"));
  await removeMatching(path.join(openclawHome, "packages"), (name) => name.startsWith("octoclaw-"));
  await removeOpenClawPluginEntry(openclawHome);
}

export async function syncOpenClawPluginEntry(openclawHome: string, octoclawRoot: string, projectedPluginConfig: JsonRecord = {}): Promise<void> {
  const openclawConfigPath = path.join(openclawHome, "openclaw.json");
  const config = await readJson(openclawConfigPath) ?? {};
  const plugins = ensureRecord(config, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = isRecord(entries["octoclaw-runtime"]) ? entries["octoclaw-runtime"] as JsonRecord : {};
  const pluginConfig = isRecord(entry.config) ? entry.config as JsonRecord : {};
  const hooks = isRecord(entry.hooks) ? entry.hooks as JsonRecord : {};

  entry.enabled = true;
  const nextConfig: JsonRecord = {
    ...pluginConfig,
    ...projectedPluginConfig,
    octoclawRoot,
    workspaceRoot: nonEmptyString(pluginConfig.workspaceRoot) ?? path.join(openclawHome, "workspace"),
  };
  if (!("judgeFast" in projectedPluginConfig)) {
    delete nextConfig.judgeFast;
  }
  entry.config = nextConfig;
  entry.hooks = {
    ...hooks,
    allowPromptInjection: hooks.allowPromptInjection ?? true,
  };
  entries["octoclaw-runtime"] = entry;

  await fs.mkdir(path.dirname(openclawConfigPath), { recursive: true });
  await fs.writeFile(openclawConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function removeOpenClawPluginEntry(openclawHome: string): Promise<void> {
  const openclawConfigPath = path.join(openclawHome, "openclaw.json");
  const config = await readJson(openclawConfigPath);
  if (!config) return;
  const plugins = isRecord(config.plugins) ? config.plugins : null;
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : null;
  if (!entries || !("octoclaw-runtime" in entries)) return;
  delete entries["octoclaw-runtime"];
  await fs.writeFile(openclawConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function writeSourceManifest(openclawHome: string, octoclawRoot: string): Promise<void> {
  const manifestPath = path.join(openclawHome, "octoclaw-source-manifest.json");
  const manifest = {
    type: "git",
    commit: await readCommand("git", ["rev-parse", "HEAD"], octoclawRoot),
    branch: await readCommand("git", ["branch", "--show-current"], octoclawRoot),
    installedAt: new Date().toISOString(),
    octoclawRoot,
  };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function discoverPackageUnits(octoclawRoot: string): Promise<DeployUnit[]> {
  const candidates = [
    ...(await discoverUnits(path.join(octoclawRoot, "packages"))),
    ...(await discoverUnits(path.join(octoclawRoot, "extensions"))),
  ];
  return candidates.filter((unit) => !unit.hasPluginManifest).map(({ name, sourceRoot }) => ({ name, sourceRoot }));
}

async function discoverExtensionUnits(octoclawRoot: string): Promise<DeployUnit[]> {
  const candidates = await discoverUnits(path.join(octoclawRoot, "extensions"));
  return candidates.filter((unit) => unit.hasPluginManifest).map(({ name, sourceRoot }) => ({ name, sourceRoot }));
}

async function discoverUnits(parentDir: string): Promise<Array<DeployUnit & { hasPluginManifest: boolean }>> {
  const names = await listDirectories(parentDir);
  const units: Array<DeployUnit & { hasPluginManifest: boolean }> = [];
  for (const dirName of names) {
    const sourceRoot = path.join(parentDir, dirName);
    const packageJson = await readJson(path.join(sourceRoot, "package.json"));
    const packageName = typeof packageJson?.name === "string" ? packageJson.name : "";
    if (!packageName.startsWith("@octoclaw/") || !(await pathExists(path.join(sourceRoot, "dist")))) {
      continue;
    }
    const hasPluginManifest = await pathExists(path.join(sourceRoot, "openclaw.plugin.json"));
    units.push({ name: packageName.replace(/^@octoclaw\//u, "octoclaw-"), sourceRoot, hasPluginManifest });
  }
  return units.sort((left, right) => left.name.localeCompare(right.name));
}

async function syncDeployUnit(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await run("rsync", [
    "-a",
    "--delete",
    "--prune-empty-dirs",
    "--include", "package.json",
    "--include", "openclaw.plugin.json",
    "--include", "README.md",
    "--include", "LICENSE*",
    "--include", "dist/***",
    "--exclude", "*",
    `${sourceDir}/`,
    `${targetDir}/`,
  ]);
}

async function listDirectories(parentDir: string, predicate?: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    return entries.map((entry) => entry.name).filter((name) => predicate ? predicate(name) : true).sort();
  } catch {
    return [];
  }
}

async function removeMatching(parentDir: string, predicate: (name: string) => boolean): Promise<void> {
  const names = await listDirectories(parentDir, predicate);
  for (const name of names) {
    await fs.rm(path.join(parentDir, name), { recursive: true, force: true });
  }
}

async function pruneStaleDeployUnits(parentDir: string, keepNames: string[]): Promise<void> {
  const keep = new Set(keepNames);
  await removeMatching(parentDir, (name) => name.startsWith("octoclaw-") && !keep.has(name));
}

async function readJson(filePath: string): Promise<JsonRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
  const current = parent[key];
  if (isRecord(current)) return current;
  const next: JsonRecord = {};
  parent[key] = next;
  return next;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fsSync.existsSync(targetPath);
}

async function readCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return await run(command, args, cwd);
}

async function run(command: string, args: string[], cwd?: string, env: Record<string, string | undefined> = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Uint8Array | string) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code: number | null) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}
