#!/usr/bin/env python3
"""Notification helpers for Octopus."""

from __future__ import annotations

import importlib.util
import json
import os
from typing import Any

from octopus_config import get_notification_backend, load_octopus_config, notification_enabled

FEISHU_CARD_SCRIPT = os.path.join(os.path.dirname(__file__), "feishu-card.py")


def _load_feishu_module():
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        return None
    spec = importlib.util.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def backend_supports_cards(config: dict[str, Any] | None = None) -> bool:
    return get_notification_backend(config) == "feishu"


def send_text(message: str, *, config: dict[str, Any] | None = None, reply_to: str | None = None) -> str | None:
    cfg = config or load_octopus_config()
    if not notification_enabled("text", cfg):
        return None
    if get_notification_backend(cfg) != "feishu":
        return None

    fc = _load_feishu_module()
    if fc is None:
        return None

    try:
        token = fc.get_tenant_access_token()
        import requests

        if reply_to:
            payload = {
                "msg_type": "text",
                "content": json.dumps({"text": message}, ensure_ascii=False),
            }
            resp = requests.post(
                f"{fc.FEISHU_API_BASE}/im/v1/messages/{reply_to}/reply",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=payload,
                timeout=15,
            )
        else:
            payload = {
                "receive_id": fc.TARGET_OPEN_ID,
                "msg_type": "text",
                "content": json.dumps({"text": message}, ensure_ascii=False),
            }
            resp = requests.post(
                f"{fc.FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=payload,
                timeout=15,
            )
        data = resp.json()
        if data.get("code") == 0:
            return data["data"]["message_id"]
    except Exception:
        return None
    return None

