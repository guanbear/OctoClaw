import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readConfig } from "./config.js";

export type ReadinessStatus = "pass" | "warn" | "fail";

export interface OctoclawReadinessCheck {
  id:
    | "openclaw"
    | "runtime_plugin"
    | "judge"
    | "im.slack"
    | "im.feishu"
    | "router_wizard"
    | "status_panel";
  status: ReadinessStatus;
  summary: string;
  remediation?: string;
}

export interface OctoclawReadinessReport {
  schemaVersion: "octoclaw.readiness/v1";
  generatedAt: string;
  checks: OctoclawReadinessCheck[];
}

export async function generateReadinessReport(openclawHome: string): Promise<OctoclawReadinessReport> {
  const checks: OctoclawReadinessCheck[] = [];

  checks.push(checkOpenClaw());
  checks.push(await checkRuntimePlugin(openclawHome));
  checks.push(await checkJudge(openclawHome));
  checks.push(await checkImChannel(openclawHome, "slack"));
  checks.push(await checkImChannel(openclawHome, "feishu"));
  checks.push(await checkRouterWizard(openclawHome));
  checks.push(await checkStatusPanel(openclawHome));

  return {
    schemaVersion: "octoclaw.readiness/v1",
    generatedAt: new Date().toISOString(),
    checks,
  };
}

function checkOpenClaw(): OctoclawReadinessCheck {
  try {
    const result = spawnSync("openclaw", ["--version"], { timeout: 3000, encoding: "utf8" });
    if (!result.error && result.status === 0) {
      const version = String(result.stdout || "").trim();
      return { id: "openclaw", status: "pass", summary: version || "installed" };
    }
    return {
      id: "openclaw",
      status: "fail",
      summary: "not installed or not on PATH",
      remediation: "Install OpenClaw: https://github.com/openclaw/openclaw#installation",
    };
  } catch (error) {
    return {
      id: "openclaw",
      status: "fail",
      summary: errorMessage(error),
      remediation: "Install OpenClaw: https://github.com/openclaw/openclaw#installation",
    };
  }
}

async function checkRuntimePlugin(openclawHome: string): Promise<OctoclawReadinessCheck> {
  const manifestPath = path.join(openclawHome, "extensions", "octoclaw-runtime", "openclaw.plugin.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (isRecord(parsed) && typeof parsed.main === "string" && parsed.main.trim()) {
      const mainPath = path.join(path.dirname(manifestPath), parsed.main);
      if (fsSync.existsSync(mainPath)) {
        return { id: "runtime_plugin", status: "pass", summary: "octoclaw-runtime plugin deployed" };
      }
    }
    return {
      id: "runtime_plugin",
      status: "fail",
      summary: "runtime plugin main file missing or invalid",
      remediation: "Run: octoclawctl deploy",
    };
  } catch {
    return {
      id: "runtime_plugin",
      status: "fail",
      summary: "octoclaw-runtime plugin not found",
      remediation: "Run: octoclawctl install && octoclawctl deploy",
    };
  }
}

async function checkJudge(openclawHome: string): Promise<OctoclawReadinessCheck> {
  try {
    const config = await readConfig(openclawHome);
    if (!config.judge.enabled || !config.judge.modelId.trim() || !config.judge.baseUrl.trim()) {
      return {
        id: "judge",
        status: "warn",
        summary: "Judge not configured",
        remediation: "Run: octoclawctl init — recommended remote preset: gpt-5.4-mini",
      };
    }

    const reachable = await pingEndpoint(config.judge.baseUrl, config.judge.apiKey);
    if (reachable) {
      return { id: "judge", status: "pass", summary: `${config.judge.modelId} — reachable` };
    }
    if (isLoopbackEndpoint(config.judge.baseUrl)) {
      return { id: "judge", status: "pass", summary: `${config.judge.modelId} — configured locally` };
    }
    return {
      id: "judge",
      status: "warn",
      summary: `${config.judge.modelId} — unreachable`,
      remediation: "Check judge.baseUrl / network / API key",
    };
  } catch (error) {
    return {
      id: "judge",
      status: "warn",
      summary: errorMessage(error),
      remediation: "Check judge configuration",
    };
  }
}

