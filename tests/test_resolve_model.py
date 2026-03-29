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
            "labels": {
                "octopus-writer": "model/legacy-writer",
            },
            "tiers": {
                "normal": "model/tier-normal",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                "normal",
                "octopus-writer",
                worker_pool="octoclaw-research",
                phase="report",
                profile="writer",
            )
        self.assertEqual(result, "model/profile-writer")

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
            "labels": {
                "octopus-fix": "model/legacy-fix",
            },
            "tiers": {
                "normal": "model/tier-normal",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                "normal",
                "octopus-fix",
                worker_pool="octoclaw-code",
                phase="verify",
                profile="code",
            )
        self.assertEqual(result, "model/code-verify")

    def test_cache_key_is_selector_aware_for_worker_pool_phase_and_profile(self) -> None:
        key = resolve_model.cache_key(
            "normal",
            label="octopus-writer",
            worker_pool="octoclaw-research",
            phase="report",
            profile="writer",
            route="spawn_single",
        )
        self.assertIn("worker_pool=octoclaw-research", key)
        self.assertIn("phase=report", key)
        self.assertIn("profile=writer", key)
        self.assertTrue(key.endswith("::normal"))

    def test_auto_policy_falls_back_to_main_model_not_legacy_label_or_tier(self) -> None:
        policy = {
            "main_model": "model/main",
            "labels": {
                "octopus-fix": "model/legacy-fix",
            },
            "tiers": {
                "normal": "model/legacy-tier",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                "normal",
                "octopus-fix",
                route="direct",
            )
        self.assertEqual(result, "model/main")

    def test_selector_aware_cache_does_not_fall_back_to_generic_tier(self) -> None:
        cache = {
            "generated_at": 9999999999,
            "ttl": resolve_model.CACHE_TTL,
            "mode": "auto_policy",
            "ironclaw_guarded": False,
            "policy_marker": "policy-v1",
            "models": {
                "trivial": "model/stale-generic",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=cache), patch.object(
            resolve_model, "_get_ironclaw_guarded", return_value=False
        ):
            result = resolve_model.read_cache(
                "trivial",
                worker_pool="octoclaw-runner",
                phase="inspect",
                profile="ops-fast",
                route="runner",
                allow_generic_tier_fallback=False,
                policy_marker="policy-v1",
                expected_mode="auto_policy",
            )
        self.assertIsNone(result)

    def test_selector_aware_cache_can_read_selector_key_under_auto_policy(self) -> None:
        key = resolve_model.cache_key(
            "normal",
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
                "normal": "model/stale-generic",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=cache), patch.object(
            resolve_model, "_get_ironclaw_guarded", return_value=False
        ):
            result = resolve_model.read_cache(
                "normal",
                worker_pool="octoclaw-code",
                phase="implement",
                profile="code",
                route="spawn_single",
                allow_generic_tier_fallback=False,
                policy_marker="policy-v2",
                expected_mode="auto_policy",
            )
        self.assertEqual(result, "model/code-implement")


if __name__ == "__main__":
    unittest.main()
