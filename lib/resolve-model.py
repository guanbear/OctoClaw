#!/usr/bin/env python3
"""
resolve-model.py — OctoClaw model selection entry.

Primary path:
1. Prefer worker_pool/profile/phase driven auto policy from model-policy.json
2. Fall back to legacy mode/tier rules only when auto policy is unavailable
3. Apply guard overrides and complexity-based upgrades
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

from octopus_config import CONFIG_FILE, MODEL_POLICY_FILE, load_json as load_shared_json

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


def load_runtime_config() -> dict:
    data = load_json(CONFIG_FILE)
    return data if isinstance(data, dict) else {}


def model_auto_enabled(config: dict | None = None) -> bool:
    cfg = config if isinstance(config, dict) else load_runtime_config()
    section = cfg.get("model_auto", {}) if isinstance(cfg, dict) else {}
    return not isinstance(section, dict) or bool(section.get("enabled", True))


def selector_context_present(
    *,
    label: str = "",
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> bool:
    return any(str(value or "").strip() for value in (label, worker_pool, phase, profile, route))


def has_auto_policy(policy: dict | None) -> bool:
    if not isinstance(policy, dict):
        return False
    for key in ("profiles", "worker_pools", "worker_pool_phases", "main_model"):
        value = policy.get(key)
        if isinstance(value, dict) and value:
            return True
        if key == "main_model" and str(value or "").strip():
            return True
    return False


def policy_generation_marker(policy: dict | None) -> str:
    if not isinstance(policy, dict):
        return ""
    return str(policy.get("generated_at", "") or "").strip()


def selector_key(
    label: str = "",
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> str:
    parts = []
    if profile:
        parts.append(f"profile={str(profile).strip()}")
    if worker_pool:
        parts.append(f"worker_pool={str(worker_pool).strip()}")
    if phase:
        parts.append(f"phase={str(phase).strip()}")
    if route:
        parts.append(f"route={str(route).strip()}")
    if label:
        parts.append(f"label={str(label).strip()}")
    return "|".join(part for part in parts if part)


def cache_key(
    tier: str,
    label: str = "",
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> str:
    selector = selector_key(
        label=label,
        worker_pool=worker_pool,
        phase=phase,
        profile=profile,
        route=route,
    )
    return f"{selector}::{tier}" if selector else tier


def read_cache(
    tier: str,
    label: str = "",
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
    *,
    allow_generic_tier_fallback: bool = True,
    policy_marker: str = "",
    expected_mode: str = "",
) -> str | None:
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
    if cache.get("mode") != (expected_mode or _get_current_mode()):
        return None
    if cache.get("ironclaw_guarded") != _get_ironclaw_guarded():
        return None
    cached_policy_marker = str(cache.get("policy_marker", "") or "").strip()
    if str(policy_marker or "").strip() != cached_policy_marker:
        return None
    models = cache.get("models", {})
    selected_key = cache_key(
        tier,
        label=label,
        worker_pool=worker_pool,
        phase=phase,
        profile=profile,
        route=route,
    )
    if selected_key in models:
        return models.get(selected_key)
    legacy_key = f"{str(label or '').strip()}::{tier}" if str(label or "").strip() else ""
    if legacy_key and legacy_key in models:
        return models.get(legacy_key)
    if allow_generic_tier_fallback:
        return models.get(tier)
    return None


def write_cache(mode: str, ironclaw_guarded: bool, models: dict, *, policy_marker: str = "") -> None:
    """将所有 tier 的模型结果写入缓存文件。"""
    cache = {
        "generated_at": int(time.time()),
        "ttl": CACHE_TTL,
        "mode": mode,
        "ironclaw_guarded": ironclaw_guarded,
        "policy_marker": str(policy_marker or "").strip(),
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


def resolve_auto_policy_model(
    tier: str,
    label: str,
    *,
    worker_pool: str = "",
    phase: str = "",
    route: str = "",
    profile: str = "",
    policy: dict | None = None,
) -> str | None:
    policy = policy if isinstance(policy, dict) else load_json(MODEL_POLICY_FILE)
    if not isinstance(policy, dict):
        return None
    profiles = policy.get("profiles", {})
    worker_pool_phases = policy.get("worker_pool_phases", {})
    worker_pools = policy.get("worker_pools", {})
    if profile and isinstance(profiles, dict):
        profile_model = profiles.get(profile)
        if isinstance(profile_model, str) and profile_model:
            return profile_model
    if worker_pool and phase and isinstance(worker_pool_phases, dict):
        pool_entry = worker_pool_phases.get(worker_pool)
        if isinstance(pool_entry, dict):
            phase_model = pool_entry.get(phase)
            if isinstance(phase_model, str) and phase_model:
                return phase_model
    if worker_pool and isinstance(worker_pools, dict):
        pool_model = worker_pools.get(worker_pool)
        if isinstance(pool_model, str) and pool_model:
            return pool_model
    main_model = str(policy.get("main_model", "") or "").strip()
    if route == "direct" and main_model:
        return main_model
    if worker_pool == "octoclaw-main" and main_model:
        return main_model
    if main_model:
        return main_model
    return None


def resolve_mode_short_name(
    mode: str,
    rules: dict,
    tier: str,
    *,
    label: str = "",
    worker_pool: str = "",
    phase: str = "",
    route: str = "",
    profile: str = "",
) -> str | None:
    if mode == "auto":
        return resolve_auto_policy_model(
            tier,
            label,
            worker_pool=worker_pool,
            phase=phase,
            route=route,
            profile=profile,
        )
    if mode == "custom":
        tier_list = rules.get("custom", {}).get(tier, [])
        return tier_list[0] if tier_list else None
    tier_list = rules.get(mode, {}).get(tier, [])
    return tier_list[0] if tier_list else None


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
    parser.add_argument("--worker-pool", dest="worker_pool", default="", help="优先 worker pool（Phase 3 source of truth）")
    parser.add_argument("--phase", default="", help="工作阶段，如 collect/inspect/report/implement/verify")
    parser.add_argument("--route", default="", help="当前 route，用于 team/runner 特殊优先级")
    parser.add_argument("--profile", default="", help="用户侧 profile，如 code/research/review/writer")
    parser.add_argument("--description", default="", help="任务描述（用于多维度复杂度评分，可升级tier）")
    args = parser.parse_args()

    tier = args.tier
    runtime_config = load_runtime_config()
    policy_data = load_json(MODEL_POLICY_FILE)
    selector_aware_request = selector_context_present(
        label=args.label,
        worker_pool=args.worker_pool,
        phase=args.phase,
        profile=args.profile,
        route=args.route,
    )
    auto_policy_active = model_auto_enabled(runtime_config) and has_auto_policy(policy_data)
    policy_marker = policy_generation_marker(policy_data) if auto_policy_active else ""
    expected_cache_mode = "auto_policy" if auto_policy_active else _get_current_mode()

    # ── Step 0: 检查模型缓存 ─────────────────────────────────────────────
    # 注意：description 评分结果不进缓存（缓存仅按 mode/guard 状态）
    # 缓存命中后若有 description 仍需做升级检测
    cached_model = read_cache(
        tier,
        args.label,
        worker_pool=args.worker_pool,
        phase=args.phase,
        profile=args.profile,
        route=args.route,
        allow_generic_tier_fallback=not (auto_policy_active and selector_aware_request),
        policy_marker=policy_marker,
        expected_mode=expected_cache_mode,
    )
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
                cached_model = read_cache(
                    tier,
                    args.label,
                    worker_pool=args.worker_pool,
                    phase=args.phase,
                    profile=args.profile,
                    route=args.route,
                    allow_generic_tier_fallback=not (auto_policy_active and selector_aware_request),
                    policy_marker=policy_marker,
                    expected_mode=expected_cache_mode,
                )
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

    auto_selected_model = None
    if auto_policy_active:
        auto_selected_model = resolve_auto_policy_model(
            tier,
            args.label,
            worker_pool=args.worker_pool,
            phase=args.phase,
            route=args.route,
            profile=args.profile,
            policy=policy_data,
        )

    short_name = None if auto_selected_model else resolve_mode_short_name(
        mode,
        rules,
        tier,
        label=args.label,
        worker_pool=args.worker_pool,
        phase=args.phase,
        route=args.route,
        profile=args.profile,
    )

    # ── Step 3: 短名 → 完整路径（从别名文件推断）───────────────────────────
    aliases_data = load_json(ALIASES_FILE)

    # 如果 rules 里没找到，用别名文件作 fallback
    if auto_selected_model:
        full_path = auto_selected_model
    else:
        if not short_name:
            if aliases_data and tier in aliases_data:
                full_path = aliases_data[tier]
                if not (isinstance(full_path, str) and "/" in full_path):
                    full_path = ""
            else:
                full_path = ""
            if not full_path:
                # 最终 fallback：legacy balanced 逻辑
                short_name = "glm" if tier in ("trivial", "simple", "normal") else "sonnet"
        else:
            full_path = ""
        if not full_path:
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
            if auto_policy_active:
                upgraded_model = resolve_auto_policy_model(
                    tier,
                    args.label,
                    worker_pool=args.worker_pool,
                    phase=args.phase,
                    route=args.route,
                    profile=args.profile,
                    policy=policy_data,
                )
                if upgraded_model:
                    full_path = upgraded_model
            else:
                upgraded_short = resolve_mode_short_name(
                    mode,
                    rules,
                    tier,
                    label=args.label,
                    worker_pool=args.worker_pool,
                    phase=args.phase,
                    route=args.route,
                    profile=args.profile,
                )
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
    if auto_policy_active and selector_aware_request:
        all_tiers_models[
            cache_key(
                tier,
                label=args.label,
                worker_pool=args.worker_pool,
                phase=args.phase,
                profile=args.profile,
                route=args.route,
            )
        ] = full_path
    else:
        for t in VALID_TIERS:
            if t == tier:
                all_tiers_models[
                    cache_key(
                        t,
                        args.label if auto_policy_active else "",
                        worker_pool=args.worker_pool if auto_policy_active else "",
                        phase=args.phase if auto_policy_active else "",
                        profile=args.profile if auto_policy_active else "",
                        route=args.route if auto_policy_active else "",
                    )
                ] = full_path
                if not (auto_policy_active and selector_aware_request):
                    all_tiers_models[t] = full_path
            else:
                if auto_policy_active:
                    t_full_path = resolve_auto_policy_model(
                        t,
                        args.label,
                        worker_pool=args.worker_pool,
                        phase=args.phase,
                        route=args.route,
                        profile=args.profile,
                        policy=policy_data,
                    ) or full_path
                else:
                    t_short = resolve_mode_short_name(
                        mode,
                        rules,
                        t,
                        label=args.label,
                        worker_pool=args.worker_pool,
                        phase=args.phase,
                        route=args.route,
                        profile=args.profile,
                    )
                    if not t_short:
                        if aliases_data and t in aliases_data:
                            t_full = aliases_data[t]
                            if isinstance(t_full, str) and "/" in t_full:
                                t_short = t_full
                        if not t_short:
                            t_short = "glm" if t in ("trivial", "simple", "normal") else "sonnet"
                    t_full_path = resolve_short_name(t_short, aliases_data)
                if guard_data and guard_data.get("guarded") is True:
                    g_status = guard_data.get("status", "")
                    if g_status == "ratelimit":
                        t_full_path = BUILTIN_MAP.get("glm", "lixiang-glm-5/kivy-glm-5")
                    elif g_status != "all_fail":
                        orig = guard_data.get("original_model", "")
                        curr = guard_data.get("current_model", "")
                        if orig and curr and t_full_path == orig:
                            t_full_path = curr
                all_tiers_models[
                    cache_key(
                        t,
                        args.label if auto_policy_active else "",
                        worker_pool=args.worker_pool if auto_policy_active else "",
                        phase=args.phase if auto_policy_active else "",
                        profile=args.profile if auto_policy_active else "",
                        route=args.route if auto_policy_active else "",
                    )
                ] = t_full_path
                if not (auto_policy_active and selector_aware_request):
                    all_tiers_models[t] = t_full_path
    write_cache(expected_cache_mode, ironclaw_guarded, all_tiers_models, policy_marker=policy_marker)
    print(full_path)


if __name__ == "__main__":
    main()