async function checkImChannel(openclawHome: string, channel: "slack" | "feishu"): Promise<OctoclawReadinessCheck> {
  const id = `im.${channel}` as OctoclawReadinessCheck["id"];
  try {
    const config = await readConfig(openclawHome);
    const channels = config.pluginConfig.channels;
    if (!isRecord(channels) || !isRecord(channels[channel])) {
      return {
        id,
        status: "warn",
        summary: `${channel} not configured`,
        remediation: `Run: octoclawctl config set pluginConfig.channels.${channel}.botToken <token>`,
      };
    }
    const channelConfig = channels[channel] as Record<string, unknown>;
    const hasToken = Object.entries(channelConfig).some(
      ([key, value]) => key.toLowerCase().includes("token") && typeof value === "string" && value.trim().length > 0,
    );
    if (hasToken) {
      return { id, status: "pass", summary: `${channel} token configured` };
    }
    return {
      id,
      status: "warn",
      summary: `${channel} token not found`,
      remediation: `Run: octoclawctl config set pluginConfig.channels.${channel}.botToken <token>`,
    };
  } catch (error) {
    return {
      id,
      status: "warn",
      summary: errorMessage(error),
      remediation: `Check ${channel} configuration`,
    };
  }
}

async function checkRouterWizard(openclawHome: string): Promise<OctoclawReadinessCheck> {
  const wizardPath = path.join(
    path.dirname(openclawHome) === openclawHome ? openclawHome : path.dirname(openclawHome),
    ".openclaw",
    "octoclaw",
    "router-wizard.json",
  );
  const altWizardPath = path.join(openclawHome, "octoclaw", "router-wizard.json");

  for (const checkPath of [wizardPath, altWizardPath]) {
    try {
      const raw = await fs.readFile(checkPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (isRecord(parsed) && Object.keys(parsed).length > 0) {
        return { id: "router_wizard", status: "pass", summary: "router wizard configured" };
      }
    } catch { /* try next path */ }
  }

  return {
    id: "router_wizard",
    status: "warn",
    summary: "router wizard not completed",
    remediation: "Run: octoclawctl router wizard",
  };
}

async function checkStatusPanel(openclawHome: string): Promise<OctoclawReadinessCheck> {
  const statusSurfacePath = path.join(openclawHome, "packages", "octoclaw-status-surface");
  if (fsSync.existsSync(statusSurfacePath)) {
    return { id: "status_panel", status: "pass", summary: "status-surface extension present" };
  }
  return {
    id: "status_panel",
    status: "warn",
    summary: "status-surface package not found",
    remediation: "Run: octoclawctl deploy",
  };
}

async function pingEndpoint(baseUrl: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    const response = await fetch(baseUrl, { method: "HEAD", signal: controller.signal, headers });
    if (response.status === 405) {
      const getResponse = await fetch(baseUrl, { method: "GET", signal: controller.signal, headers });
      return getResponse.status < 500;
    }
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function formatReadinessSummary(report: OctoclawReadinessReport, lang: "zh" | "en" = "en"): string {
  const lines: string[] = [];
  lines.push(lang === "zh" ? "OctoClaw 就绪状态" : "OctoClaw Readiness");
  lines.push("─".repeat(40));

  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️" : "❌";
    const detail = check.summary ? `  ${check.summary}` : "";
    lines.push(`${icon} ${check.id}${detail}`);
    if (check.remediation) lines.push(`   → ${check.remediation}`);
  }

  lines.push("─".repeat(40));
  const pass = report.checks.filter((c) => c.status === "pass").length;
  const warn = report.checks.filter((c) => c.status === "warn").length;
  const fail = report.checks.filter((c) => c.status === "fail").length;
  lines.push(lang === "zh" ? `${pass} 通过，${warn} 警告，${fail} 失败` : `${pass} pass, ${warn} warn, ${fail} fail`);

  return lines.join("\n");
}

export function redactReadinessReport(report: OctoclawReadinessReport): OctoclawReadinessReport {
  const secretPattern = /(?:sk-|xoxb-|xoxp-|Bearer\s+)[\w.-]+/gu;
  const urlSecretPattern = /(api[_-]?key=|token=|key=)([^&\s]+)/giu;

  return {
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      summary: check.summary.replace(secretPattern, "[REDACTED]").replace(urlSecretPattern, "$1[REDACTED]"),
      remediation: check.remediation?.replace(secretPattern, "[REDACTED]").replace(urlSecretPattern, "$1[REDACTED]"),
    })),
  };
}
