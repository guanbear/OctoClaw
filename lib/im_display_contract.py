#!/usr/bin/env python3
"""Shared IM/display contracts for OctoClaw."""

from __future__ import annotations

from typing import Any


SURFACE_ROLE_MAP = {
    "im": {
        "role": "lightweight_ops",
        "authoritative_for": ["notifications", "task_anchor_visibility"],
        "control_mode": "partial",
        "canonical_observer": False,
    },
    "cli": {
        "role": "canonical_text_operator_surface",
        "authoritative_for": ["details", "queue", "retrieve", "timeline", "graph"],
        "control_mode": "full",
        "canonical_observer": True,
    },
    "tmux": {
        "role": "optional_live_control_workbench",
        "authoritative_for": ["live_runtime_inspection", "manual_intervention"],
        "control_mode": "full",
        "canonical_observer": False,
    },
    "web_ui": {
        "role": "future_full_cockpit",
        "authoritative_for": ["future_rich_control", "future_artifact_explorer"],
        "control_mode": "future",
        "canonical_observer": "future",
    },
}


CAPABILITY_MATRIX = {
    "slack": {
        "level": "L2",
        "anchor": True,
        "thread_topic": True,
        "edit_update": True,
        "interactive_actions": True,
        "pin_persistence": True,
        "artifact_access": "summary+link",
        "queue_visibility": "thread",
        "fallback_behavior": "edit_or_thread_text",
    },
    "discord": {
        "level": "L2",
        "anchor": True,
        "thread_topic": True,
        "edit_update": True,
        "interactive_actions": True,
        "pin_persistence": True,
        "artifact_access": "summary+link",
        "queue_visibility": "thread",
        "fallback_behavior": "edit_or_thread_text",
    },
    "telegram": {
        "level": "L1",
        "anchor": True,
        "thread_topic": True,
        "edit_update": True,
        "interactive_actions": True,
        "pin_persistence": True,
        "artifact_access": "summary+link",
        "queue_visibility": "topic",
        "fallback_behavior": "edit_or_topic_reply",
    },
    "feishu": {
        "level": "L1",
        "anchor": True,
        "thread_topic": True,
        "edit_update": False,
        "interactive_actions": False,
        "pin_persistence": True,
        "artifact_access": "summary+link",
        "queue_visibility": "card_or_text",
        "fallback_behavior": "card_or_text_send",
    },
    "whatsapp": {
        "level": "L0",
        "anchor": True,
        "thread_topic": False,
        "edit_update": False,
        "interactive_actions": False,
        "pin_persistence": False,
        "artifact_access": "text_summary",
        "queue_visibility": "text",
        "fallback_behavior": "text_reply_only",
    },
    "wechat": {
        "level": "L0",
        "anchor": True,
        "thread_topic": False,
        "edit_update": False,
        "interactive_actions": False,
        "pin_persistence": False,
        "artifact_access": "text_summary",
        "queue_visibility": "text",
        "fallback_behavior": "text_reply_only",
    },
    "cli": {
        "level": "L2",
        "anchor": True,
        "thread_topic": False,
        "edit_update": True,
        "interactive_actions": False,
        "pin_persistence": False,
        "artifact_access": "full",
        "queue_visibility": "full",
        "fallback_behavior": "n/a",
    },
    "tmux": {
        "level": "L2",
        "anchor": True,
        "thread_topic": False,
        "edit_update": True,
        "interactive_actions": False,
        "pin_persistence": False,
        "artifact_access": "full",
        "queue_visibility": "full",
        "fallback_behavior": "n/a",
    },
    "web_ui": {
        "level": "future",
        "anchor": True,
        "thread_topic": "future",
        "edit_update": "future",
        "interactive_actions": "future",
        "pin_persistence": "future",
        "artifact_access": "future_full",
        "queue_visibility": "future_full",
        "fallback_behavior": "future",
    },
}


INTERACTION_STATE_MACHINE = {
    "open": {
        "canonical_anchor_required": True,
        "idempotent": True,
        "preferred_path": "send_anchor",
        "fallback": "send_anchor",
        "thread_state": "active",
    },
    "update": {
        "canonical_anchor_required": True,
        "idempotent": True,
        "preferred_path": "edit_anchor",
        "fallback": "thread_reply",
        "thread_state": "active",
    },
    "close": {
        "canonical_anchor_required": True,
        "idempotent": True,
        "preferred_path": "edit_anchor",
        "fallback": "thread_reply",
        "thread_state": "closed",
    },
}


ACTION_TAXONOMY = {
    "view": {"class": "observe", "replay_safe": True},
    "show_queue": {"class": "observe", "replay_safe": True},
    "retrieve": {"class": "navigate", "replay_safe": True},
    "timeline": {"class": "navigate", "replay_safe": True},
    "graph": {"class": "navigate", "replay_safe": True},
    "open_artifacts": {"class": "navigate", "replay_safe": True},
    "explorer": {"class": "navigate", "replay_safe": True},
    "stop": {"class": "destructive-control", "replay_safe": False},
    "retry": {"class": "safe-control", "replay_safe": False},
    "approve": {"class": "approval-mediated", "replay_safe": False},
    "reject": {"class": "approval-mediated", "replay_safe": False},
}


SUBSTRATE_DISPLAY_CONTRACT = {
    "required_fields": [
        "task_id",
        "state",
        "route",
        "worker_pool",
        "substrate_summary",
        "action_availability",
    ],
    "optional_fields": [
        "queue_position",
        "model_summary",
        "cost_estimate",
        "related_thread_artifacts",
        "create_preference",
        "create_status",
    ],
    "forbidden_inferred_fields": [
        "guessed_task_state",
        "renderer_authored_truth",
        "unconfirmed_delivery_state",
    ],
}


def capability_for_surface(surface: str) -> dict[str, Any]:
    return dict(CAPABILITY_MATRIX.get(str(surface or "").strip().lower(), CAPABILITY_MATRIX["whatsapp"]))


def ownership_for_surface(surface: str) -> dict[str, Any]:
    return dict(SURFACE_ROLE_MAP.get(str(surface or "").strip().lower(), {}))


def interaction_contract(action: str) -> dict[str, Any]:
    return dict(INTERACTION_STATE_MACHINE.get(str(action or "").strip().lower(), {}))


def action_contract(kind: str) -> dict[str, Any]:
    return dict(ACTION_TAXONOMY.get(str(kind or "").strip(), {"class": "observe", "replay_safe": True}))


def substrate_display_contract() -> dict[str, Any]:
    return {
        "required_fields": list(SUBSTRATE_DISPLAY_CONTRACT["required_fields"]),
        "optional_fields": list(SUBSTRATE_DISPLAY_CONTRACT["optional_fields"]),
        "forbidden_inferred_fields": list(SUBSTRATE_DISPLAY_CONTRACT["forbidden_inferred_fields"]),
    }
