#!/usr/bin/env python3
"""
resolve-model.py — OctoClaw policy-first model selection entry.

Primary path:
1. Prefer worker_pool/profile/phase driven auto policy from model-policy.json
2. Fall back to explicit custom overrides only when auto policy is unavailable
3. Use selector-band aliases purely as low-level final fallback
4. Apply health / guard overrides
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from model_health import model_health_marker, model_in_cooldown
from octopus_config import CONFIG_FILE, MODE_FILE, MODEL_ALIASES_FILE, MODEL_POLICY_FILE, load_json as load_shared_json
from worker_taxonomy import model_band_for_selector_band

GLOBAL_DEG_FILE = "/tmp/ironclaw-global-degradation.json"
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

VALID_SELECTOR_BANDS = ["quick", "standard", "strong", "heavy"]

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
        return mode_data.get("mode", "auto")
    return "auto"


def load_runtime_config() -> dict:
    data = load_json(CONFIG_FILE)
    return data if isinstance(data, dict) else {}


def model_auto_enabled(config: dict | None = None) -> bool:
    cfg = config if isinstance(config, dict) else load_runtime_config()
    section = cfg.get("model_auto", {}) if isinstance(cfg, dict) else {}
    return not isinstance(section, dict) or bool(section.get("enabled", True))


def selector_context_present(
    *,
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> bool:
    return any(str(value or "").strip() for value in (worker_pool, phase, profile, route))


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
    main_model = str(policy.get("main_model", "") or "").strip()
    worker_pools = policy.get("worker_pools", {}) if isinstance(policy.get("worker_pools", {}), dict) else {}
    main_pool = str(worker_pools.get("octoclaw-main", "") or "").strip()
    generated_at = str(policy.get("generated_at", "") or "").strip()
    return "|".join(part for part in (generated_at, main_model, main_pool) if part)


def selector_key(
    selector_band: str = "",
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> str:
    parts = []
    if selector_band:
        parts.append(f"selector_band={str(selector_band).strip()}")
    if profile:
        parts.append(f"profile={str(profile).strip()}")
    if worker_pool:
        parts.append(f"worker_pool={str(worker_pool).strip()}")
    if phase:
        parts.append(f"phase={str(phase).strip()}")
    if route:
        parts.append(f"route={str(route).strip()}")
    return "|".join(part for part in parts if part)


def cache_key(
    selector_band: str,
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
) -> str:
    selector = selector_key(
        selector_band=selector_band,
        worker_pool=worker_pool,
        phase=phase,
        profile=profile,
        route=route,
    )
    return f"{selector}::{selector_band}" if selector else selector_band


def read_cache(
    selector_band: str,
    worker_pool: str = "",
    phase: str = "",
    profile: str = "",
    route: str = "",
    *,
    allow_generic_selector_fallback: bool = True,
    policy_marker: str = "",
    health_marker: str = "",
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
    cached_health_marker = str(cache.get("health_marker", "") or "").strip()
    if str(health_marker or "").strip() != cached_health_marker:
        return None
    models = cache.get("models", {})
    selected_key = cache_key(
        selector_band,
        worker_pool=worker_pool,
        phase=phase,
        profile=profile,
        route=route,
    )
    if selected_key in models:
        return models.get(selected_key)
    if allow_generic_selector_fallback:
        return models.get(selector_band)
    return None


def write_cache(
    mode: str,
    ironclaw_guarded: bool,
    models: dict,
    *,
    policy_marker: str = "",
    health_marker: str = "",
) -> None:
    """将 selector band 的模型结果写入缓存文件。"""
    cache = {
        "generated_at": int(time.time()),
        "ttl": CACHE_TTL,
        "mode": mode,
        "ironclaw_guarded": ironclaw_guarded,
        "policy_marker": str(policy_marker or "").strip(),
        "health_marker": str(health_marker or "").strip(),
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
    aliases 格式: {selector_band/model_band: "vendor-model/provider-model", ...}
    我们把 aliases 里出现的路径，按已知短名特征归类。
    """
    mapping = {}
    for alias_key, full_path in aliases.items():
        if alias_key in ("updated_at", "_note"):
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
    selector_band: str = "",
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
    main_model = str(policy.get("main_model", "") or "").strip()
    if route == "direct" and main_model:
        return main_model
    if worker_pool == "octoclaw-main" and main_model:
        return main_model
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
    if main_model:
        return main_model
    return None


def resolve_custom_mode_model(
    custom_models: dict,
    selector_band: str = "",
    *,
    worker_pool: str = "",
    phase: str = "",
    route: str = "",
    profile: str = "",
) -> str | None:
    if not isinstance(custom_models, dict):
        return None
    if profile:
        profile_model = custom_models.get(f"profile:{profile}")
        if isinstance(profile_model, str) and profile_model.strip():
            return profile_model.strip()
    if worker_pool:
        pool_model = custom_models.get(worker_pool)
        if isinstance(pool_model, str) and pool_model.strip():
            return pool_model.strip()
    if route == "direct":
        direct_model = custom_models.get("main")
        if isinstance(direct_model, str) and direct_model.strip():
            return direct_model.strip()
    main_model = custom_models.get("main")
    if isinstance(main_model, str) and main_model.strip():
        return main_model.strip()
    return None


