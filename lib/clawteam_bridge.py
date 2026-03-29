#!/usr/bin/env python3
"""Minimal ClawTeam-style task/inbox/event mirror for OctoClaw validation."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any

from octopus_config import CLAWTEAM_BRIDGE_DIR, load_octopus_config, save_json, workbench_config
from runtime_task_record import normalize_task_record
try:
    from worker_taxonomy import role_display
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.worker_taxonomy import role_display


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bridge_config() -> dict[str, Any]:
    cfg = load_octopus_config()
    section = cfg.get("clawteam_bridge", {})
    return section if isinstance(section, dict) else {}


def bridge_enabled() -> bool:
    return bool(bridge_config().get("enabled", False))


def bridge_backend() -> str:
    backend = str(bridge_config().get("backend", "mirror") or "mirror").strip().lower()
    return backend if backend in ("mirror", "hybrid", "cli") else "mirror"


def bridge_root() -> str:
    return str(bridge_config().get("root_dir") or CLAWTEAM_BRIDGE_DIR)


def bridge_paths() -> dict[str, str]:
    root = bridge_root()
    return {
        "root": root,
        "tasks": os.path.join(root, "tasks"),
        "inbox": os.path.join(root, "inbox"),
        "events": os.path.join(root, "events"),
        "board": os.path.join(root, "board.json"),
        "mapping": os.path.join(root, "task-map.json"),
        "clawteam_data": os.path.join(root, "clawteam-data"),
    }


def ensure_bridge_dirs() -> dict[str, str]:
    paths = bridge_paths()
    for key in ("root", "tasks", "inbox", "events"):
        os.makedirs(paths[key], exist_ok=True)
    return paths


def _preferred_title(task: dict[str, Any]) -> str:
    for field in ("task_description", "summary", "id"):
        value = str(task.get(field, "") or "").strip()
        if value:
            return value[:120]
    return "untitled-task"


def _owner(task: dict[str, Any]) -> str:
    explicit = str(task.get("owner", "") or "").strip()
    if explicit:
        return explicit
    return str(task.get("worker_pool", "") or task.get("executor", "") or "unknown")


def _team_name() -> str:
    return str(bridge_config().get("team_name", "octoclaw-validation") or "octoclaw-validation")


def _inbox_owner() -> str:
    return str(bridge_config().get("inbox_owner", "main") or "main")


def _emit_result_mail() -> bool:
    return bool(bridge_config().get("emit_result_mail", True))


def _clawteam_bin() -> str:
    return str(bridge_config().get("clawteam_bin", "clawteam") or "clawteam")


def _clawteam_data_dir(paths: dict[str, str]) -> str:
    configured = str(bridge_config().get("clawteam_data_dir", "") or "").strip()
    return configured or paths["clawteam_data"]


def _team_description() -> str:
    return str(bridge_config().get("team_description", "OctoClaw validation bridge team") or "OctoClaw validation bridge team")


def _leader_name() -> str:
    return str(bridge_config().get("leader_name", "main") or "main")


def _commands() -> dict[str, str]:
    cfg = bridge_config().get("commands", {})
    if not isinstance(cfg, dict):
        return {}
    return {str(k): str(v or "") for k, v in cfg.items()}


def _cli_capable() -> bool:
    return bridge_backend() in ("hybrid", "cli")


def _clawteam_available() -> bool:
    return shutil.which(_clawteam_bin()) is not None


def _clawteam_base_cmd(paths: dict[str, str]) -> list[str]:
    return [_clawteam_bin(), "--json", "--data-dir", _clawteam_data_dir(paths)]


def _mirror_capable() -> bool:
    return bridge_backend() in ("mirror", "hybrid", "cli")


def _task_record(task: dict[str, Any]) -> dict[str, Any]:
    base = normalize_task_record(task)
    return {
        **base,
        "team": _team_name(),
        "title": _preferred_title(base),
        "owner": _owner(base),
        "updated_at": str(base.get("updated_at", "") or now_iso()),
    }


def _template_vars(record: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, str]:
    payload = {
        "clawteam_bin": _clawteam_bin(),
        "team": _team_name(),
        "team_description": _team_description(),
        "leader": _leader_name(),
        "recipient": _inbox_owner(),
        "message": "",
        "event_type": "",
    }
    payload.update({key: "" if value is None else str(value) for key, value in record.items()})
    if extra:
        payload.update({key: "" if value is None else str(value) for key, value in extra.items()})
    quoted = dict(payload)
    for key, value in payload.items():
        quoted[f"{key}_q"] = shlex.quote(value)
    return quoted


def _run_cli_template(template: str, record: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    command = (template or "").strip()
    if not command:
        return {"ran": False, "ok": True, "reason": "empty-template"}
    try:
        rendered = command.format_map(_template_vars(record, extra))
    except KeyError as exc:
        return {"ran": False, "ok": False, "reason": f"missing-template-key:{exc}"}

    result = subprocess.run(
        ["/bin/sh", "-lc", rendered],
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "ran": True,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "command": rendered,
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
    }


def _cli_state_path(paths: dict[str, str]) -> str:
    return os.path.join(paths["root"], "cli-state.json")


def _load_cli_state(paths: dict[str, str]) -> dict[str, Any]:
    try:
        with open(_cli_state_path(paths), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cli_state(paths: dict[str, str], state: dict[str, Any]) -> None:
    save_json(_cli_state_path(paths), state)


def _load_task_mapping(paths: dict[str, str]) -> dict[str, str]:
    try:
        with open(paths["mapping"], "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items() if str(k) and str(v)}
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _save_task_mapping(paths: dict[str, str], mapping: dict[str, str]) -> None:
    save_json(paths["mapping"], mapping)


def _ensure_cli_team(paths: dict[str, str], record: dict[str, Any]) -> dict[str, Any]:
    state = _load_cli_state(paths)
    if state.get("team_initialized"):
        return {"ran": False, "ok": True, "reason": "already-initialized"}
    if not bridge_config().get("auto_create_team", False):
        return {"ran": False, "ok": True, "reason": "auto-create-disabled"}

    result = subprocess.run(
        _clawteam_base_cmd(paths)
        + [
            "team",
            "spawn-team",
            _team_name(),
            "-d",
            _team_description(),
            "-n",
            _leader_name(),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = {
        "ran": True,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "command": "team spawn-team",
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
    }
    if payload.get("ok"):
        state["team_initialized"] = True
        state["initialized_at"] = now_iso()
        _save_cli_state(paths, state)
    return payload


def _map_status(record: dict[str, Any]) -> str:
    status = str(record.get("status", "") or "").strip().lower()
    if status in ("running", "in_progress"):
        return "in_progress"
    if status in ("done", "completed"):
        return "completed"
    if status in ("queued", "dispatched", "pending"):
        if any(str(dep).strip() for dep in (record.get("deps", []) or [])):
            return "blocked"
        return "pending"
    if status in ("pending_confirm", "blocked"):
        return "blocked"
    if status == "failed":
        return "completed"
    return "pending"


def _mapped_description(record: dict[str, Any]) -> str:
    description = str(record.get("task_description", "") or record.get("summary", "") or "").strip()
    if str(record.get("status", "") or "").strip().lower() == "failed":
        failure_note = f"[octoclaw failed] {record.get('summary', '')}".strip()
        if failure_note and failure_note not in description:
            description = f"{description}\n\n{failure_note}".strip()
    return description


def _parse_json(stdout: str) -> dict[str, Any]:
    text = (stdout or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _ensure_cli_task(paths: dict[str, str], record: dict[str, Any]) -> dict[str, Any]:
    mapping = _load_task_mapping(paths)
    octo_task_id = str(record.get("id", "") or "")
    existing = mapping.get(octo_task_id, "")
    if existing:
        return {"ran": False, "ok": True, "reason": "mapped", "task_id": existing}

    subject = str(record.get("title", "") or octo_task_id)
    cmd = _clawteam_base_cmd(paths) + [
        "task",
        "create",
        _team_name(),
        subject,
    ]
    description = _mapped_description(record)
    owner = str(record.get("owner", "") or "")
    resolved_deps: list[str] = []
    for dep in (record.get("deps", []) or []):
        dep_id = str(dep).strip()
        if not dep_id:
            continue
        resolved = str(mapping.get(dep_id, dep_id) or "").strip()
        if resolved:
            resolved_deps.append(resolved)
    deps = ",".join(resolved_deps)
    if description:
        cmd += ["-d", description]
    if owner:
        cmd += ["-o", owner]
    if deps:
        cmd += ["--blocked-by", deps]

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    payload = {
        "ran": True,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "command": "task create",
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
    }
    if payload.get("ok"):
        created = _parse_json(result.stdout)
        clawteam_task_id = str(created.get("id", "") or "")
        if clawteam_task_id:
            mapping[octo_task_id] = clawteam_task_id
            _save_task_mapping(paths, mapping)
            payload["task_id"] = clawteam_task_id
    return payload


def _sync_cli_task(paths: dict[str, str], record: dict[str, Any]) -> dict[str, Any]:
    created = _ensure_cli_task(paths, record)
    if not created.get("ok"):
        return {"create": created, "update": {"ran": False, "ok": False, "reason": "create-failed"}}

    mapping = _load_task_mapping(paths)
    clawteam_task_id = mapping.get(str(record.get("id", "") or ""), "") or str(created.get("task_id", "") or "")
    if not clawteam_task_id:
        return {"create": created, "update": {"ran": False, "ok": False, "reason": "missing-task-id"}}

    cmd = _clawteam_base_cmd(paths) + [
        "task",
        "update",
        _team_name(),
        clawteam_task_id,
        "-s",
        _map_status(record),
    ]
    owner = str(record.get("owner", "") or "")
    subject = str(record.get("title", "") or "")
    description = _mapped_description(record)
    if owner:
        cmd += ["-o", owner]
    if subject:
        cmd += ["--subject", subject]
    if description:
        cmd += ["-d", description]

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    update = {
        "ran": True,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "command": "task update",
        "task_id": clawteam_task_id,
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
    }
    return {"create": created, "update": update}


def _send_cli_inbox(paths: dict[str, str], record: dict[str, Any], content: str) -> dict[str, Any]:
    cmd = _clawteam_base_cmd(paths) + [
        "inbox",
        "send",
        _team_name(),
        _inbox_owner(),
        content,
        "--from",
        str(record.get("owner", "") or "octoclaw"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {
        "ran": True,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "command": "inbox send",
        "stdout": (result.stdout or "").strip(),
        "stderr": (result.stderr or "").strip(),
    }


def _append_jsonl(path: str, payload: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _task_brief(record: dict[str, Any]) -> dict[str, Any]:
    artifacts = record.get("artifacts", {}) if isinstance(record.get("artifacts", {}), dict) else {}
    operator_surface = artifacts.get("operator_surface", {}) if isinstance(artifacts.get("operator_surface", {}), dict) else {}
    display = role_display(record)
    explicit_owner = str(record.get("owner", "") or "").strip()
    worker_pool = str(record.get("worker_pool", "") or "").strip()
    executor = str(record.get("executor", "") or "").strip()
    display_owner = str(display.get("name", "") or "").strip()
    if explicit_owner and explicit_owner not in {worker_pool, executor}:
        brief_owner = explicit_owner
    else:
        brief_owner = display_owner or explicit_owner or worker_pool or executor or "unknown"
    return {
        "id": str(record.get("id", "") or ""),
        "title": str(record.get("title", "") or ""),
        "status": str(record.get("status", "") or ""),
        "route": str(record.get("route", "") or ""),
        "runtime": str(record.get("runtime", "") or ""),
        "executor_type": str(record.get("executor_type", "") or ""),
        "task_kind": str(record.get("task_kind", "") or ""),
        "worker_pool": str(record.get("worker_pool", "") or ""),
        "phase": str(record.get("phase", "") or ""),
        "owner": brief_owner,
        "worker_pool_display": str(display.get("name", "") or ""),
        "parent_id": str(record.get("parent_id", "") or ""),
        "report_path": str(record.get("report_path", "") or ""),
        "operator_hint": str(artifacts.get("operator_hint", "") or operator_surface.get("operator_hint", "") or ""),
        "updated_at": str(record.get("updated_at", "") or ""),
    }


def _workbench_summary() -> dict[str, Any]:
    cfg = load_octopus_config()
    workbench = workbench_config(cfg)
    mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
    session_name = str(workbench.get("tmux_session_name", "") or "").strip()
    runner_window = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    patrol_window = str(workbench.get("tmux_patrol_window_name", "patrol") or "patrol").strip() or "patrol"
    payload = {
        "supervisor_mode": mode,
        "tmux_session_name": session_name,
        "runner_window_name": runner_window,
        "patrol_window_name": patrol_window,
    }
    payload["attach_hint"] = f"tmux attach -t {session_name}" if mode == "tmux" and session_name else ""
    return payload


def _build_lineages(tasks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tasks_by_id: dict[str, dict[str, Any]] = {}
    children_by_parent: dict[str, list[dict[str, Any]]] = {}

    for task in tasks:
        task_id = str(task.get("id", "") or "").strip()
        if task_id:
            tasks_by_id[task_id] = task
        parent_id = str(task.get("parent_id", "") or "").strip()
        if parent_id:
            children_by_parent.setdefault(parent_id, []).append(task)

    lineages: list[dict[str, Any]] = []
    for task in tasks:
        task_id = str(task.get("id", "") or "").strip()
        if not task_id:
            continue
        explicit_child_ids = [str(item).strip() for item in (task.get("child_ids", []) or []) if str(item).strip()]
        children: list[dict[str, Any]] = []
        seen_child_ids: set[str] = set()

        for child_id in explicit_child_ids:
            child = tasks_by_id.get(child_id)
            if child is None:
                continue
            children.append(child)
            seen_child_ids.add(child_id)

        for child in children_by_parent.get(task_id, []):
            child_id = str(child.get("id", "") or "").strip()
            if child_id and child_id not in seen_child_ids:
                children.append(child)
                seen_child_ids.add(child_id)

        task_kind = str(task.get("task_kind", "") or "")
        if not children and task_kind != "team_parent" and not explicit_child_ids:
            continue

        status_counts: dict[str, int] = {}
        open_task_count = 0
        for child in children:
            status = str(child.get("status", "") or "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1
            if status not in {"done", "failed", "deferred", "completed"}:
                open_task_count += 1

        lineages.append(
            {
                "parent": _task_brief(task),
                "child_ids": explicit_child_ids or [str(child.get("id", "") or "") for child in children if str(child.get("id", "") or "")],
                "child_count": len(children),
                "open_task_count": open_task_count,
                "status_counts": status_counts,
                "children": [_task_brief(child) for child in children],
            }
        )

    orphan_children: list[dict[str, Any]] = []
    for parent_id, children in children_by_parent.items():
        if parent_id in tasks_by_id:
            continue
        orphan_children.extend(_task_brief(child) for child in children)

    lineages.sort(
        key=lambda item: str(
            item.get("parent", {}).get("updated_at", "")
            or tasks_by_id.get(str(item.get("parent", {}).get("id", "") or ""), {}).get("updated_at", "")
            or tasks_by_id.get(str(item.get("parent", {}).get("id", "") or ""), {}).get("spawned_at", "")
        ),
        reverse=True,
    )
    return lineages, orphan_children


def _refresh_board(tasks_dir: str, board_path: str) -> None:
    tasks: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    task_kind_counts: dict[str, int] = {}
    try:
        for name in sorted(os.listdir(tasks_dir)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(tasks_dir, name)
            with open(path, "r", encoding="utf-8") as f:
                item = json.load(f)
            if isinstance(item, dict):
                tasks.append(item)
                status = str(item.get("status", "") or "unknown")
                counts[status] = counts.get(status, 0) + 1
                task_kind = str(item.get("task_kind", "") or "unspecified")
                task_kind_counts[task_kind] = task_kind_counts.get(task_kind, 0) + 1
    except OSError:
        return

    lineages, orphan_children = _build_lineages(tasks)
    board = {
        "team": _team_name(),
        "updated_at": now_iso(),
        "counts": counts,
        "task_kind_counts": task_kind_counts,
        "workbench": _workbench_summary(),
        "lineages": lineages[:20],
        "orphan_children": orphan_children[:20],
        "tasks": tasks[-40:],
    }
    save_json(board_path, board)


def sync_task(task: dict[str, Any], *, event_type: str, previous_status: str = "") -> None:
    if not bridge_enabled():
        return
    if not isinstance(task, dict):
        return
    task_id = str(task.get("id", "") or "")
    if not task_id:
        return

    paths = ensure_bridge_dirs()
    record = _task_record(task)
    if _mirror_capable():
        save_json(os.path.join(paths["tasks"], f"{task_id}.json"), record)

    event = {
        "id": f"{task_id}:{event_type}:{int(datetime.now(timezone.utc).timestamp())}",
        "team": _team_name(),
        "task_id": task_id,
        "event_type": event_type,
        "status": record.get("status", ""),
        "previous_status": previous_status,
        "owner": record.get("owner", ""),
        "summary": record.get("summary", ""),
        "report_path": record.get("report_path", ""),
        "created_at": now_iso(),
    }
    _append_jsonl(os.path.join(paths["events"], f"{datetime.now(timezone.utc).strftime('%Y%m%d')}.jsonl"), event)

    cli_sync = {"backend": bridge_backend(), "available": _clawteam_available(), "team_init": {}, "task_sync": {}, "inbox_send": {}}
    if _cli_capable() and _clawteam_available():
        cli_sync["team_init"] = _ensure_cli_team(paths, record)
        if cli_sync["team_init"].get("ok"):
            cli_sync["task_sync"] = _sync_cli_task(paths, record)
        else:
            cli_sync["task_sync"] = {"create": {"ran": False, "ok": False, "reason": "team-init-failed"}, "update": {"ran": False, "ok": False, "reason": "team-init-failed"}}

    status = str(record.get("status", "") or "")
    if _emit_result_mail() and status in ("done", "failed"):
        inbox_message = {
            "id": event["id"],
            "team": _team_name(),
            "to": _inbox_owner(),
            "kind": "task_result",
            "task_id": task_id,
            "status": status,
            "title": record.get("title", ""),
            "summary": record.get("summary", ""),
            "worker_pool": record.get("worker_pool", ""),
            "work_type": record.get("work_type", ""),
            "phase": record.get("phase", ""),
            "protocol": record.get("protocol", ""),
            "report_path": record.get("report_path", ""),
            "artifacts": record.get("artifacts", {}),
            "files_changed": record.get("files_changed", []),
            "created_at": now_iso(),
        }
        if _mirror_capable():
            _append_jsonl(os.path.join(paths["inbox"], f"{_inbox_owner()}.jsonl"), inbox_message)
        if _cli_capable() and _clawteam_available():
            cli_sync["inbox_send"] = _send_cli_inbox(
                paths,
                record,
                f"{record.get('title', task_id)} | {status} | {record.get('summary', '')} | report={record.get('report_path', '')}",
            )

    save_json(os.path.join(paths["root"], "last-cli-sync.json"), cli_sync)
    if _mirror_capable():
        _refresh_board(paths["tasks"], paths["board"])


def load_bridge_summary() -> dict[str, Any]:
    if not bridge_enabled():
        return {"enabled": False}
    paths = ensure_bridge_dirs()
    board = {}
    try:
        with open(paths["board"], "r", encoding="utf-8") as f:
            board = json.load(f)
    except (OSError, json.JSONDecodeError):
        board = {}

    inbox_count = 0
    inbox_path = os.path.join(paths["inbox"], f"{_inbox_owner()}.jsonl")
    try:
        with open(inbox_path, "r", encoding="utf-8") as f:
            inbox_count = sum(1 for _ in f)
    except OSError:
        inbox_count = 0

    counts = board.get("counts", {}) if isinstance(board, dict) else {}
    lineages = board.get("lineages", []) if isinstance(board, dict) else []
    task_kind_counts = board.get("task_kind_counts", {}) if isinstance(board, dict) else {}
    workbench = board.get("workbench", {}) if isinstance(board, dict) else {}
    cli_state = _load_cli_state(paths)
    last_cli_sync = {}
    try:
        with open(os.path.join(paths["root"], "last-cli-sync.json"), "r", encoding="utf-8") as f:
            last_cli_sync = json.load(f)
    except (OSError, json.JSONDecodeError):
        last_cli_sync = {}
    return {
        "enabled": True,
        "backend": bridge_backend(),
        "team": _team_name(),
        "root": paths["root"],
        "counts": counts if isinstance(counts, dict) else {},
        "task_kind_counts": task_kind_counts if isinstance(task_kind_counts, dict) else {},
        "workbench": workbench if isinstance(workbench, dict) else {},
        "inbox_count": inbox_count,
        "lineage_count": len(lineages) if isinstance(lineages, list) else 0,
        "active_lineage_count": (
            sum(1 for lineage in lineages if isinstance(lineage, dict) and int(lineage.get("open_task_count", 0) or 0) > 0)
            if isinstance(lineages, list)
            else 0
        ),
        "updated_at": str(board.get("updated_at", "") or ""),
        "cli_available": _clawteam_available(),
        "team_initialized": bool(cli_state.get("team_initialized", False)),
        "last_cli_sync": last_cli_sync if isinstance(last_cli_sync, dict) else {},
    }
