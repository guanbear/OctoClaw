import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = os.homedir();

function resolveOctoClawRoot() {
  const candidates = [
    String(process.env.OCTOCLAW_ROOT || "").trim(),
    path.join(HOME_DIR, ".openclaw", "workspace", "openclaw", "skills", "octopus"),
    path.join(HOME_DIR, ".openclaw", "workspace", "openclaw", "repos", "octoclaw"),
    path.resolve(MODULE_DIR, "../../.."),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "lib"))) {
      return candidate;
    }
  }
  return path.resolve(MODULE_DIR, "../../..");
}

const REPO_ROOT = resolveOctoClawRoot();
const MODEL_TELEMETRY_REPORT_PY = path.join(REPO_ROOT, "lib", "model_telemetry_report.py");
const UPSTREAM_RELEASE_LOOKUP_MJS = path.join(REPO_ROOT, "lib", "upstream_release_lookup.mjs");

const SYSTEM_METRIC_KEYWORDS = {
  python: ["python", "python版本", "python version"],
  disk: ["磁盘", "disk", "df", "存储", "空间"],
  memory: ["内存", "memory", "ram", "swap"],
  cpu: ["cpu", "负载", "load average", "load"],
  uptime: ["uptime", "运行时间", "在线时长"],
};

const SERVICE_ALIASES = {
  redis: ["redis", "redis-server"],
  openclaw: ["openclaw"],
  nginx: ["nginx"],
  postgres: ["postgresql", "postgres", "postgresql.service"],
  mysql: ["mysql", "mysqld", "mariadb"],
  docker: ["docker", "dockerd"],
};

const SERVICE_PORTS = {
  redis: [6379, 6380],
  openclaw: [18789, 18791, 18792],
  nginx: [80, 443],
  postgres: [5432],
  mysql: [3306],
};

const SERVICE_LOG_PATHS = {
  nginx: {
    error: "/var/log/nginx/error.log",
    access: "/var/log/nginx/access.log",
    default: "/var/log/nginx/error.log",
  },
};

const PATH_PATTERN = /(?:^|[\s"'`])((?:\/[A-Za-z0-9._/\-]+))/g;
const TAIL_COUNT_PATTERNS = [
  /\btail\s+-n?\s*(\d{1,4})\b/i,
  /(?:最近|近)\s*(\d{1,4})\s*行/u,
  /\blast\s+(\d{1,4})\s+lines?\b/i,
];
const REMOTE_HINT_PATTERNS = [
  "远程",
  "remote",
  "另一台",
  "另一台机器",
  "另一台主机",
  "macmini",
  "mac mini",
];
const VERSION_QUERY_TOKENS = ["版本", "version", "--version", "ver"];
const UPSTREAM_UPDATE_TOKENS = [
  "更新",
  "发版",
  "release",
  "releases",
  "changelog",
  "what's new",
  "what is new",
  "latest",
  "recent",
  "特性",
  "变化",
  "memory",
  "dream",
  "diary",
  "rem",
];

const VERSION_COMMANDS = {
  openclaw: "if command -v openclaw >/dev/null 2>&1; then openclaw --version || openclaw version; "
    + "elif [ -x /opt/homebrew/bin/openclaw ]; then /opt/homebrew/bin/openclaw --version || /opt/homebrew/bin/openclaw version; "
    + "elif [ -x /usr/local/bin/openclaw ]; then /usr/local/bin/openclaw --version || /usr/local/bin/openclaw version; "
    + "elif [ -x /usr/bin/openclaw ]; then /usr/bin/openclaw --version || /usr/bin/openclaw version; "
    + "else echo 'openclaw not found'; fi",
  python: "python3 --version || python --version",
  node: "node --version",
  npm: "npm --version",
};

const SCHEDULER_KEYWORDS = [
  "cron",
  "crontab",
  "定时任务",
  "计划任务",
  "schedule",
  "scheduler",
  "timer",
  "timers",
  "list-timers",
];

const ERROR_LOG_TOKENS = [
  "error log",
  "error.log",
  "错误日志",
  "报错日志",
];

const ACCESS_LOG_TOKENS = [
  "access log",
  "access.log",
  "访问日志",
];

const MODEL_BENCHMARK_HINTS = [
  "首token",
  "首 token",
  "ttft",
  "吞吐",
  "tokens/s",
  "token/s",
  "throughput",
  "响应速度",
  "测速",
  "模型速度",
];

const MODEL_REFERENCE_PATTERN = /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|(?:gpt|glm|minimax|claude|qwen|kimi|deepseek|gemini|sonnet|opus)[-A-Za-z0-9_.]*)/gi;

function containsAny(text, patterns) {
  const lowered = String(text || "").toLowerCase();
  return patterns.some((pattern) => lowered.includes(String(pattern).toLowerCase()));
}

function normalizeHints(hints = {}) {
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return {};
  return { ...hints };
}

function hintedLookupScope(hints = {}) {
  return String(normalizeHints(hints).lookup_scope || "").trim();
}

function hintedLookupProject(hints = {}) {
  return String(normalizeHints(hints).lookup_project || "").trim().toLowerCase();
}

function hintedLookupFocus(hints = {}) {
  return String(normalizeHints(hints).lookup_focus || "").trim().toLowerCase();
}

function loadSshAliases() {
  const configPath = path.join(os.homedir(), ".ssh", "config");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const aliases = [];
    for (const lineRaw of raw.split(/\r?\n/u)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!line.toLowerCase().startsWith("host ")) continue;
      for (const token of line.split(/\s+/u).slice(1)) {
        if (token.includes("*") || token.includes("?")) continue;
        aliases.push(token);
      }
    }
    const deduped = [];
    const seen = new Set();
    for (const alias of aliases) {
      const lowered = alias.toLowerCase();
      if (!lowered || seen.has(lowered)) continue;
      seen.add(lowered);
      deduped.push(alias);
    }
    return deduped;
  } catch {
    return [];
  }
}