def resolve_policy_health_fallback(selected_model: str, *, policy: dict | None = None) -> str:
    if not isinstance(policy, dict):
        return selected_model
    health = policy.get("health", {})
    health_models = health.get("models", {}) if isinstance(health, dict) else {}
    selected_health = health_models.get(selected_model, {}) if isinstance(health_models, dict) else {}
    if not isinstance(selected_health, dict) or not model_in_cooldown(selected_health):
        return selected_model
    family_routing = policy.get("family_routing", {})
    family_entry = family_routing.get(selected_model, {}) if isinstance(family_routing, dict) else {}
    fallback_path = family_entry.get("fallback_path", []) if isinstance(family_entry, dict) else []
    if not isinstance(fallback_path, list):
        return selected_model
    for candidate in fallback_path:
        model_id = str(candidate or "").strip()
        if not model_id:
            continue
        candidate_health = health_models.get(model_id, {}) if isinstance(health_models, dict) else {}
        if not isinstance(candidate_health, dict) or not model_in_cooldown(candidate_health):
            print(
                f"INFO: selected model in cooldown, switching via policy fallback {selected_model} -> {model_id}",
                file=sys.stderr,
            )
            return model_id
    return selected_model


def should_bypass_policy_health_fallback(
    selected_model: str,
    *,
    policy: dict | None = None,
    route: str = "",
    worker_pool: str = "",
) -> bool:
    if not isinstance(policy, dict):
        return False
    current_model = str(selected_model or "").strip()
    if not current_model:
        return False
    expected_main = str(policy.get("main_model", "") or "").strip()
    if not expected_main or current_model != expected_main:
        return False
    return str(route or "").strip() == "direct" or str(worker_pool or "").strip() == "octoclaw-main"


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


def fallback_short_name_for_selector_band(selector_band: str) -> str:
    band = str(selector_band or "").strip().lower()
    if band == "quick":
        return "minimax"
    if band == "standard":
        return "glm"
    if band == "strong":
        return "gpt54"
    return "claudeopus"


