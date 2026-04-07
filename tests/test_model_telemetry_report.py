#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "lib" / "model_telemetry_report.py"


class ModelTelemetryReportTests(unittest.TestCase):
    def test_report_reads_local_snapshots_for_requested_models(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-model-telemetry-") as workspace:
            octopus_dir = Path(workspace) / "tmp" / "octopus"
            octopus_dir.mkdir(parents=True, exist_ok=True)
            (octopus_dir / "model-speed.json").write_text(
                json.dumps(
                    {
                        "minimax-portal/MiniMax-M2.7-highspeed": {"ttft_ms": 420, "output_tps": 78.4},
                        "zhipu/GLM-5.1": {"ttft_ms": 950, "output_tps": 42.1},
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            (octopus_dir / "model-health.json").write_text(
                json.dumps(
                    {
                        "generated_at": "2026-04-08T00:00:00Z",
                        "models": {
                            "minimax-portal/MiniMax-M2.7-highspeed": {
                                "state": "healthy",
                                "recent_success_count": 3,
                            },
                            "zhipu/GLM-5.1": {
                                "state": "degraded",
                                "last_error_reason": "timeout",
                                "recent_timeout_count": 2,
                                "recent_failover_count": 1,
                                "recent_success_count": 1,
                                "last_degraded_at": "2026-04-08T00:01:00Z",
                                "fallback_log_backfill": {"last_seen_at": "2026-04-08T00:02:00Z"},
                            },
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            (octopus_dir / "model-policy.json").write_text(
                json.dumps(
                    {
                        "generated_at": "2026-04-08T00:00:00Z",
                        "main_model": "omniroute/cx/gpt-5.4",
                        "worker_pools": {"octoclaw-runner": "minimax-portal/MiniMax-M2.7-highspeed"},
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            (octopus_dir / "model-benchmarks.json").write_text(
                json.dumps(
                    {
                        "models": {
                            "minimax-portal/MiniMax-M2.7-highspeed": {"benchmark_scores": {"pinchbench": 0.88}},
                            "zhipu/GLM-5.1": {"benchmark_scores": {"pinchbench": 0.61}},
                        }
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--task",
                    "你测试下 MiniMax-M2.7-highspeed 和 glm-5.1 的首token和 吞吐的速度",
                ],
                capture_output=True,
                text=True,
                env={**os.environ, "WORKSPACE": workspace},
                check=True,
            )

            self.assertIn("# Model Telemetry Report", result.stdout)
            self.assertIn("Mode: local telemetry / health snapshot inspection", result.stdout)
            self.assertIn("minimax-portal/MiniMax-M2.7-highspeed", result.stdout)
            self.assertIn("zhipu/GLM-5.1", result.stdout)
            self.assertIn("420 ms", result.stdout)
            self.assertIn("78.4 tok/s", result.stdout)
            self.assertIn("degraded", result.stdout)
            self.assertIn("timeout=2 / failover=1 / rate_limit=0", result.stdout)


if __name__ == "__main__":
    unittest.main()
