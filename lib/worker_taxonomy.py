#!/usr/bin/env python3
"""Shared worker taxonomy helpers for the worker-pool-first runtime."""

from __future__ import annotations

from typing import Any


VALID_WORKER_POOLS = {
    "octoclaw-main",
    "octoclaw-runner",
    "octoclaw-research",
    "octoclaw-code",
    "octoclaw-review",
}

VALID_MODEL_BANDS = {
    "fast",
    "normal",
    "strong",
    "heavy",
}

WORKER_POOL_TO_WORK_TYPE = {
    "octoclaw-main": "",
    "octoclaw-runner": "ops",
    "octoclaw-research": "research",
    "octoclaw-code": "code",
    "octoclaw-review": "review",
}

DEFAULT_PHASE_BY_WORK_TYPE = {
    "ops": "inspect",
    "research": "collect",
    "code": "implement",
    "review": "verify",
}

MODEL_BAND_TO_SELECTOR_BAND = {
    "fast": "quick",
    "normal": "standard",
    "strong": "strong",
    "heavy": "heavy",
}

SELECTOR_BAND_TO_MODEL_BAND = {
    "quick": "fast",
    "standard": "normal",
    "strong": "strong",
    "heavy": "heavy",
}

DEFAULT_MODEL_BAND_BY_WORKER_POOL = {
    "octoclaw-main": "normal",
    "octoclaw-runner": "fast",
    "octoclaw-research": "normal",
    "octoclaw-code": "strong",
    "octoclaw-review": "strong",
}

WORKER_POOL_DISPLAY = {
    "octoclaw-main": {"emoji": "🤖", "name": "主脑"},
    "octoclaw-runner": {"emoji": "🏃", "name": "飞鱼腿"},
    "octoclaw-research": {"emoji": "🔍", "name": "梭鱼眼"},
    "octoclaw-code": {"emoji": "🔧", "name": "螃蟹手"},
    "octoclaw-review": {"emoji": "🧪", "name": "海胆手"},
}


def normalize_worker_pool(value: str, default: str = "") -> str:
    text = str(value or "").strip()
    if text in VALID_WORKER_POOLS:
        return text
    return default


def normalize_model_band(value: str, default: str = "") -> str:
    text = str(value or "").strip().lower()
    if text in VALID_MODEL_BANDS:
        return text
    return default


def selector_band_for_model_band(model_band: str, *, route: str = "") -> str:
    normalized = normalize_model_band(model_band, default="normal")
    if str(route or "").strip().lower() == "runner":
        return "quick"
    return MODEL_BAND_TO_SELECTOR_BAND.get(normalized, "standard")


def model_band_for_selector_band(selector_band: str, default: str = "normal") -> str:
    text = str(selector_band or "").strip().lower()
    return SELECTOR_BAND_TO_MODEL_BAND.get(text, default)


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


def infer_model_band(
    *,
    route: str = "",
    worker_pool: str = "",
    work_type: str = "",
    protocol: str = "",
) -> str:
    current_route = str(route or "").strip().lower()
    current_pool = normalize_worker_pool(worker_pool, default="")
    current_work_type = str(work_type or "").strip().lower()
    current_protocol = str(protocol or "").strip().lower()

    if current_protocol == "heavy":
        return "heavy"
    if current_route == "runner" or current_pool == "octoclaw-runner":
        return "fast"
    if current_route == "spawn_multi":
        return "heavy"
    if current_work_type in {"code", "review"} or current_pool in {"octoclaw-code", "octoclaw-review"}:
        return "strong"
    if current_route == "direct":
        return "fast"
    return DEFAULT_MODEL_BAND_BY_WORKER_POOL.get(current_pool, "normal")


def resolve_worker_pool(task: dict[str, Any] | str, default: str = "") -> str:
    if isinstance(task, str):
        return normalize_worker_pool(task, default=default)
    if not isinstance(task, dict):
        return default

    explicit = normalize_worker_pool(str(task.get("worker_pool", "") or "").strip(), default="")
    if explicit:
        return explicit

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


def resolve_work_type(task: dict[str, Any] | str, default: str = "") -> str:
    if isinstance(task, str):
        worker_pool = resolve_worker_pool(task, default="")
        return WORKER_POOL_TO_WORK_TYPE.get(worker_pool, default)
    if not isinstance(task, dict):
        return default

    explicit = str(task.get("work_type", "") or "").strip().lower()
    if explicit:
        return explicit

    route = str(task.get("route", "") or "").strip().lower()
    if route == "runner":
        return "ops"

    worker_pool = resolve_worker_pool(task, default="")
    if worker_pool:
        work_type = WORKER_POOL_TO_WORK_TYPE.get(worker_pool, "")
        if work_type:
            return work_type

    return default


def resolve_phase(task: dict[str, Any] | str, default: str = "") -> str:
    if isinstance(task, str):
        worker_pool = resolve_worker_pool(task, default="")
        work_type = WORKER_POOL_TO_WORK_TYPE.get(worker_pool, "")
        return DEFAULT_PHASE_BY_WORK_TYPE.get(work_type, default)
    if not isinstance(task, dict):
        return default

    explicit = str(task.get("phase", "") or "").strip().lower()
    if explicit:
        return explicit

    route = str(task.get("route", "") or "").strip().lower()
    if route == "runner":
        return "inspect"

    profile = str(task.get("profile", "") or "").strip().lower()
    if profile == "writer":
        return "report"

    work_type = resolve_work_type(task, default="")
    return DEFAULT_PHASE_BY_WORK_TYPE.get(work_type, default)


def resolve_model_band(task: dict[str, Any] | str, default: str = "") -> str:
    if isinstance(task, str):
        return normalize_model_band(task, default=default)
    if not isinstance(task, dict):
        return default

    explicit = normalize_model_band(str(task.get("model_band", "") or "").strip(), default="")
    if explicit:
        return explicit

    return infer_model_band(
        route=str(task.get("route", "") or ""),
        worker_pool=resolve_worker_pool(task, default=""),
        work_type=resolve_work_type(task, default=""),
        protocol=str(task.get("protocol", "") or ""),
    ) or default


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
        return "team"
    if pool == "octoclaw-review":
        return "review"
    if pool == "octoclaw-code":
        return "review" if current_phase == "verify" else "code"
    if current_profile == "writer" or current_phase == "report":
        return "writer"
    if current_phase == "inspect":
        return "inspect"
    return "research"


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
    worker_pool = resolve_worker_pool(task, default="")
    if worker_pool in WORKER_POOL_DISPLAY:
        return dict(WORKER_POOL_DISPLAY[worker_pool])

    if isinstance(task, str):
        label = str(task).strip()
        clean = label.replace("octoclaw-", "").replace("octopus-", "") or "任务"
        return {"emoji": "🤖", "name": clean}

    return {"emoji": "🤖", "name": "任务"}
