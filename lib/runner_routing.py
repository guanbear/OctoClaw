#!/usr/bin/env python3
"""Heuristic router for lightweight runner tasks."""

from __future__ import annotations

import argparse
import json
import re
import sys


RUNNER_PATTERNS = [
    r"\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk)\b",
    r"\b(log|logs|health|status|version|port|env|headers?)\b",
    r"(查|检查|看看|看下|状态|日志|端口|版本|环境变量|接口|请求|连通性|健康检查)",
]

NON_RUNNER_PATTERNS = [
    r"(重构|设计|架构|实现|开发|写代码|修改代码|review|评审|方案|对比分析|根因分析)",
    r"\b(refactor|architect|design|implement|code review|analysis|root cause)\b",
    r"(多个文件|多文件|整个项目|全局修改|跨文件)",
]


def route_task(text: str) -> dict:
    source = (text or "").strip()
    lowered = source.lower()
    reasons = []

    for pattern in NON_RUNNER_PATTERNS:
        if re.search(pattern, source, re.IGNORECASE):
            return {"route": "spawn", "confidence": 0.9, "reason": "matched_non_runner_pattern", "source": source}

    score = 0
    for pattern in RUNNER_PATTERNS:
        if re.search(pattern, lowered, re.IGNORECASE):
            score += 1
            reasons.append(pattern)

    if len(source) <= 80 and score >= 1:
        return {"route": "runner", "confidence": 0.75, "reason": "matched_runner_pattern", "matched": reasons, "source": source}
    if score >= 2:
        return {"route": "runner", "confidence": 0.85, "reason": "matched_multiple_runner_patterns", "matched": reasons, "source": source}
    return {"route": "spawn", "confidence": 0.55, "reason": "default_spawn", "source": source}


def main():
    parser = argparse.ArgumentParser(description="Classify whether a task should go to Octopus runner")
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    print(json.dumps(route_task(args.task), ensure_ascii=False))


if __name__ == "__main__":
    main()
