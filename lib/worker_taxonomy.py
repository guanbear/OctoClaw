#!/usr/bin/env python3
"""Shared worker taxonomy helpers for the Phase 3 migration."""

from __future__ import annotations

from typing import Any


VALID_WORKER_POOLS = {
    "octoclaw-main",
    "octoclaw-runner",
    "octoclaw-research",
    "octoclaw-code",
    "octoclaw-review",
}

LEGACY_LABEL_TO_WORKER_POOL = {
    "main": "octoclaw-main",
    "octoclaw-main": "octoclaw-main",
    "octopus-runner": "octoclaw-runner",
    "octoclaw-runner": "octoclaw-runner",
    "octopus-feishu": "octoclaw-runner",
    "octopus-scout": "octoclaw-research",
    "octopus-writer": "octoclaw-research",
    "octopus-analyze": "octoclaw-research",
    "octopus-power": "octoclaw-research",
    "octopus-fix": "octoclaw-code",
    "octopus-test": "octoclaw-review",
}

MODEL_ROLE_TO_LEGACY_LABEL = {
    "runner": "octopus-runner",
    "scout": "octopus-scout",
    "writer": "octopus-writer",
    "analyze": "octopus-analyze",
    "fix": "octopus-fix",
    "test": "octopus-test",
    "power": "octopus-power",
    "main": "main",
}

WORKER_POOL_DISPLAY = {
    "octoclaw-main": {"emoji": "🤖", "name": "主脑"},
    "octoclaw-runner": {"emoji": "🏃", "name": "飞鱼腿"},
    "octoclaw-research": {"emoji": "🔍", "name": "梭鱼眼"},
    "octoclaw-code": {"emoji": "🔧", "name": "螃蟹手"},
    "octoclaw-review": {"emoji": "🧪", "name": "海胆手"},
}

LEGACY_LABEL_DISPLAY = {
    "main": {"emoji": "🤖", "name": "主脑"},
    "octoclaw-main": {"emoji": "🤖", "name": "主脑"},
    "octopus-power": {"emoji": "💪", "name": "鲸力手"},
    "octopus-scout": {"emoji": "🔍", "name": "梭鱼眼"},
    "octopus-writer": {"emoji": "✍️", "name": "墨鱼手"},
    "octopus-fix": {"emoji": "🔧", "name": "螃蟹手"},
    "octopus-test": {"emoji": "🧪", "name": "海胆手"},
    "octopus-analyze": {"emoji": "📊", "name": "章鱼脑"},
    "octopus-runner": {"emoji": "🏃", "name": "飞鱼腿"},
    "octoclaw-runner": {"emoji": "🏃", "name": "飞鱼腿"},
    "octopus-feishu": {"emoji": "🐦", "name": "鸽手"},
}


def normalize_worker_pool(value: str, default: str = "") -> str:
    text = str(value or "").strip()
    if text in VALID_WORKER_POOLS:
        return text
    return default


def worker_pool_from_legacy_label(label: str, default: str = "") -> str:
    text = str(label or "").strip()
    return LEGACY_LABEL_TO_WORKER_POOL.get(text, default)


def infer_worker_pool(route: str, work_type: str) -> str:
    if route == "direct":
        return "octoclaw-main"
    if route == "runner":
        return "octoclaw-runner"
    if work_type == "review":
        return "octoclaw-review"
    if work_type == "code":
        return "octoclaw-code"
    return "octoclaw-research"


def model_role_for_worker_pool(
    worker_pool: str,
    *,
    phase: str = "",
    route: str = "",
    profile: str = "",
) -> str:
    pool = normalize_worker_pool(worker_pool, default="octoclaw-research")
    current_phase = str(phase or "").strip()
    current_route = str(route or "").strip()
    current_profile = str(profile or "").strip()

    if pool == "octoclaw-main":
        return "main"
    if pool == "octoclaw-runner":
        return "runner"
    if current_route == "spawn_multi":
        return "power"
    if pool == "octoclaw-review":
        return "test"
    if pool == "octoclaw-code":
        return "test" if current_phase == "verify" else "fix"
    if current_profile == "writer" or current_phase == "report":
        return "writer"
    if current_phase == "inspect":
        return "analyze"
    return "scout"


