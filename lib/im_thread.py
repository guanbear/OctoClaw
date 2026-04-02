#!/usr/bin/env python3
"""IM thread lifecycle manager for OctoClaw.

Handles:
- Thread creation (open_thread) on task spawn/dispatch
- Thread updates (update_thread) on checkpoint/progress events
- Thread closure (close_thread) on task completion/failure
- Multi-origin fan-out to all registered IM targets simultaneously
- Retry/backoff for transient send failures
- Deduplication by thread_key to avoid duplicate pushes
"""

from __future__ import annotations

import time
from typing import Any

try:
    from notifier import build_task_notification_payload, send_task_notification
    from octopus_config import load_octopus_config
    from session_ops import edit_channel_message, send_channel_message
    from task_events import (
        EVENT_IMPORTANCE,
        append_task_event,
        register_session_binding,
        resolve_session_binding,
    )
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.notifier import build_task_notification_payload, send_task_notification
    from lib.octopus_config import load_octopus_config
    from lib.session_ops import edit_channel_message, send_channel_message
    from lib.task_events import (
        EVENT_IMPORTANCE,
        append_task_event,
        register_session_binding,
        resolve_session_binding,
    )


# Retry schedule: wait 0 s before 1st attempt, 1 s before 2nd, 3 s before 3rd.
_RETRY_DELAYS: tuple[float, ...] = (0.0, 1.0, 3.0)

# Backends that support in-place message editing.
_EDITABLE_BACKENDS: frozenset[str] = frozenset({"slack", "discord", "telegram"})

# Event kinds whose semantics are "the task is now done".
_CLOSE_EVENTS: frozenset[str] = frozenset(
    {
        "task_completed",
        "task_failed",
        "failed",
        "result_ready",
        "artifact_ready",
        "handoff_ready",
    }
)

# Event kinds that produce a mid-flight update to the thread.
_UPDATE_EVENTS: frozenset[str] = frozenset(
    {
        "checkpoint",
        "progress_note",
        "task_running",
        "task_started",
        "source_blocked",
        "task_blocked",
    }
)

# Event kinds that create the initial thread anchor.
_OPEN_EVENTS: frozenset[str] = frozenset({"dispatch_started", "route_selected"})


def _text(v: Any) -> str:
    return str(v or "").strip()


# ---------------------------------------------------------------------------
# Session-key helpers
# ---------------------------------------------------------------------------


def _all_session_keys(task: dict[str, Any]) -> list[str]:
    """Return all deduplicated IM session keys declared on a task.

    Checks ``session_key`` (primary), ``extra_session_keys``, and
    ``session_keys`` list fields.  Unknown / empty values are skipped.
    """
    seen: set[str] = set()
    keys: list[str] = []
    candidates: list[Any] = [
        task.get("session_key"),
        *(task.get("extra_session_keys") or []),
        *(task.get("session_keys") or []),
    ]
    for raw in candidates:
        k = _text(raw)
        if k and k not in seen:
            seen.add(k)
            keys.append(k)
    return keys


# ---------------------------------------------------------------------------
# Retry wrappers
# ---------------------------------------------------------------------------


def _retry_send(
    backend: str,
    target: str,
    message: str,
    *,
    reply_to: str = "",
    thread_id: str = "",
) -> dict[str, Any]:
    """Call send_channel_message with up to ``len(_RETRY_DELAYS)`` attempts."""
    last: dict[str, Any] = {"ok": False, "error": "no attempts made"}
    for attempt, delay in enumerate(_RETRY_DELAYS, start=1):
        if delay:
            time.sleep(delay)
        try:
            result = send_channel_message(
                backend,
                target,
                message,
                reply_to=reply_to,
                thread_id=thread_id,
            )
        except Exception as exc:  # noqa: BLE001
            last = {"ok": False, "error": str(exc), "attempt": attempt}
            continue
        result["attempt"] = attempt
        if result.get("ok"):
            return result
        last = result
    return last


