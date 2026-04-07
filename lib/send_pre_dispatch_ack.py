#!/usr/bin/env python3
"""Best-effort user-visible ack before delegated dispatch begins."""

from __future__ import annotations

import argparse
import json

try:
    from session_ops import resolve_message_target_from_session_key, send_channel_message
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.session_ops import resolve_message_target_from_session_key, send_channel_message


def main() -> None:
    parser = argparse.ArgumentParser(description="Send a best-effort pre-dispatch acknowledgement")
    parser.add_argument("--session-key", required=True)
    parser.add_argument("--channel", default="")
    parser.add_argument("--message", required=True)
    args = parser.parse_args()

    target = resolve_message_target_from_session_key(args.session_key)
    if not isinstance(target, dict) or not target.get("ok"):
        print(json.dumps({
            "ok": False,
            "sent": False,
            "session_key": args.session_key,
            "error": str((target or {}).get("error", "unresolvable session target")),
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
    payload = {
        "ok": ok,
        "sent": ok,
        "channel": channel,
        "target": str(target.get("target") or ""),
        "thread_id": str(target.get("thread_id") or ""),
        "session_key": args.session_key,
        "response": response if isinstance(response, dict) else {},
    }
    if not ok:
        payload["error"] = str((response or {}).get("error", "message send failed"))
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
