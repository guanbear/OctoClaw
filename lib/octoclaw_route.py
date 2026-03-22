#!/usr/bin/env python3
"""Deterministic task router for OctoClaw.

This router does not try to be magically perfect. It aims to be:
- stable
- explainable
- cheap to run
- easy to improve with feedback later

Output routes:
- direct: main agent should answer directly
- runner: lightweight shell/status/log task
- spawn_single: one focused subagent
- spawn_multi: multiple subagents or staged planner/builder/review flow
"""

from __future__ import annotations

import argparse
import json
import re


RUNNER_PATTERNS = [
    r"\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk|ss|ps|top|netstat)\b",
    r"\b(log|logs|health|status|version|port|env|headers?|pid|process|uptime)\b",
    r"(查|检查|看看|看下|状态|日志|端口|版本|环境变量|接口|请求|连通性|健康检查|进程)",
]

CODE_PATTERNS = [
    r"(写代码|改代码|修改代码|修复|bug|重构|实现|开发|review|评审|测试|回归)",
    r"\b(code|coding|fix|bug|refactor|implement|patch|review|test|pytest|regression)\b",
]

RESEARCH_PATTERNS = [
    r"(调研|对比|分析|研究|根因|方案|api|数据源|可行性)",
    r"\b(research|compare|analy|investigate|root cause|api|datasource|feasibility)\b",
]

WRITE_PATTERNS = [
    r"(文档|总结|报告|草稿|说明|翻译|写一篇)",
    r"\b(doc|docs|summary|report|draft|write|translate)\b",
]

MULTI_STEP_PATTERNS = [
    r"(先.*再|然后|最后|并给出|顺便|同时需要|分别|先查.*再)",
    r"\b(first.*then|then|finally|also|and give|meanwhile|in parallel)\b",
]

PARALLEL_PATTERNS = [
    r"(并行|同时|分别处理|一边.*一边)",
    r"\b(parallel|simultaneous|separately)\b",
]

HIGH_RISK_PATTERNS = [
    r"(支付|认证|鉴权|登录|生产|数据库|迁移|权限|安全|发布)",
    r"\b(payment|auth|authentication|login|prod|production|database|migration|permission|security|release)\b",
]

SIMPLE_DIRECT_PATTERNS = [
    r"(是什么|什么意思|解释一下|简单说说|怎么理解)",
    r"\b(what is|explain|summarize|meaning)\b",
]


def count_matches(text: str, patterns: list[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.IGNORECASE))


def extract_features(task: str, command: str = "") -> dict:
    raw_task = (task or "").strip()
    text = raw_task.lower()
    command = (command or "").strip()

    runner_hits = count_matches(text, RUNNER_PATTERNS)
    code_hits = count_matches(text, CODE_PATTERNS)
    research_hits = count_matches(text, RESEARCH_PATTERNS)
    write_hits = count_matches(text, WRITE_PATTERNS)
    multi_step_hits = count_matches(text, MULTI_STEP_PATTERNS)
    parallel_hits = count_matches(text, PARALLEL_PATTERNS)
    high_risk_hits = count_matches(text, HIGH_RISK_PATTERNS)
    simple_hits = count_matches(text, SIMPLE_DIRECT_PATTERNS)

    features = {
        "task_length": len(raw_task),
        "has_command": bool(command),
        "runner_hits": runner_hits,
        "code_hits": code_hits,
        "research_hits": research_hits,
        "write_hits": write_hits,
        "multi_step_hits": multi_step_hits,
        "parallel_hits": parallel_hits,
        "high_risk_hits": high_risk_hits,
        "simple_hits": simple_hits,
        "requires_tools": bool(command) or runner_hits > 0,
        "requires_code_work": code_hits > 0,
        "requires_research": research_hits > 0,
        "requires_writing": write_hits > 0,
        "multi_step": multi_step_hits > 0 or len(raw_task) > 120,
        "parallelizable": parallel_hits > 0 or ((research_hits > 0) and (code_hits > 0 or write_hits > 0)),
        "high_risk": high_risk_hits > 0,
        "simple_direct_candidate": simple_hits > 0 and runner_hits == 0 and code_hits == 0 and research_hits == 0,
    }
    return features


def infer_route(task: str, command: str = "") -> dict:
    features = extract_features(task, command)

    direct_score = 0.0
    runner_score = 0.0
    spawn_single_score = 0.0
    spawn_multi_score = 0.0
    reasons: list[str] = []

    if features["has_command"]:
        runner_score += 1.2
        reasons.append("explicit_command")

    if features["requires_tools"]:
        runner_score += 0.7
        spawn_single_score += 0.2
        reasons.append("tool_needed")

    if features["simple_direct_candidate"] and features["task_length"] <= 80:
        direct_score += 1.0
        reasons.append("simple_direct_candidate")

    if not features["requires_tools"] and not features["multi_step"] and not features["requires_code_work"] and not features["requires_research"] and features["task_length"] <= 100:
        direct_score += 0.8
        reasons.append("short_no_tool_task")

    if features["requires_code_work"]:
        spawn_single_score += 1.0
        reasons.append("code_work")

    if features["requires_research"]:
        spawn_single_score += 0.8
        reasons.append("research_work")

    if features["requires_writing"]:
        spawn_single_score += 0.4
        reasons.append("writing_work")

    if features["multi_step"]:
        spawn_single_score += 0.7
        reasons.append("multi_step")

    if features["parallelizable"]:
        spawn_multi_score += 1.1
        reasons.append("parallelizable")
        if features["multi_step"] or ((features["requires_research"] and features["requires_code_work"]) or (features["requires_research"] and features["requires_writing"])):
            spawn_multi_score += 0.9
            reasons.append("parallelizable_staged_work")

    if features["high_risk"]:
        spawn_single_score += 0.8
        spawn_multi_score += 0.4
        reasons.append("high_risk")

    if features["requires_tools"] and not features["requires_code_work"] and not features["requires_research"] and not features["requires_writing"] and features["task_length"] <= 120:
        runner_score += 0.8
        reasons.append("fast_tool_task")

    if features["requires_tools"] and (features["requires_code_work"] or features["requires_research"]):
        runner_score -= 0.4
        spawn_single_score += 0.5
        reasons.append("tool_plus_reasoning")

    scores = {
        "direct": round(direct_score, 3),
        "runner": round(runner_score, 3),
        "spawn_single": round(spawn_single_score, 3),
        "spawn_multi": round(spawn_multi_score, 3),
    }

    route = max(scores, key=scores.get)
    confidence = round(min(1.0, max(scores.values()) / 2.0), 3)

    if route == "direct" and scores["spawn_single"] >= 0.9:
        route = "spawn_single"
        reasons.append("prefer_stability_over_ambiguous_direct")

    return {
        "route": route,
        "confidence": confidence,
        "reason": reasons[0] if reasons else "default_route",
        "reasons": reasons,
        "scores": scores,
        "features": features,
        "source": (task or "").strip(),
    }


def main():
    parser = argparse.ArgumentParser(description="Deterministic OctoClaw route decision")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    args = parser.parse_args()
    print(json.dumps(infer_route(args.task, args.command), ensure_ascii=False))


if __name__ == "__main__":
    main()
