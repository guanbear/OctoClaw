#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import sys
import unittest
from unittest.mock import Mock, patch
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))
SPEC = importlib.util.spec_from_file_location("model_intel_module", REPO_ROOT / "lib" / "model-intel.py")
model_intel = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_intel)


class ModelIntelTests(unittest.TestCase):
    def test_sync_external_model_intel_sources_invokes_node_adapter(self) -> None:
        mocked_run = Mock(return_value=Mock(stdout='{"results":[{"source":"openrouter_catalog","ok":true}]}'))
        with patch.object(model_intel.subprocess, "run", mocked_run):
            payload = model_intel.sync_external_model_intel_sources()

        self.assertEqual(payload["results"][0]["source"], "openrouter_catalog")
        args, kwargs = mocked_run.call_args
        self.assertEqual(args[0][0], "node")
        self.assertTrue(str(args[0][1]).endswith("model-intel-sync.mjs"))
        self.assertEqual(args[0][2], "refresh")
        self.assertIn("/opt/homebrew/bin", kwargs["env"]["PATH"])
        self.assertIn("/usr/local/bin", kwargs["env"]["PATH"])

    def test_ensure_source_registry_file_merges_missing_seed_sources(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-source-registry-") as workspace:
            existing_file = Path(workspace) / "model-sources-existing.json"
            seed_file = Path(workspace) / "model-sources.json"
            module_file = Path(workspace) / "model-intel.py"
            module_file.write_text("# test module placeholder\n", encoding="utf-8")
            existing_file.write_text(
                json.dumps(
                    {
                        "updated_at": "2026-04-01T00:00:00Z",
                        "sources": {
                            "openrouter_catalog": {
                                "role": "custom_override",
                                "description": "custom",
                                "default_confidence": 0.5,
                                "decay_days": 30,
                                "min_factor": 0.4,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            seed_file.write_text(
                json.dumps(
                    {
                        "updated_at": "2026-04-02T00:00:00Z",
                        "sources": {
                            "openrouter_catalog": {
                                "role": "directory_pricing",
                            },
                            "runtime_health": {
                                "role": "runtime_observation",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            def fake_load_json(path: str):
                mapping = {
                    str(existing_file): json.loads(existing_file.read_text(encoding="utf-8")),
                    str(seed_file): json.loads(seed_file.read_text(encoding="utf-8")),
                }
                return mapping.get(str(path), {})

            saved_payloads: list[dict] = []

            def fake_save_json(path: str, payload: dict):
                if str(path) == str(existing_file):
                    saved_payloads.append(payload)
                return True

            with patch.object(model_intel, "__file__", str(module_file)), patch.object(
                model_intel, "MODEL_SOURCES_FILE", str(existing_file)
            ), patch.object(model_intel, "load_json", side_effect=fake_load_json), patch.object(
                model_intel, "save_json", side_effect=fake_save_json
            ):
                payload = model_intel.ensure_source_registry_file()

        self.assertIn("runtime_health", payload["sources"])
        self.assertEqual(payload["sources"]["openrouter_catalog"]["role"], "custom_override")
        self.assertEqual(saved_payloads[0]["sources"]["runtime_health"]["role"], "runtime_observation")

    def test_resolve_openclaw_bin_uses_configured_absolute_path(self) -> None:
        with patch.object(model_intel, "load_octopus_config", return_value={"spawn_execution": {"openclaw_bin": "/opt/homebrew/bin/openclaw"}}), patch.object(
            model_intel.os.path, "exists", side_effect=lambda path: path == "/opt/homebrew/bin/openclaw"
        ), patch.object(model_intel.shutil, "which", return_value=None):
            self.assertEqual(model_intel.resolve_openclaw_bin(), "/opt/homebrew/bin/openclaw")

    def test_load_models_from_openclaw_expands_noninteractive_path(self) -> None:
        mocked_run = Mock(return_value=Mock(returncode=0, stdout='["omniroute/cx/gpt-5.4"]'))
        with patch.object(model_intel, "load_octopus_config", return_value={"spawn_execution": {"openclaw_bin": "/opt/homebrew/bin/openclaw"}}), patch.object(
            model_intel.os.path, "exists", side_effect=lambda path: path == "/opt/homebrew/bin/openclaw"
        ), patch.object(model_intel.shutil, "which", return_value=None), patch.object(
            model_intel.subprocess, "run", mocked_run
        ):
            model_ids = model_intel.load_models_from_openclaw()

        self.assertEqual(model_ids, ["omniroute/cx/gpt-5.4"])
        args, kwargs = mocked_run.call_args
        self.assertEqual(args[0][0], "/opt/homebrew/bin/openclaw")
        self.assertIn("/opt/homebrew/bin", kwargs["env"]["PATH"])
        self.assertIn("/usr/local/bin", kwargs["env"]["PATH"])

    def test_collect_candidate_model_ids_prefers_primary_configured_ids(self) -> None:
        model_ids = model_intel.collect_candidate_model_ids(
            ["omniroute/cx/gpt-5.4", "zai/glm-4.7"],
            {"openai-codex/gpt-5.4": {"ttft_ms": 1200}},
            {"zhipu/GLM-4.7": {"pinchbench": 0.82}},
        )
        self.assertEqual(model_ids, ["omniroute/cx/gpt-5.4", "zai/glm-4.7"])

    def test_collect_candidate_model_ids_falls_back_to_local_snapshots(self) -> None:
        model_ids = model_intel.collect_candidate_model_ids(
            [],
            {"vendor/model-a": {"ttft_ms": 1200}},
            {"vendor/model-b": {"pinchbench": 0.9}},
        )
        self.assertEqual(model_ids, ["vendor/model-a", "vendor/model-b"])

    def test_resolve_benchmark_override_matches_provider_variant(self) -> None:
        source_model, override = model_intel.resolve_benchmark_override(
            "zai/glm-4.7",
            {
                "zhipu/GLM-4.7": {
                    "benchmark_scores": {"pinchbench": 0.83},
                    "benchmark_meta": {"pinchbench": {"confidence": 0.9}},
                }
            },
        )
        self.assertEqual(source_model, "zhipu/GLM-4.7")
        self.assertEqual(override["benchmark_scores"]["pinchbench"], 0.83)

    def test_build_catalog_prefers_configured_models_and_reuses_provider_variant_benchmark(self) -> None:
        with patch.object(model_intel, "ensure_pricing_file"), patch.object(
            model_intel, "ensure_plan_state_file"
        ), patch.object(model_intel, "ensure_benchmark_snapshot_file"), patch.object(
            model_intel, "ensure_source_registry_file"
        ), patch.object(
            model_intel, "load_latency_data", return_value={}
        ), patch.object(
            model_intel, "load_speed_data", return_value={}
        ), patch.object(
            model_intel, "load_benchmark_overrides", return_value={"zhipu/GLM-4.7": {"benchmark_scores": {"pinchbench": 0.83}}}
        ), patch.object(
            model_intel, "load_source_registry", return_value={}
        ), patch.object(
            model_intel, "load_models_from_openclaw", return_value=["zai/glm-4.7"]
        ), patch.object(
            model_intel, "get_pricing_entry", return_value={}
        ), patch.object(
            model_intel, "get_plan_state_entry", return_value={}
        ), patch.object(model_intel, "save_json", return_value=True):
            catalog = model_intel.build_catalog()

        self.assertEqual([model["id"] for model in catalog["models"]], ["zai/glm-4.7"])
        self.assertEqual(catalog["models"][0]["benchmark_source_model"], "zhipu/GLM-4.7")
        self.assertEqual(catalog["models"][0]["benchmark_scores"]["pinchbench"], 0.83)
        self.assertEqual(catalog["schema_version"], model_intel.MODEL_INTEL_CATALOG_SCHEMA_VERSION)
        self.assertEqual(catalog["facts_plane"]["source_status_file"], model_intel.MODEL_INTEL_SOURCE_STATUS_FILE)
        self.assertIn("pricing", catalog["facts_plane"]["source_precedence"])

    def test_build_catalog_surfaces_external_snapshot_metadata_and_rankings(self) -> None:
        source_registry = {
            "openrouter_catalog": {"default_confidence": 0.88, "role": "directory_pricing"},
            "openrouter_rankings": {"default_confidence": 0.55, "role": "ecosystem_signal"},
            "models_dev_registry": {"default_confidence": 0.86, "role": "external_model_registry"},
        }
        ranking_lookup_key = model_intel.normalize_model_lookup_key("gpt-5.4")
        external_snapshots = {
            "models_dev_registry": {
                "records": [{"full_id": "openai/gpt-5.4"}],
                "lookup": {
                    ranking_lookup_key: {
                        "full_id": "openai/gpt-5.4",
                        "tool_call": True,
                        "reasoning": True,
                        "input_modalities": ["text"],
                        "output_modalities": ["text"],
                        "output_limit": 16000,
                    }
                },
                "updated_at": "2026-04-08T00:00:00Z",
                "source_file": "/tmp/models-dev.json",
            },
            "openrouter_catalog": {
                "records": [{"id": "openai/gpt-5.4"}],
                "lookup": {
                    ranking_lookup_key: {
                        "id": "openai/gpt-5.4",
                        "name": "GPT-5.4",
                        "modality": "text->text",
                        "input_modalities": ["text"],
                        "output_modalities": ["text"],
                        "context_length": 256000,
                        "max_completion_tokens": 32000,
                        "supported_parameters": ["tools", "response_format"],
                    }
                },
                "updated_at": "2026-04-08T00:00:00Z",
                "source_file": "/tmp/openrouter-catalog.json",
            },
            "openrouter_rankings": {
                "payload": {
                    "filters": {"exclude_free_models": True, "policy": "paid_only_ecosystem_signal"},
                    "counts": {"candidate_count": 9, "retained_count": 5, "skipped_free_count": 4},
                },
                "records": [{"model_id": "openai/gpt-5.4", "score": 0.91}],
                "lookup": {
                    ranking_lookup_key: {
                        "model_id": "openai/gpt-5.4",
                        "name": "GPT-5.4",
                        "score": 0.91,
                    }
                },
                "updated_at": "2026-04-08T00:00:00Z",
                "source_file": "/tmp/openrouter-rankings.json",
            },
        }
        with patch.object(model_intel, "ensure_pricing_file"), patch.object(
            model_intel, "ensure_plan_state_file"
        ), patch.object(model_intel, "ensure_benchmark_snapshot_file"), patch.object(
            model_intel, "ensure_source_registry_file"
        ), patch.object(model_intel, "load_latency_data", return_value={}), patch.object(
            model_intel, "load_speed_data", return_value={}
        ), patch.object(model_intel, "load_benchmark_overrides", return_value={}), patch.object(
            model_intel, "load_source_registry", return_value=source_registry
        ), patch.object(model_intel, "load_external_model_intel_snapshots", return_value=external_snapshots), patch.object(
            model_intel, "load_models_from_openclaw", return_value=["omniroute/cx/gpt-5.4"]
        ), patch.object(model_intel, "get_pricing_entry", return_value={}), patch.object(
            model_intel, "get_plan_state_entry", return_value={}
        ), patch.object(
            model_intel, "load_pricing_file", return_value={"models": []}
        ), patch.object(model_intel, "load_json", return_value={}), patch.object(
            model_intel, "save_json", return_value=True
        ):
            catalog = model_intel.build_catalog()

        record = catalog["models"][0]
        self.assertTrue(record["capability_hints"]["tool_call"])
        self.assertTrue(record["capability_hints"]["reasoning"])
        self.assertEqual(record["limits"]["context_length"], 256000)
        self.assertEqual(record["limits"]["max_completion_tokens"], 32000)
        self.assertEqual(record["benchmark_scores"]["openrouter_rankings"], 0.91)
        self.assertEqual(record["benchmark_meta"]["openrouter_rankings"]["filter_policy"], "paid_only_ecosystem_signal")
        self.assertEqual(record["benchmark_meta"]["openrouter_rankings"]["counts"]["skipped_free_count"], 4)
        self.assertIn("models_dev_registry", catalog["facts_plane"]["active_sources"])
        self.assertIn("openrouter_rankings_sync", record["source_refs"])

    def test_compute_openrouter_rankings_factor_caps_ecosystem_signal_when_local_truth_exists(self) -> None:
        factor, policy = model_intel.compute_openrouter_rankings_factor(
            {
                "benchmark_scores": {"openrouter_rankings": 0.95, "openclaw_live_compat": 0.82},
                "benchmark_meta": {
                    "openrouter_rankings": {
                        "filtered_free_models": True,
                        "filter_policy": "paid_only_ecosystem_signal",
                    }
                },
                "source_factors": {"openrouter_rankings": 0.91},
                "local_truth_signals": {
                    "configured": True,
                    "openclaw_live_compat": True,
                    "local_speed": False,
                    "runtime_health": True,
                    "plan_state": False,
                },
            }
        )

        self.assertAlmostEqual(factor, 0.35)
        self.assertTrue(policy["capped"])
        self.assertIn("local_truth:compat_or_runtime", policy["cap_reasons"])
        self.assertTrue(policy["filtered_free_models"])
        self.assertEqual(policy["filter_policy"], "paid_only_ecosystem_signal")

    def test_compute_policy_empty_catalog_uses_new_fields_only(self) -> None:
        with patch.object(model_intel, "save_json", return_value=True), patch.object(
            model_intel, "load_octopus_config", return_value={}
        ):
            policy = model_intel.compute_policy({"models": []}, mode="auto")
        self.assertEqual(policy["mode"], "auto")
        self.assertEqual(policy["main_model"], "")
        self.assertEqual(policy["profiles"], {})
        self.assertEqual(policy["worker_pools"], {})
        self.assertEqual(policy["worker_pool_phases"], {})
        self.assertIn("main_selection", policy)
        self.assertEqual(policy["facts_plane"]["source_status_file"], model_intel.MODEL_INTEL_SOURCE_STATUS_FILE)
        self.assertNotIn("labels", policy)
        self.assertNotIn("tiers", policy)

    def test_compute_policy_deprioritizes_cooldown_model_and_emits_health_block(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "model/primary",
                    "available": True,
                    "pricing": {"input": 1.0, "output": 2.0},
                    "scores": {"coding": 0.95, "reasoning": 0.95, "openclaw": 0.95, "writing": 0.90, "reliability": 0.95},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1500, "output_tps": 80},
                    "size_class": "strong",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": ["model/fallback"],
                    "source_refs": [],
                },
                {
                    "id": "model/fallback",
                    "available": True,
                    "pricing": {"input": 1.2, "output": 2.5},
                    "scores": {"coding": 0.85, "reasoning": 0.86, "openclaw": 0.86, "writing": 0.84, "reliability": 0.90},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1800, "output_tps": 75},
                    "size_class": "base",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        health_payload = {
            "generated_at": "2026-03-29T00:00:00Z",
            "models": {
                "model/primary": {
                    "recent_429_count": 3,
                }
            },
        }
        with patch.object(model_intel, "load_json", return_value=health_payload), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(model_intel, "load_octopus_config", return_value={}):
            policy = model_intel.compute_policy(catalog, mode="auto")
        self.assertEqual(policy["main_model"], "model/fallback")
        self.assertEqual(policy["health"]["models"]["model/primary"]["state"], "cooldown")
        self.assertGreater(policy["health"]["selection_penalties"]["model/primary"]["main"], 0.5)

    def test_compute_policy_applies_main_capability_floor(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "model/mid-balanced",
                    "available": True,
                    "pricing": {"input": 0.3, "output": 0.9},
                    "scores": {"coding": 0.83, "reasoning": 0.82, "openclaw": 0.81, "writing": 0.80, "reliability": 0.83},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1200, "output_tps": 90},
                    "size_class": "base",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
                {
                    "id": "model/strong-main",
                    "available": True,
                    "pricing": {"input": 4.0, "output": 16.0},
                    "scores": {"coding": 0.95, "reasoning": 0.95, "openclaw": 0.92, "writing": 0.87, "reliability": 0.91},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 5200, "output_tps": 52},
                    "size_class": "strong",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        with patch.object(model_intel, "load_json", return_value={}), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(
            model_intel,
            "load_octopus_config",
            return_value={"model_auto": {"main_selection": {"max_relax_rounds": 0}}},
        ):
            policy = model_intel.compute_policy(catalog, mode="auto")

        self.assertEqual(policy["main_model"], "model/strong-main")
        self.assertEqual(policy["worker_pools"]["octoclaw-main"], "model/strong-main")
        self.assertEqual(policy["main_selection"]["selected_model"], "model/strong-main")
        mid = {row["model"]: row for row in policy["main_selection"]["candidates"]}["model/mid-balanced"]
        self.assertFalse(mid["eligible"])
        self.assertIn("capability_score", mid["failed_checks"])

    def test_compute_policy_prefers_models_with_available_auth_provider(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "anthropic/claude-opus-4-6",
                    "available": True,
                    "provider": "anthropic",
                    "pricing": {"input": 15.0, "output": 75.0},
                    "scores": {"coding": 0.95, "reasoning": 0.95, "openclaw": 0.92, "writing": 0.90, "reliability": 0.91},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 6200, "output_tps": 42},
                    "size_class": "strong",
                    "family": "claude",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
                {
                    "id": "zai/glm-4.7",
                    "available": True,
                    "provider": "zai",
                    "pricing": {"input": 0.45, "output": 1.2},
                    "scores": {"coding": 0.83, "reasoning": 0.82, "openclaw": 0.81, "writing": 0.78, "reliability": 0.83},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 2600, "output_tps": 72},
                    "size_class": "base",
                    "family": "glm",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        with patch.object(model_intel, "load_json", return_value={}), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(model_intel, "load_octopus_config", return_value={}), patch.object(
            model_intel, "load_available_auth_providers", return_value={"zai"}
        ):
            policy = model_intel.compute_policy(catalog, mode="auto")

        self.assertEqual(policy["main_model"], "zai/glm-4.7")
        self.assertEqual(policy["profiles"]["research"], "zai/glm-4.7")
        self.assertEqual(policy["health"]["available_auth_providers"], ["zai"])

    def test_compute_policy_keeps_configured_main_model_and_fast_runner(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "omniroute/cx/gpt-5.4",
                    "available": True,
                    "configured": True,
                    "provider": "omniroute",
                    "pricing": {"input": 24.0, "output": 96.0, "effective_cny_per_1m_tokens": 24.0},
                    "scores": {"coding": 0.96, "reasoning": 0.96, "openclaw": 0.93, "writing": 0.89, "reliability": 0.92},
                    "benchmark_scores": {
                        "pinchbench": 0.86,
                        "artificial_analysis_coding": 0.96,
                        "claw_eval": 0.91,
                        "openrouter_rankings": 0.89,
                    },
                    "source_factors": {
                        "pinchbench": 0.35,
                        "artificial_analysis_coding": 0.30,
                        "claw_eval": 0.40,
                        "openrouter_rankings": 0.20,
                    },
                    "speed": {"ttft_ms": 5200, "output_tps": 54},
                    "size_class": "strong",
                    "family": "gpt-5.4",
                    "preferred_use": ["main"],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
                {
                    "id": "minimax-portal/MiniMax-M2.7-highspeed",
                    "available": True,
                    "configured": True,
                    "provider": "minimax-portal",
                    "pricing": {"input": 3.5, "output": 6.0, "effective_cny_per_1m_tokens": 3.5},
                    "scores": {"coding": 0.78, "reasoning": 0.76, "openclaw": 0.80, "writing": 0.75, "reliability": 0.90},
                    "benchmark_scores": {
                        "pinchbench": 0.74,
                        "artificial_analysis_coding": 0.72,
                        "claw_eval": 0.76,
                        "openrouter_rankings": 0.70,
                    },
                    "source_factors": {
                        "pinchbench": 0.82,
                        "artificial_analysis_coding": 0.80,
                        "claw_eval": 0.84,
                        "openrouter_rankings": 0.75,
                    },
                    "speed": {"ttft_ms": 900, "output_tps": 125},
                    "size_class": "base",
                    "family": "minimax",
                    "preferred_use": ["runner"],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
                {
                    "id": "zai/glm-4.7",
                    "available": True,
                    "configured": True,
                    "provider": "zai",
                    "pricing": {"input": 0.87, "output": 1.6, "effective_cny_per_1m_tokens": 0.87},
                    "scores": {"coding": 0.85, "reasoning": 0.84, "openclaw": 0.84, "writing": 0.81, "reliability": 0.88},
                    "benchmark_scores": {
                        "pinchbench": 0.82,
                        "artificial_analysis_coding": 0.84,
                        "claw_eval": 0.83,
                        "openrouter_rankings": 0.76,
                    },
                    "source_factors": {
                        "pinchbench": 0.88,
                        "artificial_analysis_coding": 0.88,
                        "claw_eval": 0.88,
                        "openrouter_rankings": 0.80,
                    },
                    "speed": {"ttft_ms": 2100, "output_tps": 82},
                    "size_class": "base",
                    "family": "glm",
                    "preferred_use": ["fix", "test", "research"],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        with patch.object(model_intel, "load_json", return_value={}), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(model_intel, "load_octopus_config", return_value={}), patch.object(
            model_intel, "load_available_auth_providers", return_value={"zai", "minimax-portal"}
        ), patch.object(model_intel, "compute_plan_value_score", return_value=0.5), patch.object(
            model_intel, "should_fallback_due_to_plan", return_value=False
        ), patch.object(model_intel, "preferred_fallback_model", return_value=""):
            policy = model_intel.compute_policy(catalog, mode="auto")

        self.assertEqual(policy["main_model"], "omniroute/cx/gpt-5.4")
        self.assertEqual(policy["profiles"]["ops-fast"], "minimax-portal/MiniMax-M2.7-highspeed")
        self.assertEqual(policy["worker_pools"]["octoclaw-main"], "omniroute/cx/gpt-5.4")
        self.assertEqual(policy["worker_pools"]["octoclaw-runner"], "minimax-portal/MiniMax-M2.7-highspeed")
        self.assertEqual(policy["health"]["available_auth_providers"], ["minimax-portal", "zai"])


if __name__ == "__main__":
    unittest.main()