def main():
    parser = argparse.ArgumentParser(description="八爪鱼统一模型选择入口")
    parser.add_argument("--selector-band", dest="selector_band", default="", choices=VALID_SELECTOR_BANDS, help="选模强度带")
    parser.add_argument("--worker-pool", dest="worker_pool", default="", help="优先 worker pool（Phase 3 source of truth）")
    parser.add_argument("--phase", default="", help="工作阶段，如 collect/inspect/report/implement/verify")
    parser.add_argument("--route", default="", help="当前 route，用于 team/runner 特殊优先级")
    parser.add_argument("--profile", default="", help="用户侧 profile，如 code/research/review/writer")
    parser.add_argument("--description", default="", help="任务描述（仅用于上下文，不驱动 band 升级）")
    args = parser.parse_args()

    selector_band = str(args.selector_band or "").strip() or "standard"
    runtime_config = load_runtime_config()
    policy_data = load_json(MODEL_POLICY_FILE)
    selector_aware_request = selector_context_present(
        worker_pool=args.worker_pool,
        phase=args.phase,
        profile=args.profile,
        route=args.route,
    )
    auto_policy_active = model_auto_enabled(runtime_config) and has_auto_policy(policy_data)
    policy_marker = policy_generation_marker(policy_data) if auto_policy_active else ""
    health_marker = model_health_marker(policy_data.get("health", {})) if auto_policy_active and isinstance(policy_data, dict) else ""
    expected_cache_mode = "auto_policy" if auto_policy_active else _get_current_mode()

    cached_model = read_cache(
        selector_band,
        worker_pool=args.worker_pool,
        phase=args.phase,
        profile=args.profile,
        route=args.route,
        allow_generic_selector_fallback=not (auto_policy_active and selector_aware_request),
        policy_marker=policy_marker,
        health_marker=health_marker,
        expected_mode=expected_cache_mode,
    )
    if cached_model:
        print(f"INFO: 命中模型缓存 selector_band={selector_band} model={cached_model}", file=sys.stderr)
        print(cached_model)
        return

    override_mode = None
    deg_data = load_json(GLOBAL_DEG_FILE)
    if deg_data and deg_data.get("active") is True:
        override_mode = deg_data.get("override_mode")

    mode_data = load_json(MODE_FILE)
    if not mode_data:
        mode_data = {"mode": "auto", "customModels": {}}

    mode = override_mode if override_mode else mode_data.get("mode", "auto")
    if mode not in {"auto", "custom"}:
        mode = "auto"
    custom_models = mode_data.get("customModels", {})
    if not isinstance(custom_models, dict):
        custom_models = {}

    auto_selected_model = None
    if auto_policy_active:
        auto_selected_model = resolve_auto_policy_model(
            selector_band,
            worker_pool=args.worker_pool,
            phase=args.phase,
            route=args.route,
            profile=args.profile,
            policy=policy_data,
        )

    short_name = None
    if not auto_selected_model and mode == "custom":
        short_name = resolve_custom_mode_model(
            custom_models,
            selector_band,
            worker_pool=args.worker_pool,
            phase=args.phase,
            route=args.route,
            profile=args.profile,
        )

    aliases_data = load_json(MODEL_ALIASES_FILE)

    if auto_selected_model:
        full_path = auto_selected_model
    else:
        full_path = ""
        if short_name:
            full_path = resolve_short_name(short_name, aliases_data)
        if not full_path and isinstance(aliases_data, dict):
            model_band = model_band_for_selector_band(selector_band, default="normal")
            candidate = str(
                aliases_data.get(selector_band, "")
                or aliases_data.get(model_band, "")
                or ""
            ).strip()
            if "/" in candidate:
                full_path = candidate
        if not full_path:
            full_path = resolve_short_name(fallback_short_name_for_selector_band(selector_band), aliases_data)

    if auto_policy_active and not should_bypass_policy_health_fallback(
        full_path,
        policy=policy_data,
        route=args.route,
        worker_pool=args.worker_pool,
    ):
        full_path = resolve_policy_health_fallback(full_path, policy=policy_data)

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

    ironclaw_guarded = _get_ironclaw_guarded()
    all_selector_models: dict = {}
    if auto_policy_active and selector_aware_request:
        all_selector_models[
                    cache_key(
                        selector_band,
                        worker_pool=args.worker_pool,
                        phase=args.phase,
                        profile=args.profile,
                route=args.route,
            )
        ] = full_path
    else:
        for band in VALID_SELECTOR_BANDS:
            if band == selector_band:
                all_selector_models[
                    cache_key(
                        band,
                        worker_pool=args.worker_pool if auto_policy_active else "",
                        phase=args.phase if auto_policy_active else "",
                        profile=args.profile if auto_policy_active else "",
                        route=args.route if auto_policy_active else "",
                    )
                ] = full_path
                if not (auto_policy_active and selector_aware_request):
                    all_selector_models[band] = full_path
            else:
                if auto_policy_active:
                    band_full_path = resolve_auto_policy_model(
                        band,
                        worker_pool=args.worker_pool,
                        phase=args.phase,
                        route=args.route,
                        profile=args.profile,
                        policy=policy_data,
                    ) or full_path
                    if not should_bypass_policy_health_fallback(
                        band_full_path,
                        policy=policy_data,
                        route=args.route,
                        worker_pool=args.worker_pool,
                    ):
                        band_full_path = resolve_policy_health_fallback(band_full_path, policy=policy_data)
                else:
                    band_short = None
                    if mode == "custom":
                        band_short = resolve_custom_mode_model(
                            custom_models,
                            band,
                            worker_pool=args.worker_pool,
                            phase=args.phase,
                            route=args.route,
                            profile=args.profile,
                        )
                    if band_short:
                        band_full_path = resolve_short_name(band_short, aliases_data)
                    else:
                        candidate = ""
                        if isinstance(aliases_data, dict):
                            candidate = str(
                                aliases_data.get(band, "")
                                or aliases_data.get(model_band_for_selector_band(band, default="normal"), "")
                                or ""
                            ).strip()
                        band_full_path = candidate if "/" in candidate else resolve_short_name(
                            fallback_short_name_for_selector_band(band),
                            aliases_data,
                        )
                if guard_data and guard_data.get("guarded") is True:
                    g_status = guard_data.get("status", "")
                    if g_status == "ratelimit":
                        band_full_path = BUILTIN_MAP.get("glm", "lixiang-glm-5/kivy-glm-5")
                    elif g_status != "all_fail":
                        orig = guard_data.get("original_model", "")
                        curr = guard_data.get("current_model", "")
                        if orig and curr and band_full_path == orig:
                            band_full_path = curr
                all_selector_models[
                    cache_key(
                        band,
                        worker_pool=args.worker_pool if auto_policy_active else "",
                        phase=args.phase if auto_policy_active else "",
                        profile=args.profile if auto_policy_active else "",
                        route=args.route if auto_policy_active else "",
                    )
                ] = band_full_path
                if not (auto_policy_active and selector_aware_request):
                    all_selector_models[band] = band_full_path
    write_cache(
        expected_cache_mode,
        ironclaw_guarded,
        all_selector_models,
        policy_marker=policy_marker,
        health_marker=health_marker,
    )
    print(full_path)


if __name__ == "__main__":
    main()
