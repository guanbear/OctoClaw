#!/usr/bin/env python3
"""Generic runner playbooks for natural-language local inspection tasks.

This module exists to keep fast local checks on the runner path without forcing
the main agent to invent shell commands inline. The goal is not to enumerate
every app/service, but to cover a few common execution shapes:

- system summary: python / disk / memory / cpu / uptime
- service health: service status + process + recent logs + optional port checks
- local search: grep / tail / cat style file inspection when paths are explicit
"""

from __future__ import annotations

import os
import re
import shlex
from typing import Iterable

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_TELEMETRY_REPORT_PY = os.path.join(SCRIPT_DIR, "model_telemetry_report.py")
UPSTREAM_RELEASE_LOOKUP_MJS = os.path.join(SCRIPT_DIR, "upstream_release_lookup.mjs")

SYSTEM_METRIC_KEYWORDS = {
    "python": ["python", "python版本", "python version"],
    "disk": ["磁盘", "disk", "df", "存储", "空间"],
    "memory": ["内存", "memory", "ram", "swap"],
    "cpu": ["cpu", "负载", "load average", "load"],
    "uptime": ["uptime", "运行时间", "在线时长"],
}

SERVICE_ALIASES = {
    "redis": ["redis", "redis-server"],
    "openclaw": ["openclaw"],
    "nginx": ["nginx"],
    "postgres": ["postgresql", "postgres", "postgresql.service"],
    "mysql": ["mysql", "mysqld", "mariadb"],
    "docker": ["docker", "dockerd"],
}

SERVICE_PORTS = {
    "redis": [6379, 6380],
    "openclaw": [18789, 18791, 18792],
    "nginx": [80, 443],
    "postgres": [5432],
    "mysql": [3306],
}

SERVICE_LOG_PATHS = {
    "nginx": {
        "error": "/var/log/nginx/error.log",
        "access": "/var/log/nginx/access.log",
        "default": "/var/log/nginx/error.log",
    },
}

PATH_PATTERN = re.compile(r"(/[A-Za-z0-9._/\-]+)")
TAIL_COUNT_PATTERNS = [
    re.compile(r"\btail\s+-n?\s*(\d{1,4})\b", re.IGNORECASE),
    re.compile(r"(?:最近|近)\s*(\d{1,4})\s*行"),
    re.compile(r"\blast\s+(\d{1,4})\s+lines?\b", re.IGNORECASE),
]
REMOTE_HINT_PATTERNS = [
    "远程",
    "remote",
    "另一台",
    "另一台机器",
    "另一台主机",
    "macmini",
    "mac mini",
]
VERSION_QUERY_TOKENS = ["版本", "version", "--version", "ver"]
UPSTREAM_UPDATE_TOKENS = [
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
]

VERSION_COMMANDS = {
    "openclaw": "if command -v openclaw >/dev/null 2>&1; then openclaw --version || openclaw version; "
                "elif [ -x /opt/homebrew/bin/openclaw ]; then /opt/homebrew/bin/openclaw --version || /opt/homebrew/bin/openclaw version; "
                "elif [ -x /usr/local/bin/openclaw ]; then /usr/local/bin/openclaw --version || /usr/local/bin/openclaw version; "
                "elif [ -x /usr/bin/openclaw ]; then /usr/bin/openclaw --version || /usr/bin/openclaw version; "
                "else echo 'openclaw not found'; fi",
    "python": "python3 --version || python --version",
    "node": "node --version",
    "npm": "npm --version",
}

SCHEDULER_KEYWORDS = [
    "cron",
    "crontab",
    "定时任务",
    "计划任务",
    "schedule",
    "scheduler",
    "timer",
    "timers",
    "list-timers",
]

ERROR_LOG_TOKENS = [
    "error log",
    "error.log",
    "错误日志",
    "报错日志",
]

ACCESS_LOG_TOKENS = [
    "access log",
    "access.log",
    "访问日志",
]

MODEL_BENCHMARK_HINTS = [
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
]

MODEL_REFERENCE_PATTERN = re.compile(
    r"(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|(?:gpt|glm|minimax|claude|qwen|kimi|deepseek|gemini|sonnet|opus)[-A-Za-z0-9_.]*)",
    re.IGNORECASE,
)


