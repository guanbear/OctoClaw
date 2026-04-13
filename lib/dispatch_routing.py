"""Dispatch routing key generation for OctoClaw."""

from __future__ import annotations

import hashlib
import re
from typing import Any

DISPATCH_ROUTING_SCHEMA_VERSION = "octoclaw.dispatch_routing/v1"

CAPACITY_GROUPS = {
    "runner": "lightweight",
    "spawn_single": "standard",
    "spawn_multi": "heavy",
    "direct": "none",
}

# Valid capacity group values
VALID_CAPACITY_GROUPS = {"lightweight", "standard", "heavy", "none"}


def _collapse_whitespace(text: str) -> str:
    """Collapse multiple whitespace characters into single space."""
    return re.sub(r'\s+', ' ', text)


def normalize_dispatch_key(value: str) -> str:
    """Validate dispatch key is exactly 16 hex characters, return lowercase or empty string."""
    if isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{16}', value):
        return value.lower()
    return ""


def normalize_lane_key(value: str) -> str:
    """Validate lane key format (route:worker_pool:capacity_group), return lowercase or empty string."""
    if isinstance(value, str):
        parts = value.split(':')
        if len(parts) == 3 and all(part for part in parts):
            return value.lower()
    return ""


def normalize_capacity_group(value: str) -> str:
    """Validate capacity group against known groups, return lowercase or empty string."""
    if isinstance(value, str) and value.lower() in VALID_CAPACITY_GROUPS:
        return value.lower()
    return ""


def normalize_task_text_for_key(text: str) -> str:
    """Lowercase, collapse whitespace, truncate to 500 chars."""
    normalized = _collapse_whitespace(text.lower().strip())
    return normalized[:500]


def generate_dispatch_key(
    parent_session_key: str,
    parent_turn_id: str,
    normalized_task_text: str,
    route: str,
    worker_pool: str,
    model_lane: str,
) -> str:
    """Generate deterministic dispatch key from inputs.

    Same inputs always produce the same key. All inputs are normalized
    (lowercased, whitespace-collapsed) before hashing.
    """
    # Normalize all inputs
    def norm(s: str) -> str:
        return _collapse_whitespace(s.lower().strip())

    # Join with newlines, empty strings preserved
    parts = [
        norm(parent_session_key),
        norm(parent_turn_id),
        norm(normalized_task_text),
        norm(route),
        norm(worker_pool),
        norm(model_lane),
    ]
    concatenated = '\n'.join(parts)

    # SHA256 hash, return first 16 hex characters
    return hashlib.sha256(concatenated.encode('utf-8')).hexdigest()[:16]


def generate_lane_key(route: str, worker_pool: str, capacity_group: str) -> str:
    """Generate deterministic lane key: {route}:{worker_pool}:{capacity_group}."""
    return f"{route.lower().strip()}:{worker_pool.lower().strip()}:{capacity_group.lower().strip()}"


def resolve_capacity_group(route: str, worker_pool: str = "", work_type: str = "", model_band: str = "") -> str:
    """Resolve capacity group for a route.

    First checks CAPACITY_GROUPS for the route. If unknown, derives from
    worker_pool or model_band.
    """
    route_lower = route.lower().strip()
    if route_lower in CAPACITY_GROUPS:
        return CAPACITY_GROUPS[route_lower]

    # Derive from worker_pool
    worker_pool_lower = worker_pool.lower().strip()
    if worker_pool_lower == "octoclaw-runner":
        return "lightweight"

    # Derive from model_band
    model_band_lower = model_band.lower().strip()
    if model_band_lower == "fast":
        return "lightweight"
    if model_band_lower == "heavy":
        return "heavy"

    return "standard"


def build_dispatch_routing_payload(dispatch_key: str, lane_key: str, capacity_group: str) -> dict[str, Any]:
    """Build dispatch routing payload with schema version."""
    return {
        "schema_version": DISPATCH_ROUTING_SCHEMA_VERSION,
        "dispatch_key": dispatch_key,
        "lane_key": lane_key,
        "capacity_group": capacity_group,
    }