#!/usr/bin/env python3
"""Contract-first route inspection for OctoClaw.

This module no longer tries to behave like a full lightweight router.
Its job is narrower and more stable:

1. Hard-gate obvious runner work.
2. Extract execution-contract hints for policy merge.
3. Emit only a weak route bias for non-runner lanes.

Design goals:
- stable before clever
- contract-first, not task-taxonomy-first
- cheap to run
- explainable in production
- easy to improve with replay/eval feedback later

Output:
- system_preferred_route: weak initial route bias before main-brain hint merge
- route: compatibility alias for the same preferred route
- work_contract_hint: execution-contract hint used by policy/runtime
"""

from __future__ import annotations

import argparse
import atexit
import json

# ═══════════════════════════════════════════════════════════════
# DEPRECATION NOTICE (2026-04-12, R8 cleanup)
# This module's route scoring logic is superseded by the Node runtime
# extension (extensions/octoclaw-runtime/). Only infer_route() is called
# externally, and it delegates to _infer_route_via_node().
# The functions below (previously lines ~1-1740) were Python parity code
# kept for eval/replay compatibility. They have been removed.
# ═══════════════════════════════════════════════════════════════


def _infer_route_via_node_subprocess(task: str, command: str = "", metadata: dict | None = None) -> dict:
    """Compatibility shim: Node runtime is the source of truth for route policy."""
    import subprocess
    from pathlib import Path
    from node_runtime import ensure_node_environment, resolve_node_bin

    repo_root = Path(__file__).resolve().parents[1]
    extension_path = repo_root / "extensions" / "octoclaw-runtime" / "index.js"
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(extension_path))};
const task = {json.dumps(task or "", ensure_ascii=False)};
const command = {json.dumps(command or "", ensure_ascii=False)};
const metadata = {json.dumps(metadata or {}, ensure_ascii=False)};
const value = __octoclawTest.inferRouteWithConversationContext(task, command, metadata);
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        [resolve_node_bin(), "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(repo_root),
        env=ensure_node_environment(),
        check=True,
    )
    return json.loads(result.stdout)


_node_bridge = None


def _get_node_bridge():
    global _node_bridge
    if _node_bridge is not None and _node_bridge.is_alive():
        return _node_bridge
    from node_bridge import NodeBridge
    from node_runtime import ensure_node_environment, resolve_node_bin
    from pathlib import Path
    repo_root = Path(__file__).resolve().parents[1]
    bridge_script = repo_root / "extensions" / "octoclaw-runtime" / "bridge.js"
    env = ensure_node_environment()
    _node_bridge = NodeBridge(str(bridge_script), resolve_node_bin(), env)
    _node_bridge.start()
    return _node_bridge


def _shutdown_bridge():
    global _node_bridge
    if _node_bridge is not None:
        _node_bridge.stop()
        _node_bridge = None


atexit.register(_shutdown_bridge)


def _infer_route_via_node(task: str, command: str = "", metadata: dict | None = None) -> dict:
    try:
        bridge = _get_node_bridge()
        return bridge.call("inferRoute", task=task, command=command, metadata=metadata or {})
    except Exception:
        return _infer_route_via_node_subprocess(task, command, metadata)


def infer_route(task: str, command: str = "", metadata: dict | None = None) -> dict:
    return _infer_route_via_node(task, command, metadata)


def main():
    parser = argparse.ArgumentParser(description="Deterministic OctoClaw route decision")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    args = parser.parse_args()
    print(json.dumps(infer_route(args.task, args.command), ensure_ascii=False))


if __name__ == "__main__":
    main()
