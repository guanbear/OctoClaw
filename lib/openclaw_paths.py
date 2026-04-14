#!/usr/bin/env python3
"""Canonical OpenClaw path helpers.

OpenClaw callers are inconsistent about the meaning of ``OPENCLAW_HOME``:
some pass the config directory (``~/.openclaw``), while older code treated it
as the user's home directory and then appended ``.openclaw`` again.  That
mistake produces ``~/.openclaw/.openclaw`` and causes stale config/auth reads.
"""

from __future__ import annotations

import os
from pathlib import Path


def _expand_candidate(value: str | Path | None) -> Path:
    raw = str(value or "").strip()
    if raw:
        return Path(raw).expanduser()
    configured = str(os.environ.get("OPENCLAW_HOME", "") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".openclaw"


def resolve_openclaw_config_dir(value: str | Path | None = None) -> Path:
    """Return the canonical config directory that contains ``openclaw.json``."""
    candidate = _expand_candidate(value)
    if candidate.is_file() and candidate.name == "openclaw.json":
        return candidate.parent.resolve()
    if (candidate / "openclaw.json").exists():
        return candidate.resolve()
    nested = candidate / ".openclaw"
    if (nested / "openclaw.json").exists():
        return nested.resolve()
    if candidate.name == ".openclaw":
        return candidate.resolve()
    return candidate.resolve()


def resolve_openclaw_config_path(value: str | Path | None = None) -> Path:
    return resolve_openclaw_config_dir(value) / "openclaw.json"


def resolve_openclaw_main_agent_dir(value: str | Path | None = None) -> Path:
    return resolve_openclaw_config_dir(value) / "agents" / "main" / "agent"


def resolve_openclaw_user_home(value: str | Path | None = None) -> Path:
    config_dir = resolve_openclaw_config_dir(value)
    if config_dir.name == ".openclaw":
        return config_dir.parent.resolve()
    return config_dir.resolve()
