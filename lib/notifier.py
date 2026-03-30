#!/usr/bin/env python3
"""Notification helpers for OctoClaw."""

from __future__ import annotations

import importlib.util
import json
import os
from typing import Any

try:
    from octopus_config import get_notification_backend, infer_session_origin, load_octopus_config, notification_enabled
    from task_events import append_task_event, register_session_binding, resolve_session_binding
    from task_display import build_operator_task_surface, render_task_anchor_slack
    from session_ops import edit_channel_message, resolve_message_target_from_session_key, send_channel_message
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import get_notification_backend, infer_session_origin, load_octopus_config, notification_enabled
    from lib.task_events import append_task_event, register_session_binding, resolve_session_binding
    from lib.task_display import build_operator_task_surface, render_task_anchor_slack
    from lib.session_ops import edit_channel_message, resolve_message_target_from_session_key, send_channel_message

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


def _resolve_task_backend(task: dict[str, Any], requested_backend: str, cfg: dict[str, Any]) -> str:
    resolved_backend = (requested_backend or "auto").strip().lower() or "auto"
    if resolved_backend != "auto":
        return resolved_backend

    session_key = str(task.get("session_key", "") or "").strip()
    parsed_route = resolve_message_target_from_session_key(session_key) if session_key else {}
    session_origin = (
        str(task.get("session_origin", "") or "").strip().lower()
        or str(parsed_route.get("origin", "") or "").strip().lower()
        or infer_session_origin(session_key)
    )
    if session_origin in {"slack", "discord", "telegram", "whatsapp", "signal", "msteams", "googlechat", "feishu"}:
        return session_origin
    return get_notification_backend(cfg)


