#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))
SPEC = importlib.util.spec_from_file_location("set_main_model_module", REPO_ROOT / "lib" / "set-main-model.py")
set_main_model = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(set_main_model)


class SetMainModelTests(unittest.TestCase):
    def test_resolve_session_api_key_accepts_full_key(self) -> None:
        self.assertEqual(
            set_main_model.resolve_session_api_key("agent:main:main"),
            "agent:main:main",
        )

    def test_resolve_session_api_key_prefixes_short_key(self) -> None:
        self.assertEqual(
            set_main_model.resolve_session_api_key("main"),
            "agent:main:main",
        )


if __name__ == "__main__":
    unittest.main()
