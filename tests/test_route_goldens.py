#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ROUTE_SCRIPT = REPO_ROOT / "lib" / "octoclaw_route.py"
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-route-goldens-v1.json"


def _run_node_expression(expression: str, *, workspace: str) -> dict:
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(EXTENSION_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    env = {**os.environ, "WORKSPACE": workspace}
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=env,
        check=True,
    )
    return json.loads(result.stdout)


class RouteGoldensTests(unittest.TestCase):
    def _run_python_route(self, workspace: str, task: str) -> dict:
        env = {**os.environ, "WORKSPACE": workspace}
        result = subprocess.run(
            ["python3", str(ROUTE_SCRIPT), "--task", task],
            capture_output=True,
            text=True,
            env=env,
            check=True,
        )
        return json.loads(result.stdout)

    def test_route_goldens_match_python_and_js(self) -> None:
        cases = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
        for case in cases:
            task = case["task"]
            expected = case["expected"]
            with self.subTest(task=task):
                with tempfile.TemporaryDirectory(prefix="octoclaw-route-golden-py-") as py_workspace, tempfile.TemporaryDirectory(prefix="octoclaw-route-golden-js-") as js_workspace:
                    python_payload = self._run_python_route(py_workspace, task)
                    js_payload = _run_node_expression(
                        f"__octoclawTest.inferRouteWithConversationContext({json.dumps(task)})",
                        workspace=js_workspace,
                    )
                self.assertEqual(js_payload, python_payload)
                self.assertEqual(python_payload["system_preferred_route"], expected["system_preferred_route"])
                self.assertEqual(python_payload["task_class"], expected["task_class"])
                self.assertEqual(python_payload["work_contract_hint"], expected["work_contract_hint"])
                self.assertEqual(python_payload.get("protected_lane", ""), expected["protected_lane"])


if __name__ == "__main__":
    unittest.main()
