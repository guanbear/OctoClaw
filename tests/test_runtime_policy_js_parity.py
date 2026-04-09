#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"
ROUTE_SCRIPT = REPO_ROOT / "lib" / "octoclaw_route.py"
POLICY_SCRIPT = REPO_ROOT / "lib" / "octoclaw_policy.py"


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


def _normalize_decision(payload: dict) -> dict:
    normalized = json.loads(json.dumps(payload))
    normalized.pop("generated_at", None)
    auto_router = normalized.get("auto_router")
    if isinstance(auto_router, dict):
        model_intel = auto_router.get("model_intel")
        if isinstance(model_intel, dict):
            model_intel.pop("source_files", None)
            facts_plane = model_intel.get("facts_plane")
            if isinstance(facts_plane, dict):
                facts_plane.pop("source_status_file", None)
    return normalized


class RuntimePolicyJsParityTests(unittest.TestCase):
    def _write_runtime_config(self, workspace: str, payload: Optional[dict] = None) -> None:
        config_path = Path(workspace) / "tmp" / "octopus-config.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(payload or {}, fh)

    def _write_model_policy(self, workspace: str, payload: dict) -> None:
        policy_path = Path(workspace) / "tmp" / "octopus" / "model-policy.json"
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        with open(policy_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)

    def _write_route_stickiness(self, workspace: str, payload: dict) -> None:
        stickiness_path = Path(workspace) / "tmp" / "octopus" / "route-stickiness.json"
        stickiness_path.parent.mkdir(parents=True, exist_ok=True)
        with open(stickiness_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)

    def _run_python_route(self, workspace: str, task: str, *, command: str = "") -> dict:
        env = {**os.environ, "WORKSPACE": workspace}
        cmd = ["python3", str(ROUTE_SCRIPT), "--task", task]
        if command:
            cmd.extend(["--command", command])
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, check=True)
        return json.loads(result.stdout)

    def _run_python_policy(
        self,
        workspace: str,
        task: str,
        *,
        command: str = "",
        metadata: Optional[dict] = None,
        force_route: str = "",
        route_hint: Optional[dict] = None,
    ) -> dict:
        env = {**os.environ, "WORKSPACE": workspace}
        cmd = ["python3", str(POLICY_SCRIPT), "--task", task]
        if command:
            cmd.extend(["--command", command])
        if metadata:
            cmd.extend(["--metadata-json", json.dumps(metadata, ensure_ascii=False)])
        if force_route:
            cmd.extend(["--force-route", force_route])
        if route_hint:
            cmd.extend(["--route-hint-json", json.dumps(route_hint, ensure_ascii=False)])
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, check=True)
        return json.loads(result.stdout)

    def test_route_parity_against_python_reference(self) -> None:
        cases = [
            {
                "task": "检查一下 nginx error log 最近 80 行，然后总结问题",
                "config": {},
            },
            {
                "task": "8080番ポートが開いているか確認して",
                "config": {"runtime_policy": {"route_language_packs": {"enabled": ["zh", "en", "ja"]}}},
            },
            {
                "task": "调研三个兼容方案并写一版简短建议",
                "config": {},
            },
            {
                "task": "发布到生产环境前再检查一下鉴权配置",
                "config": {},
            },
            {
                "task": "分三个子任务并行进行：1) 检查认证模块现有漏洞 2) 检查存储层备份状态 3) 检查API网关限流配置，每项出独立报告",
                "config": {},
            },
            {
                "task": "八爪鱼状态",
                "config": {},
            },
            {
                "task": "你现在是啥模型",
                "config": {},
            },
            {
                "task": "你是啥模型",
                "config": {},
            },
            {
                "task": "这次有没有走 dispatch",
                "config": {},
            },
            {
                "task": "查一下 OctoClaw 项目在 GitHub 上今天（2026-04-07）有更新吗",
                "config": {},
            },
            {
                "task": "你测试下 MiniMax-M2.7-highspeed 和 glm-5.1 的首token和 吞吐的速度",
                "config": {},
            },
            {
                "task": "好了吗",
                "config": {},
            },
            {
                "task": "在吗",
                "config": {},
            },
            {
                "task": "details task-123",
                "config": {},
            },
            {
                "task": "stop task-123",
                "config": {},
            },
        ]

        for case in cases:
            with self.subTest(task=case["task"]):
                with tempfile.TemporaryDirectory(prefix="octoclaw-route-py-") as py_workspace, tempfile.TemporaryDirectory(prefix="octoclaw-route-js-") as js_workspace:
                    self._write_runtime_config(py_workspace, case["config"])
                    self._write_runtime_config(js_workspace, case["config"])
                    python_payload = self._run_python_route(py_workspace, case["task"])
                    js_payload = _run_node_expression(
                        f"__octoclawTest.inferRoute({json.dumps(case['task'])})",
                        workspace=js_workspace,
                    )
                    self.assertEqual(js_payload, python_payload)

    def test_policy_decision_parity_against_python_reference(self) -> None:
        model_policy_runner = {
            "generated_at": "2026-03-29T00:00:00Z",
            "main_model": "model/main",
            "profiles": {"ops-fast": "model/profile-ops"},
            "worker_pools": {"octoclaw-runner": "model/runner"},
            "worker_pool_phases": {"octoclaw-runner": {"inspect": "model/runner-inspect"}},
        }
        model_policy_writer = {
            "generated_at": "2026-03-29T00:00:00Z",
            "main_model": "model/main",
            "profiles": {"writer": "model/profile-writer"},
            "worker_pools": {"octoclaw-research": "model/research"},
            "worker_pool_phases": {"octoclaw-research": {"report": "model/research-report"}},
        }
        sticky_payload = {
            "demo": {
                "route": "spawn_single",
                "work_type": "research",
                "work_contract": "deliverable_work",
                "applied_count": 0,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        }
        sticky_runner_payload = {
            "demo": {
                "route": "runner",
                "work_type": "research",
                "work_contract": "inspect_report",
                "applied_count": 0,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        }
        cases = [
            {
                "task": "看下 8080 端口开了没",
                "metadata": {},
                "config": {},
                "model_policy": model_policy_runner,
            },
            {
                "task": "调研三个兼容方案并写一版简短建议",
                "metadata": {},
                "config": {},
                "model_policy": model_policy_writer,
            },
            {
                "task": "好",
                "metadata": {"session_key": "demo"},
                "config": {
                    "runtime_policy": {
                        "route_stickiness": {
                            "enabled": True,
                            "ack_followup_enabled": True,
                        },
                        "switches": {
                            "route_hint_required": True,
                        },
                    }
                },
                "stickiness": sticky_payload,
            },
            {
                "task": "继续",
                "metadata": {"session_key": "demo"},
                "config": {
                    "runtime_policy": {
                        "route_stickiness": {
                            "enabled": True,
                            "ack_followup_enabled": True,
                        },
                        "switches": {
                            "route_hint_required": True,
                        },
                    }
                },
                "stickiness": sticky_runner_payload,
            },
            {
                "task": "调研三个兼容方案并写一版简短建议",
                "metadata": {},
                "config": {},
                "route_hint": {
                    "route_hint": "direct",
                    "work_type": "research",
                    "phase": "report",
                    "review_required": False,
                    "confidence": 0.6,
                    "reason": "try direct first",
                    "source": "main_agent",
                },
            },
            {
                "task": "检查一下服务健康状态",
                "metadata": {},
                "config": {},
                "force_route": "runner",
            },
        ]

        for case in cases:
            with self.subTest(task=case["task"], route_hint=bool(case.get("route_hint"))):
                with tempfile.TemporaryDirectory(prefix="octoclaw-policy-py-") as py_workspace, tempfile.TemporaryDirectory(prefix="octoclaw-policy-js-") as js_workspace:
                    self._write_runtime_config(py_workspace, case.get("config"))
                    self._write_runtime_config(js_workspace, case.get("config"))
                    if case.get("model_policy"):
                        self._write_model_policy(py_workspace, case["model_policy"])
                        self._write_model_policy(js_workspace, case["model_policy"])
                    if case.get("stickiness"):
                        self._write_route_stickiness(py_workspace, case["stickiness"])
                        self._write_route_stickiness(js_workspace, case["stickiness"])

                    python_payload = self._run_python_policy(
                        py_workspace,
                        case["task"],
                        metadata=case.get("metadata"),
                        route_hint=case.get("route_hint"),
                        force_route=case.get("force_route", ""),
                    )
                    js_payload = _run_node_expression(
                        "__octoclawTest.buildDecision("
                        f"{json.dumps(case['task'])}, "
                        f"{json.dumps({'metadata': case.get('metadata', {}), 'routeHint': case.get('route_hint', {}), 'forceRoute': case.get('force_route', '')})}"
                        ")",
                        workspace=js_workspace,
                    )

                    self.assertEqual(_normalize_decision(js_payload), _normalize_decision(python_payload))


_GUARD_FILE = Path("/tmp/ironclaw-model-guard-override.json")
_GLM_BUILTIN = "lixiang-glm-5/kivy-glm-5"


class RuntimePolicyModelGuardTests(unittest.TestCase):
    """JS-only guard tests — Python does not implement the guard layer."""

    def setUp(self) -> None:
        self._guard_backup: Optional[str] = None
        if _GUARD_FILE.exists():
            self._guard_backup = _GUARD_FILE.read_text("utf-8")

    def tearDown(self) -> None:
        if self._guard_backup is not None:
            _GUARD_FILE.write_text(self._guard_backup, "utf-8")
        elif _GUARD_FILE.exists():
            _GUARD_FILE.unlink()

    def _write_guard(self, payload: dict) -> None:
        _GUARD_FILE.write_text(json.dumps(payload), "utf-8")

    def test_guard_all_fail_returns_empty_model(self) -> None:
        self._write_guard({"guarded": True, "status": "all_fail"})
        with tempfile.TemporaryDirectory(prefix="octoclaw-guard-") as ws:
            result = _run_node_expression(
                "__octoclawTest.buildDecision('看下磁盘使用率', {})",
                workspace=ws,
            )
        self.assertEqual(result["model_policy"]["selected_model"], "")

    def test_guard_ratelimit_falls_back_to_glm(self) -> None:
        self._write_guard({"guarded": True, "status": "ratelimit"})
        with tempfile.TemporaryDirectory(prefix="octoclaw-guard-") as ws:
            result = _run_node_expression(
                "__octoclawTest.buildDecision('看下磁盘使用率', {})",
                workspace=ws,
            )
        self.assertEqual(result["model_policy"]["selected_model"], _GLM_BUILTIN)

    def test_guard_inactive_does_not_redirect(self) -> None:
        self._write_guard({"guarded": False})
        with tempfile.TemporaryDirectory(prefix="octoclaw-guard-") as ws:
            result = _run_node_expression(
                "__octoclawTest.buildDecision('看下磁盘使用率', {})",
                workspace=ws,
            )
        # When guard is not active, model must not be forcibly set to GLM
        self.assertNotEqual(result["model_policy"]["selected_model"], "")


if __name__ == "__main__":
    unittest.main()