function extractRemoteTarget(task) {
  const lowered = String(task || "").toLowerCase();
  for (const alias of loadSshAliases()) {
    if (lowered.includes(alias.toLowerCase())) return alias;
  }
  if (lowered.includes("macmini") || lowered.includes("mac mini")) return "macmini";
  if (!containsAny(lowered, REMOTE_HINT_PATTERNS)) return "";
  const reserved = new Set([
    "openclaw", "python", "redis", "nginx", "docker", "memory", "disk", "version",
    "status", "health", "service", "remote", "host", "server", "machine",
  ]);
  const hostLike = lowered.match(/[a-z][a-z0-9._-]{2,}/g) || [];
  for (const token of hostLike) {
    if (reserved.has(token)) continue;
    if (token.startsWith("octopus") || token.startsWith("runner")) continue;
    return token;
  }
  return "";
}

function shellQuote(value) {
  const text = String(value ?? "");
  return `'${text.split("'").join("'\"'\"'")}'`;
}

function wrapRemoteCommand(target, command) {
  const remoteScript = [
    "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH",
    String(command || "").trim(),
  ].join("\n");
  const remoteCmd = `/bin/sh -lc ${shellQuote(remoteScript)}`;
  return `ssh ${shellQuote(target)} ${shellQuote(remoteCmd)}`;
}

function extractLineCount(task, defaultCount = 40) {
  const text = String(task || "");
  for (const pattern of TAIL_COUNT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value)) continue;
    return Math.max(1, Math.min(value, 5000));
  }
  return defaultCount;
}

function buildSystemSummaryPlan(task) {
  const lowered = String(task || "").toLowerCase();
  const requested = [];
  for (const [metric, keywords] of Object.entries(SYSTEM_METRIC_KEYWORDS)) {
    if (containsAny(lowered, keywords)) requested.push(metric);
  }
  if (requested.length === 0) return null;
  const commands = [];
  if (requested.includes("python")) commands.push("python3 --version");
  if (requested.includes("disk")) commands.push("df -h /");
  if (requested.includes("memory")) commands.push("free -h || vm_stat");
  if (requested.includes("cpu")) commands.push("uptime");
  if (requested.includes("uptime") && !requested.includes("cpu")) commands.push("uptime");
  return {
    kind: "system_summary",
    summary: "检查当前机器系统摘要",
    command: commands.join("\n"),
    probe_spec: {
      kind: "system_summary",
      metrics: requested,
    },
    reason_codes: ["runner_playbook_system_summary"],
    confidence: 0.88,
  };
}

