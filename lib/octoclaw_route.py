#!/usr/bin/env python3
"""Deterministic task router for OctoClaw.

This module is not a keyword toy router. It is a lightweight orchestration
decision layer that tries to answer three questions, in order:

1. Should the main agent handle this directly?
2. If not, should a persistent runner handle it?
3. If not, should we isolate the work into one or multiple subagents?

Design goals:
- stable before clever
- cheap to run
- explainable in production
- easy to improve with replay/eval feedback later

Output routes:
- direct: main agent should answer directly
- runner: lightweight local shell/status/log task
- spawn_single: one focused subagent
- spawn_multi: multiple subagents or staged planner/builder/review flow
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Iterable


RUNNER_PATTERNS = [
    r"\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk|ss|ps|top|netstat)\b",
    r"\b(log|logs|health|status|version|port|env|headers?|pid|process|uptime)\b",
    r"(日志|端口|版本|环境变量|连通性|健康检查|进程|服务状态|端口监听|磁盘|内存|cpu|负载)",
]

CODE_PATTERNS = [
    r"(写代码|改代码|修改代码|修复|bug|重构|实现|开发|review|评审|测试|回归)",
    r"\b(code|coding|fix|bug|refactor|implement|patch|review|test|pytest|regression)\b",
]

RESEARCH_PATTERNS = [
    r"(调研|对比|分析|研究|根因|方案|api|数据源|可行性)",
    r"\b(research|compare|analy|investigate|root cause|api|datasource|feasibility)\b",
]

EXTERNAL_LOOKUP_PATTERNS = [
    r"(天气|花粉|汇率|航班|酒店|机票|新闻|价格|行情|官网|接口文档|文档链接)",
    r"\b(weather|pollen|exchange rate|flight|hotel|price|news|official docs?|documentation)\b",
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

LOCAL_STATE_PATTERNS = [
    r"(这台机器|本机|服务器|机器上|当前机器|当前环境|本地环境|系统状态)",
    r"\b(this machine|host|server|local env|current machine|system status)\b",
]

VERIFY_PATTERNS = [
    r"(验证|确认|检查结果|回归|复现|复查|再看一下)",
    r"\b(verify|validation|regression|confirm|reproduce|double check)\b",
]

IMPLEMENT_PATTERNS = [
    r"(实现|落地|接入|修复|改一下|补上|生成代码|写脚本)",
    r"\b(implement|integrate|fix|patch|write code|script)\b",
]

MUTATION_PATTERNS = [
    r"(修改|改成|改为|更新|删除|新增|创建|写入|替换|迁移|重启|部署|安装|卸载|启用|禁用|调整)",
    r"(改cron|改配置|改任务|改脚本|改服务|更新配置|修改配置|修改任务|修改服务)",
    r"(后台执行|本地后台|只负责|避免.*中断|回读日志|触发并回读|更稳的方案)",
    r"\b(modify|change|update|delete|add|create|write|replace|migrate|restart|deploy|install|uninstall|enable|disable|tune)\b",
    r"\b(update cron|change cron|modify cron|update config|modify config|change config|update service|modify service)\b",
]

COST_SENSITIVE_PATTERNS = [
    r"(省钱|低成本|便宜点|别太贵)",
    r"\b(cost|cheap|budget|save money)\b",
]

SEMANTIC_AMBIGUITY_PATTERNS = [
    r"(顺手|顺便|一起|同时帮我|看看要不要|必要时|如果需要|最好|更稳的方案)",
    r"\b(if needed|if necessary|also help|at the same time|better approach|safer approach)\b",
]


def count_matches(text: str, patterns: Iterable[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.IGNORECASE))


def extract_features(task: str, command: str = "") -> dict:
    raw_task = (task or "").strip()
    text = raw_task.lower()
    command = (command or "").strip()

    runner_hits = count_matches(text, RUNNER_PATTERNS)
    code_hits = count_matches(text, CODE_PATTERNS)
    research_hits = count_matches(text, RESEARCH_PATTERNS)
    external_lookup_hits = count_matches(text, EXTERNAL_LOOKUP_PATTERNS)
    write_hits = count_matches(text, WRITE_PATTERNS)
    multi_step_hits = count_matches(text, MULTI_STEP_PATTERNS)
    parallel_hits = count_matches(text, PARALLEL_PATTERNS)
    high_risk_hits = count_matches(text, HIGH_RISK_PATTERNS)
    simple_hits = count_matches(text, SIMPLE_DIRECT_PATTERNS)
    local_state_hits = count_matches(text, LOCAL_STATE_PATTERNS)
    verify_hits = count_matches(text, VERIFY_PATTERNS)
    implement_hits = count_matches(text, IMPLEMENT_PATTERNS)
    mutation_hits = count_matches(text, MUTATION_PATTERNS)
    cost_sensitive_hits = count_matches(text, COST_SENSITIVE_PATTERNS)
    semantic_ambiguity_hits = count_matches(text, SEMANTIC_AMBIGUITY_PATTERNS)

    estimated_steps = 1
    if multi_step_hits > 0:
        estimated_steps += 1
    if research_hits > 0:
        estimated_steps += 1
    if code_hits > 0:
        estimated_steps += 1
    if write_hits > 0:
        estimated_steps += 1
    if parallel_hits > 0:
        estimated_steps += 1
    if verify_hits > 0:
        estimated_steps += 1
    if mutation_hits > 0:
        estimated_steps += 1
    if len(raw_task) > 140:
        estimated_steps += 1

    task_shape = "single_step"
    if estimated_steps >= 4 or parallel_hits > 0:
        task_shape = "staged"
    elif estimated_steps >= 2:
        task_shape = "multi_step"

    context_growth = "low"
    if code_hits > 0 or local_state_hits > 0 or verify_hits > 0 or mutation_hits > 0:
        context_growth = "medium"
    if estimated_steps >= 4 or mutation_hits > 0 or (research_hits > 0 and (code_hits > 0 or write_hits > 0)):
        context_growth = "high"

    latency_sensitivity = "normal"
    if local_state_hits > 0 or command:
        latency_sensitivity = "high"
    elif external_lookup_hits > 0 and research_hits == 0 and code_hits == 0:
        latency_sensitivity = "normal"

    features = {
        "task_length": len(raw_task),
        "has_command": bool(command),
        "runner_hits": runner_hits,
        "code_hits": code_hits,
        "research_hits": research_hits,
        "external_lookup_hits": external_lookup_hits,
        "write_hits": write_hits,
        "multi_step_hits": multi_step_hits,
        "parallel_hits": parallel_hits,
        "high_risk_hits": high_risk_hits,
        "simple_hits": simple_hits,
        "local_state_hits": local_state_hits,
        "verify_hits": verify_hits,
        "implement_hits": implement_hits,
        "mutation_hits": mutation_hits,
        "cost_sensitive_hits": cost_sensitive_hits,
        "semantic_ambiguity_hits": semantic_ambiguity_hits,
        "requires_tools": bool(command) or runner_hits > 0 or local_state_hits > 0,
        "requires_code_work": code_hits > 0,
        "requires_research": research_hits > 0,
        "requires_mutation": mutation_hits > 0 or (implement_hits > 0 and (code_hits > 0 or local_state_hits > 0)),
        "external_lookup_only": external_lookup_hits > 0 and research_hits == 0 and code_hits == 0 and write_hits == 0,
        "requires_writing": write_hits > 0,
        "estimated_steps": estimated_steps,
        "task_shape": task_shape,
        "multi_step": estimated_steps >= 2,
        "parallelizable": (
            parallel_hits > 0
            or (research_hits > 0 and write_hits > 0 and multi_step_hits > 0)
            or (verify_hits > 0 and (code_hits > 0 or implement_hits > 0))
        ),
        "local_observation_only": (
            (bool(command) or runner_hits > 0 or local_state_hits > 0)
            and mutation_hits == 0
            and implement_hits == 0
            and code_hits == 0
            and research_hits == 0
            and write_hits == 0
        ),
        "high_risk": high_risk_hits > 0,
        "context_growth": context_growth,
        "latency_sensitivity": latency_sensitivity,
        "simple_direct_candidate": simple_hits > 0 and runner_hits == 0 and code_hits == 0 and research_hits == 0 and local_state_hits == 0,
    }
    return features


def infer_role_hint(features: dict) -> str:
    if features["local_observation_only"]:
        return "octopus-runner"
    if features["requires_mutation"] and not features["requires_research"]:
        return "octopus-fix"
    if features["requires_code_work"]:
        return "octopus-fix"
    if features["requires_writing"] and not features["requires_research"]:
        return "octopus-writer"
    if features["requires_research"] and not features["requires_code_work"]:
        return "octopus-scout"
    if features["high_risk"]:
        return "octopus-analyze"
    return "octopus-power"


def infer_tier_hint(features: dict, route: str) -> str:
    if route == "runner":
        return "trivial"
    if route == "direct":
        return "simple"
    if features["high_risk"] or route == "spawn_multi":
        return "hard"
    if features["requires_code_work"] or features["requires_research"] or features["estimated_steps"] >= 3:
        return "normal"
    return "simple"


def expected_latency_ms(route: str, features: dict) -> int:
    if route == "runner":
        return 1500 if features["estimated_steps"] <= 2 else 3500
    if route == "direct":
        return 1200 if features["task_length"] <= 80 else 3500
    if route == "spawn_single":
        return 12000 if features["requires_code_work"] else 9000
    return 18000


def expected_cost_band(route: str, features: dict) -> str:
    if route == "runner":
        return "low"
    if route == "direct":
        return "low" if not features["requires_research"] else "medium"
    if route == "spawn_single":
        return "medium"
    return "high"


def infer_task_class(features: dict, route: str) -> str:
    if route == "runner":
        return "fast_local_check"
    if features["requires_mutation"] and route.startswith("spawn"):
        return "focused_local_change"
    if route == "direct" and features["external_lookup_only"]:
        return "simple_lookup"
    if route == "direct":
        return "direct_answer"
    if route == "spawn_multi":
        return "staged_workflow"
    if features["requires_code_work"]:
        return "focused_code_work"
    if features["requires_research"]:
        return "focused_research"
    return "focused_subtask"


def infer_execution_owner(route: str) -> str:
    if route == "direct":
        return "main_agent"
    if route == "runner":
        return "persistent_runner"
    return "subagent"


def choose_semantic_model_hint() -> str:
    try:
        from octopus_config import MODEL_POLICY_FILE, load_json  # lazy import to keep route script cheap

        policy = load_json(MODEL_POLICY_FILE)
        if isinstance(policy, dict):
            labels = policy.get("labels", {})
            if isinstance(labels, dict):
                model_id = str(labels.get("octopus-router", "") or labels.get("octopus-runner", "") or "")
                if model_id:
                    return model_id
    except Exception:
        pass
    return "minimax-portal/MiniMax-M2.7-highspeed"


def should_request_semantic_review(features: dict, scores: dict, route: str) -> tuple[bool, float, str]:
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if len(ordered) < 2:
        return False, 1.0, ""
    top_route, top_score = ordered[0]
    second_route, second_score = ordered[1]
    margin = round(float(top_score) - float(second_score), 3)

    if route == "direct":
        return False, margin, ""

    if features["requires_mutation"] and route == "runner":
        return True, margin, "mutation_vs_runner"

    if features["semantic_ambiguity_hits"] > 0 and margin < 0.55:
        return True, margin, "ambiguous_task_shape"

    if features["requires_research"] and features["requires_tools"] and margin < 0.6:
        return True, margin, "research_with_tools"

    if features["estimated_steps"] >= 3 and top_route != second_route and margin < 0.45:
        return True, margin, "close_score_multi_step"

    return False, margin, ""


def hard_gate_route(features: dict) -> tuple[str | None, list[str]]:
    reasons: list[str] = []

    if features["has_command"]:
        return "runner", ["explicit_command"]

    if (
        features["external_lookup_only"]
        and not features["requires_tools"]
        and not features["requires_mutation"]
        and not features["high_risk"]
        and features["estimated_steps"] <= 2
    ):
        return "direct", ["single_round_external_lookup"]

    if features["requires_mutation"]:
        reasons = ["mutation_requires_isolation"]
        if features["local_state_hits"] > 0:
            reasons.append("local_change_task")
        if features["high_risk"]:
            reasons.append("high_risk_mutation")
        return "spawn_single", reasons

    if (
        features["local_observation_only"]
        and features["estimated_steps"] <= 2
    ):
        return "runner", ["fast_local_tool_task"]

    if (
        not features["requires_tools"]
        and not features["requires_code_work"]
        and not features["requires_research"]
        and not features["requires_writing"]
        and not features["high_risk"]
        and features["estimated_steps"] <= 2
        and features["task_length"] <= 140
    ):
        return "direct", ["short_low_context_direct"]

    if features["parallelizable"] and (features["estimated_steps"] >= 3 or (features["requires_research"] and (features["requires_code_work"] or features["requires_writing"]))):
        return "spawn_multi", ["staged_parallel_work"]

    if features["requires_code_work"] and not features["parallelizable"]:
        reasons.append("code_work_isolate_context")
        if features["high_risk"]:
            reasons.append("high_risk_code_work")
        return "spawn_single", reasons

    if features["requires_research"] and not features["external_lookup_only"]:
        return "spawn_single", ["structured_research_task"]

    return None, reasons


def infer_route(task: str, command: str = "") -> dict:
    features = extract_features(task, command)

    direct_score = 0.0
    runner_score = 0.0
    spawn_single_score = 0.0
    spawn_multi_score = 0.0
    reason_codes: list[str] = []

    hard_route, hard_reasons = hard_gate_route(features)
    if hard_route:
        route = hard_route
        scores = {"direct": 0.0, "runner": 0.0, "spawn_single": 0.0, "spawn_multi": 0.0}
        scores[route] = 1.0
        reason_codes.extend(hard_reasons)
    else:
        if features["simple_direct_candidate"]:
            direct_score += 0.9
            reason_codes.append("simple_direct_candidate")

        if not features["requires_tools"] and features["task_length"] <= 120 and features["estimated_steps"] <= 2:
            direct_score += 0.6
            reason_codes.append("small_context_task")

        if features["external_lookup_only"] and features["estimated_steps"] <= 2:
            direct_score += 0.5
            reason_codes.append("single_round_lookup")

        if features["requires_tools"]:
            runner_score += 0.7
            spawn_single_score += 0.15
            reason_codes.append("tool_needed")

        if features["requires_mutation"]:
            runner_score -= 0.8
            spawn_single_score += 1.15
            spawn_multi_score += 0.1
            reason_codes.append("mutation_work")

        if features["local_state_hits"] > 0:
            runner_score += 0.8
            reason_codes.append("local_state_inspection")

        if features["requires_code_work"]:
            spawn_single_score += 1.0
            reason_codes.append("code_work")

        if features["requires_research"]:
            spawn_single_score += 0.7
            reason_codes.append("research_work")

        if features["requires_writing"]:
            spawn_single_score += 0.3
            reason_codes.append("writing_work")

        if features["multi_step"]:
            spawn_single_score += 0.55
            reason_codes.append("multi_step")

        if features["parallelizable"]:
            spawn_multi_score += 0.95
            reason_codes.append("parallelizable")

        if features["parallelizable"] and features["estimated_steps"] >= 3:
            spawn_multi_score += 0.8
            reason_codes.append("parallelizable_staged_work")

        if features["high_risk"]:
            spawn_single_score += 0.65
            spawn_multi_score += 0.35
            reason_codes.append("high_risk")

        if features["verify_hits"] > 0 and (features["requires_code_work"] or features["requires_research"]):
            spawn_multi_score += 0.45
            reason_codes.append("verification_after_work")

        if features["requires_tools"] and (features["requires_code_work"] or features["requires_research"]):
            runner_score -= 0.4
            spawn_single_score += 0.4
            reason_codes.append("tool_plus_reasoning")

        if features["local_state_hits"] > 0 and features["requires_mutation"]:
            runner_score -= 0.6
            spawn_single_score += 0.45
            reason_codes.append("local_change_not_runner")

        if features["cost_sensitive_hits"] > 0 and features["requires_tools"] and not features["requires_code_work"]:
            runner_score += 0.1
            reason_codes.append("cost_sensitive_fast_path")

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
            reason_codes.append("prefer_stability_over_ambiguous_direct")
        elif route == "runner" and scores["spawn_single"] >= 0.95 and features["requires_research"]:
            route = "spawn_single"
            reason_codes.append("prefer_research_isolation_over_runner")
    if hard_route:
        confidence = 0.92 if route in ("runner", "direct") else 0.88

    needs_semantic_review, score_margin, semantic_reason = should_request_semantic_review(features, scores, route)
    semantic_model_hint = choose_semantic_model_hint() if needs_semantic_review else ""

    role_hint = infer_role_hint(features)
    if route == "direct":
        role_hint = "main"
    elif route == "runner":
        role_hint = "octopus-runner"
    elif route == "spawn_multi":
        role_hint = "octopus-power"

    tier_hint = infer_tier_hint(features, route)
    should_wait = route == "runner"
    wait_timeout_seconds = 0
    if route == "runner":
        wait_timeout_seconds = 8 if features["estimated_steps"] <= 2 else 12

    return {
        "route": route,
        "confidence": confidence,
        "reason": reason_codes[0] if reason_codes else "default_route",
        "reasons": reason_codes,
        "reason_codes": reason_codes,
        "scores": scores,
        "features": features,
        "task_class": infer_task_class(features, route),
        "role_hint": role_hint,
        "tier_hint": tier_hint,
        "expected_latency_ms": expected_latency_ms(route, features),
        "expected_cost_band": expected_cost_band(route, features),
        "context_growth_band": features["context_growth"],
        "execution_owner": infer_execution_owner(route),
        "dispatch_required": route != "direct",
        "main_agent_can_execute_directly": route == "direct",
        "should_wait": should_wait,
        "wait_timeout_seconds": wait_timeout_seconds,
        "needs_semantic_review": needs_semantic_review,
        "semantic_review_reason": semantic_reason,
        "score_margin": score_margin,
        "semantic_model_hint": semantic_model_hint,
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