def build_task_notification_payload(
    task: dict[str, Any],
    *,
    backend: str = "auto",
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    resolved_backend = _resolve_task_backend(task, backend, cfg)

    surface = build_operator_task_surface(task)
    anchor = surface.get("task_anchor", {}) if isinstance(surface.get("task_anchor"), dict) else {}
    actions = surface.get("task_actions", []) if isinstance(surface.get("task_actions"), list) else []
    interactive = surface.get("interactive", {}) if isinstance(surface.get("interactive"), dict) else {}
    text_fallback = str(surface.get("text_fallback", "") or "").strip()

    payload: dict[str, Any] = {
        "schema_version": "octoclaw.notification.task/v1",
        "backend": resolved_backend or "none",
        "text": text_fallback,
        "task_anchor": anchor,
        "task_actions": actions,
        "operator_surface": surface,
        "interactive": interactive,
        "transport": {
            "kind": "none",
            "supports_rich": False,
        },
    }

    if resolved_backend == "slack":
        payload["slack"] = render_task_anchor_slack(anchor, actions)
        payload["transport"] = {
            "kind": "slack",
            "supports_rich": True,
            "supports_buttons": True,
            "fallback_kind": "text",
        }
    elif resolved_backend == "feishu":
        payload["transport"] = {
            "kind": "feishu",
            "supports_rich": True,
            "supports_buttons": False,
            "fallback_kind": "text",
        }
        payload["feishu"] = {
            "text": text_fallback,
            "summary": str(anchor.get("summary", "") or ""),
        }
    elif resolved_backend in {"discord", "telegram", "whatsapp", "wechat"}:
        payload["transport"] = {
            "kind": resolved_backend,
            "supports_rich": False,
            "supports_buttons": resolved_backend in {"telegram", "discord", "msteams"},
            "fallback_kind": "text",
        }
    elif resolved_backend == "none":
        payload["transport"] = {
            "kind": "none",
            "supports_rich": False,
            "supports_buttons": False,
            "fallback_kind": "text",
        }
    else:
        payload["transport"] = {
            "kind": resolved_backend,
            "supports_rich": False,
            "supports_buttons": False,
            "fallback_kind": "text",
        }

    return payload


def send_task_notification(
    task: dict[str, Any],
    *,
    backend: str = "auto",
    config: dict[str, Any] | None = None,
    reply_to: str | None = None,
    existing_message_id: str | None = None,
) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    payload = build_task_notification_payload(task, backend=backend, config=cfg)
    resolved_backend = str(payload.get("backend", "") or "")
    text = str(payload.get("text", "") or "").strip()
    interactive = payload.get("interactive", {}) if isinstance(payload.get("interactive"), dict) else {}
    session_key = str(task.get("session_key", "") or "").strip()

    if resolved_backend == "feishu":
        message_id = send_text(text, config=cfg, reply_to=reply_to)
        if message_id:
            append_task_event(task, "anchor_sent", message=text, extra={"backend": resolved_backend, "message_id": message_id, "action": "send"})
        return {
            "ok": bool(message_id),
            "backend": resolved_backend,
            "message_id": message_id,
            "action": "send",
            "payload": payload,
        }

    binding = resolve_session_binding(session_key)
    route = {
        "ok": bool(str(binding.get("target", "") or "").strip()),
        "origin": str(binding.get("origin", "") or "").strip(),
        "session_key": session_key,
        "target": str(binding.get("target", "") or "").strip(),
        "thread_id": str(binding.get("thread_id", "") or "").strip(),
        "thread_key": str(binding.get("thread_key", "") or "").strip(),
        "binding_key": str(binding.get("binding_key", "") or "").strip(),
        "message_id": str(binding.get("last_message_id", "") or binding.get("message_id", "") or "").strip(),
    }
    if not route.get("ok"):
        route = resolve_message_target_from_session_key(session_key)
    if not route.get("ok"):
        append_task_event(
            task,
            "anchor_resolution_failed",
            message=str(route.get("error") or "unable to resolve session target"),
            extra={"backend": resolved_backend},
        )
        return {
            "ok": False,
            "backend": resolved_backend,
            "payload": payload,
            "error": route.get("error") or "unable to resolve session target",
        }

    transport = payload.get(resolved_backend, {}) if isinstance(payload.get(resolved_backend), dict) else {}
    message = text
    if resolved_backend == "slack":
        message = str(transport.get("text", "") or text)

    editable_backends = {"slack", "discord", "telegram"}
    message_id_value = str(existing_message_id or route.get("message_id") or "").strip()
    if message_id_value and resolved_backend in editable_backends:
        result = edit_channel_message(
            resolved_backend,
            str(route.get("target", "") or ""),
            message_id_value,
            message,
        )
        result.setdefault("backend", resolved_backend)
        result.setdefault("payload", payload)
        result.setdefault("resolved_target", route)
        result.setdefault("action", "edit")
        result.setdefault("message_id", message_id_value)
        if result.get("ok"):
            register_session_binding(
                session_key,
                route,
                task=task,
                source="anchor_edit",
                message_id=str(result.get("message_id", "") or message_id_value),
                action="edit",
                thread_state="active",
            )
            append_task_event(
                task,
                "anchor_edited",
                message=message,
                extra={
                    "backend": resolved_backend,
                    "message_id": str(result.get("message_id", "") or message_id_value),
                    "action": "edit",
                    "resolved_target": route,
                },
            )
            return result

    interactive_payload = interactive if resolved_backend in {"slack", "telegram", "discord", "msteams"} else None
    result = send_channel_message(
        resolved_backend,
        str(route.get("target", "") or ""),
        message,
        reply_to=str(reply_to or "").strip(),
        thread_id=str(route.get("thread_id", "") or "").strip(),
        interactive=interactive_payload,
    )
    result.setdefault("backend", resolved_backend)
    result.setdefault("payload", payload)
    result.setdefault("resolved_target", route)
    result.setdefault("action", "send")
    if result.get("ok"):
        register_session_binding(
            session_key,
            route,
            task=task,
            source="anchor_send",
            message_id=str(result.get("message_id", "") or result.get("messageId", "") or ""),
            action="send",
            thread_state="active",
        )
        append_task_event(
            task,
            "anchor_sent",
            message=message,
            extra={
                "backend": resolved_backend,
                "message_id": str(result.get("message_id", "") or result.get("messageId", "") or ""),
                "action": "send",
                "resolved_target": route,
            },
        )
    else:
        append_task_event(
            task,
            "anchor_send_failed",
            message=str(result.get("error") or "send_task_notification failed"),
            extra={"backend": resolved_backend, "resolved_target": route},
        )
    return result


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