function buildModelTelemetryReportPlan(task) {
  const lowered = String(task || "").toLowerCase();
  if (!containsAny(lowered, MODEL_BENCHMARK_HINTS)) return null;
  if (!fs.existsSync(MODEL_TELEMETRY_REPORT_PY)) return null;
  const modelRefs = Array.from(new Set((String(task || "").match(MODEL_REFERENCE_PATTERN) || []).map((item) => item.toLowerCase())));
  if (modelRefs.length === 0) return null;
  const baseCommand = `python3 ${shellQuote(MODEL_TELEMETRY_REPORT_PY)} --task ${shellQuote(task)}`;
  const plan = {
    kind: "model_telemetry_report",
    summary: "比较请求模型的本地速度与健康快照",
    command: baseCommand,
    probe_spec: {
      kind: "model_telemetry_report",
      task,
      models: [...modelRefs].sort(),
      metrics: ["ttft_ms", "output_tps", "health_state", "fallback_failures"],
    },
    reason_codes: ["runner_playbook_model_telemetry_report"],
    confidence: 0.93,
  };
  const remoteTarget = extractRemoteTarget(task);
  if (remoteTarget) {
    plan.kind = "remote_model_telemetry_report";
    plan.summary = `比较 ${remoteTarget} 上请求模型的本地速度与健康快照`;
    plan.command = wrapRemoteCommand(remoteTarget, baseCommand);
    plan.reason_codes = [...plan.reason_codes, `remote_target:${remoteTarget}`];
    plan.confidence = 0.95;
  }
  return plan;
}

function buildUpstreamReleaseLookupPlan(task, hints = {}) {
  const lowered = String(task || "").toLowerCase();
  const scope = hintedLookupScope(hints);
  let project = hintedLookupProject(hints);
  const focus = hintedLookupFocus(hints);
  if (scope !== "upstream_project" && !containsAny(lowered, UPSTREAM_UPDATE_TOKENS)) return null;
  if (!project) {
    if (lowered.includes("openclaw")) project = "openclaw";
    else if (lowered.includes("octoclaw")) project = "octoclaw";
  }
  if (!["openclaw", "octoclaw"].includes(project)) return null;
  if (!fs.existsSync(UPSTREAM_RELEASE_LOOKUP_MJS)) return null;
  const effectiveFocus = focus || "latest_updates";
  return {
    kind: "upstream_release_lookup",
    summary: `检查 ${project} 上游最新发版与最近更新`,
    command: `node ${shellQuote(UPSTREAM_RELEASE_LOOKUP_MJS)} --project ${shellQuote(project)} --focus ${shellQuote(effectiveFocus)}`,
    probe_spec: {
      kind: "upstream_release_lookup",
      project,
      focus: effectiveFocus,
      source: "github_api",
    },
    reason_codes: ["runner_playbook_upstream_release_lookup", `project:${project}`, `focus:${effectiveFocus}`],
    confidence: scope === "upstream_project" ? 0.95 : 0.88,
  };
}

function buildVersionProbePlan(task, hints = {}) {
  const lowered = String(task || "").toLowerCase();
  if (hintedLookupScope(hints) === "upstream_project") return null;
  if (containsAny(lowered, UPSTREAM_UPDATE_TOKENS) && (lowered.includes("openclaw") || lower.includes("octoclaw"))) return null;
  if (containsAny(lowered, ["分析", "总结", "对比", "研究", "analyze", "analysis", "compare", "research"])) return null;
  if (!containsAny(lowered, VERSION_QUERY_TOKENS)) return null;
  let targetTool = "";
  const aliases = {
    openclaw: ["openclaw"],
    python: ["python", "python3"],
    node: ["node"],
    npm: ["npm"],
  };
  for (const [tool, values] of Object.entries(aliases)) {
    if (containsAny(lowered, values)) {
      targetTool = tool;
      break;
    }
  }
  if (!targetTool) return null;
  const baseCommand = VERSION_COMMANDS[targetTool] || "";
  if (!baseCommand) return null;
  const remoteTarget = extractRemoteTarget(task);
  if (remoteTarget) {
    return {
      kind: "remote_version_probe",
      summary: `检查 ${remoteTarget} 的 ${targetTool} 版本`,
      command: wrapRemoteCommand(remoteTarget, baseCommand),
      probe_spec: {
        kind: "version_probe",
        tool: targetTool,
        remote_target: remoteTarget,
      },
      reason_codes: ["runner_playbook_version_probe", `remote_target:${remoteTarget}`, `tool:${targetTool}`],
      confidence: 0.9,
    };
  }
  return {
    kind: "version_probe",
    summary: `检查当前机器的 ${targetTool} 版本`,
    command: baseCommand,
    probe_spec: {
      kind: "version_probe",
      tool: targetTool,
    },
    reason_codes: ["runner_playbook_version_probe", `tool:${targetTool}`],
    confidence: 0.86,
  };
}

function extractServiceName(task) {
  const lowered = String(task || "").toLowerCase();
  for (const [canonical, aliases] of Object.entries(SERVICE_ALIASES)) {
    if (containsAny(lowered, aliases)) return canonical;
  }
  return "";
}

