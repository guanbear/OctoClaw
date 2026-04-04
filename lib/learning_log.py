#!/usr/bin/env python3
"""Shared learning/error logging helpers.

OctoClaw should stay directly compatible with the self-improving-agent
convention instead of inventing a separate error store. We therefore write to:

1. OpenClaw workspace learnings: ~/.openclaw/workspace/.learnings/ERRORS.md
2. Legacy workspace path:       /workspace/.learnings/ERRORS.md
3. Mirror path:                 ~/self-improving/domains/octoclaw-errors.md
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from octopus_config import WORKSPACE

OPENCLAW_WORKSPACE = os.path.expanduser("~/.openclaw/workspace")


def _dedupe_keep_order(paths: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for path in paths:
        if not path or path in seen:
            continue
        seen.add(path)
        result.append(path)
    return result


def error_targets() -> list[str]:
    return _dedupe_keep_order(
        [
            os.path.join(OPENCLAW_WORKSPACE, ".learnings", "ERRORS.md"),
            os.path.join(WORKSPACE, ".learnings", "ERRORS.md"),
        ]
    )


def learning_targets() -> list[str]:
    return _dedupe_keep_order(
        [
            os.path.join(OPENCLAW_WORKSPACE, ".learnings", "LEARNINGS.md"),
            os.path.join(WORKSPACE, ".learnings", "LEARNINGS.md"),
        ]
    )


def legacy_octopus_error_mirror() -> str:
    return os.path.join(os.path.expanduser("~"), "self-improving", "domains", "octoclaw-errors.md")


def _next_error_id(existing: str) -> str:
    today = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d")
    matches = re.findall(rf"ERR-{today}-(\d+)", existing)
    seq = max((int(m) for m in matches), default=0) + 1
    return f"ERR-{today}-{seq:03d}"


def append_error_entry(
    *,
    skill_or_command: str,
    summary: str,
    error_text: str,
    context_lines: list[str] | None = None,
    suggested_fix: str = "",
    priority: str = "high",
    area: str = "infra",
    reproducible: str = "unknown",
    related_files: list[str] | None = None,
) -> str:
    now = datetime.now(timezone.utc).astimezone()
    logged_at = now.isoformat()
    targets = error_targets()
    existing = ""
    primary = targets[0]
    if os.path.exists(primary):
        try:
            with open(primary, "r", encoding="utf-8") as f:
                existing = f.read()
        except OSError:
            existing = ""
    err_id = _next_error_id(existing)

    context_block = "\n".join(f"- {line}" for line in (context_lines or []) if line.strip()).strip()
    related = ", ".join(related_files or [])
    entry = "\n".join(
        [
            f"## [{err_id}] {skill_or_command}",
            "",
            f"**Logged**: {logged_at}",
            f"**Priority**: {priority}",
            "**Status**: pending",
            f"**Area**: {area}",
            "",
            "### Summary",
            summary.strip() or "Unexpected OctoClaw error",
            "",
            "### Error",
            "```text",
            (error_text or "").strip() or "(no error text)",
            "```",
            "",
            "### Context",
            context_block or "- (no extra context)",
            "",
            "### Suggested Fix",
            suggested_fix.strip() or "Route the same task through OctoClaw runtime instead of hand-crafting tool arguments.",
            "",
            "### Metadata",
            f"- Reproducible: {reproducible}",
            f"- Related Files: {related or '(none)'}",
            f"- Source: octoclaw",
            "",
            "---",
            "",
        ]
    )

    for path in targets:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(entry)
        except OSError:
            pass

    try:
        mirror = legacy_octopus_error_mirror()
        os.makedirs(os.path.dirname(mirror), exist_ok=True)
        with open(mirror, "a", encoding="utf-8") as f:
            f.write(
                f"- [{now.strftime('%Y-%m-%d')}] {skill_or_command}: "
                f"{summary.strip() or 'Unexpected OctoClaw error'} → "
                f"{suggested_fix.strip() or 'Use OctoClaw spawn wrapper / fix incompatible tool arguments'}\n"
            )
    except OSError:
        pass

    return err_id


def append_learning_entry(
    *,
    category: str,
    summary: str,
    details: str,
    suggested_action: str,
    priority: str = "medium",
    area: str = "infra",
    tags: list[str] | None = None,
    source: str = "nightly_error_review",
    sink_type: str = "operator-learning",
    run_id: str = "",
    phase: str = "learn",
    evidence_paths: list[str] | None = None,
) -> str:
    now = datetime.now(timezone.utc).astimezone()
    entry_id = f"LRN-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}"
    evidence = ", ".join(str(item).strip() for item in (evidence_paths or []) if str(item).strip())
    entry = "\n".join(
        [
            f"## [{entry_id}] {category}",
            "",
            f"**Logged**: {now.isoformat()}",
            f"**Priority**: {priority}",
            "**Status**: pending",
            f"**Area**: {area}",
            "",
            "### Summary",
            summary.strip(),
            "",
            "### Details",
            details.strip(),
            "",
            "### Suggested Action",
            suggested_action.strip(),
            "",
            "### Metadata",
            f"- Source: {source}",
            f"- Sink-Type: {sink_type}",
            f"- Phase: {phase}",
            f"- Run-ID: {run_id or '(none)'}",
            f"- Evidence: {evidence or '(none)'}",
            f"- Tags: {', '.join(tags or []) or '(none)'}",
            "",
            "---",
            "",
        ]
    )
    for path in learning_targets():
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(entry)
        except OSError:
            pass
    return entry_id
