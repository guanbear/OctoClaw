#!/usr/bin/env python3
import unittest

from lib.nightly_reply_review import build_prompt


class NightlyReplyReviewTests(unittest.TestCase):
    def test_build_prompt_includes_selection_metrics_and_analysis_context(self) -> None:
        packet = {
            "sessions_considered": 3,
            "case_count": 1,
            "selection_metrics": {
                "direct_case_count": 1,
                "protected_lane_case_count": 1,
                "direct_policy_missing_count": 1,
            },
            "cases": [
                {
                    "session_key": "s1",
                    "user_timestamp": "2026-04-08T00:00:00+08:00",
                    "assistant_timestamp": "2026-04-08T00:00:30+08:00",
                    "user_prompt": "你是啥模型",
                    "assistant_reply": "我先派个子任务看一下。",
                    "policy": {
                        "route": "",
                        "system_preferred_route": "",
                        "worker_pool": "",
                    },
                    "dispatch": {
                        "called": False,
                    },
                    "analysis": {
                        "policy_matched": False,
                        "assistant_latency_seconds": 30.0,
                        "selection_tags": [
                            "direct_path",
                            "protected_lane",
                            "control_observer",
                            "direct_policy_missing",
                            "delegation_explanation_risk",
                        ],
                        "current_expected": {
                            "route": "direct",
                            "task_class": "control_observer",
                            "protected_lane": "control_observer",
                            "work_contract_hint": "answer_now",
                        },
                    },
                }
            ],
        }

        prompt = build_prompt(packet, day="2026-04-08", timezone="Asia/Shanghai")
        self.assertIn("Selection metrics:", prompt)
        self.assertIn("protected_lane: control_observer", prompt)
        self.assertIn("assistant_latency_seconds: 30.0", prompt)
        self.assertIn("selection_tags: direct_path, protected_lane, control_observer, direct_policy_missing, delegation_explanation_risk", prompt)
        self.assertIn("invented delegation explanation", prompt)


if __name__ == "__main__":
    unittest.main()
