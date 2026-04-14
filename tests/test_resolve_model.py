#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location("resolve_model_module", REPO_ROOT / "lib" / "resolve-model.py")
resolve_model = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(resolve_model)


class ResolveModelTests(unittest.TestCase):
    def test_current_mode_defaults_to_auto_when_mode_file_missing(self) -> None:
        with patch.object(resolve_model, "load_json", return_value=None):
            self.assertEqual(resolve_model._get_current_mode(), "auto")

    def test_auto_policy_prefers_profile_then_worker_pool_phase(self) -> None:
        policy = {
            "profiles": {
                "writer": "model/profile-writer",
            },
            "worker_pool_phases": {
                "octoclaw-research": {
                    "report": "model/research-report",
                }
            },
            "worker_pools": {
                "octoclaw-research": "model/research-default",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                worker_pool="octoclaw-research",
                phase="report",
                profile="writer",
            )
        self.assertEqual(result, "model/profile-writer")

    def test_auto_policy_direct_route_prefers_main_model_over_profile(self) -> None:
        policy = {
            "main_model": "model/main",
            "profiles": {
                "research": "model/profile-research",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                worker_pool="octoclaw-main",
                route="direct",
                profile="research",
            )
        self.assertEqual(result, "model/main")

    def test_auto_policy_worker_pool_phase_beats_pool_label_and_tier(self) -> None:
        policy = {
            "worker_pool_phases": {
                "octoclaw-code": {
                    "verify": "model/code-verify",
                }
            },
            "worker_pools": {
                "octoclaw-code": "model/code-default",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                worker_pool="octoclaw-code",
                phase="verify",
                profile="code",
            )
        self.assertEqual(result, "model/code-verify")

    def test_cache_key_is_selector_aware_for_worker_pool_phase_and_profile(self) -> None:
        key = resolve_model.cache_key(
            "standard",
            worker_pool="octoclaw-research",
            phase="report",
            profile="writer",
            route="spawn_single",
        )
        self.assertIn("selector_band=standard", key)
        self.assertIn("worker_pool=octoclaw-research", key)
        self.assertIn("phase=report", key)
        self.assertIn("profile=writer", key)
        self.assertTrue(key.endswith("::standard"))

    def test_auto_policy_falls_back_to_main_model(self) -> None:
        policy = {
            "main_model": "model/main",
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                route="direct",
            )
        self.assertEqual(result, "model/main")

    def test_main_direct_model_bypasses_health_fallback(self) -> None:
        policy = {
            "main_model": "omniroute/cx/gpt-5.4",
            "health": {
                "models": {
                    "omniroute/cx/gpt-5.4": {"state": "cooldown"},
                    "minimax-portal/MiniMax-M2.7-highspeed": {"state": "healthy"},
                }
            },
            "family_routing": {
                "omniroute/cx/gpt-5.4": {
                    "fallback_path": ["minimax-portal/MiniMax-M2.7-highspeed"],
                }
            },
        }
        self.assertTrue(
            resolve_model.should_bypass_policy_health_fallback(
                "omniroute/cx/gpt-5.4",
                policy=policy,
                route="direct",
                worker_pool="octoclaw-main",
            )
        )

    def test_selector_aware_cache_does_not_fall_back_to_generic_selector_band(self) -> None:
        cache = {
            "generated_at": 9999999999,
            "ttl": resolve_model.CACHE_TTL,
            "mode": "auto_policy",
            "ironclaw_guarded": False,
            "policy_marker": "policy-v1",
            "models": {
                "quick": "model/stale-generic",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=cache), patch.object(
            resolve_model, "_get_ironclaw_guarded", return_value=False
        ):
            result = resolve_model.read_cache(
                "quick",
                worker_pool="octoclaw-runner",
                phase="inspect",
                profile="ops-fast",
                route="runner",
                allow_generic_selector_fallback=False,
                policy_marker="policy-v1",
                expected_mode="auto_policy",
            )
        self.assertIsNone(result)

    def test_selector_aware_cache_can_read_selector_key_under_auto_policy(self) -> None:
        key = resolve_model.cache_key(
            "standard",
            worker_pool="octoclaw-code",
            phase="implement",
            profile="code",
            route="spawn_single",
        )
        cache = {
            "generated_at": 9999999999,
            "ttl": resolve_model.CACHE_TTL,
            "mode": "auto_policy",
            "ironclaw_guarded": False,
            "policy_marker": "policy-v2",
            "models": {
                key: "model/code-implement",
                "standard": "model/stale-generic",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=cache), patch.object(
            resolve_model, "_get_ironclaw_guarded", return_value=False
        ):
            result = resolve_model.read_cache(
                "standard",
                worker_pool="octoclaw-code",
                phase="implement",
                profile="code",
                route="spawn_single",
                allow_generic_selector_fallback=False,
                policy_marker="policy-v2",
                expected_mode="auto_policy",
            )
        self.assertEqual(result, "model/code-implement")

    def test_policy_health_fallback_avoids_cooldown_candidate(self) -> None:
        policy = {
            "family_routing": {
                "model/primary": {
                    "fallback_path": ["model/fallback", "model/other"],
                }
            },
            "health": {
                "models": {
                    "model/primary": {"state": "cooldown"},
                    "model/fallback": {"state": "healthy"},
                }
            },
        }
        result = resolve_model.resolve_policy_health_fallback("model/primary", policy=policy)
        self.assertEqual(result, "model/fallback")

    def test_cache_respects_health_marker(self) -> None:
        key = resolve_model.cache_key(
            "standard",
            worker_pool="octoclaw-main",
            phase="orchestrate",
            profile="research",
            route="direct",
        )
        cache = {
            "generated_at": 9999999999,
            "ttl": resolve_model.CACHE_TTL,
            "mode": "auto_policy",
            "ironclaw_guarded": False,
            "policy_marker": "policy-v2",
            "health_marker": "health-a",
            "models": {
                key: "model/main-a",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=cache), patch.object(
            resolve_model, "_get_ironclaw_guarded", return_value=False
        ):
            result = resolve_model.read_cache(
                "standard",
                worker_pool="octoclaw-main",
                phase="orchestrate",
                profile="research",
                route="direct",
                allow_generic_selector_fallback=False,
                policy_marker="policy-v2",
                health_marker="health-b",
                expected_mode="auto_policy",
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
