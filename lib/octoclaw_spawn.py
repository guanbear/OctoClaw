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
import subprocess
import sys
from datetime import datetime, timezone

from learning_log import append_error_entry
from octoclaw_route import infer_route
from octopus_config import CONTEXT_DIR, SHARED_DIR, TASK_STATE_FILE, load_json


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


def resolve_model_and_thinking(tier: str, label: str, description: str) -> tuple[str, str]:
    result = subprocess.run(
        ["python3", RESOLVE_MODEL_PY, "--tier", tier, "--label", label, "--description", description],
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
) -> str:
    lines = [
        "【状态写入】开始前先执行：",
        f"python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py upsert --id {task_id} --label {label} --model '{model}' --status running --tier {tier} --expected-done '{expected_done}' --route {route} --runtime subagent --executor subagent --report-path '{report_path}'",
        "",
        "【目标】",
        task.strip(),
        "",
        "【上下文预算】",
        "- 默认只消费当前任务描述 + 最多 3 条相关历史摘要",
        "- 长日志、长调研、长 diff 一律写共享文件，不要直接塞回上下文",
        "- 如需详细历史，优先读取 context pack / report_path 的前 80 行",
    ]
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
        "",
        "【文件读取强制要求】",
        "- cat -> head -n 60",
        "- grep/rg -> | head -20",
        "- 日志 -> tail -n 50",
        "",
        "【RESULT 规范】",
        "---RESULT---",
        '{"status":"success","summary":"2-5句结论，每句≤30字，禁列表/表格/代码块","files":[],"report":"共享文件路径或null"}',
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
    ]
    if context_path:
        cmd.extend(["--context-path", context_path])
    if context_summary:
        cmd.extend(["--context-summary", compact_text(context_summary, 240)])
    if parent_id:
        cmd.extend(["--parent-id", parent_id])
    subprocess.run(cmd, check=True, capture_output=True, text=True)


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
    register: bool = False,
) -> dict:
    route_meta = infer_route(task)
    final_route = route or route_meta.get("route", "spawn_single")
    if final_route not in ("spawn_single", "spawn_multi"):
        raise ValueError(f"octoclaw_spawn 只处理 spawn 路径，当前 route={final_route}")

    final_label = label or route_meta.get("role_hint") or infer_label(task)
    if final_label in ("main", "octopus-runner"):
        final_label = infer_label(task)
    final_tier = tier or route_meta.get("tier_hint") or infer_tier(task, final_label)
    final_model, thinking = resolve_model_and_thinking(final_tier, final_label, task)
    if model:
        final_model = model
    if not final_model:
        raise ValueError("无法解析 spawn 模型")

    problems = validate_runtime(runtime, stream_to, supports_acp)
    if problems:
        error_text = "；".join(problems)
        log_spawn_error(task, error_text, runtime=runtime, stream_to=stream_to, parent_id=parent_id)
        raise ValueError(error_text)

    task_id = f"{final_label}-{now_compact()}"
    expected_done = expected_done_offset(final_tier)
    report_path = os.path.join(SHARED_DIR, f"{task_id}.md")
    context_bundle = build_context_bundle(task, parent_id, task_id)
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
        "runtime": runtime,
        "stream_to": stream_to or "",
        "report_path": report_path,
        "context_summary": context_bundle.get("summary", ""),
        "context_path": context_bundle.get("context_path", ""),
        "context_refs": context_bundle.get("refs", []),
        "context_budget": context_bundle.get("budget", {}),
        "expected_done": expected_done,
        "task_prompt": prompt,
        "task_prompt_preview": prompt[:320] + ("…" if len(prompt) > 320 else ""),
        "handoff": {
            "kind": "plan",
            "status": "planned",
            "summary": "已生成统一子任务派发规范。",
            "reply_text": "我会按 OctoClaw 统一 spawn 规范派给子任务处理。",
            "report_path": report_path,
            "user_safe": True,
        },
        "sessions_spawn_payload": payload,
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
    parser.add_argument("--register", action="store_true")
    args = parser.parse_args()

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
    )
    print(json.dumps(spec, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
