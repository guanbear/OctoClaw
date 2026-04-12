#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.acceptance_runtime import (
    bootstrap_acceptance_runtime,
    default_acceptance_paths,
)


class AcceptanceRuntimeTests(unittest.TestCase):
    def test_default_acceptance_paths_use_workspace_tmp(self) -> None:
        home, workspace = default_acceptance_paths(Path("/tmp/octo"))
        self.assertTrue(str(home).endswith("/tmp/octo/tmp/octoclaw-acceptance-home"))
        self.assertTrue(str(workspace).endswith("/tmp/octo/tmp/octoclaw-acceptance-workspace"))

    @patch("lib.acceptance_runtime.run_rollout")
    def test_bootstrap_acceptance_runtime_copies_config_and_agent_files(self, mock_rollout) -> None:
        mock_rollout.return_value = {"ok": True, "skipped": False}
        with tempfile.TemporaryDirectory(prefix="octoclaw-acceptance-runtime-") as tmpdir:
            root = Path(tmpdir)
            source_home = root / "source-home"
            target_home = root / "target-home"
            target_workspace = root / "target-workspace"
            (source_home / "agents" / "main" / "agent").mkdir(parents=True)
            (source_home / "openclaw.json").write_text(
                json.dumps(
                    {
                        "channels": {
                            "slack": {
                                "enabled": True,
                                "botToken": "old-bot",
                                "appToken": "old-app",
                                "groupPolicy": "open",
                                "dmPolicy": "open",
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            (source_home / "agents" / "main" / "agent" / "auth-profiles.json").write_text("{}", encoding="utf-8")
            (source_home / "agents" / "main" / "agent" / "models.json").write_text("{}", encoding="utf-8")

            result = bootstrap_acceptance_runtime(
                repo_root=root,
                source_home=source_home,
                target_home=target_home,
                target_workspace=target_workspace,
                slack_bot_token="new-bot",
                slack_app_token="new-app",
                run_rollout_install=True,
            )

            self.assertTrue(result["ok"])
            target_config = json.loads((target_home / "openclaw.json").read_text(encoding="utf-8"))
            self.assertEqual(target_config["channels"]["slack"]["botToken"], "new-bot")
            self.assertEqual(target_config["channels"]["slack"]["appToken"], "new-app")
            self.assertEqual(target_config["gateway"]["port"], 18790)
            self.assertEqual(target_config["gateway"]["bind"], "127.0.0.1")
            self.assertTrue((target_home / "agents" / "main" / "agent" / "auth-profiles.json").exists())
            self.assertTrue((target_home / "agents" / "main" / "agent" / "models.json").exists())
            self.assertTrue((target_workspace / "tmp" / "octopus").exists())


if __name__ == "__main__":
    unittest.main()