def contains_any(text: str, patterns: Iterable[str]) -> bool:
    lowered = text.lower()
    return any(pattern.lower() in lowered for pattern in patterns)


def normalize_hints(hints: dict | None) -> dict:
    if not isinstance(hints, dict):
        return {}
    return {str(key): value for key, value in hints.items()}


def hinted_lookup_scope(hints: dict | None) -> str:
    return str(normalize_hints(hints).get("lookup_scope", "") or "").strip()


def hinted_lookup_project(hints: dict | None) -> str:
    return str(normalize_hints(hints).get("lookup_project", "") or "").strip().lower()


def hinted_lookup_focus(hints: dict | None) -> str:
    return str(normalize_hints(hints).get("lookup_focus", "") or "").strip().lower()


def load_ssh_aliases() -> list[str]:
    aliases: list[str] = []
    config_path = os.path.expanduser("~/.ssh/config")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if not line.lower().startswith("host "):
                    continue
                for token in line.split()[1:]:
                    if "*" in token or "?" in token:
                        continue
                    aliases.append(token)
    except OSError:
        return []
    deduped: list[str] = []
    seen = set()
    for alias in aliases:
        lowered = alias.lower()
        if lowered and lowered not in seen:
            seen.add(lowered)
            deduped.append(alias)
    return deduped


def extract_remote_target(task: str) -> str | None:
    lowered = task.lower()
    aliases = load_ssh_aliases()
    for alias in aliases:
        if alias.lower() in lowered:
            return alias
    if "macmini" in lowered or "mac mini" in lowered:
        return "macmini"
    if not contains_any(lowered, REMOTE_HINT_PATTERNS):
        return None
    host_like = re.findall(r"[a-z][a-z0-9._-]{2,}", lowered)
    reserved = {
        "openclaw", "python", "redis", "nginx", "docker", "memory", "disk", "version",
        "status", "health", "service", "remote", "host", "server", "machine",
    }
    for token in host_like:
        if token in reserved:
            continue
        if token.startswith("octopus") or token.startswith("runner"):
            continue
        return token
    return None


def wrap_remote_command(target: str, command: str) -> str:
    remote_script = "\n".join([
        "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH",
        command.strip(),
    ])
    remote_cmd = f"/bin/sh -lc {shlex.quote(remote_script)}"
    return f"ssh {shlex.quote(target)} {shlex.quote(remote_cmd)}"


def extract_line_count(task: str, default: int = 40) -> int:
    text = str(task or "")
    for pattern in TAIL_COUNT_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            value = int(match.group(1))
        except Exception:
            continue
        return max(1, min(value, 5000))
    return default


def build_system_summary_plan(task: str) -> dict | None:
    lowered = task.lower()
    requested: list[str] = []
    for metric, keywords in SYSTEM_METRIC_KEYWORDS.items():
        if contains_any(lowered, keywords):
            requested.append(metric)
    if not requested:
        return None

    commands: list[str] = []
    if "python" in requested:
        commands.append("python3 --version")
    if "disk" in requested:
        commands.append("df -h /")
    if "memory" in requested:
        commands.append("free -h || vm_stat")
    if "cpu" in requested:
        commands.append("uptime")
    if "uptime" in requested and "cpu" not in requested:
        commands.append("uptime")

    return {
        "kind": "system_summary",
        "summary": "检查当前机器系统摘要",
        "command": "\n".join(commands),
        "probe_spec": {
            "kind": "system_summary",
            "metrics": requested,
        },
        "reason_codes": ["runner_playbook_system_summary"],
        "confidence": 0.88,
    }


def build_model_telemetry_report_plan(task: str) -> dict | None:
    lowered = task.lower()
    if not contains_any(lowered, MODEL_BENCHMARK_HINTS):
        return None
    model_refs = {value.lower() for value in MODEL_REFERENCE_PATTERN.findall(task)}
    if not model_refs:
        return None

    base_command = f"python3 {shlex.quote(MODEL_TELEMETRY_REPORT_PY)} --task {shlex.quote(task)}"
    plan = {
        "kind": "model_telemetry_report",
        "summary": "比较请求模型的本地速度与健康快照",
        "command": base_command,
        "probe_spec": {
            "kind": "model_telemetry_report",
            "task": task,
            "models": sorted(model_refs),
            "metrics": ["ttft_ms", "output_tps", "health_state", "fallback_failures"],
        },
        "reason_codes": ["runner_playbook_model_telemetry_report"],
        "confidence": 0.93,
    }
    remote_target = extract_remote_target(task)
    if remote_target:
        plan["kind"] = "remote_model_telemetry_report"
        plan["summary"] = f"比较 {remote_target} 上请求模型的本地速度与健康快照"
        plan["command"] = wrap_remote_command(remote_target, base_command)
        plan["reason_codes"] = [*plan["reason_codes"], f"remote_target:{remote_target}"]
        plan["confidence"] = 0.95
    return plan


