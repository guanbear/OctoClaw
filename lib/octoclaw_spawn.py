#!/usr/bin/env python3
"""Validated subagent spawn wrapper for OctoClaw.

This module captures the strongest parts of the older Octopus workflow:
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
from worker_taxonomy import (
    infer_worker_pool as taxonomy_infer_worker_pool,
    legacy_label_for_worker_pool,
    resolve_phase as taxonomy_resolve_phase,
    resolve_work_type as taxonomy_resolve_work_type,
    worker_pool_from_legacy_label,
)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")

DEFAULT_RUNTIME = "subagent"
DEFAULT_TIER_MINUTES = {
    "trivial": 3,
    "simple": 5,
    "normal": 8,
    "hard": 15,
    "deep": 20,
}

STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "then", "into", "will",
    "帮我", "一下", "然后", "最后", "当前", "机器", "本机", "进行", "处理", "检查", "分析",
    "给我", "一个", "并且", "需要", "继续", "相关", "可以", "如果", "不要", "还是", "那个",
}


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


def infer_label(task: str) -> str:
    text = (task or "").lower()
    rules = [
        ("octopus-test", [r"\b(test|pytest|unit test|regression|验证|测试)\b"]),
        ("octopus-writer", [r"\b(write|draft|doc|readme|总结|文档|说明|报告|翻译)\b"]),
        ("octopus-scout", [r"\b(research|compare|investigate|调研|对比|查资料)\b"]),
        ("octopus-analyze", [r"\b(analy|root cause|日志分析|根因|分析)\b"]),
        ("octopus-fix", [r"\b(fix|bug|修复|排障|hotfix)\b"]),
    ]
    for label, patterns in rules:
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            return label
    return "octopus-power"


def infer_tier(task: str, label: str) -> str:
    text = (task or "").lower()
    if any(token in text for token in ["并行", "同时", "分别", "一边", "parallel"]):
        return "hard"
    if any(token in text for token in ["架构", "重构", "多文件", "根因", "系统设计", "microservice", "refactor"]):
        return "hard"
    if label in ("octopus-power", "octopus-analyze"):
        return "hard"
    if label in ("octopus-fix", "octopus-test", "octopus-scout", "octopus-writer"):
        return "normal"
    return "normal"


def expected_done_offset(tier: str) -> str:
    minutes = DEFAULT_TIER_MINUTES.get(tier or "normal", 8)
    return f"+{minutes}min"


def resolve_model_and_thinking(
    tier: str,
    label: str,
    description: str,
    *,
    worker_pool: str = "",
    phase: str = "",
    route: str = "",
    profile: str = "",
) -> tuple[str, str]:
    cmd = ["python3", RESOLVE_MODEL_PY, "--tier", tier, "--label", label, "--description", description]
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


def prefers_longform_result(label: str, route: str) -> bool:
    return label in ("octopus-scout", "octopus-analyze", "octopus-writer") or route == "spawn_multi"


def result_summary_contract(label: str, route: str) -> str:
    if prefers_longform_result(label, route):
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
        for field in ("task_description", "summary", "label", "route")
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
            "label": str(candidate.get("label", "") or ""),
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
        "octopus-validation",
    ):
        text = str(value or "").strip()
        if text:
            return text
    return "octopus-validation"


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


def resolve_profile(label: str, model: str, tier: str) -> str:
    cfg = spawn_execution_config()
    label_map = cfg.get("profile_by_label", {})
    if isinstance(label_map, dict):
        value = str(label_map.get(label, "") or "").strip()
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

    tier_map = cfg.get("profile_by_tier", {})
    if isinstance(tier_map, dict):
        value = str(tier_map.get(tier, "") or "").strip()
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

    command = [
        clawteam_bin,
        "--json",
        "--data-dir",
        clawteam_data_dir(),
        "spawn",
        backend_name,
        openclaw_bin,
    ]
    if profile:
        command.extend(["--profile", profile])
    command.append("tui")
    if thinking:
        command.extend(["--thinking", thinking])
    command.extend([
        "-t",
        team_name,
        "-n",
        agent_name,
        "--task",
        prompt,
    ])
    if not workspace_enabled:
        command.append("--no-workspace")
    return command


def execute_clawteam_spawn(
    *,
    task_id: str,
    label: str,
    model: str,
    tier: str,
    prompt: str,
    thinking: str,
    profile_override: str = "",
) -> dict:
    if shutil.which(str(clawteam_runtime_config().get("clawteam_bin", "clawteam") or "clawteam")) is None:
        raise RuntimeError("未找到 clawteam 命令，无法执行 ClawTeam spawn")
    if shutil.which(str(spawn_execution_config().get("openclaw_bin", "openclaw") or "openclaw")) is None:
        raise RuntimeError("未找到 openclaw 命令，无法执行 ClawTeam spawn")

    team_name = resolve_spawn_team_name()
    profile = profile_override or resolve_profile(label, model, tier)
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
    label: str,
    model: str,
    tier: str,
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
) -> str:
    lines = [
        "【状态写入】开始前先执行：",
        (
            f"python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py upsert "
            f"--id {task_id} --label {label} --model '{model}' --status running --tier {tier} "
            f"--expected-done '{expected_done}' --route {route} --runtime subagent --executor subagent "
            f"--report-path '{report_path}' --worker-pool {worker_pool or 'octoclaw-research'} "
            f"--work-type {work_type or 'research'} --phase {phase or 'collect'} "
            f"--protocol {protocol or 'normal'} --profile {profile or 'default'} "
            f"--review-required {'true' if review_required else 'false'}"
        ),
        "",
        "【目标】",
        task.strip(),
    ]
    if any([profile, work_type, phase, protocol, review_required]):
        lines.extend([
            "",
            "【执行画像】",
            f"- profile={profile or 'default'}",
            f"- work_type={work_type or 'unknown'}",
            f"- phase={phase or 'unknown'}",
            f"- protocol={protocol or 'normal'}",
            f"- review_required={'true' if review_required else 'false'}",
        ])
    if skill_bundle:
        lines.extend([
            "",
            "【默认技能包】",
            "- " + ", ".join(str(item) for item in skill_bundle if str(item).strip()),
        ])
    lines.extend([
        "",
        "【上下文预算】",
        "- 默认只消费当前任务描述 + 最多 3 条相关历史摘要",
        "- 长日志、长调研、长 diff 一律写共享文件，不要直接塞回上下文",
        "- 如需详细历史，优先读取 context pack / report_path 的前 80 行",
    ])
    if context_summary:
        lines.extend([
            "",
            "【相关历史摘要】",
            context_summary,
        ])
    if context_path:
        lines.extend([
            "",
            "【上下文文件】",
            f"- 如需更多背景，先读取：{context_path}",
        ])
    lines.extend([
        "",
        "【执行约束】",
        "- 每 turn ≤500字；分段读文件，避免一次性灌长上下文",
        "- 大段内容写共享文件，不要直接塞进上下文或 RESULT",
        "- 如果遇到阻塞，立刻执行 failed 状态写入，然后输出 failure RESULT",
        f"- 详细报告默认写到：{report_path}",
        "- 若填写 report，summary 仍需自包含，不能只写“已写入报告”",
        "",
        "【文件读取强制要求】",
        "- cat -> head -n 60",
        "- grep/rg -> | head -20",
        "- 日志 -> tail -n 50",
        "",
        "【RESULT 规范】",
        "---RESULT---",
        f'{{"status":"success","summary":"{result_summary_contract(label, route)}","files":[],"report":"共享文件路径或null"}}',
        "",
        "【Fail Fast】",
        f"python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py failed --id {task_id} --summary \"阻塞原因（1句）：xxx，建议：xxx\"",
    ])
    return "\n".join(lines).strip()


def register_dispatched_task(
    *,
    task_id: str,
    label: str,
    model: str,
    tier: str,
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
    deps: list[str] | None = None,
    artifacts_json: dict | None = None,
) -> None:
    cmd = [
        "python3",
        TASK_STATE_PY,
        "upsert",
        "--id",
        task_id,
        "--label",
        label,
        "--model",
        model,
        "--status",
        "dispatched",
        "--tier",
        tier,
        "--task-description",
        task,
        "--expected-done",
        expected_done,
        "--source",
        "octopus",
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
    label: str,
    model: str,
    tier: str,
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
    artifacts_json: dict | None = None,
) -> None:
    register_dispatched_task(
        task_id=task_id,
        label=label,
        model=model,
        tier=tier,
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
    label: str = "",
    tier: str = "",
    model: str = "",
    runtime: str = DEFAULT_RUNTIME,
    stream_to: str = "",
    supports_acp: bool = False,
    parent_id: str = "",
    task_kind: str = "",
    register: bool = False,
    execute: bool | None = None,
    deps: list[str] | None = None,
    policy_decision: dict | None = None,
) -> dict:
    policy = policy_decision if isinstance(policy_decision, dict) else {}
    route_decision = policy.get("route_decision", {}) if isinstance(policy.get("route_decision", {}), dict) else {}
    model_policy = policy.get("model_policy", {}) if isinstance(policy.get("model_policy", {}), dict) else {}
    skill_policy = policy.get("skill_policy", {}) if isinstance(policy.get("skill_policy", {}), dict) else {}
    review_policy = policy.get("review_policy", {}) if isinstance(policy.get("review_policy", {}), dict) else {}
    prompt_policy = policy.get("prompt_contract", {}) if isinstance(policy.get("prompt_contract", {}), dict) else {}

    route_meta = infer_route(task)
    final_route = route or str(route_decision.get("route", "") or "") or route_meta.get("route", "spawn_single")
    if final_route not in ("spawn_single", "spawn_multi"):
        raise ValueError(f"octoclaw_spawn 只处理 spawn 路径，当前 route={final_route}")

    preliminary_profile = str(model_policy.get("profile", "") or "")
    hinted_worker_pool = str(route_decision.get("worker_pool", "") or "")
    hinted_work_type = str(route_decision.get("work_type", "") or "")
    hinted_phase = str(route_decision.get("phase", "") or "")
    derived_label = legacy_label_for_worker_pool(
        hinted_worker_pool,
        phase=hinted_phase,
        route=final_route,
        profile=preliminary_profile,
        role_hint=str(route_meta.get("role_hint", "") or ""),
    ) if hinted_worker_pool else ""
    final_label = label or str(model_policy.get("legacy_label", "") or "") or derived_label or route_meta.get("role_hint") or infer_label(task)
    if final_label in ("main", "octopus-runner", "octoclaw-main", "octoclaw-runner"):
        final_label = infer_label(task)
    final_tier = tier or str(model_policy.get("legacy_tier", "") or "") or route_meta.get("tier_hint") or infer_tier(task, final_label)
    worker_pool = hinted_worker_pool or worker_pool_from_legacy_label(final_label) or taxonomy_infer_worker_pool(final_route, hinted_work_type)
    work_type = hinted_work_type or str(
        taxonomy_resolve_work_type(
            {
                "worker_pool": worker_pool,
                "label": final_label,
                "route": final_route,
                "profile": preliminary_profile,
            }
        )
        or ""
    )
    if not worker_pool:
        worker_pool = taxonomy_infer_worker_pool(final_route, work_type)
    phase = hinted_phase or str(
        taxonomy_resolve_phase(
            {
                "worker_pool": worker_pool,
                "work_type": work_type,
                "label": final_label,
                "route": final_route,
                "profile": preliminary_profile,
            }
        )
        or ""
    )
    protocol = str(route_decision.get("protocol", "") or "")
    final_model = model or str(model_policy.get("selected_model", "") or "")
    thinking = str(model_policy.get("reasoning_effort", "") or "")
    if not final_model:
        fallback_worker_pool = worker_pool or worker_pool_from_legacy_label(final_label)
        final_model, resolved_thinking = resolve_model_and_thinking(
            final_tier,
            final_label,
            task,
            worker_pool=fallback_worker_pool,
            phase=phase,
            route=final_route,
            profile=preliminary_profile,
        )
        if not thinking:
            thinking = resolved_thinking
    if not final_model:
        raise ValueError("无法解析 spawn 模型")
    profile = preliminary_profile or resolve_profile(final_label, final_model, final_tier)
    skill_bundle = skill_policy.get("default_skill_bundle", [])
    if not isinstance(skill_bundle, list):
        skill_bundle = []
    review_required = bool(review_policy.get("required", False))
    final_task_kind = str(task_kind or "").strip() or ("team_parent" if final_route == "spawn_multi" else "subtask")
    spawn_team_name = resolve_spawn_team_name()
    base_artifacts = initial_spawn_artifacts(route=final_route, runtime=runtime, team_name=spawn_team_name)

    task_id = f"{final_label}-{now_compact()}"
    report_path = os.path.join(SHARED_DIR, f"{task_id}.md")
    context_bundle = build_context_bundle(task, parent_id, task_id)

    problems = validate_runtime(runtime, stream_to, supports_acp)
    if problems:
        error_text = "；".join(problems)
        log_spawn_error(task, error_text, runtime=runtime, stream_to=stream_to, parent_id=parent_id)
        register_failed_spawn_task(
            task_id=task_id,
            label=final_label,
            model=final_model,
            tier=final_tier,
            task=task,
            route=final_route,
            runtime=runtime,
            parent_id=parent_id,
            report_path=report_path,
            context_path=str(context_bundle.get("context_path", "") or ""),
            context_summary=str(context_bundle.get("summary", "") or ""),
            task_kind=final_task_kind,
            worker_pool=worker_pool,
            work_type=work_type,
            phase=phase,
            protocol=protocol,
            profile=profile,
            review_required=review_required,
            artifacts_json=base_artifacts,
            summary=f"spawn派发失败：{compact_text(error_text, 120)}",
        )
        raise ValueError(error_text)
    expected_done = expected_done_offset(final_tier)
    prompt = build_task_prompt(
        task_id=task_id,
        label=final_label,
        model=final_model,
        tier=final_tier,
        task=task,
        expected_done=expected_done,
        report_path=report_path,
        route=final_route,
        context_summary=str(context_bundle.get("summary", "") or ""),
        context_path=str(context_bundle.get("context_path", "") or ""),
        profile=profile,
        skill_bundle=skill_bundle,
        worker_pool=worker_pool,
        work_type=work_type,
        phase=phase,
        protocol=protocol,
        review_required=review_required,
    )

    if register:
        register_dispatched_task(
            task_id=task_id,
            label=final_label,
            model=final_model,
            tier=final_tier,
            task=task,
            expected_done=expected_done,
            route=final_route,
            runtime=runtime,
            report_path=report_path,
            parent_id=parent_id,
            context_path=str(context_bundle.get("context_path", "") or ""),
            context_summary=str(context_bundle.get("summary", "") or ""),
            task_kind=final_task_kind,
            worker_pool=worker_pool,
            work_type=work_type,
            phase=phase,
            protocol=protocol,
            profile=profile,
            review_required=review_required,
            deps=deps,
            artifacts_json=base_artifacts,
        )

    spawn_execution: dict[str, object] | None = None
    execution_error = ""
    executed = False
    if should_execute_spawn(final_route, runtime, explicit=execute):
        try:
            spawn_execution = execute_clawteam_spawn(
                task_id=task_id,
                label=final_label,
                model=final_model,
                tier=final_tier,
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
        "label": final_label,
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
        "label": final_label,
        "tier": final_tier,
        "model": final_model,
        "thinking": thinking,
        "profile": profile,
        "runtime": runtime,
        "stream_to": stream_to or "",
        "report_path": report_path,
        "task_kind": final_task_kind,
        "parent_id": parent_id,
        "deps": [str(dep).strip() for dep in (deps or []) if str(dep).strip()],
        "worker_pool": worker_pool,
        "work_type": work_type,
        "phase": phase,
        "protocol": protocol,
        "skill_bundle": skill_bundle,
        "review_required": review_required,
        "prompt_contract": prompt_policy,
        "context_summary": context_bundle.get("summary", ""),
        "context_path": context_bundle.get("context_path", ""),
        "context_refs": context_bundle.get("refs", []),
        "context_budget": context_bundle.get("budget", {}),
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
    parser.add_argument("--label", default="")
    parser.add_argument("--tier", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--runtime", default=DEFAULT_RUNTIME, choices=["subagent", "acp"])
    parser.add_argument("--stream-to", dest="stream_to", default="")
    parser.add_argument("--supports-acp", action="store_true")
    parser.add_argument("--parent-id", dest="parent_id", default="")
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

    spec = build_spawn_spec(
        args.task,
        route=args.route,
        label=args.label,
        tier=args.tier,
        model=args.model,
        runtime=args.runtime,
        stream_to=args.stream_to,
        supports_acp=args.supports_acp,
        parent_id=args.parent_id,
        register=args.register,
        execute=args.execute,
        policy_decision=policy_decision,
    )
    print(json.dumps(spec, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
