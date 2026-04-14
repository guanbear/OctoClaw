#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lib.openclaw_paths import (
    resolve_openclaw_config_dir,
    resolve_openclaw_config_path,
    resolve_openclaw_main_agent_dir,
    resolve_openclaw_user_home,
)


class OpenClawPathsTests(unittest.TestCase):
    def test_config_dir_keeps_normal_openclaw_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openclaw-paths-") as tmpdir:
            config_dir = Path(tmpdir) / ".openclaw"
            config_dir.mkdir(parents=True, exist_ok=True)
            (config_dir / "openclaw.json").write_text("{}", encoding="utf-8")

            self.assertEqual(resolve_openclaw_config_dir(config_dir), config_dir.resolve())
            self.assertEqual(resolve_openclaw_config_path(config_dir), (config_dir / "openclaw.json").resolve())
            self.assertEqual(resolve_openclaw_main_agent_dir(config_dir), (config_dir / "agents" / "main" / "agent").resolve())
            self.assertEqual(resolve_openclaw_user_home(config_dir), Path(tmpdir).resolve())

    def test_config_dir_normalizes_parent_home_input(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openclaw-paths-parent-") as tmpdir:
            home_dir = Path(tmpdir)
            config_dir = home_dir / ".openclaw"
            config_dir.mkdir(parents=True, exist_ok=True)
            (config_dir / "openclaw.json").write_text("{}", encoding="utf-8")

            self.assertEqual(resolve_openclaw_config_dir(home_dir), config_dir.resolve())
            self.assertEqual(resolve_openclaw_user_home(home_dir), home_dir.resolve())


if __name__ == "__main__":
    unittest.main()
