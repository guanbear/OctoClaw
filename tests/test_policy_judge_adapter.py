#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
JUDGE_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "judge.js"


def run_judge_expression(expression: str, env: Optional[dict] = None) -> dict:
    script = f"""
import * as judge from {json.dumps(str(JUDGE_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **(env or {})},
        check=True,
    )
    return json.loads(result.stdout)


class PolicyJudgeAdapterTests(unittest.TestCase):
    def test_command_adapter_returns_normalized_policy_judge_result(self) -> None:
        command = (
            "python3 -c \"import sys, json; "
            "req=json.load(sys.stdin); "
            "print(json.dumps({"
            "'route':'runner',"
            "'request_kind':'fresh_external_lookup',"
            "'scope':'upstream_project',"
            "'target':'openclaw',"
            "'evidence_required':['web_lookup','execution_ledger'],"
            "'confidence':0.91,"
            "'reason_codes':['semantic_lookup']"
            "}))\""
        )
        payload = run_judge_expression(
            """judge.invokePolicyJudge({
                task: "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                metadata: { session_key: "agent:main:slack:direct:u1" },
                intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                runtimeCfg: {
                  features: { policy_judge_live: true },
                  policy_router: {
                    mode: "model_first",
                    timeout_ms: 1200,
                    candidates: {
                      main_grade_model: {
                        enabled: true,
                        provider: "stateless_ephemeral_judge",
                        model: "inherit_main_grade",
                        command: process.env.OCTOCLAW_POLICY_JUDGE_COMMAND,
                        tools: "none"
                      }
                    }
                  }
                }
            })""",
            env={"OCTOCLAW_POLICY_JUDGE_COMMAND": command},
        )

        self.assertTrue(payload["invoked"])
        self.assertEqual(payload["invocation_state"], "completed")
        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["request_kind"], "fresh_external_lookup")
        self.assertEqual(payload["scope"], "upstream_project")
        self.assertEqual(payload["target"], "openclaw")
        self.assertEqual(payload["evidence_required"], ["web_lookup", "execution_ledger"])

    def test_openai_compatible_adapter_reports_unavailable_without_credentials(self) -> None:
        payload = run_judge_expression(
            """judge.invokePolicyJudge({
                task: "这个是不是要换个更稳的做法",
                metadata: { session_key: "agent:main:slack:direct:u2" },
                intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                runtimeCfg: {
                  features: { policy_judge_live: true, cheap_judge_live: true },
                  policy_router: {
                    mode: "model_first",
                    timeout_ms: 1200,
                    default_judge: "cheap_model",
                    candidates: {
                      cheap_model: {
                        enabled: true,
                        provider: "openai_compatible",
                        model: "cheap-router",
                        base_url: "",
                        tools: "none"
                      }
                    }
                  }
                }
            })"""
        )

        self.assertFalse(payload["invoked"])
        self.assertEqual(payload["invocation_state"], "openai_compatible_adapter_unavailable")

    def test_safe_mode_forces_main_grade_judge_selection(self) -> None:
        payload = run_judge_expression(
            """judge.selectPolicyJudge({
                features: {
                  policy_judge_live: true,
                  cheap_judge_live: true,
                  local_judge_live: true
                },
                policy_router: {
                  default_judge: "cheap_model",
                  candidates: {
                    main_grade_model: {
                      enabled: true,
                      provider: "stateless_ephemeral_judge",
                      model: "main-grade"
                    },
                    cheap_model: {
                      enabled: true,
                      provider: "openai_compatible",
                      model: "cheap-router"
                    }
                  }
                }
            })""",
            env={"OCTOCLAW_RUNTIME_SAFE_MODE": "1"},
        )

        self.assertEqual(payload["name"], "main_grade_model")
        self.assertEqual(payload["model"], "main-grade")


if __name__ == "__main__":
    unittest.main()
