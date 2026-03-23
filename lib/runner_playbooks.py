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
from typing import Iterable


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

PATH_PATTERN = re.compile(r"(/[A-Za-z0-9._/\-]+)")


def contains_any(text: str, patterns: Iterable[str]) -> bool:
    lowered = text.lower()
    return any(pattern.lower() in lowered for pattern in patterns)


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
        "reason_codes": ["runner_playbook_system_summary"],
        "confidence": 0.88,
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

    return {
        "kind": "service_health",
        "summary": f"检查 {service} 的端口、状态与日志",
        "command": "\n".join(commands),
        "reason_codes": ["runner_playbook_service_health", f"service:{service}"],
        "confidence": 0.9,
    }


def build_local_file_probe_plan(task: str) -> dict | None:
    lowered = task.lower()
    if not any(token in lowered for token in ["grep", "tail", "head", "cat", "查看文件", "查一下文件", "日志文件"]):
        return None
    paths = PATH_PATTERN.findall(task)
    if not paths:
        return None
    path = paths[0]
    if "tail" in lowered or "最近" in lowered:
        command = f"tail -n 40 {path}"
    elif "head" in lowered or "前" in lowered:
        command = f"head -n 40 {path}"
    else:
        command = f"sed -n '1,120p' {path}"
    return {
        "kind": "local_file_probe",
        "summary": f"查看文件 {os.path.basename(path)}",
        "command": command,
        "reason_codes": ["runner_playbook_local_file_probe"],
        "confidence": 0.82,
    }


def infer_runner_playbook(task: str) -> dict | None:
    for builder in (build_system_summary_plan, build_service_health_plan, build_local_file_probe_plan):
        plan = builder(task)
        if plan:
            return plan
    return None

