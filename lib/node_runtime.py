#!/usr/bin/env python3
"""Shared Node.js runtime resolution helpers."""

from __future__ import annotations

import os
import shutil
from typing import Mapping


_NODE_PATH_HINTS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.npm-global/bin"),
    os.path.expanduser("~/.volta/bin"),
    os.path.expanduser("~/.nvm/versions/node/current/bin"),
    os.path.expanduser("~/Library/pnpm"),
)

_NODE_BIN_CANDIDATES = (
    "node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    os.path.expanduser("~/.volta/bin/node"),
    os.path.expanduser("~/.nvm/versions/node/current/bin/node"),
)


def _merge_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    merged = dict(os.environ)
    if env:
        merged.update({str(key): str(value) for key, value in env.items()})
    return merged


def _normalize_path_entries(path_value: str) -> list[str]:
    seen: set[str] = set()
    entries: list[str] = []
    for raw in (path_value or "").split(os.pathsep):
        entry = raw.strip()
        if not entry or entry in seen:
            continue
        seen.add(entry)
        entries.append(entry)
    return entries


def _resolve_node_bin_from_env(env: Mapping[str, str]) -> str:
    configured = str(env.get("OCTOCLAW_NODE_BIN", "") or "").strip()
    candidates = [configured] if configured else []
    candidates.extend(_NODE_BIN_CANDIDATES)
    search_path = str(env.get("PATH", "") or "")
    for candidate in candidates:
        if not candidate:
            continue
        resolved = shutil.which(candidate, path=search_path)
        if resolved:
            return resolved
        if os.path.isabs(candidate) and os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return configured or "node"


def ensure_node_environment(env: Mapping[str, str] | None = None) -> dict[str, str]:
    merged = _merge_env(env)
    path_entries = _normalize_path_entries(merged.get("PATH", ""))
    for hint in _NODE_PATH_HINTS:
        if hint and hint not in path_entries and os.path.isdir(hint):
            path_entries.insert(0, hint)
    merged["PATH"] = os.pathsep.join(path_entries)
    merged["OCTOCLAW_NODE_BIN"] = _resolve_node_bin_from_env(merged)
    return merged


def resolve_node_bin(env: Mapping[str, str] | None = None) -> str:
    return ensure_node_environment(env).get("OCTOCLAW_NODE_BIN", "node")
