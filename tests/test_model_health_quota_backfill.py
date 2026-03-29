#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location(
    "model_health_quota_backfill_module",
    REPO_ROOT / "lib" / "model_health_quota_backfill.py",
)
model_health_quota_backfill = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_health_quota_backfill)


class ModelHealthQuotaBackfillTests(unittest.TestCase):
    def test_summarize_provider_usage_marks_high_and_critical(self) -> None:
        summary = {
            "updatedAt": 1,
            "providers": [
                {
                    "provider": "minimax",
                    "displayName": "MiniMax",
                    "windows": [{"label": "5h", "usedPercent": 91}],
                },
                {
                    "provider": "openai-codex",
                    "displayName": "OpenAI Codex",
                    "windows": [{"label": "3h", "usedPercent": 97}],
                },
            ],
        }
        result = model_health_quota_backfill.summarize_provider_usage(summary)
        self.assertEqual(result["minimax"]["quota_pressure"], "high")
        self.assertEqual(result["openai-codex"]["quota_pressure"], "critical")

    def test_apply_quota_summary_maps_provider_pressure_to_catalog_models(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-quota-backfill-") as tmpdir:
            health_path = Path(tmpdir) / "model-health.json"
            catalog_path = Path(tmpdir) / "model-catalog.json"
            catalog_path.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-03-29T00:00:00Z",
                        "models": [
                            {"id": "minimax-portal/MiniMax-M2.7", "provider": "minimax-portal"},
                            {"id": "omniroute/cx/gpt-5.4", "provider": "omniroute"},
                            {"id": "zhipu/GLM-4.7", "provider": "zhipu"},
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            summary = {
                "updatedAt": 1,
                "providers": [
                    {
                        "provider": "minimax",
                        "displayName": "MiniMax",
                        "windows": [{"label": "5h", "usedPercent": 88}],
                    },
                    {
                        "provider": "openai-codex",
                        "displayName": "OpenAI Codex",
                        "windows": [{"label": "Day", "usedPercent": 96}],
                    },
                ],
            }
            result = model_health_quota_backfill.apply_quota_summary_to_health(
                summary,
                health_file=str(health_path),
                catalog_file=str(catalog_path),
            )
            self.assertEqual(
                result["models_updated"]["minimax-portal/MiniMax-M2.7"]["quota_pressure"],
                "high",
            )
            self.assertEqual(
                result["models_updated"]["omniroute/cx/gpt-5.4"]["quota_pressure"],
                "critical",
            )


if __name__ == "__main__":
    unittest.main()
