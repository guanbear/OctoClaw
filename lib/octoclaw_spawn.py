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
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from functools import lru_cache

from learning_log import append_error_entry
from octoclaw_route import infer_route
from octopus_config import (
    CONTEXT_DIR,
    SHARED_DIR,
    TASK_STATE_FILE,
    load_json,
    load_octopus_config,
    spawn_operator_surface,
)
from runtime_protocol import build_result_contract, build_task_brief
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
    summary_lines: list[str] = []
    refs: list[dict] = []

    for candidate in related_tasks:
        candidate_id = str(candidate.get("id", "") or "")
        summary = compact_text(str(candidate.get("summary", "") or candidate.get("task_description", "") or ""))
        if not summary:
            continue
        report_path = str(candidate.get("report_path", "") or "")
        line = f"- {candidate_id}: {summary}"
        if report_path:
            line += f" | report={report_path}"
        summary_lines.append(line)
        refs.append({
            "task_id": candidate_id,
            "status": str(candidate.get("status", "") or ""),
            "summary": summary,
            "report_path": report_path,
            "route": str(candidate.get("route", "") or ""),
            "worker_pool": str(candidate.get("worker_pool", "") or ""),
            "work_type": str(candidate.get("work_type", "") or ""),
            "phase": str(candidate.get("phase", "") or ""),
        })

    context_summary = "\n".join(summary_lines).strip()
    context_path = ""
    if context_summary:
        os.makedirs(CONTEXT_DIR, exist_ok=True)
        context_path = os.path.join(CONTEXT_DIR, f"{task_id}.md")
        content = "\n".join([
            f"# OctoClaw Context Pack: {task_id}",
            "",
            "## Requested Task",
            task.strip(),
            "",
            "## Related Recent Tasks",
            context_summary,
            "",
            "## Usage",
            "- 优先使用短摘要判断，不要把长历史直接塞进子任务上下文。",
            "- 若需要详细背景，先 head -n 80 对应 report_path 或共享文件。",
        ]).rstrip() + "\n"
        with open(context_path, "w", encoding="utf-8") as f:
            f.write(content)

    return {
        "summary": context_summary,
        "refs": refs,
        "context_path": context_path,
        "budget": {
            "inline_history_max_items": 3,
            "inline_history_max_chars": 480,
            "share_large_context": True,
        },
    }


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
    return bool(cfg.get("enabled", False)) and str(cfg.get("backend", "plan") or "plan").strip().lower() == "clawteam"


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
    workspace = os.environ.get("WORKSPACE", "/workspace")
    return os.path.join(workspace, "tmp", "octopus", "clawteam-bridge", "clawteam-data")


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
    openclaw_bin = str(spawn_cfg.get("openclaw_bin", "openclaw") or "openclaw").strip() or "openclaw"
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
    if shutil.which(str(spawn_execution_config().get("openclaw_bin", "openclaw") or "openclaw")) is None:
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
    return {
        "backend": "clawteam",
        "team_name": team_name,
        "agent_name": agent_name,
        "profile": profile,
        "thinking": thinking,
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
    lines = [
        "【状态写入 / entry】开始前先执行：",
        (
            f"python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py upsert "
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
        (
            f"checkpoint: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py event "
            f"--id {task_id} --kind checkpoint --message '当前阶段一句话总结' --summary '当前阶段一句话总结'"
        ),
        (
            f"artifact_ready: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py event "
            f"--id {task_id} --kind artifact_ready --report-path '{report_path}' --message 'artifact ready'"
        ),
        (
            f"checklist: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py checklist "
            f"--id {task_id} --checklist-json '{{\"kind\":\"explicit\",\"items\":[...]}}'"
        ),
        "",
        "【RESULT 规范】",
        "---RESULT---",
        json.dumps(result_payload, ensure_ascii=False),
        "",
        "【收口命令】",
        (
            f"done: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py done "
            f"--id {task_id} --summary '结果一句话总结' --report-path '{report_path}'"
        ),
        (
            f"blocked: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py blocked "
            f"--id {task_id} --summary '可交付受阻说明' --report-path '{report_path}' "
            f"--blocked-reason '阻塞原因（1句）'"
        ),
        (
            f"failed: python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py failed "
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
        execution_backend = "clawteam"
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
    expected_done = expected_done_offset(final_model_band)
    summary_hint = result_summary_contract(resolved_worker_pool, resolved_phase, final_route)
    brief = build_task_brief(
        task_id=task_id,
        goal=task,
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
        skill_bundle=skill_bundle,
        expected_done=expected_done,
        summary_hint=summary_hint,
    )
    result_contract = build_result_contract(summary_hint, artifact_first=True)
    base_artifacts.update(
        {
            "brief": brief,
            "expected_output": brief.get("expected_output", {}),
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
    if should_execute_spawn(final_route, runtime, explicit=execute):
        try:
            spawn_execution = execute_clawteam_spawn(
                task_id=task_id,
                worker_pool=resolved_worker_pool,
                model=final_model,
                model_band=final_model_band,
                prompt=prompt,
                thinking=thinking,
                profile_override=profile,
            )
            agent_owner = str((spawn_execution or {}).get("agent_name", "") or "")
            base_artifacts.update(
                {
                    "execution_backend": f"{str((spawn_execution or {}).get('backend', 'clawteam') or 'clawteam')}_"
                    f"{str(spawn_execution_config().get('backend_name', 'tmux') or 'tmux')}",
                    "operator_surface": spawn_operator_surface(
                        agent_name=agent_owner,
                        team_name=spawn_team_name,
                    ),
                    "spawn_execution": {
                        "backend": str((spawn_execution or {}).get("backend", "") or ""),
                        "team_name": str((spawn_execution or {}).get("team_name", "") or ""),
                        "agent_name": agent_owner,
                        "profile": str((spawn_execution or {}).get("profile", "") or ""),
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
        "context_refs": context_bundle.get("refs", []),
        "context_budget": context_bundle.get("budget", {}),
        "brief": brief,
        "result_contract": result_contract,
        "expected_done": expected_done,
        "task_prompt": prompt,
        "task_prompt_preview": prompt[:320] + ("…" if len(prompt) > 320 else ""),
        "handoff": {
            "kind": "background" if executed else "plan",
            "status": "pending" if executed else ("failed" if execution_error else "planned"),
            "summary": "子任务已通过 ClawTeam/tmux 启动。" if executed else ("子任务启动失败。" if execution_error else "已生成统一子任务派发规范。"),
            "reply_text": (
                "我已经把这个子任务挂到 ClawTeam/tmux 工位里继续处理，稍后回来汇总结论。"
                if executed
                else ("子任务启动失败，我已记录失败状态。" if execution_error else "我会按 OctoClaw 统一 spawn 规范派给子任务处理。")
            ),
            "report_path": report_path,
            "user_safe": True,
        },
        "sessions_spawn_payload": payload,
        "executed": executed,
        "execution_error": execution_error,
        "spawn_execution": spawn_execution or {},
        "operator_surface": base_artifacts.get("operator_surface", {}),
        "policy_decision": policy,
        "registered": register,
    }


def main() -> None:
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