def build_upstream_release_lookup_plan(task: str, hints: dict | None = None) -> dict | None:
    lowered = task.lower()
    scope = hinted_lookup_scope(hints)
    project = hinted_lookup_project(hints)
    focus = hinted_lookup_focus(hints)
    if hints and hints.get("requires_research"):
        return None
    if scope != "upstream_project" and not contains_any(lowered, UPSTREAM_UPDATE_TOKENS):
        return None
    if not project:
        if "openclaw" in lowered:
            project = "openclaw"
        elif "octoclaw" in lowered:
            project = "octoclaw"
    if project not in {"openclaw", "octoclaw"}:
        return None

    cmd = (
        f"node {shlex.quote(UPSTREAM_RELEASE_LOOKUP_MJS)}"
        f" --project {shlex.quote(project)}"
        f" --focus {shlex.quote(focus or 'latest_updates')}"
    )
    return {
        "kind": "upstream_release_lookup",
        "summary": f"检查 {project} 上游最新发版与最近更新",
        "command": cmd,
        "probe_spec": {
            "kind": "upstream_release_lookup",
            "project": project,
            "focus": focus or "latest_updates",
            "source": "github_api",
        },
        "reason_codes": ["runner_playbook_upstream_release_lookup", f"project:{project}", f"focus:{focus or 'latest_updates'}"],
        "confidence": 0.95 if scope == "upstream_project" else 0.88,
    }


def build_version_probe_plan(task: str, hints: dict | None = None) -> dict | None:
    lowered = task.lower()
    if hinted_lookup_scope(hints) == "upstream_project":
        return None
    if hints and hints.get("requires_research"):
        return None
    if contains_any(lowered, UPSTREAM_UPDATE_TOKENS) and ("openclaw" in lowered or "octoclaw" in lowered):
        return None
    if not contains_any(lowered, VERSION_QUERY_TOKENS):
        return None

    target_tool = ""
    for tool, aliases in {
        "openclaw": ["openclaw"],
        "python": ["python", "python3"],
        "node": ["node"],
        "npm": ["npm"],
    }.items():
        if contains_any(lowered, aliases):
            target_tool = tool
            break

    if not target_tool:
        return None

    base_command = VERSION_COMMANDS.get(target_tool, "")
    if not base_command:
        return None

    remote_target = extract_remote_target(task)
    if remote_target:
        return {
            "kind": "remote_version_probe",
            "summary": f"检查 {remote_target} 的 {target_tool} 版本",
            "command": wrap_remote_command(remote_target, base_command),
            "probe_spec": {
                "kind": "version_probe",
                "tool": target_tool,
                "remote_target": remote_target,
            },
            "reason_codes": ["runner_playbook_version_probe", f"remote_target:{remote_target}", f"tool:{target_tool}"],
            "confidence": 0.9,
        }

    return {
        "kind": "version_probe",
        "summary": f"检查当前机器的 {target_tool} 版本",
        "command": base_command,
        "probe_spec": {
            "kind": "version_probe",
            "tool": target_tool,
        },
        "reason_codes": ["runner_playbook_version_probe", f"tool:{target_tool}"],
        "confidence": 0.86,
    }


def extract_service_name(task: str) -> str | None:
    lowered = task.lower()
    for canonical, aliases in SERVICE_ALIASES.items():
        if contains_any(lowered, aliases):
            return canonical
    return None


