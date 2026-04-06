#!/usr/bin/env python3
import unittest

from lib.im_display_contract import (
    action_contract,
    capability_for_surface,
    interaction_contract,
    ownership_for_surface,
    substrate_display_contract,
)


class ImDisplayContractTests(unittest.TestCase):
    def test_capability_matrix_returns_expected_levels(self) -> None:
        self.assertEqual(capability_for_surface("slack")["level"], "L2")
        self.assertEqual(capability_for_surface("feishu")["level"], "L1")
        self.assertEqual(capability_for_surface("whatsapp")["level"], "L0")
        self.assertTrue(capability_for_surface("discord")["edit_update"])
        self.assertFalse(capability_for_surface("wechat")["interactive_actions"])

    def test_interaction_contract_marks_update_as_idempotent(self) -> None:
        contract = interaction_contract("update")
        self.assertTrue(contract["idempotent"])
        self.assertEqual(contract["fallback"], "thread_reply")

    def test_action_contract_distinguishes_control_classes(self) -> None:
        self.assertEqual(action_contract("stop")["class"], "destructive-control")
        self.assertEqual(action_contract("approve")["class"], "approval-mediated")
        self.assertTrue(action_contract("retrieve")["replay_safe"])

    def test_surface_ownership_marks_cli_as_canonical_observer(self) -> None:
        payload = ownership_for_surface("cli")
        self.assertTrue(payload["canonical_observer"])
        self.assertEqual(payload["control_mode"], "full")

    def test_substrate_display_contract_exposes_required_and_forbidden_fields(self) -> None:
        payload = substrate_display_contract()
        self.assertIn("task_id", payload["required_fields"])
        self.assertIn("guessed_task_state", payload["forbidden_inferred_fields"])


if __name__ == "__main__":
    unittest.main()
