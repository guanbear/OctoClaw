#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from lib.octopus_config import runner_operator_surface, spawn_operator_surface


class OperatorSurfaceTests(unittest.TestCase):
    @patch("lib.octopus_config.load_octopus_config", return_value={"workbench": {"supervisor_mode": "auto"}})
    def test_runner_surface_defaults_to_backend_neutral_hint(self, _mock_cfg) -> None:
        surface = runner_operator_surface()

        self.assertEqual(surface["role"], "execution_lane")
        self.assertEqual(surface["backend_posture"], "default_runtime")
        self.assertFalse(surface["optional_backend"])
        self.assertEqual(surface["operator_hint"], "")

    @patch(
        "lib.octopus_config.load_octopus_config",
        return_value={"workbench": {"supervisor_mode": "tmux", "tmux_session_name": "octoclaw-runtime", "tmux_runner_window_name": "runner"}},
    )
    def test_runner_surface_marks_tmux_as_optional_backend(self, _mock_cfg) -> None:
        surface = runner_operator_surface()

        self.assertEqual(surface["backend_posture"], "optional_backend")
        self.assertTrue(surface["optional_backend"])
        self.assertEqual(surface["operator_hint"], "opt tmux octoclaw-runtime:runner")
        self.assertTrue(surface["attach_hint"].startswith("tmux attach -t octoclaw-runtime"))

    @patch(
        "lib.octopus_config.load_octopus_config",
        return_value={
            "spawn_execution": {"backend": "native", "backend_name": "tmux"},
            "clawteam_bridge": {"team_name": "octoclaw-validation"},
            "workbench": {"supervisor_mode": "auto"},
        },
    )
    def test_spawn_surface_defaults_to_openclaw_substrate_without_optional_hint(self, _mock_cfg) -> None:
        surface = spawn_operator_surface(agent_name="research")

        self.assertEqual(surface["backend"], "native")
        self.assertEqual(surface["backend_posture"], "default_runtime")
        self.assertFalse(surface["optional_backend"])
        self.assertEqual(surface["operator_hint"], "")
        self.assertIn("default OpenClaw substrate path", surface["surface_summary"])

    @patch(
        "lib.octopus_config.load_octopus_config",
        return_value={
            "spawn_execution": {"backend": "native", "backend_name": "tmux"},
            "clawteam_bridge": {"team_name": "octoclaw-validation"},
            "workbench": {"supervisor_mode": "tmux", "tmux_session_name": "octoclaw-runtime"},
        },
    )
    def test_spawn_surface_can_explicitly_mark_optional_clawteam_backend(self, _mock_cfg) -> None:
        surface = spawn_operator_surface(agent_name="review", backend_override="clawteam", backend_name_override="tmux")

        self.assertEqual(surface["backend"], "clawteam")
        self.assertEqual(surface["backend_name"], "tmux")
        self.assertEqual(surface["backend_posture"], "optional_backend")
        self.assertTrue(surface["optional_backend"])
        self.assertEqual(surface["operator_hint"], "opt clawteam/tmux octoclaw-validation/review")
        self.assertTrue(surface["attach_hint"].startswith("tmux attach -t octoclaw-runtime"))


if __name__ == "__main__":
    unittest.main()