def _retry_edit(
    backend: str,
    target: str,
    message_id: str,
    message: str,
) -> dict[str, Any]:
    """Call edit_channel_message with up to ``len(_RETRY_DELAYS)`` attempts."""
    last: dict[str, Any] = {"ok": False, "error": "no attempts made"}
    for attempt, delay in enumerate(_RETRY_DELAYS, start=1):
        if delay:
            time.sleep(delay)
        try:
            result = edit_channel_message(backend, target, message_id, message)
        except Exception as exc:  # noqa: BLE001
            last = {"ok": False, "error": str(exc), "attempt": attempt}
            continue
        result["attempt"] = attempt
        if result.get("ok"):
            return result
        last = result
    return last


# ---------------------------------------------------------------------------
# Per-session push
# ---------------------------------------------------------------------------


def _push_one(
    session_key: str,
    task: dict[str, Any],
    message: str,
    *,
    action: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Push one message to a single session key with full lifecycle semantics.

    ``action`` must be one of:

    * ``'open'``   — always sends a new anchor message; delegates to
      ``send_task_notification`` so that rich card / Feishu formatting works.
    * ``'update'`` — edits the anchor in-place on editable backends;
      otherwise sends a reply into the thread.
    * ``'close'``  — same as ``'update'`` but marks the thread as closed.
    """
    if action == "open":
        # Delegate to the full send_task_notification path so Feishu / rich
        # cards are handled correctly for every backend.
        sub_task = {**task, "session_key": session_key}
        result = send_task_notification(sub_task, config=config)
        result.setdefault("session_key", session_key)
        binding = resolve_session_binding(session_key)
        result.setdefault("thread_key", _text(binding.get("thread_key")))
        result["action"] = "open"
        return result

    # update / close: resolve the stored binding and use direct send/edit.
    binding = resolve_session_binding(session_key)
    origin = _text(binding.get("origin"))
    target = _text(binding.get("target"))
    thread_id = _text(binding.get("thread_id"))
    thread_key = _text(binding.get("thread_key"))
    last_message_id = _text(
        binding.get("last_message_id") or binding.get("message_id")
    )

    if not target:
        return {
            "ok": False,
            "session_key": session_key,
            "thread_key": thread_key,
            "error": "no IM target resolved for session key",
            "action": action,
        }

    thread_state = "closed" if action == "close" else "active"

    # Prefer editing the existing anchor on backends that support it.
    if last_message_id and origin in _EDITABLE_BACKENDS:
        result = _retry_edit(origin, target, last_message_id, message)
        result["session_key"] = session_key
        result["thread_key"] = thread_key
        result["action"] = "edit"
        if result.get("ok"):
            register_session_binding(
                session_key,
                binding,
                task=task,
                source=f"im_thread_{action}",
                message_id=last_message_id,
                action="edit",
                thread_state=thread_state,
            )
        return result

    # Fallback: send a reply inside the existing thread.
    result = _retry_send(origin, target, message, thread_id=thread_id)
    result["session_key"] = session_key
    result["thread_key"] = thread_key
    result["action"] = "send"
    if result.get("ok"):
        new_mid = _text(result.get("message_id") or result.get("messageId"))
        register_session_binding(
            session_key,
            binding,
            task=task,
            source=f"im_thread_{action}",
            message_id=new_mid,
            action="send",
            thread_state=thread_state,
        )
    return result


# ---------------------------------------------------------------------------
# Multi-origin fan-out
# ---------------------------------------------------------------------------


def _fan_out(
    task: dict[str, Any],
    message: str,
    *,
    action: str,
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    """Push to every session key on the task, deduplicating by thread_key.

    When two session keys resolve to the same ``thread_key`` (e.g. the same
    Slack channel opened from different routing paths) only the first is sent.
    """
    session_keys = _all_session_keys(task)
    if not session_keys:
        return []
    seen_thread_keys: set[str] = set()
    results: list[dict[str, Any]] = []
    for sk in session_keys:
        binding = resolve_session_binding(sk)
        thread_key = _text(binding.get("thread_key"))
        if thread_key:
            if thread_key in seen_thread_keys:
                continue
            seen_thread_keys.add(thread_key)
        result = _push_one(sk, task, message, action=action, config=config)
        results.append(result)
    return results


# ---------------------------------------------------------------------------
# Public lifecycle API
# ---------------------------------------------------------------------------


def open_thread(
    task: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Create anchor message(s) for all IM origins when a task is spawned.

    Builds the rich notification payload once (so card formatting is shared),
    then fans out to every session key.  Each origin records its own binding.

    Returns one result dict per origin push attempt.
    """
    cfg = config or load_octopus_config()
    notification_payload = build_task_notification_payload(task, config=cfg)
    message = _text(notification_payload.get("text"))
    if not message:
        return []
    results = _fan_out(task, message, action="open", config=cfg)
    for r in results:
        ok = bool(r.get("ok"))
        append_task_event(
            task,
            "thread_opened" if ok else "thread_open_failed",
            message=message if ok else _text(r.get("error")),
            extra={
                "session_key": _text(r.get("session_key")),
                "thread_key": _text(r.get("thread_key")),
                "message_id": _text(r.get("message_id")),
                "action": "open",
            },
        )
    return results


def update_thread(
    task: dict[str, Any],
    event_kind: str,
    message: str,
    *,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Push a progress/checkpoint update to all IM threads.

    Low-importance events (``EVENT_IMPORTANCE == "low"``) are silently skipped
    to avoid flooding IM channels with noise.

    For editable backends (Slack / Discord / Telegram) the anchor message is
    edited in-place so the thread stays clean.  For others a reply is sent.

    Returns one result dict per origin.
    """
    importance = EVENT_IMPORTANCE.get(_text(event_kind), "normal")
    if importance == "low":
        return []
    cfg = config or load_octopus_config()
    msg = (
        _text(message)
        or _text(task.get("summary"))
        or _text(task.get("user_safe_summary"))
        or _text(event_kind)
    )
    results = _fan_out(task, msg, action="update", config=cfg)
    for r in results:
        ok = bool(r.get("ok"))
        append_task_event(
            task,
            "thread_updated" if ok else "thread_update_failed",
            message=msg if ok else _text(r.get("error")),
            extra={
                "event_kind": event_kind,
                "session_key": _text(r.get("session_key")),
                "thread_key": _text(r.get("thread_key")),
                "message_id": _text(r.get("message_id")),
                "action": _text(r.get("action")),
            },
        )
    return results


def close_thread(
    task: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Push the final task summary to all IM threads and mark them closed.

    For editable backends the anchor message is updated to the final state.
    For others a closing reply is sent into the thread.

    Returns one result dict per origin.
    """
    cfg = config or load_octopus_config()
    notification_payload = build_task_notification_payload(task, config=cfg)
    message = _text(notification_payload.get("text"))
    if not message:
        return []
    results = _fan_out(task, message, action="close", config=cfg)
    for r in results:
        ok = bool(r.get("ok"))
        append_task_event(
            task,
            "thread_closed" if ok else "thread_close_failed",
            message=message if ok else _text(r.get("error")),
            extra={
                "session_key": _text(r.get("session_key")),
                "thread_key": _text(r.get("thread_key")),
                "message_id": _text(r.get("message_id")),
                "action": _text(r.get("action")),
            },
        )
    return results


def push_thread_event(
    task: dict[str, Any],
    event_kind: str,
    *,
    message: str = "",
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Unified dispatcher — main entry point for lifecycle → IM push.

    Routes ``event_kind`` to the appropriate handler:

    ============ ==================================
    event_kind   handler
    ============ ==================================
    OPEN_EVENTS  :func:`open_thread`
    UPDATE_EVENTS :func:`update_thread`
    CLOSE_EVENTS :func:`close_thread`
    others        no-op, returns ``[]``
    ============ ==================================
    """
    cfg = config or load_octopus_config()
    kind = _text(event_kind)
    if kind in _CLOSE_EVENTS:
        return close_thread(task, config=cfg)
    if kind in _UPDATE_EVENTS:
        return update_thread(task, kind, message, config=cfg)
    if kind in _OPEN_EVENTS:
        return open_thread(task, config=cfg)
    return []