def legacy_label_for_worker_pool(
    worker_pool: str,
    *,
    phase: str = "",
    route: str = "",
    profile: str = "",
    role_hint: str = "",
) -> str:
    computed = MODEL_ROLE_TO_LEGACY_LABEL.get(
        model_role_for_worker_pool(worker_pool, phase=phase, route=route, profile=profile),
        "octopus-scout",
    )
    hint = str(role_hint or "").strip()
    hinted_pool = worker_pool_from_legacy_label(hint)
    if hint and hint not in {"main", "octoclaw-main"} and hinted_pool == normalize_worker_pool(worker_pool) and hint == computed:
        return hint
    return computed


def resolve_worker_pool(task: dict[str, Any] | str, default: str = "") -> str:
    if isinstance(task, str):
        return normalize_worker_pool(task, default=default) or worker_pool_from_legacy_label(task, default=default)
    if not isinstance(task, dict):
        return default

    explicit = normalize_worker_pool(str(task.get("worker_pool", "") or "").strip())
    if explicit:
        return explicit

    label = worker_pool_from_legacy_label(str(task.get("label", "") or "").strip(), default="")
    if label:
        return label

    route = str(task.get("route", "") or "").strip().lower()
    runtime = str(task.get("runtime", "") or "").strip().lower()
    executor = str(task.get("executor", "") or task.get("executor_type", "") or "").strip().lower()
    work_type = str(task.get("work_type", "") or "").strip().lower()

    if route == "direct":
        return "octoclaw-main"
    if route == "runner" or runtime == "runner" or executor == "runner" or work_type == "ops":
        return "octoclaw-runner"
    if work_type == "code":
        return "octoclaw-code"
    if work_type == "review":
        return "octoclaw-review"
    if work_type == "research":
        return "octoclaw-research"
    if route in {"spawn_single", "spawn_multi"}:
        return "octoclaw-research"
    return default


def resolve_executor(task: dict[str, Any] | str, default: str = "subagent") -> str:
    if isinstance(task, dict):
        explicit = str(task.get("executor", "") or task.get("executor_type", "") or "").strip().lower()
        if explicit in {"runner", "subagent", "team", "main"}:
            return explicit

        task_kind = str(task.get("task_kind", "") or "").strip().lower()
        route = str(task.get("route", "") or "").strip().lower()
        worker_pool = resolve_worker_pool(task, default="")
        if task_kind == "team_parent" or route == "spawn_multi":
            return "team"
        if worker_pool == "octoclaw-main" or route == "direct":
            return "main"
        if worker_pool == "octoclaw-runner" or route == "runner":
            return "runner"
        return default

    pool = resolve_worker_pool(task, default="")
    if pool == "octoclaw-main":
        return "main"
    if pool == "octoclaw-runner":
        return "runner"
    return default


def is_runner_task(task: dict[str, Any] | str) -> bool:
    return resolve_worker_pool(task, default="") == "octoclaw-runner" or resolve_executor(task) == "runner"


def role_display(task: dict[str, Any] | str) -> dict[str, str]:
    if isinstance(task, str):
        worker_pool = resolve_worker_pool(task, default="")
        if worker_pool in WORKER_POOL_DISPLAY:
            return dict(WORKER_POOL_DISPLAY[worker_pool])
        label = str(task).strip()
        if label in LEGACY_LABEL_DISPLAY:
            return dict(LEGACY_LABEL_DISPLAY[label])
        return {"emoji": "🤖", "name": label or "任务"}

    explicit_worker_pool = normalize_worker_pool(str(task.get("worker_pool", "") or "").strip(), default="")
    if explicit_worker_pool and explicit_worker_pool in WORKER_POOL_DISPLAY:
        return dict(WORKER_POOL_DISPLAY[explicit_worker_pool])

    label = str(task.get("label", "") or "").strip()
    if label in LEGACY_LABEL_DISPLAY:
        return dict(LEGACY_LABEL_DISPLAY[label])

    worker_pool = resolve_worker_pool(task, default="")
    if worker_pool in WORKER_POOL_DISPLAY:
        return dict(WORKER_POOL_DISPLAY[worker_pool])
    if worker_pool:
        return {"emoji": "🤖", "name": worker_pool.replace("octoclaw-", "")}
    return {"emoji": "🤖", "name": label.replace("octopus-", "") if label else "任务"}

