import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readConfig, configPath, type OctoclawConfig } from "../config.js";

declare const process: { version: string };

export interface DoctorCheckResult {
  name: string;
  nameZh: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
  hint?: string;
}

export interface DoctorOpts {
  json: boolean;
  lang: "zh" | "en";
  openclawHome: string;
}

export async function runDoctor(opts: DoctorOpts): Promise<{ output: string; exitCode: number }> {
  const results: DoctorCheckResult[] = [];

  results.push(checkNodeVersion(opts.lang));
  results.push(checkOpenClaw(opts.lang));
  results.push(await checkJudgeModel(opts));
  results.push(await checkImTokens(opts));
  results.push(await checkConfigWritable(opts));

  if (opts.json) {
    return { output: JSON.stringify({ checks: results }, null, 2), exitCode: computeExitCode(results) };
  }

  const lines: string[] = ["OctoClaw Doctor", "─".repeat(40)];

  for (const result of results) {
    const icon = result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
    const name = opts.lang === "zh" ? result.nameZh : result.name;
    const detail = result.detail ? `  ${result.detail}` : "";
    lines.push(`${icon} ${name}${detail}`);
    if (result.hint) lines.push(`   → ${result.hint}`);
  }

  lines.push("─".repeat(40));
  const pass = results.filter((result) => result.status === "pass").length;
  const warn = results.filter((result) => result.status === "warn").length;
  const fail = results.filter((result) => result.status === "fail").length;
  lines.push(opts.lang === "zh" ? `${pass} 通过，${warn} 警告，${fail} 失败` : `${pass} pass, ${warn} warn, ${fail} fail`);

  return { output: lines.join("\n"), exitCode: computeExitCode(results) };
}

function computeExitCode(results: DoctorCheckResult[]): number {
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

function checkNodeVersion(lang: DoctorOpts["lang"]): DoctorCheckResult {
  try {
    const major = Number.parseInt(process.version.replace(/^v/u, "").split(".")[0] ?? "", 10);
    if (Number.isFinite(major) && major >= 22) {
      return check("Node.js", "Node.js", "pass", `${process.version} — OK`);
    }
    return check("Node.js", "Node.js", "fail", process.version, lang === "zh" ? "需要 Node.js >= 22" : "Requires Node.js >= 22");
  } catch (error) {
    return check("Node.js", "Node.js", "fail", errorMessage(error), lang === "zh" ? "需要 Node.js >= 22" : "Requires Node.js >= 22");
  }
}

function checkOpenClaw(lang: DoctorOpts["lang"]): DoctorCheckResult {
  try {
    const result = spawnSync("openclaw", ["--version"], { timeout: 3000, encoding: "utf8" });
    if (!result.error && result.status === 0) {
      const version = String(result.stdout || "").trim() || (lang === "zh" ? "已安装" : "installed");
      return check("OpenClaw", "OpenClaw", "pass", version);
    }
    const detail = result.error ? result.error.message : String(result.stderr || (lang === "zh" ? "未检测到" : "not found")).trim();
    return check("OpenClaw", "OpenClaw", "fail", detail, "https://github.com/openclaw/openclaw#installation");
  } catch (error) {
    return check("OpenClaw", "OpenClaw", "fail", errorMessage(error), "https://github.com/openclaw/openclaw#installation");
  }
}

async function checkJudgeModel(opts: DoctorOpts): Promise<DoctorCheckResult> {
  try {
    const config = await readConfig(opts.openclawHome);
    if (!config.judge.enabled || !config.judge.modelId.trim() || !config.judge.baseUrl.trim()) {
      return check("Judge model", "Judge 模型", "warn", opts.lang === "zh" ? "未配置" : "not configured");
    }

    const reachable = await pingEndpoint(config.judge.baseUrl, config.judge.apiKey);
    if (reachable) {
      return check("Judge model", "Judge 模型", "pass", `${config.judge.modelId} — OK`);
    }
    return check("Judge model", "Judge 模型", "fail", config.judge.baseUrl, opts.lang === "zh" ? "检查 judge.baseUrl / 网络 / API key" : "Check judge.baseUrl / network / API key");
  } catch (error) {
    return check("Judge model", "Judge 模型", "fail", errorMessage(error), opts.lang === "zh" ? "检查 judge 配置" : "Check judge configuration");
  }
}

async function pingEndpoint(baseUrl: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(baseUrl, {
      method: "HEAD",
      signal: controller.signal,
      headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
    });
    if (response.status === 405) {
      const getResponse = await fetch(baseUrl, {
        method: "GET",
        signal: controller.signal,
        headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      });
      return getResponse.status < 500;
    }
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkImTokens(opts: DoctorOpts): Promise<DoctorCheckResult> {
  try {
    const config = await readConfig(opts.openclawHome);
    if (hasImTokens(config)) {
      return check("IM tokens", "IM Token", "pass", opts.lang === "zh" ? "已配置" : "configured");
    }
    return check("IM tokens", "IM Token", "warn", opts.lang === "zh" ? "未配置" : "not configured");
  } catch (error) {
    return check("IM tokens", "IM Token", "warn", errorMessage(error), opts.lang === "zh" ? "检查 IM 配置" : "Check IM configuration");
  }
}

function hasImTokens(config: OctoclawConfig): boolean {
  const channels = config.pluginConfig.channels;
  if (!isRecord(channels)) return false;
  return Object.values(channels).some((channel) => hasTokenValue(channel));
}

function hasTokenValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => key.toLowerCase().includes("token") && typeof nested === "string" && nested.trim().length > 0);
}

async function checkConfigWritable(opts: DoctorOpts): Promise<DoctorCheckResult> {
  const configDir = path.dirname(configPath(opts.openclawHome));
  const testPath = path.join(configDir, `.octoclaw-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.mkdir(configDir, { recursive: true });
    const descriptor = fsSync.openSync(testPath, "w");
    fsSync.closeSync(descriptor);
    await fs.rm(testPath, { force: true });
    return check("Config writable", "配置可写", "pass", opts.lang === "zh" ? "配置目录可写" : "config directory is writable");
  } catch (error) {
    return check("Config writable", "配置可写", "fail", errorMessage(error), opts.lang === "zh" ? `chmod u+w ${configDir}` : `chmod u+w ${configDir}`);
  }
}

function check(name: string, nameZh: string, status: DoctorCheckResult["status"], detail?: string, hint?: string): DoctorCheckResult {
  return { name, nameZh, status, ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
