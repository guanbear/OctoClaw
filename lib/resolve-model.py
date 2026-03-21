#!/usr/bin/env python3
"""
resolve-model.py — 八爪鱼统一模型选择入口
用法: python3 resolve-model.py --tier hard [--label octopus-fix] [--description "任务描述"]
输出: 完整模型路径，如 vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6

选模型优先级:
1. 读 /tmp/ironclaw-global-degradation.json: active=true → override_mode 覆盖当前模式
2. 读 /workspace/tmp/octopus-mode.json: rules[mode][tier][0] 取短名
3. 短名映射 → 完整路径（从 octopus-model-aliases.json 推断，或内置映射）
4. 读 /tmp/ironclaw-model-guard-override.json: guarded=true 且选出模型==original_model → 改用 current_model
5. 多维度描述分析（ClawRouter启发）：--description 若建议更高tier则自动升级
6. 输出最终路径
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

from octopus_config import MODEL_POLICY_FILE, load_json as load_shared_json

GLOBAL_DEG_FILE = "/tmp/ironclaw-global-degradation.json"
MODE_FILE = "/workspace/tmp/octopus-mode.json"
ALIASES_FILE = "/workspace/tmp/octopus-model-aliases.json"
GUARD_FILE = "/tmp/ironclaw-model-guard-override.json"
CACHE_FILE = "/tmp/octopus-model-cache.json"
CACHE_TTL = 1800  # 30 分钟

# 内置短名到完整路径的静态映射（最终 fallback，仅在别名文件无法推断时使用）
BUILTIN_MAP = {
    "glm": "lixiang-glm-5/kivy-glm-5",
    "sonnet": "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6",
    "claudeopus": "vendor-claude-opus-4-6/aws-claude-opus-4-6",
    "gpt54": "openai/gpt-5.4",
    "glm5": "lixiang-glm-5/kivy-glm-5",
    "minimax": "minimax/minimax-m2.7",
}

VALID_TIERS = ["trivial", "simple", "normal", "hard", "deep"]

# 多维度关键词权重（ClawRouter 启发，15维度简化版）
# 正分 → 建议升级tier；负分 → 建议降级tier
# 仅用于升级安全网（不降级，尊重主 Agent 判断）
_SCORING_RULES = [
    # (weight, pattern_list, dimension_name)
    # 代码维度 (+0.15): 含代码标志 → 至少 normal
    (0.15, [r"```", r"\bdef\b", r"\bclass\b", r"\bfunction\b", r"\bimport\b",
             r"\breturn\b", r"=>", r"\basync\b", r"\bawait\b"], "code"),
    # 复杂度维度 (+0.18): 架构/重构/分布式 → hard/deep
    (0.18, [r"\b(architect|重构|refactor|distributed|分布式|design pattern|设计模式|"
             r"scalab|优化系统|system design|microservice|微服务)\b"], "complexity"),
    # 推理维度 (+0.18): 分析/比较/论证 → deep
    (0.18, [r"\b(analyz|分析|compar|比较|prove|论证|step.by.step|逐步|"
             r"root cause|根因|tradeoff|权衡|综合评估)\b"], "reasoning"),
    # Agentic 维度 (+0.08): 部署/运行/测试/批量 → normal+
    (0.08, [r"\b(deploy|部署|run tests|运行测试|execute|批量|batch|migrate|迁移|"
             r"rollout|上线|pipeline)\b"], "agentic"),
    # 多文件维度 (+0.10): 涉及多个文件 → hard
    (0.10, [r"\b(multiple files|多个文件|across files|整个项目|全局|codebase|"
             r"all.*\.py|所有.*文件)\b"], "multi_file"),
    # 简单维度 (-0.12): 明显简单任务 → 不升级
    (-0.12, [r"\b(what is|是什么|translate|翻译|rename|重命名|typo|拼写|"
              r"add comment|加注释|fix typo|简单|simple change|一行)\b"], "simple"),
    # 创意/写作维度 (+0.05): 内容创作略高于 trivial
    (0.05, [r"\b(write.*article|写.*文章|draft|起草|creative|创意|blog|文案)\b"], "creative"),
    # 约束维度 (+0.06): 多约束条件 → 更高模型
    (0.06, [r"\b(must|必须|require|要求|ensure|保证|constraint|限制|comply|符合|"
             r"standard|规范)\b"], "constraint"),
]

# tier 数值映射（用于比较高低）
_TIER_RANK = {t: i for i, t in enumerate(VALID_TIERS)}


def score_description_complexity(description: str) -> str | None:
    """
    对任务描述进行多维度关键词评分，返回建议 tier 或 None（无法判断）。
    只用于升级安全网：若建议 tier > 请求 tier 则升级，否则保持原 tier。
    评分 < -0.05 → trivial；-0.05~0.10 → simple；0.10~0.25 → normal；
    0.25~0.40 → hard；> 0.40 → deep
    """
    if not description or len(description.strip()) < 5:
        return None

    text = description.lower()
    total_score = 0.0
    matched_dims = []

    for weight, patterns, dim_name in _SCORING_RULES:
        for pat in patterns:
            if re.search(pat, text, re.IGNORECASE):
                total_score += weight
                matched_dims.append(f"{dim_name}({weight:+.2f})")
                break  # 每维度只计一次

    # 无任何维度匹配 → 无法判断
    if not matched_dims:
        return None

    # 评分 → tier
    if total_score < -0.05:
        suggested = "trivial"
    elif total_score < 0.10:
        suggested = "simple"
    elif total_score < 0.25:
        suggested = "normal"
    elif total_score < 0.40:
        suggested = "hard"
    else:
        suggested = "deep"

    print(
        f"INFO: description scoring: score={total_score:.2f} dims=[{', '.join(matched_dims)}] → {suggested}",
        file=sys.stderr,
    )
    return suggested


def load_json(path):
    """安全读取 JSON 文件，不存在或解析失败返回 None。"""
    return load_shared_json(path)


def _get_ironclaw_guarded() -> bool:
    """检测铁甲虾 guard 是否激活（仅检查文件存在且 guarded=true）。"""
    data = load_json(GUARD_FILE)
    return bool(data and data.get("guarded") is True)


def _get_current_mode() -> str:
    """读取当前 octopus mode（已考虑全局降级）。"""
    deg_data = load_json(GLOBAL_DEG_FILE)
    if deg_data and deg_data.get("active") is True:
        override = deg_data.get("override_mode")
        if override:
            return override
    mode_data = load_json(MODE_FILE)
    if mode_data:
        return mode_data.get("mode", "balanced")
    return "balanced"


def read_cache(tier: str) -> str | None:
    """
    尝试读取模型缓存。命中返回模型路径，未命中返回 None。
    命中条件：
      1. 缓存文件存在且未过期（generated_at + ttl > now）
      2. mode 与当前一致
      3. ironclaw_guarded 状态与当前一致
    """
    cache = load_json(CACHE_FILE)
    if not cache:
        return None
    now = int(time.time())
    generated_at = cache.get("generated_at", 0)
    ttl = cache.get("ttl", CACHE_TTL)
    if now - generated_at > ttl:
        return None
    if cache.get("mode") != _get_current_mode():
        return None
    if cache.get("ironclaw_guarded") != _get_ironclaw_guarded():
        return None
    models = cache.get("models", {})
    return models.get(tier)


def write_cache(mode: str, ironclaw_guarded: bool, models: dict) -> None:
    """将所有 tier 的模型结果写入缓存文件。"""
    cache = {
        "generated_at": int(time.time()),
        "ttl": CACHE_TTL,
        "mode": mode,
        "ironclaw_guarded": ironclaw_guarded,
        "models": models,
    }
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"WARNING: 写入模型缓存失败: {e}", file=sys.stderr)


def build_short_name_map(aliases: dict) -> dict:
    """
    从 aliases 文件推断短名 → 完整路径映射。
    aliases 格式: {tier: "vendor-model/provider-model", ...}
    我们把 aliases 里出现的路径，按已知短名特征归类。
    """
    mapping = {}
    for tier, full_path in aliases.items():
        if tier in ("updated_at", "_note"):
            continue
        if not isinstance(full_path, str) or "/" not in full_path:
            continue
        lower = full_path.lower()
        if "glm" in lower:
            mapping.setdefault("glm", full_path)
        elif "sonnet" in lower:
            mapping.setdefault("sonnet", full_path)
        elif "opus" in lower:
            mapping.setdefault("claudeopus", full_path)
        elif "gpt-5.4" in lower:
            mapping.setdefault("gpt54", full_path)
        elif "minimax" in lower or "m2.7" in lower:
            mapping.setdefault("minimax", full_path)
    return mapping


def resolve_auto_policy_model(tier: str, label: str) -> str | None:
    policy = load_json(MODEL_POLICY_FILE)
    if not isinstance(policy, dict):
        return None
    labels = policy.get("labels", {})
    tiers = policy.get("tiers", {})
    if label and isinstance(labels, dict):
        label_model = labels.get(label)
        if isinstance(label_model, str) and label_model:
            return label_model
    if isinstance(tiers, dict):
        tier_model = tiers.get(tier)
        if isinstance(tier_model, str) and tier_model:
            return tier_model
    return None


def resolve_short_name(short_name: str, aliases_data: dict | None) -> str:
    """把短名解析为完整路径。先尝试别名文件推断，再 fallback 到内置映射。"""
    # 如果已经是完整路径（含 /），直接返回
    if "/" in short_name:
        return short_name

    # 从 aliases 文件推断
    if aliases_data:
        inferred = build_short_name_map(aliases_data)
        if short_name in inferred:
            return inferred[short_name]

    # 内置静态映射
    if short_name in BUILTIN_MAP:
        return BUILTIN_MAP[short_name]

    # 无法映射，fallback 到 sonnet 并输出警告
    print(f"WARNING: unknown model short name '{short_name}', falling back to sonnet", file=sys.stderr)
    return BUILTIN_MAP["sonnet"]


def main():
    parser = argparse.ArgumentParser(description="八爪鱼统一模型选择入口")
    parser.add_argument("--tier", required=True, choices=VALID_TIERS, help="任务级别")
    parser.add_argument("--label", default="", help="任务标签（仅用于日志，不影响选模型）")
    parser.add_argument("--description", default="", help="任务描述（用于多维度复杂度评分，可升级tier）")
    args = parser.parse_args()

    tier = args.tier

    # ── Step 0: 检查模型缓存 ─────────────────────────────────────────────
    # 注意：description 评分结果不进缓存（缓存仅按 mode/guard 状态）
    # 缓存命中后若有 description 仍需做升级检测
    cached_model = read_cache(tier)
    if cached_model:
        # 即使命中缓存，也检查 description 是否建议升级 tier
        if args.description:
            suggested_tier = score_description_complexity(args.description)
            if suggested_tier and _TIER_RANK[suggested_tier] > _TIER_RANK[tier]:
                print(
                    f"INFO: description suggests upgrading tier {tier} → {suggested_tier} (cache bypass)",
                    file=sys.stderr,
                )
                tier = suggested_tier
                cached_model = read_cache(tier)
        if cached_model:
            print(f"INFO: 命中模型缓存 tier={tier} model={cached_model}", file=sys.stderr)
            print(cached_model)
            return

    # ── Step 1: 全局降级检测 ──────────────────────────────────────────────
    override_mode = None
    deg_data = load_json(GLOBAL_DEG_FILE)
    if deg_data and deg_data.get("active") is True:
        override_mode = deg_data.get("override_mode")

    # ── Step 2: 读 octopus-mode.json，确定最终 mode ───────────────────────
    mode_data = load_json(MODE_FILE)
    if not mode_data:
        # 文件不存在时 fallback 到 balanced
        mode_data = {"mode": "balanced", "modes": {}}

    mode = override_mode if override_mode else mode_data.get("mode", "balanced")
    rules = mode_data.get("modes", {})

    auto_policy_model = resolve_auto_policy_model(tier, args.label) if mode == "auto" else None
    if auto_policy_model:
        short_name = auto_policy_model
    # custom 模式：直接读 modes.custom[tier]
    elif mode == "custom":
        tier_list = rules.get("custom", {}).get(tier, [])
        short_name = tier_list[0] if tier_list else None
    else:
        tier_list = rules.get(mode, {}).get(tier, [])
        short_name = tier_list[0] if tier_list else None

    # ── Step 3: 短名 → 完整路径（从别名文件推断）───────────────────────────
    aliases_data = load_json(ALIASES_FILE)

    # 如果 rules 里没找到，用别名文件作 fallback
    if not short_name:
        if aliases_data and tier in aliases_data:
            full_path = aliases_data[tier]
            if isinstance(full_path, str) and "/" in full_path:
                short_name = full_path  # 别名文件已经是完整路径
        if not short_name:
            # 最终 fallback：balanced 模式逻辑
            short_name = "glm" if tier in ("trivial", "simple", "normal") else "sonnet"

    full_path = resolve_short_name(short_name, aliases_data)

    # ── Step 3.5: 多维度描述升级检测 ─────────────────────────────────────
    # 若 description 建议更高 tier → 重新按更高 tier 选模型（仅升级，不降级）
    if args.description:
        suggested_tier = score_description_complexity(args.description)
        if suggested_tier and _TIER_RANK[suggested_tier] > _TIER_RANK[tier]:
            print(
                f"INFO: description suggests upgrading tier {tier} → {suggested_tier}, re-selecting model",
                file=sys.stderr,
            )
            tier = suggested_tier
            if mode == "auto":
                upgraded_short = resolve_auto_policy_model(tier, args.label)
            elif mode == "custom":
                upgraded_list = rules.get("custom", {}).get(tier, [])
                upgraded_short = upgraded_list[0] if upgraded_list else None
            else:
                upgraded_list = rules.get(mode, {}).get(tier, [])
                upgraded_short = upgraded_list[0] if upgraded_list else None
            if not upgraded_short:
                if aliases_data and tier in aliases_data:
                    up_full = aliases_data[tier]
                    if isinstance(up_full, str) and "/" in up_full:
                        upgraded_short = up_full
                if not upgraded_short:
                    upgraded_short = "glm" if tier in ("trivial", "simple", "normal") else "sonnet"
            full_path = resolve_short_name(upgraded_short, aliases_data)

    # ── Step 4: 模型守卫降级检测 ─────────────────────────────────────────
    guard_data = load_json(GUARD_FILE)
    if guard_data and guard_data.get("guarded") is True:
        status = guard_data.get("status", "")

        # Bug F1/J1: all_fail → 输出警告并 exit 1
        if status == "all_fail":
            print("ERROR: 所有模型均不可用 (status=all_fail)，无法选择模型", file=sys.stderr)
            sys.exit(1)

        # Bug B1: ratelimit → 自动降级到 GLM
        if status == "ratelimit":
            glm_path = BUILTIN_MAP.get("glm", "lixiang-glm-5/kivy-glm-5")
            print(f"INFO: 检测到限流(ratelimit)，自动降级到 GLM: {glm_path}", file=sys.stderr)
            full_path = glm_path
        else:
            # 普通 guard 切换：选出模型==original_model → 改用 current_model
            original_model = guard_data.get("original_model", "")
            current_model = guard_data.get("current_model", "")
            if original_model and current_model and full_path == original_model:
                full_path = current_model

    # ── Step 5: 写入缓存 & 输出 ───────────────────────────────────────────
    # 计算所有 tier 的模型，写入缓存（避免每个 tier 都重新计算）
    ironclaw_guarded = _get_ironclaw_guarded()
    all_tiers_models: dict = {}
    for t in VALID_TIERS:
        if t == tier:
            all_tiers_models[t] = full_path
        else:
            # 复用当前已解析的 mode/rules/aliases 快速计算其他 tier
            if mode == "auto":
                t_short = resolve_auto_policy_model(t, args.label)
            elif mode == "custom":
                t_list = rules.get("custom", {}).get(t, [])
                t_short = t_list[0] if t_list else None
            else:
                t_list = rules.get(mode, {}).get(t, [])
                t_short = t_list[0] if t_list else None
            if not t_short:
                if aliases_data and t in aliases_data:
                    t_full = aliases_data[t]
                    if isinstance(t_full, str) and "/" in t_full:
                        t_short = t_full
                if not t_short:
                    t_short = "glm" if t in ("trivial", "simple", "normal") else "sonnet"
            t_full_path = resolve_short_name(t_short, aliases_data)
            # 同样检查 guard
            if guard_data and guard_data.get("guarded") is True:
                g_status = guard_data.get("status", "")
                if g_status == "ratelimit":
                    t_full_path = BUILTIN_MAP.get("glm", "lixiang-glm-5/kivy-glm-5")
                elif g_status != "all_fail":
                    orig = guard_data.get("original_model", "")
                    curr = guard_data.get("current_model", "")
                    if orig and curr and t_full_path == orig:
                        t_full_path = curr
            all_tiers_models[t] = t_full_path
    write_cache(mode, ironclaw_guarded, all_tiers_models)
    print(full_path)


if __name__ == "__main__":
    main()