def build_service_health_plan(task: str) -> dict | None:
    service = extract_service_name(task)
    if not service:
        return None

    lowered = task.lower()
    wants_logs = any(token in lowered for token in ["log", "logs", "日志"])
    wants_ports = any(token in lowered for token in ["端口", "port", "监听"])
    wants_process = any(token in lowered for token in ["进程", "process", "service", "服务状态", "状态"])
    wants_status = wants_logs or wants_ports or wants_process
    if not wants_status:
        return None

    aliases = SERVICE_ALIASES.get(service, [service])
    ports = SERVICE_PORTS.get(service, [])
    commands: list[str] = []

    if wants_ports and ports:
        port_expr = " || ".join([f"ss -lntp | grep -E ':{port}\\b'" for port in ports])
        commands.append(f"({port_expr}) || true")
    elif wants_ports:
        commands.append(f"ss -lntp | grep -i '{service}' || true")

    if wants_process:
        unit_args = " ".join(aliases[:2])
        commands.append(f"systemctl status {unit_args} --no-pager -n 20 || true")
        proc_expr = " ".join([f"-e '{alias}'" for alias in aliases[:2]])
        commands.append(f"ps -ef | grep -i {proc_expr} | grep -v grep || true")

    if wants_logs:
        unit_args = " ".join([f"-u {alias}" for alias in aliases[:2]])
        commands.append(f"journalctl {unit_args} -n 40 --no-pager || true")

    plan = {
        "kind": "service_health",
        "summary": f"检查 {service} 的端口、状态与日志",
        "command": "\n".join(commands),
        "probe_spec": {
            "kind": "service_health",
            "service": service,
            "ports": ports,
            "includes_logs": wants_logs,
            "includes_process": wants_process,
            "includes_ports": wants_ports,
        },
        "reason_codes": ["runner_playbook_service_health", f"service:{service}"],
        "confidence": 0.9,
    }
    remote_target = extract_remote_target(task)
    if remote_target:
        plan["kind"] = "remote_service_health"
        plan["summary"] = f"检查 {remote_target} 上 {service} 的端口、状态与日志"
        plan["command"] = wrap_remote_command(remote_target, plan["command"])
        plan["reason_codes"] = [*plan["reason_codes"], f"remote_target:{remote_target}"]
        plan["confidence"] = 0.92
    return plan


def _infer_service_log_path(service: str, task: str) -> tuple[str, str]:
    lowered = task.lower()
    mapping = SERVICE_LOG_PATHS.get(service, {})
    if not isinstance(mapping, dict) or not mapping:
        return "", ""
    if contains_any(lowered, ACCESS_LOG_TOKENS):
        return str(mapping.get("access", "") or mapping.get("default", "") or ""), "access"
    if contains_any(lowered, ERROR_LOG_TOKENS):
        return str(mapping.get("error", "") or mapping.get("default", "") or ""), "error"
    return str(mapping.get("default", "") or mapping.get("error", "") or ""), "default"


def build_service_log_file_probe_plan(task: str) -> dict | None:
    service = extract_service_name(task)
    if not service:
        return None
    lowered = task.lower()
    if not any(token in lowered for token in ["log", "logs", "日志"]):
        return None

    path, log_kind = _infer_service_log_path(service, task)
    if not path:
        return None

    line_count = extract_line_count(task)
    display = "error" if log_kind == "error" else ("access" if log_kind == "access" else "")
    summary = f"查看 {service} {display + ' ' if display else ''}log 最近 {line_count} 行".strip()
    plan = {
        "kind": "local_file_probe",
        "summary": summary,
        "command": f"tail -n {line_count} {path}",
        "probe_spec": {
            "kind": "local_file_probe",
            "path": path,
            "mode": "tail",
            "line_count": line_count,
            "service": service,
            "log_kind": log_kind,
        },
        "reason_codes": [
            "runner_playbook_service_log_file_probe",
            f"service:{service}",
            f"log_kind:{log_kind}",
        ],
        "confidence": 0.94,
    }
    remote_target = extract_remote_target(task)
    if remote_target:
        plan["kind"] = "remote_local_file_probe"
        plan["summary"] = f"查看 {remote_target} 上 {service} {display + ' ' if display else ''}log 最近 {line_count} 行".strip()
        plan["command"] = wrap_remote_command(remote_target, plan["command"])
        plan["reason_codes"] = [*plan["reason_codes"], f"remote_target:{remote_target}"]
        plan["confidence"] = 0.95
    return plan


