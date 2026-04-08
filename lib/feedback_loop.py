#!/usr/bin/env python3
"""Shared feedback-loop contracts for OctoClaw."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any


FEEDBACK_PHASES = ("observe", "summarize", "review", "curate", "validate", "promote", "learn")
MANIFEST_SCHEMA_VERSION = "octoclaw.feedback_manifest/v1"
VALIDATION_SCHEMA_VERSION = "octoclaw.feedback_validation_summary/v1"


def now_local_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def build_run_id(prefix: str = "feedback") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).astimezone().strftime('%Y%m%d%H%M%S')}"


def normalize_prompt(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def prompt_hash(value: str) -> str:
    normalized = normalize_prompt(value)
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def candidate_severity(*, blocked_events: list[str] | None = None, review_required: bool = False, tags: list[str] | None = None) -> str:
    blocked = [str(item).strip() for item in (blocked_events or []) if str(item).strip()]
    normalized_tags = {str(item).strip().lower() for item in (tags or []) if str(item).strip()}
    if blocked:
        return "high"
    if review_required or "route_changed" in normalized_tags or "missing_hint" in normalized_tags:
        return "medium"
    return "low"


def shared_case_fields(
    *,
    prompt: str,
    route: str = "",
    worker_pool: str = "",
    route_language_packs: list[str] | None = None,
    tags: list[str] | None = None,
    review_required: bool = False,
    blocked_events: list[str] | None = None,
    confidence: Any = None,
) -> dict[str, Any]:
    normalized = normalize_prompt(prompt)
    return {
        "normalized_prompt": normalized,
        "prompt_hash": prompt_hash(prompt),
        "candidate_severity": candidate_severity(
            blocked_events=blocked_events,
            review_required=review_required,
            tags=tags,
        ),
        "route_language_packs": [str(item).strip() for item in (route_language_packs or []) if str(item).strip()],
        "route": str(route or "").strip(),
        "worker_pool": str(worker_pool or "").strip(),
        "review_required": bool(review_required),
        "confidence": confidence,
        "tags": [str(item).strip() for item in (tags or []) if str(item).strip()],
    }


def build_phase_record(
    *,
    phase: str,
    status: str,
    artifacts: dict[str, str] | None = None,
    upstream_phases: list[str] | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "phase": phase,
        "status": status,
        "artifacts": dict(artifacts or {}),
        "upstream_phases": [str(item).strip() for item in (upstream_phases or []) if str(item).strip()],
        "notes": [str(item).strip() for item in (notes or []) if str(item).strip()],
    }


def build_feedback_manifest(
    *,
    run_id: str,
    source_inputs: dict[str, Any],
    phase_records: list[dict[str, Any]],
    generated_artifacts: dict[str, str],
    output_dir: str,
    validation_status: str,
    promotion_eligibility: str,
    learning_written: bool,
    upstream_run_ids: list[str] | None = None,
    validation_artifacts: dict[str, str] | None = None,
    route_outcome_metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "run_id": run_id,
        "generated_at": now_local_iso(),
        "loop": list(FEEDBACK_PHASES),
        "source_inputs": dict(source_inputs),
        "phase_records": list(phase_records),
        "generated_artifacts": dict(generated_artifacts),
        "upstream_run_ids": [str(item).strip() for item in (upstream_run_ids or []) if str(item).strip()],
        "validation_status": validation_status,
        "validation_artifacts": dict(validation_artifacts or {}),
        "route_outcome_metrics": dict(route_outcome_metrics or {}),
        "promotion_eligibility": promotion_eligibility,
        "learning_written": bool(learning_written),
        "output_dir": output_dir,
    }


def build_validation_summary(
    *,
    source_run_id: str,
    source_label: str,
    report_path: str,
    source_manifest_path: str = "",
    cases_total: int,
    cases_passed: int,
    cases_failed: int,
    findings: list[str],
    passed: bool,
    route_outcome_metrics: dict[str, Any] | None = None,
    generated_artifacts: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": VALIDATION_SCHEMA_VERSION,
        "generated_at": now_local_iso(),
        "source_run_id": str(source_run_id or "").strip(),
        "source_manifest_path": str(source_manifest_path or "").strip(),
        "source_label": str(source_label or "").strip(),
        "report_path": str(report_path or "").strip(),
        "cases_total": int(cases_total or 0),
        "cases_passed": int(cases_passed or 0),
        "cases_failed": int(cases_failed or 0),
        "findings": [str(item).strip() for item in findings if str(item).strip()],
        "route_outcome_metrics": dict(route_outcome_metrics or {}),
        "generated_artifacts": dict(generated_artifacts or {}),
        "passed": bool(passed),
    }