function buildServiceHealthPlan(task) {
  const service = extractServiceName(task);
  if (!service) return null;
  const lowered = String(task || "").toLowerCase();
  const wantsLogs = ["log", "logs", "日志"].some((token) => lowered.includes(token));
  const wantsPorts = ["端口", "port", "监听"].some((token) => lowered.includes(token));
  const wantsProcess = ["进程", "process", "service", "服务状态", "状态"].some((token) => lowered.includes(token));
  const wantsStatus = wantsLogs || wantsPorts || wantsProcess;
  if (!wantsStatus) return null;

  const aliases = SERVICE_ALIASES[service] || [service];
  const ports = SERVICE_PORTS[service] || [];
  const commands = [];

  if (wantsPorts && ports.length > 0) {
    const portExpr = ports.map((port) => `ss -lntp | grep -E ':${port}\\b'`).join(" || ");
    commands.push(`(${portExpr}) || true`);
  } else if (wantsPorts) {
    commands.push(`ss -lntp | grep -i '${service}' || true`);
  }

  if (wantsProcess) {
    const unitArgs = aliases.slice(0, 2).join(" ");
    commands.push(`systemctl status ${unitArgs} --no-pager -n 20 || true`);
    const procExpr = aliases.slice(0, 2).map((alias) => `-e '${alias}'`).join(" ");
    commands.push(`ps -ef | grep -i ${procExpr} | grep -v grep || true`);
  }

  if (wantsLogs) {
    const unitArgs = aliases.slice(0, 2).map((alias) => `-u ${alias}`).join(" ");
    commands.push(`journalctl ${unitArgs} -n 40 --no-pager || true`);
  }

  const plan = {
    kind: "service_health",
    summary: `检查 ${service} 的端口、状态与日志`,
    command: commands.join("\n"),
    probe_spec: {
      kind: "service_health",
      service,
      ports,
      includes_logs: wantsLogs,
      includes_process: wantsProcess,
      includes_ports: wantsPorts,
    },
    reason_codes: ["runner_playbook_service_health", `service:${service}`],
    confidence: 0.9,
  };
  const remoteTarget = extractRemoteTarget(task);
  if (remoteTarget) {
    plan.kind = "remote_service_health";
    plan.summary = `检查 ${remoteTarget} 上 ${service} 的端口、状态与日志`;
    plan.command = wrapRemoteCommand(remoteTarget, plan.command);
    plan.reason_codes = [...plan.reason_codes, `remote_target:${remoteTarget}`];
    plan.confidence = 0.92;
  }
  return plan;
}

function inferServiceLogPath(service, task) {
  const lowered = String(task || "").toLowerCase();
  const mapping = SERVICE_LOG_PATHS[service];
  if (!mapping || typeof mapping !== "object") return { path: "", logKind: "" };
  if (containsAny(lowered, ACCESS_LOG_TOKENS)) return { path: String(mapping.access || mapping.default || ""), logKind: "access" };
  if (containsAny(lowered, ERROR_LOG_TOKENS)) return { path: String(mapping.error || mapping.default || ""), logKind: "error" };
  return { path: String(mapping.default || mapping.error || ""), logKind: "default" };
}

function buildServiceLogFileProbePlan(task) {
  const service = extractServiceName(task);
  if (!service) return null;
  const lowered = String(task || "").toLowerCase();
  if (!["log", "logs", "日志"].some((token) => lowered.includes(token))) return null;
  const { path: logPath, logKind } = inferServiceLogPath(service, task);
  if (!logPath) return null;
  const lineCount = extractLineCount(task);
  const display = logKind === "error" ? "error" : (logKind === "access" ? "access" : "");
  const summary = `查看 ${service} ${display ? `${display} ` : ""}log 最近 ${lineCount} 行`.trim();
  const plan = {
    kind: "local_file_probe",
    summary,
    command: `tail -n ${lineCount} ${logPath}`,
    probe_spec: {
      kind: "local_file_probe",
      path: logPath,
      mode: "tail",
      line_count: lineCount,
      service,
      log_kind: logKind,
    },
    reason_codes: [
      "runner_playbook_service_log_file_probe",
      `service:${service}`,
      `log_kind:${logKind}`,
    ],
    confidence: 0.94,
  };
  const remoteTarget = extractRemoteTarget(task);
  if (remoteTarget) {
    plan.kind = "remote_local_file_probe";
    plan.summary = `查看 ${remoteTarget} 上 ${service} ${display ? `${display} ` : ""}log 最近 ${lineCount} 行`.trim();
    plan.command = wrapRemoteCommand(remoteTarget, plan.command);
    plan.reason_codes = [...plan.reason_codes, `remote_target:${remoteTarget}`];
    plan.confidence = 0.95;
  }
  return plan;
}

