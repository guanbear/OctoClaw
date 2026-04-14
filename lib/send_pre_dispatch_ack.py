#!/usr/bin/env python3
"""Best-effort user-visible ack before delegated dispatch begins."""

from __future__ import annotations

import argparse
import json

try:
    from session_ops import send_channel_message
    from task_events import resolve_session_binding
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.session_ops import send_channel_message
    from lib.task_events import resolve_session_binding


def _resolve_target(session_key: str) -> dict:
    binding = resolve_session_binding(session_key)
    if isinstance(binding, dict) and binding.get("target"):
        origin = str(binding.get("origin") or "").strip()
        target = str(binding.get("target") or "").strip()
        thread_id = str(binding.get("thread_id") or "").strip()
        if origin and target:
            return {"ok": True, "origin": origin, "target": target, "thread_id": thread_id}
    return {
        "ok": False,
        "error": "unresolvable canonical session target",
        "session_key": session_key,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Send a best-effort pre-dispatch acknowledgement")
    parser.add_argument("--session-key", required=True)
    parser.add_argument("--channel", default="")
    parser.add_argument("--message", required=True)
    args = parser.parse_args()

    target = _resolve_target(args.session_key)
    if not isinstance(target, dict) or not target.get("ok"):
        print(json.dumps({
            "ok": False,
            "sent": False,
            "attempted": False,
            "delivered": False,
            "error": str((target or {}).get("error", "unresolvable session target")),
            "target": str((target or {}).get("target") or ""),
            "session_key": args.session_key,
        }, ensure_ascii=False))
        return

    channel = str(args.channel or target.get("origin") or "").strip()
    response = send_channel_message(
        channel,
        str(target.get("target") or ""),
        str(args.message or ""),
        thread_id=str(target.get("thread_id") or ""),
        timeout_seconds=12,
    )
    ok = bool(isinstance(response, dict) and response.get("ok"))
    error_detail = "" if ok else str((response or {}).get("error", "message send failed"))
    payload = {
        "ok": ok,
        "sent": ok,          # legacy alias; prefer 'delivered'
        "attempted": True,    # always True if we reached the send step
        "delivered": ok,      # True only if Slack API returned success
        "error": error_detail,
        "channel": channel,
        "target": str(target.get("target") or ""),
        "thread_id": str(target.get("thread_id") or ""),
        "session_key": args.session_key,
        "response": response if isinstance(response, dict) else {},
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
