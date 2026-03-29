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
    "main_model_drift_module",
    REPO_ROOT / "lib" / "main_model_drift.py",
)
main_model_drift = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(main_model_drift)


class MainModelDriftTests(unittest.TestCase):
    def test_assess_detects_aligned_auto_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-main-drift-") as tmpdir:
            mode_path = Path(tmpdir) / "mode.json"
            policy_path = Path(tmpdir) / "policy.json"
            sessions_path = Path(tmpdir) / "sessions.json"
            mode_path.write_text(json.dumps({"mode": "auto"}), encoding="utf-8")
            policy_path.write_text(json.dumps({"main_model": "omniroute/cx/gpt-5.4"}), encoding="utf-8")
            sessions_path.write_text(
                json.dumps({"agent:main:main": {"channelSessionKey": "slack:dm:test", "modelOverride": "omniroute/cx/gpt-5.4"}}),
                encoding="utf-8",
            )
            result = main_model_drift.assess_main_model_drift(
                config={"model_health": {"main_session_drift": {"enabled": True, "auto_recover": False}}},
                main_session="slack:dm:test",
                sessions_file=str(sessions_path),
                mode_file=str(mode_path),
                policy_file=str(policy_path),
            )
            self.assertFalse(result["drift"])
            self.assertEqual(result["reason"], "aligned")

    def test_assess_detects_drifted_auto_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-main-drift-") as tmpdir:
            mode_path = Path(tmpdir) / "mode.json"
            policy_path = Path(tmpdir) / "policy.json"
            sessions_path = Path(tmpdir) / "sessions.json"
            mode_path.write_text(json.dumps({"mode": "auto"}), encoding="utf-8")
            policy_path.write_text(json.dumps({"main_model": "omniroute/cx/gpt-5.4"}), encoding="utf-8")
            sessions_path.write_text(
                json.dumps({"agent:main:main": {"channelSessionKey": "slack:dm:test", "modelOverride": "zhipu/GLM-5.1"}}),
                encoding="utf-8",
            )
            result = main_model_drift.assess_main_model_drift(
                config={"model_health": {"main_session_drift": {"enabled": True, "auto_recover": False}}},
                main_session="slack:dm:test",
                sessions_file=str(sessions_path),
                mode_file=str(mode_path),
                policy_file=str(policy_path),
            )
            self.assertTrue(result["drift"])
            self.assertEqual(result["expected_model"], "omniroute/cx/gpt-5.4")
            self.assertEqual(result["current_override"], "zhipu/GLM-5.1")

    def test_assess_reads_custom_main_model(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-main-drift-") as tmpdir:
            mode_path = Path(tmpdir) / "mode.json"
            policy_path = Path(tmpdir) / "policy.json"
            sessions_path = Path(tmpdir) / "sessions.json"
            mode_path.write_text(json.dumps({"mode": "custom", "customModels": {"main": "custom/model"}}), encoding="utf-8")
            policy_path.write_text(json.dumps({"main_model": "ignored/model"}), encoding="utf-8")
            sessions_path.write_text(
                json.dumps({"agent:main:main": {"channelSessionKey": "slack:dm:test", "modelOverride": ""}}),
                encoding="utf-8",
            )
            result = main_model_drift.assess_main_model_drift(
                config={"model_health": {"main_session_drift": {"enabled": True, "auto_recover": False}}},
                main_session="slack:dm:test",
                sessions_file=str(sessions_path),
                mode_file=str(mode_path),
                policy_file=str(policy_path),
            )
            self.assertTrue(result["drift"])
            self.assertEqual(result["expected_model"], "custom/model")


if __name__ == "__main__":
    unittest.main()