function extractPaths(task) {
  const results = [];
  for (const match of String(task || "").matchAll(PATH_PATTERN)) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

function buildLocalFileProbePlan(task) {
  const lowered = String(task || "").toLowerCase();
  if (!["grep", "tail", "head", "cat", "查看文件", "查一下文件", "日志文件"].some((token) => lowered.includes(token))) return null;
  const paths = extractPaths(task);
  if (paths.length === 0) return null;
  const targetPath = paths[0];
  const lineCount = extractLineCount(task);
  let command = "";
  let mode = "";
  if (lowered.includes("tail") || lowered.includes("最近")) {
    command = `tail -n ${lineCount} ${targetPath}`;
    mode = "tail";
  } else if (lowered.includes("head") || lowered.includes("前")) {
    command = `head -n ${lineCount} ${targetPath}`;
    mode = "head";
  } else {
    command = `sed -n '1,120p' ${targetPath}`;
    mode = "read";
  }
  return {
    kind: "local_file_probe",
    summary: `查看文件 ${path.basename(targetPath)}`,
    command,
    probe_spec: {
      kind: "local_file_probe",
      path: targetPath,
      mode,
      line_count: mode === "tail" || mode === "head" ? lineCount : 120,
    },
    reason_codes: ["runner_playbook_local_file_probe"],
    confidence: 0.82,
  };
}

function buildSchedulerHealthPlan(task) {
  const lowered = String(task || "").toLowerCase();
  if (!containsAny(lowered, SCHEDULER_KEYWORDS)) return null;
  const command = [
    "printf '== crontab ==\\n'",
    "crontab -l 2>&1 || true",
    "printf '\\n== systemd timers ==\\n'",
    "systemctl list-timers --all --no-pager 2>&1 | sed -n '1,80p' || true",
  ].join("\n");
  const plan = {
    kind: "scheduler_health",
    summary: "检查当前机器的 cron / systemd timer 状态",
    command,
    probe_spec: {
      kind: "scheduler_health",
      checks: ["crontab", "systemd_timers"],
    },
    reason_codes: ["runner_playbook_scheduler_health"],
    confidence: 0.9,
  };
  const remoteTarget = extractRemoteTarget(task);
  if (remoteTarget) {
    plan.kind = "remote_scheduler_health";
    plan.summary = `检查 ${remoteTarget} 的 cron / systemd timer 状态`;
    plan.command = wrapRemoteCommand(remoteTarget, command);
    plan.reason_codes = [...plan.reason_codes, `remote_target:${remoteTarget}`];
    plan.confidence = 0.92;
  }
  return plan;
}

export function inferRunnerPlaybook(task, hints = {}) {
  const builders = [
    () => buildModelTelemetryReportPlan(task),
    () => buildUpstreamReleaseLookupPlan(task, hints),
    () => buildVersionProbePlan(task, hints),
    () => buildSystemSummaryPlan(task),
    () => buildLocalFileProbePlan(task),
    () => buildSchedulerHealthPlan(task),
    () => buildServiceLogFileProbePlan(task),
    () => buildServiceHealthPlan(task),
  ];
  for (const build of builders) {
    const plan = build();
    if (plan) return plan;
  }
  return buildAiGoalPlan(task);
}

const AI_GOAL_TRIGGER_TOKENS = [
  "分析", "总结", "对比", "比较", "调研", "研究",
  "特性", "功能", "变化", "更新", "新特性", "新功能",
  "memory", "记忆", "方向", "影响", "使用方式",
  "相关", "重点", "内容", "详情", "文档",
  "analyze", "analysis", "summary", "compare", "research",
  "feature", "features", "changelog", "release notes",
  "what's new", "what changed", "how to", "usage",
];

function buildAiGoalPlan(task) {
  if (!task || !String(task).trim()) return null;
  const lowered = String(task).toLowerCase();
  const hasTrigger = AI_GOAL_TRIGGER_TOKENS.some((t) => lowered.includes(t));
  if (!hasTrigger) return null;
  const escapedGoal = String(task).replace(/'/g, "'\\''").replace(/"/g, '\\"');
  const command = `openclaw agent --agent main --message '${escapedGoal}' --json --no-confirm 2>&1 | head -n 200`;
  return {
    kind: "ai_goal",
    summary: String(task).substring(0, 80),
    command,
    probe_spec: {
      kind: "ai_goal",
      goal: String(task),
      execution_mode: "ai_agent",
    },
    reason_codes: ["runner_playbook_ai_goal", "no_fixed_playbook_match"],
    confidence: 0.85,
  };
}