def build_local_file_probe_plan(task: str) -> dict | None:
    lowered = task.lower()
    if not any(token in lowered for token in ["grep", "tail", "head", "cat", "查看文件", "查一下文件", "日志文件"]):
        return None
    paths = PATH_PATTERN.findall(task)
    if not paths:
        return None
    path = paths[0]
    line_count = extract_line_count(task)
    if "tail" in lowered or "最近" in lowered:
        command = f"tail -n {line_count} {path}"
        mode = "tail"
    elif "head" in lowered or "前" in lowered:
        command = f"head -n {line_count} {path}"
        mode = "head"
    else:
        command = f"sed -n '1,120p' {path}"
        mode = "read"
    return {
        "kind": "local_file_probe",
        "summary": f"查看文件 {os.path.basename(path)}",
        "command": command,
        "probe_spec": {
            "kind": "local_file_probe",
            "path": path,
            "mode": mode,
            "line_count": line_count if mode in {"tail", "head"} else 120,
        },
        "reason_codes": ["runner_playbook_local_file_probe"],
        "confidence": 0.82,
    }


def build_scheduler_health_plan(task: str) -> dict | None:
    lowered = task.lower()
    if not contains_any(lowered, SCHEDULER_KEYWORDS):
        return None

    command = "\n".join(
        [
            "printf '== crontab ==\\n'",
            "crontab -l 2>&1 || true",
            "printf '\\n== systemd timers ==\\n'",
            "systemctl list-timers --all --no-pager 2>&1 | sed -n '1,80p' || true",
        ]
    )
    plan = {
        "kind": "scheduler_health",
        "summary": "检查当前机器的 cron / systemd timer 状态",
        "command": command,
        "probe_spec": {
            "kind": "scheduler_health",
            "checks": ["crontab", "systemd_timers"],
        },
        "reason_codes": ["runner_playbook_scheduler_health"],
        "confidence": 0.9,
    }
    remote_target = extract_remote_target(task)
    if remote_target:
        plan["kind"] = "remote_scheduler_health"
        plan["summary"] = f"检查 {remote_target} 的 cron / systemd timer 状态"
        plan["command"] = wrap_remote_command(remote_target, command)
        plan["reason_codes"] = [*plan["reason_codes"], f"remote_target:{remote_target}"]
        plan["confidence"] = 0.92
    return plan


AI_GOAL_TRIGGER_TOKENS = [
    "分析", "总结", "对比", "比较", "调研", "研究",
    "特性", "功能", "变化", "更新", "新特性", "新功能",
    "memory", "记忆", "方向", "影响", "使用方式",
    "相关", "重点", "内容", "详情", "文档",
    "analyze", "analysis", "summary", "compare", "research",
    "feature", "features", "changelog", "release notes",
    "what's new", "what changed", "how to", "usage",
]


def build_ai_goal_plan(task: str, hints: dict | None = None) -> dict | None:
    if not task or not task.strip():
        return None
    hints = hints or {}
    if not hints.get("requires_research") and not hints.get("bounded_software_update_lookup"):
        lowered = task.lower()
        if not any(t in lowered for t in AI_GOAL_TRIGGER_TOKENS):
            return None
    escaped_goal = task.replace("'", "'\\''").replace('"', '\\"')
    command = f"openclaw agent --agent main --message '{escaped_goal}' --json 2>&1 | head -n 200"
    return {
        "kind": "ai_goal",
        "summary": task[:80],
        "command": command,
        "probe_spec": {
            "kind": "ai_goal",
            "goal": task,
            "execution_mode": "ai_agent",
        },
        "reason_codes": ["runner_playbook_ai_goal", "no_fixed_playbook_match"],
        "confidence": 0.85,
    }


def infer_runner_playbook(task: str, hints: dict | None = None) -> dict | None:
    hints = hints or {}
    if hints.get("requires_research"):
        goal_plan = build_ai_goal_plan(task, hints)
        if goal_plan:
            return goal_plan
    for builder in (
        build_model_telemetry_report_plan,
        build_upstream_release_lookup_plan,
        build_version_probe_plan,
        build_system_summary_plan,
        build_local_file_probe_plan,
        build_scheduler_health_plan,
        build_service_log_file_probe_plan,
        build_service_health_plan,
        build_ai_goal_plan,
    ):
        plan = builder(task, hints) if builder in {build_upstream_release_lookup_plan, build_version_probe_plan, build_ai_goal_plan} else builder(task)
        if plan:
            return plan
    return build_ai_goal_plan(task, hints)
