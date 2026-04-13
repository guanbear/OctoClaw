#!/usr/bin/env python3
"""Tests for lib/cli_reconciler.py."""

from __future__ import annotations

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

mock_reconciler = MagicMock()
mock_openclaw_taskflow_adapter = MagicMock()

sys.modules['reconciler'] = mock_reconciler
sys.modules['lib.reconciler'] = mock_reconciler
sys.modules['openclaw_taskflow_adapter'] = mock_openclaw_taskflow_adapter
sys.modules['lib.openclaw_taskflow_adapter'] = mock_openclaw_taskflow_adapter

from cli_reconciler import main


class TestCLIReconciler(unittest.TestCase):
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_stale_subcommand_runs(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale"]):
            try:
                main()
            except SystemExit:
                pass
        mock_reconcile.assert_called_once()
        call_kwargs = mock_reconcile.call_args[1]
        self.assertEqual(call_kwargs["max_stale_minutes"], 30)
        self.assertTrue(call_kwargs["dry_run"])
        self.assertEqual(call_kwargs["workspace"], "")
    
    @patch("cli_reconciler.reconcile_all")
    def test_all_subcommand_runs(self, mock_reconcile):
        mock_reconcile.return_value = {"total_reconciled": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "all"]):
            try:
                main()
            except SystemExit:
                pass
        mock_reconcile.assert_called_once()
        call_kwargs = mock_reconcile.call_args[1]
        self.assertTrue(call_kwargs["dry_run"])
        self.assertEqual(call_kwargs["workspace"], "")
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_dry_run_default_true(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale"]):
            try:
                main()
            except SystemExit:
                pass
        call_kwargs = mock_reconcile.call_args[1]
        self.assertTrue(call_kwargs["dry_run"])
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_apply_flag(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale", "--apply"]):
            try:
                main()
            except SystemExit:
                pass
        call_kwargs = mock_reconcile.call_args[1]
        self.assertFalse(call_kwargs["dry_run"])
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_exit_code_0_nothing_to_reconcile(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale"]):
            with self.assertRaises(SystemExit) as cm:
                main()
        self.assertEqual(cm.exception.code, 0)
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_exit_code_1_on_errors(self, mock_reconcile):
        mock_reconcile.return_value = {"errors": ["some error"]}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale"]):
            with self.assertRaises(SystemExit) as cm:
                main()
        self.assertEqual(cm.exception.code, 1)
    
    @patch("cli_reconciler.reconcile_stale_tasks")
    def test_exit_code_2_on_reconciled_items(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 5}
        with patch.object(sys, "argv", ["cli_reconciler.py", "stale"]):
            with self.assertRaises(SystemExit) as cm:
                main()
        self.assertEqual(cm.exception.code, 2)
    
    def test_no_command_shows_help(self):
        with patch.object(sys, "argv", ["cli_reconciler.py"]):
            with self.assertRaises(SystemExit) as cm:
                main()
        self.assertEqual(cm.exception.code, 0)
    
    @patch("cli_reconciler.reconcile_native_bindings")
    def test_native_subcommand_with_fix(self, mock_reconcile):
        mock_reconcile.return_value = {"reconciled_count": 0}
        with patch.object(sys, "argv", ["cli_reconciler.py", "native", "--fix"]):
            try:
                main()
            except SystemExit:
                pass
        mock_reconcile.assert_called_once()
        call_kwargs = mock_reconcile.call_args[1]
        self.assertTrue(call_kwargs["fix"])
        self.assertEqual(call_kwargs["workspace"], "")


if __name__ == "__main__":
    unittest.main()