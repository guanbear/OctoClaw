#!/usr/bin/env python3
"""Compatibility wrapper around octoclaw_route.

Historically OctoClaw had a separate runner_routing heuristic. That created
split-brain behavior once `octoclaw_route` grew into the real route engine.
This wrapper keeps old call sites working, but the decision source is now
`octoclaw_route` only.
"""

from __future__ import annotations

import argparse
import json

from octoclaw_route import infer_route


def route_task(text: str) -> dict:
    payload = infer_route(text)
    route = "runner" if payload.get("route") == "runner" else "spawn"
    return {
        "route": route,
        "confidence": payload.get("confidence", 0.0),
        "reason": payload.get("reason", "delegated_to_octoclaw_route"),
        "reason_codes": payload.get("reason_codes", []),
        "source": text,
    }


def main():
    parser = argparse.ArgumentParser(description="Compatibility runner router backed by octoclaw_route")
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    print(json.dumps(route_task(args.task), ensure_ascii=False))


if __name__ == "__main__":
    main()
