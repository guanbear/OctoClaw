#!/usr/bin/env python3
"""Validated subagent spawn wrapper for OctoClaw.

This module captures the strongest parts of the older OctoClaw workflow:
- register task-state before spawn
- keep long output in shared files
- enforce RESULT contract
- validate runtime compatibility before the main agent calls sessions_spawn
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache

from learning_log import append_error_entry
from context_pack import build_context_pack
from openclaw_taskflow_adapter import create_managed_taskflow_binding
from octoclaw_route import infer_route
from octopus_config import (
    CONTEXT_DIR,
    SHARED_DIR,
    TASK_STATE_FILE,
    WORKSPACE,
    load_json,
    load_octopus_config,
    spawn_operator_surface,
)
from runtime_protocol import build_result_contract, build_task_brief, normalize_result_status
from worker_taxonomy import (
    infer_model_band as taxonomy_infer_model_band,
    infer_worker_pool as taxonomy_infer_worker_pool,
    resolve_phase as taxonomy_resolve_phase,
    resolve_work_type as taxonomy_resolve_work_type,
    selector_band_for_model_band,
)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")

DEFAULT_RUNTIME = "subagent"
DEFAULT_MODEL_BAND_MINUTES = {
    "fast": 3,
    "normal": 8,
    "strong": 15,
    "heavy": 20,
}

DEFAULT_MODEL_BAND_BY_WORKER_POOL = {
    "octoclaw-runner": "fast",
    "octoclaw-research": "normal",
    "octoclaw-code": "strong",
    "octoclaw-review": "strong",
    "octoclaw-main": "normal",
}
MAX_INLINE_SPAWN_PROMPT_CHARS = 1800

STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "then", "into", "will",
    "帮我", "一下", "然后", "最后", "当前", "机器", "本机", "进行", "处理", "检查", "分析",
    "给我", "一个", "并且", "需要", "继续", "相关", "可以", "如果", "不要", "还是", "那个",
}


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


def infer_model_band_from_taxonomy(
    *,
    route: str,
    worker_pool: str,
    work_type: str,
    phase: str,
    protocol: str,
) -> str:
    current_route = str(route or "").strip()
    current_worker_pool = str(worker_pool or "").strip()
    current_work_type = str(work_type or "").strip()
    current_phase = str(phase or "").strip()
    current_protocol = str(protocol or "").strip()

    inferred = taxonomy_infer_model_band(
        route=current_route,
        worker_pool=current_worker_pool,
        work_type=current_work_type,
        protocol=current_protocol,
    )
    if inferred:
        return inferred
    if current_route == "runner" or current_worker_pool == "octoclaw-runner":
        return "fast"
    if current_route == "spawn_multi":
        return "heavy"
    if current_protocol == "heavy":
        return "heavy"
    if current_worker_pool in DEFAULT_MODEL_BAND_BY_WORKER_POOL:
        return DEFAULT_MODEL_BAND_BY_WORKER_POOL[current_worker_pool]
    if current_work_type == "review" or current_phase == "verify":
        return "strong"
    return "normal"


def worker_pool_slug(worker_pool: str) -> str:
    text = str(worker_pool or "").strip()
    if not text:
        return "task"
    return text.replace("octoclaw-", "")


def expected_done_offset(model_band: str) -> str:
    minutes = DEFAULT_MODEL_BAND_MINUTES.get(model_band or "normal", 8)
    return f"+{minutes}min"


@lru_cache(maxsize=8)
def clawteam_spawn_help_text(clawteam_bin: str) -> str:
    result = subprocess.run(
        [clawteam_bin, "spawn", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


def clawteam_spawn_supports_option(option: str, *, clawteam_bin: str) -> bool:
    return option in clawteam_spawn_help_text(clawteam_bin)


@lru_cache(maxsize=8)
def openclaw_agent_help_text(openclaw_bin: str) -> str:
    result = subprocess.run(
        [openclaw_bin, "agent", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


def openclaw_agent_supports_option(option: str, *, openclaw_bin: str) -> bool:
    return option in openclaw_agent_help_text(openclaw_bin)


def resolve_model_and_thinking(
    selector_band: str,
    description: str,
    *,
    worker_pool: str = "",
    phase: str = "",
    route: str = "",
    profile: str = "",
) -> tuple[str, str]:
    cmd = ["python3", RESOLVE_MODEL_PY, "--selector-band", selector_band, "--description", description]
    if worker_pool:
        cmd.extend(["--worker-pool", worker_pool])
    if phase:
        cmd.extend(["--phase", phase])
    if route:
        cmd.extend(["--route", route])
    if profile:
        cmd.extend(["--profile", profile])
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return "", ""
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        return "", ""
    model = lines[0]
    thinking = ""
    for line in lines[1:]:
        if line.startswith("thinking="):
            thinking = line.split("=", 1)[1].strip()
            break
    return model, thinking


def policy_request(policy: dict) -> dict:
    value = policy.get("request", {})
    return value if isinstance(value, dict) else {}


def policy_metadata(policy: dict) -> dict:
    request = policy_request(policy)
    value = request.get("metadata", {})
    return value if isinstance(value, dict) else {}


def task_title(task: str, limit: int = 72) -> str:
    text = re.sub(r"\s+", " ", (task or "").strip())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def compact_text(text: str, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def inject_spawn_runtime_hints(prompt: str, *, profile: str, thinking: str, supports_profile: bool, supports_thinking: bool) -> str:
    hints: list[str] = []
    if profile and not supports_profile:
        hints.append(f"- preferred_profile: {profile}")
    if thinking and not supports_thinking:
        hints.append(f"- reasoning_effort: {thinking}")
    if not hints:
        return prompt
    block = ["【RUNTIME HINT】", *hints, ""]
    return "\n".join(block) + prompt


def prefers_longform_result(worker_pool: str, phase: str, route: str) -> bool:
    return worker_pool == "octoclaw-research" or phase == "report" or route == "spawn_multi"


def result_summary_contract(worker_pool: str, phase: str, route: str) -> str:
    if prefers_longform_result(worker_pool, phase, route):
        return "4-8句可直接转述给用户的中文结论；前2句先给总判断，后续补关键差异/建议；允许轻量编号；禁表格/代码块"
    return "2-5句结论，每句≤30字，禁列表/表格/代码块"


def tokenize(text: str) -> set[str]:
    lowered = (text or "").lower()
    chinese = re.findall(r"[\u4e00-\u9fff]{2,}", lowered)
    english = re.findall(r"[a-z0-9][a-z0-9_.:-]{1,}", lowered)
    return {
        token for token in chinese + english
        if token not in STOPWORDS and len(token) >= 2
    }


def score_related_task(task_tokens: set[str], candidate: dict, parent_id: str) -> float:
    if not isinstance(candidate, dict):
        return 0.0
    candidate_id = str(candidate.get("id", "") or "")
    if parent_id and candidate_id == parent_id:
        return 100.0
    haystack = " ".join(
        str(candidate.get(field, "") or "")
        for field in ("task_description", "summary", "worker_pool", "work_type", "phase", "route")
    )
    candidate_tokens = tokenize(haystack)
    overlap = len(task_tokens & candidate_tokens)
    score = float(overlap)
    if candidate.get("status") == "done":
        score += 0.5
    if candidate.get("report_path"):
        score += 0.5
    return score


def load_recent_related_tasks(task: str, parent_id: str, limit: int = 3) -> list[dict]:
    state = load_json(TASK_STATE_FILE)
    if not isinstance(state, dict):
        return []
    tasks = state.get("tasks", [])
    if not isinstance(tasks, list):
        return []
    task_tokens = tokenize(task)
    scored: list[tuple[float, dict]] = []
    for candidate in tasks:
        score = score_related_task(task_tokens, candidate, parent_id)
        if score <= 0:
            continue
        scored.append((score, candidate))
    scored.sort(
        key=lambda item: (
            item[0],
            str(item[1].get("updated_at", "") or item[1].get("completed_at", "") or item[1].get("spawned_at", "")),
        ),
        reverse=True,
    )
    return [item[1] for item in scored[:limit]]


def build_context_bundle(task: str, parent_id: str, task_id: str) -> dict:
    related_tasks = load_recent_related_tasks(task, parent_id)
    return build_context_pack(
        task_id=task_id,
        requested_task=task,
        related_tasks=related_tasks,
        context_dir=CONTEXT_DIR,
    )


def prompt_file_path(task_id: str) -> str:
    return os.path.join(CONTEXT_DIR, f"{task_id}.spawn-prompt.md")


def persist_prompt_file(path: str, prompt: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(prompt)


def build_bootstrap_prompt(*, prompt_path: str, report_path: str, context_path: str) -> str:
    lines = [
        "OctoClaw bootstrap task.",
        f"1. First read the full task contract from: {prompt_path}",
        "2. Follow that file exactly before doing any other work.",
        "3. Do not ask for more context until you have read the file.",
    ]
    if context_path:
        lines.append(f"4. If you need background, read context from: {context_path}")
    if report_path:
        lines.append(f"5. Persist detailed output to: {report_path}")
    lines.append("Return RESULT only after following the prompt file contract.")
    return "\n".join(lines)


def prepare_spawn_prompt(
    *,
    task_id: str,
    prompt: str,
    report_path: str,
    context_path: str,
    backend: str = "",
) -> tuple[str, str]:
    if str(backend or "").strip().lower() == "native":
        return prompt, ""
    if len(prompt) <= MAX_INLINE_SPAWN_PROMPT_CHARS:
        return prompt, ""
    external_path = prompt_file_path(task_id)
    persist_prompt_file(external_path, prompt)
    return build_bootstrap_prompt(
        prompt_path=external_path,
        report_path=report_path,
        context_path=context_path,
    ), external_path


def _native_contract_brief_payload(brief: dict | None) -> dict:
    payload = json.loads(json.dumps(brief if isinstance(brief, dict) else {}, ensure_ascii=False))

    def _scrub(value):
        if isinstance(value, dict):
            cleaned = {}
            for key, item in value.items():
                if key in {"report_path", "context_path", "context_pack_path"}:
                    cleaned[key] = ""
                else:
                    cleaned[key] = _scrub(item)
            return cleaned
        if isinstance(value, list):
            cleaned_items = [_scrub(item) for item in value]
            return [item for item in cleaned_items if item not in ("", [], {})]
        if isinstance(value, str):
            text = value.replace(TASK_STATE_PY, "").strip()
            text = re.sub(r"/(?:Users|root)/[^\s'\"`]+", "", text).strip()
            if text.startswith("/Users/") or text.startswith("/root/"):
                return ""
            return text
        return value

    return _scrub(payload) if payload else {}


def _native_result_contract_payload(result_contract: dict | None) -> dict:
    payload = dict(result_contract) if isinstance(result_contract, dict) else {}
    payload["artifacts"] = []
    payload["report"] = "可选详细 Markdown；没有则写空字符串"
    payload["files"] = []
    payload["verification"] = payload.get("verification") if isinstance(payload.get("verification"), list) else []
    payload["risks"] = payload.get("risks") if isinstance(payload.get("risks"), list) else []
    payload["next_step"] = str(payload.get("next_step") or "none")
    return payload


def build_native_task_prompt(
    *,
    task_id: str,
    task: str,
    brief: dict | None,
    result_contract: dict | None,
) -> str:
    brief_payload = _native_contract_brief_payload(brief)
    result_payload = _native_result_contract_payload(result_contract)
    lines = [
        "【TASK BRIEF / 必读输入】",
        "```json",
        json.dumps(brief_payload, ensure_ascii=False, indent=2),
        "```",
        "",
        "【Native 执行约束】",
        "- 只使用当前会话实际可访问的文件和环境，不要依赖 /Users/... 或其他宿主机绝对路径",
        "- 不要尝试调用本地 task-state-update.py，也不要尝试写宿主机 report 文件",
        "- 如果当前 workspace 里缺少某个路径，不要卡住；基于 TASK BRIEF 继续，必要时在 RESULT 里写 blocked",
        "- 最终只输出一个 ---RESULT--- 块，里面放合法 JSON；不要附加额外解释",
        "",
        "【原始任务】",
        task.strip(),
        "",
        "【RESULT 规范】",
        "---RESULT---",
        json.dumps(result_payload, ensure_ascii=False),
        "",
        f"task_id={task_id}",
    ]
    return "\n".join(lines).strip()


def _strip_result_code_fence(text: str) -> str:
    body = str(text or "").strip()
    if body.startswith("```json"):
        body = body[len("```json"):].strip()
    elif body.startswith("```"):
        body = body[len("```"):].strip()
    if body.endswith("```"):
        body = body[:-3].strip()
    return body


def _parse_result_json_fragment(text: str) -> dict | None:
    body = _strip_result_code_fence(text)
    start = body.find("{")
    if start < 0:
        return None
    decoder = json.JSONDecoder()
    try:
        payload, _ = decoder.raw_decode(body[start:])
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _parse_result_kv_block(text: str) -> dict | None:
    body = _strip_result_code_fence(text)
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if not lines:
        return None
    payload: dict[str, str] = {}
    for line in lines:
        if line.startswith("---END---"):
            break
        if ":" in line:
            key, value = line.split(":", 1)
        elif "：" in line:
            key, value = line.split("：", 1)
        else:
            continue
        payload[key.strip().lower()] = value.strip()
    if not payload:
        return None
    return {
        "status": payload.get("状态") or payload.get("status") or "",
        "summary": payload.get("摘要") or payload.get("summary") or "",
        "user_safe_summary": payload.get("用户摘要") or payload.get("user_safe_summary") or "",
        "report": payload.get("报告") or payload.get("report") or "",
        "artifacts": [],
        "files": [],
        "risks": [],
        "verification": [],
        "next_step": payload.get("下一步") or payload.get("next_step") or "",
    }


def _extract_native_result_payload(text: str) -> dict | None:
    body = str(text or "")
    candidate = body.split("---RESULT---", 1)[1] if "---RESULT---" in body else body
    parsed = _parse_result_json_fragment(candidate)
    if parsed:
        return parsed
    return _parse_result_kv_block(candidate)


def _load_native_stdout_payload(stdout_path: str) -> dict:
    text = ""
    try:
        with open(stdout_path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read().strip()
    except Exception:
        return {}
    if not text:
        return {}
    try:
        payload = json.loads(text)
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        pass
    last_payload: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            last_payload = payload
    return last_payload


def _native_payload_texts(payload: dict) -> list[str]:
    texts: list[str] = []
    if not isinstance(payload, dict):
        return texts
    for key in ("text", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            texts.append(value.strip())
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    for item in result.get("payloads", []) if isinstance(result.get("payloads", []), list) else []:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return texts


def _read_log_tail(path: str, limit: int = 400) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()
    except Exception:
        return ""
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def _write_native_report(report_path: str, report_text: str) -> str:
    path = str(report_path or "").strip()
    body = str(report_text or "").strip()
    if not path or not body:
        return ""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body if body.endswith("\n") else body + "\n")
    return path


def finalize_native_spawn_result(
    *,
    task_id: str,
    stdout_path: str,
    stderr_path: str,
    report_path: str,
    exit_code: int,
) -> dict:
    stderr_tail = _read_log_tail(stderr_path, limit=240)
    stdout_payload = _load_native_stdout_payload(stdout_path)
    texts = _native_payload_texts(stdout_payload)
    result_payload: dict | None = None
    reply_preview = ""
    for text in reversed(texts):
        reply_preview = compact_text(text, 180)
        parsed = _extract_native_result_payload(text)
        if isinstance(parsed, dict):
            result_payload = parsed
            break

    if int(exit_code) != 0:
        summary = compact_text(stderr_tail or reply_preview or f"spawn启动失败：native openclaw agent exited non-zero for {task_id}", 180)
        subprocess.run(
            ["python3", TASK_STATE_PY, "failed", "--id", task_id, "--summary", summary],
            check=False,
            capture_output=True,
            text=True,
        )
        return {"status": "failed", "summary": summary}

    if not result_payload:
        summary = compact_text(reply_preview or stderr_tail or "native openclaw agent 未返回结构化 RESULT", 180)
        subprocess.run(
            ["python3", TASK_STATE_PY, "failed", "--id", task_id, "--summary", summary],
            check=False,
            capture_output=True,
            text=True,
        )
        return {"status": "failed", "summary": summary}

    status = normalize_result_status(str(result_payload.get("status", "") or ""), default="failed")
    summary = compact_text(
        str(result_payload.get("summary", "") or result_payload.get("user_safe_summary", "") or reply_preview or "native spawn completed").strip(),
        180,
    )
    user_safe_summary = str(result_payload.get("user_safe_summary", "") or "").strip()
    blocked_reason = compact_text(
        str(result_payload.get("next_step", "") or result_payload.get("report", "") or result_payload.get("summary", "") or "").strip(),
        180,
    ) if status == "blocked" else ""
    report_written = _write_native_report(report_path, str(result_payload.get("report", "") or ""))
    artifacts_json = {
        "worker_result": {
            "task_id": task_id,
            "status": status,
            "summary": summary,
            "user_safe_summary": user_safe_summary,
            "report": report_written,
            "artifacts": result_payload.get("artifacts", []) if isinstance(result_payload.get("artifacts"), list) else [],
            "files": result_payload.get("files", []) if isinstance(result_payload.get("files"), list) else [],
            "risks": result_payload.get("risks", []) if isinstance(result_payload.get("risks"), list) else [],
            "verification": result_payload.get("verification", []) if isinstance(result_payload.get("verification"), list) else [],
            "next_step": str(result_payload.get("next_step", "") or "none"),
        }
    }
    command = [
        "python3",
        TASK_STATE_PY,
        "blocked" if status == "blocked" else ("done" if status == "done" else "failed"),
        "--id",
        task_id,
        "--summary",
        summary,
        "--artifacts-json",
        json.dumps(artifacts_json, ensure_ascii=False),
    ]
    if report_written:
        command.extend(["--report-path", report_written])
    if user_safe_summary:
        command.extend(["--user-safe-summary", user_safe_summary])
    if blocked_reason and status == "blocked":
        command.extend(["--blocked-reason", blocked_reason])
    subprocess.run(command, check=False, capture_output=True, text=True)
    return {"status": status, "summary": summary, "report_path": report_written}


def validate_runtime(runtime: str, stream_to: str, supports_acp: bool) -> list[str]:
    problems: list[str] = []
    if runtime == "subagent" and stream_to:
        problems.append("runtime=subagent 时禁止传 streamTo；streamTo 只适用于 runtime=acp")
    if runtime == "acp" and stream_to and not supports_acp:
        problems.append("当前会话未声明支持 ACP 绑定，不要传 runtime=acp + streamTo")
    return problems


def log_spawn_error(task: str, error_text: str, *, runtime: str, stream_to: str, parent_id: str) -> None:
    append_error_entry(
        skill_or_command="octoclaw_spawn",
        summary="OctoClaw spawn 参数不兼容，子任务未真正派发。",
        error_text=error_text,
        context_lines=[
            f"task={compact_text(task, 160)}",
            f"runtime={runtime or '(empty)'}",
            f"stream_to={stream_to or '(empty)'}",
            f"parent_id={parent_id or '(empty)'}",
        ],
        suggested_fix="不要手写 sessions_spawn 参数；统一通过 octoclaw_spawn.py 生成 payload，runtime=subagent 时禁止 streamTo。",
        related_files=[TASK_STATE_PY],
    )


def spawn_execution_config() -> dict:
    cfg = load_octopus_config()
    section = cfg.get("spawn_execution", {})
    return section if isinstance(section, dict) else {}


def clawteam_runtime_config() -> dict:
    cfg = load_octopus_config()
    section = cfg.get("clawteam_bridge", {})
    return section if isinstance(section, dict) else {}


def should_execute_spawn(route: str, runtime: str, explicit: bool | None = None) -> bool:
    if explicit is not None:
        return explicit
    if route != "spawn_single" or runtime != "subagent":
        return False
    cfg = spawn_execution_config()
    backend = str(cfg.get("backend", "plan") or "plan").strip().lower()
    return bool(cfg.get("enabled", False)) and backend in {"clawteam", "native"}


def resolve_spawn_backend() -> str:
    cfg = spawn_execution_config()
    backend = str(cfg.get("backend", "plan") or "plan").strip().lower()
    return backend or "plan"


def resolve_spawn_team_name() -> str:
    spawn_cfg = spawn_execution_config()
    bridge_cfg = clawteam_runtime_config()
    for value in (
        spawn_cfg.get("team_name"),
        bridge_cfg.get("team_name"),
        "octoclaw-validation",
    ):
        text = str(value or "").strip()
        if text:
            return text
    return "octoclaw-validation"


def clawteam_data_dir() -> str:
    bridge_cfg = clawteam_runtime_config()
    configured = str(bridge_cfg.get("clawteam_data_dir", "") or "").strip()
    if configured:
        return configured
    root_dir = str(bridge_cfg.get("root_dir", "") or "").strip()
    if root_dir:
        return os.path.join(root_dir, "clawteam-data")
    return os.path.join(WORKSPACE, "tmp", "octopus", "clawteam-bridge", "clawteam-data")


def resolve_profile(worker_pool: str, model: str, model_band: str) -> str:
    cfg = spawn_execution_config()
    worker_pool_map = cfg.get("profile_by_worker_pool", {})
    if isinstance(worker_pool_map, dict):
        value = str(worker_pool_map.get(worker_pool, "") or "").strip()
        if value:
            return value

    model_map = cfg.get("profile_by_model_prefix", {})
    if isinstance(model_map, dict):
        matches = sorted(
            (
                (prefix, str(profile or "").strip())
                for prefix, profile in model_map.items()
                if str(prefix).strip() and model.startswith(str(prefix).strip()) and str(profile or "").strip()
            ),
            key=lambda item: len(item[0]),
            reverse=True,
        )
        if matches:
            return matches[0][1]

    model_band_map = cfg.get("profile_by_model_band", {})
    if isinstance(model_band_map, dict):
        value = str(model_band_map.get(model_band, "") or "").strip()
        if value:
            return value

    return str(cfg.get("default_profile", "") or "").strip()


def resolve_agent_name(task_id: str) -> str:
    cfg = spawn_execution_config()
    prefix = re.sub(r"[^a-z0-9_-]+", "-", str(cfg.get("agent_name_prefix", "octo") or "octo").lower()).strip("-")
    base = re.sub(r"[^a-z0-9_-]+", "-", task_id.lower()).strip("-")
    name = f"{prefix}-{base}" if prefix else base
    return name[:48].rstrip("-") or f"octo-{now_compact()}"


def resolve_native_session_key(task_id: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", str(task_id or "").strip().lower()).strip("-")
    return f"agent:main:subagent:{slug or now_compact()}"


def resolve_native_session_id(task_id: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", str(task_id or "").strip().lower()).strip("-")
    return f"octoclaw-subagent-{slug or now_compact()}"


def native_spawn_dir() -> str:
    return os.path.join(WORKSPACE, "tmp", "octopus", "native-spawn")


def resolve_python_bin() -> str:
    configured = str(os.environ.get("OCTOCLAW_PYTHON_BIN", "") or "").strip()
    candidates = [
        configured,
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        shutil.which("python3") or "",
        sys.executable,
    ]
    for candidate in candidates:
        text = str(candidate or "").strip()
        if text and os.path.exists(text):
            return text
    return "python3"


def resolve_openclaw_bin(config: dict[str, Any] | None = None) -> str:
    cfg = config if isinstance(config, dict) else spawn_execution_config()
    configured = str(cfg.get("openclaw_bin", "openclaw") or "openclaw").strip() or "openclaw"
    path = os.pathsep.join(
        part
        for part in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            str(os.environ.get("PATH", "") or "").strip(),
        ]
        if part
    )
    candidates = [configured, "openclaw", "/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]
    for candidate in candidates:
        text = str(candidate or "").strip()
        if not text:
            continue
        resolved = shutil.which(text, path=path)
        if resolved:
            return resolved
        if os.path.isabs(text) and os.path.exists(text) and os.access(text, os.X_OK):
            return text
    return configured


def build_native_openclaw_command(
    *,
    task_id: str,
    prompt: str,
    model: str,
    thinking: str,
) -> tuple[list[str], str, str]:
    cfg = spawn_execution_config()
    openclaw_bin = resolve_openclaw_bin(cfg)
    session_key = ""
    session_id = resolve_native_session_id(task_id)
    supports_thinking = openclaw_agent_supports_option("--thinking", openclaw_bin=openclaw_bin)
    command = [
        openclaw_bin,
        "agent",
        "--agent",
        "main",
        "--session-id",
        session_id,
        "--message",
        prompt,
        "--json",
    ]
    if thinking and supports_thinking:
        command.extend(["--thinking", thinking])
    return command, session_key, session_id


def execute_native_openclaw_spawn(
    *,
    task_id: str,
    worker_pool: str,
    model: str,
    model_band: str,
    prompt: str,
    thinking: str,
    profile_override: str = "",
) -> dict:
    command, child_session_key, child_session_id = build_native_openclaw_command(
        task_id=task_id,
        prompt=prompt,
        model=model,
        thinking=thinking,
    )
    openclaw_bin = command[0]
    if shutil.which(openclaw_bin) is None:
        raise RuntimeError(f"未找到 {openclaw_bin} 命令，无法执行 native OpenClaw spawn")

    os.makedirs(native_spawn_dir(), exist_ok=True)
    stdout_path = os.path.join(native_spawn_dir(), f"{task_id}.stdout.log")
    stderr_path = os.path.join(native_spawn_dir(), f"{task_id}.stderr.log")
    wrapper_path = os.path.join(native_spawn_dir(), f"{task_id}.run.sh")
    python_bin = resolve_python_bin()
    fail_summary = compact_text(f"spawn启动失败：native openclaw agent exited non-zero for {task_id}", 180)
    command_str = " ".join(shlex.quote(part) for part in command)
    script = "\n".join(
        [
            "#!/bin/bash",
            "set -uo pipefail",
            f"export WORKSPACE={shlex.quote(WORKSPACE)}",
            f"export OCTOCLAW_ROOT={shlex.quote(SCRIPT_DIR)}",
            f"export OCTOCLAW_PYTHON_BIN={shlex.quote(python_bin)}",
            "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH",
            "export OCTOCLAW_DISABLE_RUNTIME_POLICY=1",
            "export OPENCLAW_NO_RESPAWN=1",
            f"cd {shlex.quote(WORKSPACE)} || exit 1",
            f"{command_str}",
            "rc=$?",
            f"{shlex.quote(python_bin)} {shlex.quote(os.path.abspath(__file__))} native-finalize "
            f"--task-id {shlex.quote(task_id)} "
            f"--stdout-path {shlex.quote(stdout_path)} "
            f"--stderr-path {shlex.quote(stderr_path)} "
            f"--report-path {shlex.quote(os.path.join(SHARED_DIR, f'{task_id}.md'))} "
            f"--exit-code \"$rc\" >/dev/null 2>&1 || true",
            'if [ "$rc" -ne 0 ]; then',
            f"  {shlex.quote(python_bin)} {shlex.quote(TASK_STATE_PY)} failed --id {shlex.quote(task_id)} --summary {shlex.quote(fail_summary)} >/dev/null 2>&1 || true",
            "fi",
            'exit "$rc"',
            "",
        ]
    )
    with open(wrapper_path, "w", encoding="utf-8") as fh:
        fh.write(script)
    os.chmod(wrapper_path, 0o755)

    env = dict(os.environ)
    env["WORKSPACE"] = WORKSPACE
    env["OCTOCLAW_ROOT"] = SCRIPT_DIR
    env["OCTOCLAW_PYTHON_BIN"] = python_bin
    env["OCTOCLAW_DISABLE_RUNTIME_POLICY"] = "1"
    env["OPENCLAW_NO_RESPAWN"] = "1"
    path_parts = ["/opt/homebrew/bin", "/usr/local/bin", env.get("PATH", "")]
    env["PATH"] = ":".join(part for part in path_parts if part)

    with open(stdout_path, "a", encoding="utf-8") as stdout_fh, open(stderr_path, "a", encoding="utf-8") as stderr_fh:
        proc = subprocess.Popen(
            [wrapper_path],
            stdout=stdout_fh,
            stderr=stderr_fh,
            cwd=WORKSPACE,
            env=env,
            start_new_session=True,
            text=True,
        )

    return {
        "backend": "native",
        "backend_name": "openclaw_agent",
        "team_name": "",
        "agent_name": "main",
        "profile": profile_override,
        "thinking": thinking,
        "session_key": child_session_key,
        "child_session_key": child_session_key,
        "session_id": child_session_id,
        "run_id": "",
        "native_task_id": "",
        "native_flow_id": "",
        "model_override_applied": True,
        "model_override_status": 0,
        "model_override_error": "",
        "pid": int(proc.pid),
        "stdout_path": stdout_path,
        "stderr_path": stderr_path,
        "wrapper_path": wrapper_path,
        "command": command,
        "payload": {
            "sessionKey": child_session_key,
            "sessionId": child_session_id,
            "taskId": "",
            "flowId": "",
            "pid": int(proc.pid),
        },
    }


def execute_spawn_backend(
    *,
    task_id: str,
    worker_pool: str,
    model: str,
    model_band: str,
    prompt: str,
    thinking: str,
    profile_override: str = "",
) -> dict:
    backend = resolve_spawn_backend()
    if backend == "clawteam":
        return execute_clawteam_spawn(
            task_id=task_id,
            worker_pool=worker_pool,
            model=model,
            model_band=model_band,
            prompt=prompt,
            thinking=thinking,
            profile_override=profile_override,
        )
    if backend == "native":
        return execute_native_openclaw_spawn(
            task_id=task_id,
            worker_pool=worker_pool,
            model=model,
            model_band=model_band,
            prompt=prompt,
            thinking=thinking,
            profile_override=profile_override,
        )
    raise RuntimeError(f"不支持的 spawn backend: {backend}")


def derive_spawn_session_keys(team_name: str, agent_name: str) -> list[str]:
    normalized_team = re.sub(r"[^a-z0-9_-]+", "-", str(team_name or "").strip().lower()).strip("-")
    normalized_agent = re.sub(r"[^a-z0-9_-]+", "-", str(agent_name or "").strip().lower()).strip("-")
    candidates: list[str] = []
    for value in (
        f"agent:main:clawteam-{normalized_team}-{normalized_agent}" if normalized_team and normalized_agent else "",
        f"agent:main:{normalized_agent}" if normalized_agent else "",
        f"clawteam-{normalized_team}-{normalized_agent}" if normalized_team and normalized_agent else "",
    ):
        text = str(value or "").strip()
        if text and text not in candidates:
            candidates.append(text)
    return candidates


def load_openclaw_gateway_options() -> tuple[int, str]:
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    gateway_port = 3000
    gateway_token = ""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        gateway_cfg = config.get("gateway", {}) if isinstance(config, dict) else {}
        if isinstance(gateway_cfg, dict):
            gateway_port = int(gateway_cfg.get("port", config.get("port", 3000)) or 3000)
            auth_cfg = gateway_cfg.get("auth", {})
            if isinstance(auth_cfg, dict):
                gateway_token = str(auth_cfg.get("token", "") or "").strip()
        elif isinstance(config, dict):
            gateway_port = int(config.get("port", 3000) or 3000)
    except Exception:
        pass
    return gateway_port, gateway_token


def patch_openclaw_session_model(session_key: str, model: str) -> tuple[bool, int, str]:
    gateway_port, gateway_token = load_openclaw_gateway_options()
    encoded_session = urllib.parse.quote(str(session_key or "").strip(), safe=":")
    url = f"http://127.0.0.1:{gateway_port}/api/sessions/{encoded_session}"
    payload = json.dumps({"modelOverride": model}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if gateway_token:
        headers["Authorization"] = f"Bearer {gateway_token}"
    request = urllib.request.Request(url, data=payload, headers=headers, method="PATCH")
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status in (200, 204), int(response.status), ""
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            detail = ""
        return False, int(exc.code), detail.strip()
    except Exception as exc:
        return False, 0, str(exc)


def apply_spawn_session_model_override(
    *,
    team_name: str,
    agent_name: str,
    model: str,
    attempts: int = 8,
    sleep_seconds: float = 0.75,
) -> dict:
    selected_model = str(model or "").strip()
    if not selected_model:
        return {"applied": False, "session_key": "", "status_code": 0, "error": "empty-model"}
    candidates = derive_spawn_session_keys(team_name, agent_name)
    if not candidates:
        return {"applied": False, "session_key": "", "status_code": 0, "error": "missing-session-key"}

    last_status = 0
    last_error = ""
    for _ in range(max(attempts, 1)):
        for session_key in candidates:
            ok, status_code, detail = patch_openclaw_session_model(session_key, selected_model)
            if ok:
                return {
                    "applied": True,
                    "session_key": session_key,
                    "status_code": status_code,
                    "error": "",
                }
            last_status = status_code
            last_error = detail or last_error
        time.sleep(max(sleep_seconds, 0))
    return {
        "applied": False,
        "session_key": candidates[0],
        "status_code": last_status,
        "error": last_error,
    }


def build_clawteam_spawn_command(
    *,
    team_name: str,
    agent_name: str,
    prompt: str,
    profile: str,
    thinking: str,
) -> list[str]:
    bridge_cfg = clawteam_runtime_config()
    spawn_cfg = spawn_execution_config()
    clawteam_bin = str(bridge_cfg.get("clawteam_bin", "clawteam") or "clawteam").strip() or "clawteam"
    openclaw_bin = resolve_openclaw_bin(spawn_cfg)
    backend_name = str(spawn_cfg.get("backend_name", "tmux") or "tmux").strip() or "tmux"
    workspace_enabled = bool(spawn_cfg.get("workspace", False))
    supports_profile = clawteam_spawn_supports_option("--profile", clawteam_bin=clawteam_bin)
    supports_thinking = clawteam_spawn_supports_option("--thinking", clawteam_bin=clawteam_bin)
    final_prompt = inject_spawn_runtime_hints(
        prompt,
        profile=profile,
        thinking=thinking,
        supports_profile=supports_profile,
        supports_thinking=supports_thinking,
    )

    command = [
        clawteam_bin,
        "--json",
        "--data-dir",
        clawteam_data_dir(),
        "spawn",
        backend_name,
        openclaw_bin,
    ]
    if profile and supports_profile:
        command.extend(["--profile", profile])
    command.append("tui")
    if thinking and supports_thinking:
        command.extend(["--thinking", thinking])
    command.extend([
        "-t",
        team_name,
        "-n",
        agent_name,
        "--task",
        final_prompt,
    ])
    if not workspace_enabled:
        command.append("--no-workspace")
    return command


def execute_clawteam_spawn(
    *,
    task_id: str,
    worker_pool: str,
    model: str,
    model_band: str,
    prompt: str,
    thinking: str,
    profile_override: str = "",
) -> dict:
    if shutil.which(str(clawteam_runtime_config().get("clawteam_bin", "clawteam") or "clawteam")) is None:
        raise RuntimeError("未找到 clawteam 命令，无法执行 ClawTeam spawn")
    if shutil.which(resolve_openclaw_bin(spawn_execution_config())) is None:
        raise RuntimeError("未找到 openclaw 命令，无法执行 ClawTeam spawn")

    team_name = resolve_spawn_team_name()
    profile = profile_override or resolve_profile(worker_pool, model, model_band)
    agent_name = resolve_agent_name(task_id)
    command = build_clawteam_spawn_command(
        team_name=team_name,
        agent_name=agent_name,
        prompt=prompt,
        profile=profile,
        thinking=thinking,
    )
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    payload: dict[str, object] = {}
    if stdout:
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = {}
    if result.returncode != 0:
        detail = stderr or stdout or "clawteam spawn failed"
        raise RuntimeError(detail)
    session_override = apply_spawn_session_model_override(
        team_name=team_name,
        agent_name=agent_name,
        model=model,
    )
    def _payload_value(*keys: str) -> str:
        for key in keys:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
        for key in keys:
            value = session.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    child_session_key = _payload_value("childSessionKey", "child_session_key", "sessionKey", "session_key")
    child_session_id = _payload_value("childSessionId", "child_session_id", "sessionId", "session_id")
    run_id = _payload_value("runId", "run_id")
    native_task_id = _payload_value("taskId", "task_id")
    native_flow_id = _payload_value("parentFlowId", "parent_flow_id", "flowId", "flow_id")
    return {
        "backend": "clawteam",
        "team_name": team_name,
        "agent_name": agent_name,
        "profile": profile,
        "thinking": thinking,
        "session_key": str(session_override.get("session_key", "") or ""),
        "child_session_key": child_session_key,
        "session_id": child_session_id,
        "run_id": run_id,
        "native_task_id": native_task_id,
        "native_flow_id": native_flow_id,
        "model_override_applied": bool(session_override.get("applied", False)),
        "model_override_status": int(session_override.get("status_code", 0) or 0),
        "model_override_error": str(session_override.get("error", "") or ""),
        "command": command,
        "stdout": stdout,
        "stderr": stderr,
        "payload": payload,
    }


def build_task_prompt(
    *,
    task_id: str,
    model: str,
    model_band: str,
    task: str,
    expected_done: str,
    report_path: str,
    route: str,
    context_summary: str = "",
    context_path: str = "",
    profile: str = "",
    skill_bundle: list[str] | None = None,
    worker_pool: str = "",
    work_type: str = "",
    phase: str = "",
    protocol: str = "",
    review_required: bool = False,
    brief: dict | None = None,
    result_contract: dict | None = None,
) -> str:
    summary_hint = result_summary_contract(worker_pool, phase, route)
    brief_payload = brief if isinstance(brief, dict) else build_task_brief(
        task_id=task_id,
        goal=task.strip(),
        route=route,
        worker_pool=worker_pool or "octoclaw-research",
        work_type=work_type or "research",
        phase=phase or "collect",
        profile=profile or "default",
        protocol=protocol or "normal",
        review_required=review_required,
        report_path=report_path,
        context_summary=context_summary,
        context_path=context_path,
        skill_bundle=skill_bundle,
        expected_done=expected_done,
        summary_hint=summary_hint,
    )
    result_payload = result_contract if isinstance(result_contract, dict) else build_result_contract(summary_hint, artifact_first=True)
    task_state_py = shlex.quote(TASK_STATE_PY)
    lines = [
        "【状态写入 / entry】开始前先执行：",
        (
            f"python3 {task_state_py} upsert "
            f"--id {task_id} --model '{model}' --status running --model-band {model_band} "
            f"--expected-done '{expected_done}' --route {route} --runtime subagent --executor subagent "
            f"--report-path '{report_path}' --worker-pool {worker_pool or 'octoclaw-research'} "
            f"--work-type {work_type or 'research'} --phase {phase or 'collect'} "
            f"--protocol {protocol or 'normal'} --profile {profile or 'default'} "
            f"--review-required {'true' if review_required else 'false'}"
        ),
        "",
        "【TASK BRIEF / 必读输入】",
        "```json",
        json.dumps(brief_payload, ensure_ascii=False, indent=2),
        "```",
        "",
        "【执行约束】",
        "- 优先按 TASK BRIEF 执行；不要自行改目标、边界、交付格式",
        "- 每 turn ≤500字；分段读文件，避免一次性灌长上下文",
        "- 大段内容、长 diff、长日志分析优先写共享文件，不要直接塞进上下文或 RESULT",
        f"- 详细报告默认写到：{report_path}",
        "- 若填写 report，summary 仍需自包含，不能只写“已写入报告”",
        "- 真正失败才用 failed；仍有可交付解释但被阻塞时用 blocked",
        "",
        "【文件读取强制要求】",
        "- cat -> head -n 60",
        "- grep/rg -> | head -20",
        "- 日志 -> tail -n 50",
        "",
        "【运行中事件】",
        "每完成一个重要阶段，先输出内联信号（在执行 state 命令之前）：",
        "CHECKPOINT: <当前阶段一句话总结>",
        "ARTIFACTS_READY: <已生成的文件列表（如有）>",
        "全部阶段完成后再输出最终 ---RESULT--- 块。",
        "",
        (
            f"checkpoint: python3 {task_state_py} event "
            f"--id {task_id} --kind checkpoint --message '当前阶段一句话总结' --summary '当前阶段一句话总结'"
        ),
        (
            f"artifact_ready: python3 {task_state_py} event "
            f"--id {task_id} --kind artifact_ready --report-path '{report_path}' --message 'artifact ready'"
        ),
        (
            f"checklist: python3 {task_state_py} checklist "
            f"--id {task_id} --checklist-json '{{\"kind\":\"explicit\",\"items\":[...]}}'"
        ),
        "",
        "【RESULT 规范】",
        "---RESULT---",
        json.dumps(result_payload, ensure_ascii=False),
        "",
        "【收口命令】",
        (
            f"done: python3 {task_state_py} done "
            f"--id {task_id} --summary '结果一句话总结' --report-path '{report_path}'"
        ),
        (
            f"blocked: python3 {task_state_py} blocked "
            f"--id {task_id} --summary '可交付受阻说明' --report-path '{report_path}' "
            f"--blocked-reason '阻塞原因（1句）'"
        ),
        (
            f"failed: python3 {task_state_py} failed "
            f"--id {task_id} --summary '失败原因（1句）：xxx，建议：xxx'"
        ),
    ]
    return "\n".join(lines).strip()


def register_dispatched_task(
    *,
    task_id: str,
    model: str,
    model_band: str,
    task: str,
    expected_done: str,
    route: str,
    runtime: str,
    report_path: str,
    parent_id: str,
    context_path: str,
    context_summary: str,
    task_kind: str = "",
    worker_pool: str = "",
    work_type: str = "",
    phase: str = "",
    protocol: str = "",
    profile: str = "",
    review_required: bool = False,
    owner: str = "",
    session_key: str = "",
    session_id: str = "",
    agent_id: str = "",
    agent_namespace: str = "octoclaw",
    managed_by_octoclaw: bool = True,
    deps: list[str] | None = None,
    artifacts_json: dict | None = None,
) -> None:
    cmd = [
        "python3",
        TASK_STATE_PY,
        "upsert",
        "--id",
        task_id,
        "--model",
        model,
        "--status",
        "dispatched",
        "--model-band",
        model_band,
        "--task-description",
        task,
        "--expected-done",
        expected_done,
        "--source",
        "octoclaw",
        "--executor",
        "subagent",
        "--route",
        route,
        "--runtime",
        runtime,
        "--report-path",
        report_path,
        "--summary",
        task_title(task, 60),
        "--title",
        task_title(task),
        "--task-kind",
        task_kind,
        "--worker-pool",
        worker_pool,
        "--work-type",
        work_type,
        "--phase",
        phase,
        "--protocol",
        protocol,
        "--profile",
        profile,
        "--review-required",
        "true" if review_required else "false",
    ]
    if owner:
        cmd.extend(["--owner", owner])
    if session_key:
        cmd.extend(["--session-key", session_key])
    if session_id:
        cmd.extend(["--session-id", session_id])
    if agent_id:
        cmd.extend(["--agent-id", agent_id])
    if agent_namespace:
        cmd.extend(["--agent-namespace", agent_namespace])
    cmd.extend(["--managed-by-octoclaw", "true" if managed_by_octoclaw else "false"])
    if deps:
        joined = ",".join(str(dep).strip() for dep in deps if str(dep).strip())
        if joined:
            cmd.extend(["--deps", joined])
    if context_path:
        cmd.extend(["--context-path", context_path])
    if context_summary:
        cmd.extend(["--context-summary", compact_text(context_summary, 240)])
    if parent_id:
        cmd.extend(["--parent-id", parent_id])
    if artifacts_json:
        cmd.extend(["--artifacts-json", json.dumps(artifacts_json, ensure_ascii=False)])
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def register_failed_spawn_task(
    *,
    task_id: str,
    model: str,
    model_band: str,
    task: str,
    route: str,
    runtime: str,
    parent_id: str,
    report_path: str,
    context_path: str,
    context_summary: str,
    worker_pool: str,
    work_type: str,
    phase: str,
    protocol: str,
    profile: str,
    review_required: bool,
    task_kind: str,
    summary: str,
    session_key: str = "",
    session_id: str = "",
    agent_id: str = "",
    agent_namespace: str = "octoclaw",
    managed_by_octoclaw: bool = True,
    artifacts_json: dict | None = None,
) -> None:
    if report_path:
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        failure_lines = [
            "# OctoClaw Spawn Failure",
            "",
            f"- task_id: {task_id}",
            f"- route: {route}",
            f"- runtime: {runtime}",
            f"- worker_pool: {worker_pool}",
            f"- phase: {phase}",
            "",
            "## Task",
            task.strip(),
            "",
            "## Error",
            summary.strip(),
            "",
            "## Suggested Next Step",
            "Inspect the spawn command/runtime compatibility, then retry or fall back to direct handling.",
            "",
        ]
        with open(report_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(failure_lines))
    register_dispatched_task(
        task_id=task_id,
        model=model,
        model_band=model_band,
        task=task,
        expected_done="",
        route=route,
        runtime=runtime,
        report_path=report_path,
        parent_id=parent_id,
        context_path=context_path,
        context_summary=context_summary,
        task_kind=task_kind,
        worker_pool=worker_pool,
        work_type=work_type,
        phase=phase,
        protocol=protocol,
        profile=profile,
        review_required=review_required,
        session_key=session_key,
        session_id=session_id,
        agent_id=agent_id,
        agent_namespace=agent_namespace,
        managed_by_octoclaw=managed_by_octoclaw,
        artifacts_json=artifacts_json,
    )
    subprocess.run(
        ["python3", TASK_STATE_PY, "failed", "--id", task_id, "--summary", summary[:180]],
        check=False,
        capture_output=True,
        text=True,
    )


def initial_spawn_artifacts(*, route: str, runtime: str, team_name: str) -> dict:
    execution_backend = "spawn_plan"
    if should_execute_spawn(route, runtime, explicit=None):
        backend = resolve_spawn_backend()
        execution_backend = backend if backend in {"clawteam", "native"} else "spawn_plan"
    surface = spawn_operator_surface(team_name=team_name)
    return {
        "execution_backend": execution_backend,
        "operator_surface": surface,
        "operator_hint": str(surface.get("operator_hint", "") or ""),
    }


def build_spawn_spec(
    task: str,
    *,
    route: str = "",
    model_band: str = "",
    selector_band: str = "",
    model: str = "",
    worker_pool: str = "",
    work_type: str = "",
    phase: str = "",
    profile: str = "",
    runtime: str = DEFAULT_RUNTIME,
    stream_to: str = "",
    supports_acp: bool = False,
    parent_id: str = "",
    task_kind: str = "",
    register: bool = False,
    execute: bool | None = None,
    deps: list[str] | None = None,
    policy_decision: dict | None = None,
    session_key: str = "",
    metadata: dict | None = None,
) -> dict:
    policy = policy_decision if isinstance(policy_decision, dict) else {}
    request = policy_request(policy)
    request_metadata = dict(policy_metadata(policy))
    if isinstance(metadata, dict):
        request_metadata.update(metadata)
    route_decision = policy.get("route_decision", {}) if isinstance(policy.get("route_decision", {}), dict) else {}
    model_policy = policy.get("model_policy", {}) if isinstance(policy.get("model_policy", {}), dict) else {}
    skill_policy = policy.get("skill_policy", {}) if isinstance(policy.get("skill_policy", {}), dict) else {}
    review_policy = policy.get("review_policy", {}) if isinstance(policy.get("review_policy", {}), dict) else {}
    prompt_policy = policy.get("prompt_contract", {}) if isinstance(policy.get("prompt_contract", {}), dict) else {}

    route_meta = infer_route(task)
    final_route = route or str(route_decision.get("route", "") or "") or route_meta.get("route", "spawn_single")
    if final_route not in ("spawn_single", "spawn_multi"):
        raise ValueError(f"octoclaw_spawn 只处理 spawn 路径，当前 route={final_route}")

    preliminary_profile = str(profile or model_policy.get("profile", "") or "")
    hinted_worker_pool = str(worker_pool or route_decision.get("worker_pool", "") or "")
    hinted_work_type = str(work_type or route_decision.get("work_type", "") or "")
    hinted_phase = str(phase or route_decision.get("phase", "") or "")

    resolved_worker_pool = hinted_worker_pool or taxonomy_infer_worker_pool(final_route, hinted_work_type)
    if not resolved_worker_pool:
        resolved_worker_pool = taxonomy_infer_worker_pool(final_route, hinted_work_type)

    resolved_work_type = hinted_work_type or str(
        taxonomy_resolve_work_type(
            {
                "worker_pool": resolved_worker_pool,
                "route": final_route,
                "profile": preliminary_profile,
            }
        )
        or ""
    )
    if not resolved_work_type and resolved_worker_pool == "octoclaw-runner":
        resolved_work_type = "ops"
    elif not resolved_work_type:
        resolved_work_type = "research"

    resolved_phase = hinted_phase or str(
        taxonomy_resolve_phase(
            {
                "worker_pool": resolved_worker_pool,
                "work_type": resolved_work_type,
                "route": final_route,
                "profile": preliminary_profile,
            }
        )
        or ""
    )
    if not resolved_phase:
        resolved_phase = "inspect" if resolved_worker_pool == "octoclaw-runner" else "collect"

    protocol = str(route_decision.get("protocol", "") or "")
    final_model_band = (
        str(model_band or model_policy.get("model_band", "") or "").strip()
        or infer_model_band_from_taxonomy(
            route=final_route,
            worker_pool=resolved_worker_pool,
            work_type=resolved_work_type,
            phase=resolved_phase,
            protocol=protocol,
        )
    )
    final_selector_band = str(selector_band or model_policy.get("selector_band", "") or "").strip() or selector_band_for_model_band(
        final_model_band,
        route=final_route,
    )
    final_model = model or str(model_policy.get("selected_model", "") or "")
    thinking = str(model_policy.get("reasoning_effort", "") or "")
    if not final_model:
        final_model, resolved_thinking = resolve_model_and_thinking(
            final_selector_band,
            task,
            worker_pool=resolved_worker_pool,
            phase=resolved_phase,
            route=final_route,
            profile=preliminary_profile,
        )
        if not thinking:
            thinking = resolved_thinking
    if not final_model:
        raise ValueError("无法解析 spawn 模型")
    profile = preliminary_profile or resolve_profile(resolved_worker_pool, final_model, final_model_band)
    skill_bundle = skill_policy.get("default_skill_bundle", [])
    if not isinstance(skill_bundle, list):
        skill_bundle = []
    review_required = bool(review_policy.get("required", False))
    resolved_session_key = str(session_key or request.get("session_key", "") or request_metadata.get("session_key", "") or "").strip()
    resolved_session_id = str(request_metadata.get("session_id", "") or "").strip()
    resolved_agent_id = str(request_metadata.get("agent_id", "") or "").strip()
    resolved_agent_namespace = str(request_metadata.get("agent_namespace", "") or "octoclaw").strip() or "octoclaw"
    managed_value = request_metadata.get("managed_by_octoclaw")
    managed_by_octoclaw = True if managed_value is None or str(managed_value).strip() == "" else str(managed_value).strip().lower() in {"1", "true", "yes", "on"}
    final_task_kind = str(task_kind or "").strip() or ("team_parent" if final_route == "spawn_multi" else "subtask")
    spawn_team_name = resolve_spawn_team_name()
    base_artifacts = initial_spawn_artifacts(route=final_route, runtime=runtime, team_name=spawn_team_name)

    task_id = f"{worker_pool_slug(resolved_worker_pool)}-{now_compact()}"
    report_path = os.path.join(SHARED_DIR, f"{task_id}.md")
    context_bundle = build_context_bundle(task, parent_id, task_id)

    problems = validate_runtime(runtime, stream_to, supports_acp)
    if problems:
        error_text = "；".join(problems)
        log_spawn_error(task, error_text, runtime=runtime, stream_to=stream_to, parent_id=parent_id)
        register_failed_spawn_task(
            task_id=task_id,
            model=final_model,
            model_band=final_model_band,
            task=task,
            route=final_route,
            runtime=runtime,
            parent_id=parent_id,
            report_path=report_path,
            context_path=str(context_bundle.get("context_path", "") or ""),
            context_summary=str(context_bundle.get("summary", "") or ""),
            task_kind=final_task_kind,
            worker_pool=resolved_worker_pool,
            work_type=resolved_work_type,
            phase=resolved_phase,
            protocol=protocol,
            profile=profile,
            review_required=review_required,
            session_key=resolved_session_key,
            session_id=resolved_session_id,
            agent_id=resolved_agent_id,
            agent_namespace=resolved_agent_namespace,
            managed_by_octoclaw=managed_by_octoclaw,
            artifacts_json=base_artifacts,
            summary=f"spawn派发失败：{compact_text(error_text, 120)}",
        )
        raise ValueError(error_text)
    taskflow_binding = create_managed_taskflow_binding(
        {
            "id": task_id,
            "route": final_route,
            "runtime": runtime,
            "status": "queued" if should_execute_spawn(final_route, runtime, explicit=execute) else "dispatched",
            "worker_pool": resolved_worker_pool,
            "phase": resolved_phase,
            "summary": task_title(task, 60),
            "task_description": task,
            "session_key": resolved_session_key,
        }
    )
    if taskflow_binding:
        base_artifacts["openclaw_taskflow"] = taskflow_binding
    expected_done = expected_done_offset(final_model_band)
    summary_hint = result_summary_contract(resolved_worker_pool, resolved_phase, final_route)
    brief = build_task_brief(
        task_id=task_id,
        goal=task,
        work_contract=str(route_decision.get("work_contract", route_decision.get("work_contract_hint", "")) or ""),
        route=final_route,
        worker_pool=resolved_worker_pool,
        work_type=resolved_work_type,
        phase=resolved_phase,
        profile=profile or preliminary_profile or "default",
        protocol=protocol or "normal",
        review_required=review_required,
        report_path=report_path,
        context_summary=str(context_bundle.get("summary", "") or ""),
        context_path=str(context_bundle.get("context_path", "") or ""),
        context_pack=context_bundle.get("context_pack") if isinstance(context_bundle.get("context_pack"), dict) else {},
        context_budget=context_bundle.get("budget") if isinstance(context_bundle.get("budget"), dict) else {},
        skill_bundle=skill_bundle,
        expected_done=expected_done,
        summary_hint=summary_hint,
        budget_policy=policy.get("budget_policy") if isinstance(policy.get("budget_policy"), dict) else {},
        merge_contract=str(prompt_policy.get("merge_contract", "") or ""),
        handoff_contract=str(prompt_policy.get("handoff_contract", "") or ""),
    )
    result_contract = build_result_contract(summary_hint, artifact_first=True)
    base_artifacts.update(
        {
            "brief": brief,
            "expected_output": brief.get("expected_output", {}),
            "context_pack_path": str(context_bundle.get("context_pack_path", "") or ""),
        }
    )
    prompt = build_task_prompt(
        task_id=task_id,
        model=final_model,
        model_band=final_model_band,
        task=task,
        expected_done=expected_done,
        report_path=report_path,
        route=final_route,
        context_summary=str(context_bundle.get("summary", "") or ""),
        context_path=str(context_bundle.get("context_path", "") or ""),
        profile=profile,
        skill_bundle=skill_bundle,
        worker_pool=resolved_worker_pool,
        work_type=resolved_work_type,
        phase=resolved_phase,
        protocol=protocol,
        review_required=review_required,
        brief=brief,
        result_contract=result_contract,
    )
    planned_backend = resolve_spawn_backend() if should_execute_spawn(final_route, runtime, explicit=execute) else ""
    if planned_backend == "native":
        prompt = build_native_task_prompt(
            task_id=task_id,
            task=task,
            brief=brief,
            result_contract=result_contract,
        )

    if register:
        register_dispatched_task(
            task_id=task_id,
            model=final_model,
            model_band=final_model_band,
            task=task,
            expected_done=expected_done,
            route=final_route,
            runtime=runtime,
            report_path=report_path,
            parent_id=parent_id,
            context_path=str(context_bundle.get("context_path", "") or ""),
            context_summary=str(context_bundle.get("summary", "") or ""),
            task_kind=final_task_kind,
            worker_pool=resolved_worker_pool,
            work_type=resolved_work_type,
            phase=resolved_phase,
            protocol=protocol,
            profile=profile,
            review_required=review_required,
            deps=deps,
            session_key=resolved_session_key,
            session_id=resolved_session_id,
            agent_id=resolved_agent_id,
            agent_namespace=resolved_agent_namespace,
            managed_by_octoclaw=managed_by_octoclaw,
            artifacts_json=base_artifacts,
        )

    spawn_execution: dict[str, object] | None = None
    execution_error = ""
    executed = False
    spawn_prompt = prompt
    spawn_prompt_path = ""
    if should_execute_spawn(final_route, runtime, explicit=execute):
        spawn_prompt, spawn_prompt_path = prepare_spawn_prompt(
            task_id=task_id,
            prompt=prompt,
            report_path=report_path,
            context_path=str(context_bundle.get("context_path", "") or ""),
            backend=planned_backend,
        )
        if spawn_prompt_path:
            base_artifacts["spawn_prompt_path"] = spawn_prompt_path
        try:
            spawn_execution = execute_spawn_backend(
                task_id=task_id,
                worker_pool=resolved_worker_pool,
                model=final_model,
                model_band=final_model_band,
                prompt=spawn_prompt,
                thinking=thinking,
                profile_override=profile,
            )
            agent_owner = str((spawn_execution or {}).get("agent_name", "") or "")
            operator_surface = spawn_operator_surface(
                agent_name=agent_owner,
                team_name=spawn_team_name,
                backend_override=str((spawn_execution or {}).get("backend", "") or ""),
                backend_name_override=str((spawn_execution or {}).get("backend_name", "") or ""),
            )
            operator_surface["backend_name"] = str((spawn_execution or {}).get("backend_name", "") or "")
            base_artifacts.update(
                {
                    "execution_backend": (
                        f"{str((spawn_execution or {}).get('backend', 'spawn') or 'spawn')}_"
                        f"{str((spawn_execution or {}).get('backend_name', spawn_execution_config().get('backend_name', 'tmux')) or 'tmux')}"
                    ),
                    "operator_surface": operator_surface,
                    "spawn_execution": {
                        "backend": str((spawn_execution or {}).get("backend", "") or ""),
                        "backend_name": str((spawn_execution or {}).get("backend_name", "") or ""),
                        "team_name": str((spawn_execution or {}).get("team_name", "") or ""),
                        "agent_name": agent_owner,
                        "profile": str((spawn_execution or {}).get("profile", "") or ""),
                        "session_key": str((spawn_execution or {}).get("session_key", "") or ""),
                        "child_session_key": str((spawn_execution or {}).get("child_session_key", "") or ""),
                        "session_id": str((spawn_execution or {}).get("session_id", "") or ""),
                        "run_id": str((spawn_execution or {}).get("run_id", "") or ""),
                        "native_task_id": str((spawn_execution or {}).get("native_task_id", "") or ""),
                        "native_flow_id": str((spawn_execution or {}).get("native_flow_id", "") or ""),
                        "pid": int((spawn_execution or {}).get("pid", 0) or 0),
                        "stdout_path": str((spawn_execution or {}).get("stdout_path", "") or ""),
                        "stderr_path": str((spawn_execution or {}).get("stderr_path", "") or ""),
                        "wrapper_path": str((spawn_execution or {}).get("wrapper_path", "") or ""),
                        "model_override_applied": bool((spawn_execution or {}).get("model_override_applied", False)),
                        "model_override_status": int((spawn_execution or {}).get("model_override_status", 0) or 0),
                        "model_override_error": str((spawn_execution or {}).get("model_override_error", "") or ""),
                    },
                }
            )
            base_artifacts["operator_hint"] = str(
                ((base_artifacts.get("operator_surface") or {}) if isinstance(base_artifacts.get("operator_surface"), dict) else {}).get("operator_hint", "")
                or ""
            )
            cmd = [
                "python3",
                TASK_STATE_PY,
                "upsert",
                "--id",
                task_id,
                "--artifacts-json",
                json.dumps(base_artifacts, ensure_ascii=False),
            ]
            if agent_owner:
                cmd.extend(["--owner", agent_owner])
            child_session_id = str((spawn_execution or {}).get("session_id", "") or "").strip()
            child_run_id = str((spawn_execution or {}).get("run_id", "") or "").strip()
            taskflow_binding = base_artifacts.get("openclaw_taskflow")
            if isinstance(taskflow_binding, dict) and taskflow_binding:
                taskflow_binding["updated_at"] = datetime.now(timezone.utc).astimezone().isoformat()
                if str((spawn_execution or {}).get("backend", "") or "").strip() == "native":
                    taskflow_binding["substrate_state"] = "running"
                taskflow_binding["session_id"] = child_session_id or str(taskflow_binding.get("session_id", "") or "")
                taskflow_binding["run_id"] = child_run_id or str(taskflow_binding.get("run_id", "") or "")
                taskflow_binding["task_id"] = str((spawn_execution or {}).get("native_task_id", "") or taskflow_binding.get("task_id", "") or "")
                taskflow_binding["flow_id"] = str((spawn_execution or {}).get("native_flow_id", "") or taskflow_binding.get("flow_id", "") or "")
            if child_session_id:
                cmd.extend(["--session-id", child_session_id])
            if child_run_id:
                cmd.extend(["--run-id", child_run_id])
            child_session_key = str((spawn_execution or {}).get("child_session_key", "") or "").strip()
            if child_session_key:
                cmd.extend(["--session-key", child_session_key])
            pid = int((spawn_execution or {}).get("pid", 0) or 0)
            if pid > 0:
                cmd.extend(["--session-status", "spawned"])
                cmd.extend(["--status", "running"])
            subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
            )
            executed = True
        except Exception as exc:
            execution_error = compact_text(str(exc), 220)
            subprocess.run(
                ["python3", TASK_STATE_PY, "failed", "--id", task_id, "--summary", f"spawn启动失败：{execution_error}"],
                check=False,
                capture_output=True,
                text=True,
            )

    payload = {
        "model": final_model,
        "message": prompt,
        "runtime": runtime,
    }
    if thinking:
        payload["thinking"] = thinking
    if runtime == "acp" and stream_to:
        payload["streamTo"] = stream_to

    return {
        "route": final_route,
        "task_id": task_id,
        "title": task_title(task),
        "model": final_model,
        "thinking": thinking,
        "profile": profile,
        "model_band": final_model_band,
        "selector_band": final_selector_band,
        "runtime": runtime,
        "stream_to": stream_to or "",
        "report_path": report_path,
        "task_kind": final_task_kind,
        "parent_id": parent_id,
        "deps": [str(dep).strip() for dep in (deps or []) if str(dep).strip()],
        "worker_pool": resolved_worker_pool,
        "work_type": resolved_work_type,
        "phase": resolved_phase,
        "protocol": protocol,
        "skill_bundle": skill_bundle,
        "review_required": review_required,
        "prompt_contract": prompt_policy,
        "context_summary": context_bundle.get("summary", ""),
        "context_path": context_bundle.get("context_path", ""),
        "context_pack_path": context_bundle.get("context_pack_path", ""),
        "context_pack": context_bundle.get("context_pack", {}),
        "context_refs": context_bundle.get("refs", []),
        "context_budget": context_bundle.get("budget", {}),
        "brief": brief,
        "result_contract": result_contract,
        "expected_done": expected_done,
        "task_prompt": prompt,
        "task_prompt_preview": prompt[:320] + ("…" if len(prompt) > 320 else ""),
        "spawn_prompt_path": spawn_prompt_path,
        "handoff": {
            "kind": "background" if executed else "plan",
            "status": "pending" if executed else ("failed" if execution_error else "planned"),
            "summary": (
                f"子任务已通过 native OpenClaw session 异步启动（task={task_id}）。正常完成会自动回推；若几分钟后仍无新消息，可用 details {task_id} / queue 查看。"
                if executed and str((spawn_execution or {}).get("backend", "") or "") == "native"
                else (
                    f"子任务已通过 ClawTeam/tmux 异步启动（task={task_id}）。正常完成会自动回推；若几分钟后仍无新消息，可用 details {task_id} / queue 查看。"
                    if executed
                    else ("子任务启动失败。" if execution_error else "已生成统一子任务派发规范。")
                )
            ),
            "reply_text": (
                f"我已经把这个子任务挂到 OpenClaw 原生后台会话里继续处理。正常完成会自动回到当前会话；如果几分钟后还没收到更新，你可以随时发 `details {task_id}` 或 `queue` 来看进度。"
                if executed and str((spawn_execution or {}).get("backend", "") or "") == "native"
                else (
                    f"我已经把这个子任务挂到 ClawTeam/tmux 工位里继续处理。正常完成会自动回到当前会话；如果几分钟后还没收到更新，你可以随时发 `details {task_id}` 或 `queue` 来看进度。"
                    if executed
                    else ("子任务启动失败，我已记录失败状态。" if execution_error else "我会按 OctoClaw 统一 spawn 规范派给子任务处理。")
                )
            ),
            "report_path": report_path,
            "user_safe": True,
        },
        "sessions_spawn_payload": payload,
        "executed": executed,
        "execution_error": execution_error,
        "spawn_execution": spawn_execution or {},
        "operator_surface": base_artifacts.get("operator_surface", {}),
        "openclaw_taskflow": base_artifacts.get("openclaw_taskflow", {}),
        "policy_decision": policy,
        "registered": register,
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "native-finalize":
        parser = argparse.ArgumentParser(description="Finalize native OpenClaw spawn result")
        parser.add_argument("native_finalize")
        parser.add_argument("--task-id", dest="task_id", required=True)
        parser.add_argument("--stdout-path", dest="stdout_path", required=True)
        parser.add_argument("--stderr-path", dest="stderr_path", required=True)
        parser.add_argument("--report-path", dest="report_path", default="")
        parser.add_argument("--exit-code", dest="exit_code", type=int, default=0)
        args = parser.parse_args()
        result = finalize_native_spawn_result(
            task_id=args.task_id,
            stdout_path=args.stdout_path,
            stderr_path=args.stderr_path,
            report_path=args.report_path,
            exit_code=args.exit_code,
        )
        print(json.dumps(result, ensure_ascii=False))
        return

    parser = argparse.ArgumentParser(description="Validated OctoClaw subagent spawn wrapper")
    parser.add_argument("--task", required=True)
    parser.add_argument("--route", choices=["spawn_single", "spawn_multi"], default="spawn_single")
    parser.add_argument("--model-band", dest="model_band", default="")
    parser.add_argument("--selector-band", dest="selector_band", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--runtime", default=DEFAULT_RUNTIME, choices=["subagent", "acp"])
    parser.add_argument("--stream-to", dest="stream_to", default="")
    parser.add_argument("--supports-acp", action="store_true")
    parser.add_argument("--parent-id", dest="parent_id", default="")
    parser.add_argument("--session-key", dest="session_key", default="")
    parser.add_argument("--metadata-json", dest="metadata_json", default="")
    parser.add_argument("--policy-json", default="")
    parser.add_argument("--register", action="store_true")
    parser.add_argument("--execute", dest="execute", action="store_true")
    parser.add_argument("--no-execute", dest="execute", action="store_false")
    parser.set_defaults(execute=None)
    args = parser.parse_args()

    policy_decision = None
    if args.policy_json:
        try:
            parsed = json.loads(args.policy_json)
            if isinstance(parsed, dict):
                policy_decision = parsed
        except json.JSONDecodeError:
            policy_decision = None
    metadata = None
    if args.metadata_json:
        try:
            parsed = json.loads(args.metadata_json)
            if isinstance(parsed, dict):
                metadata = parsed
        except json.JSONDecodeError:
            metadata = None

    spec = build_spawn_spec(
        args.task,
        route=args.route,
        model_band=args.model_band,
        selector_band=args.selector_band,
        model=args.model,
        runtime=args.runtime,
        stream_to=args.stream_to,
        supports_acp=args.supports_acp,
        parent_id=args.parent_id,
        register=args.register,
        execute=args.execute,
        policy_decision=policy_decision,
        session_key=args.session_key,
        metadata=metadata,
    )
    print(json.dumps(spec, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
