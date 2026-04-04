#!/usr/bin/env python3
"""Nightly OctoClaw error review.

Pure-script nightly review that reads shared self-improving compatible error logs,
groups recurring problems, writes a report, and promotes high-frequency learnings
into LEARNINGS.md.
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from learning_log import append_learning_entry, error_targets
from octopus_config import SHARED_DIR


ENTRY_RE = re.compile(r"^## \[(ERR-[^\]]+)\] (.+)$", re.MULTILINE)


def split_entries(text: str) -> list[str]:
    matches = list(ENTRY_RE.finditer(text))
    if not matches:
        return []
    entries: list[str] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        entries.append(text[start:end].strip())
    return entries


def extract_field(block: str, heading: str) -> str:
    pattern = rf"### {re.escape(heading)}\n(.*?)(?:\n### |\n---|\Z)"
    match = re.search(pattern, block, re.S)
    return (match.group(1).strip() if match else "")


def extract_meta(block: str, key: str) -> str:
    match = re.search(rf"^- {re.escape(key)}:\s*(.+)$", block, re.M)
    return (match.group(1).strip() if match else "")


def parse_logged_at(block: str):
    match = re.search(r"^\*\*Logged\*\*:\s*(.+)$", block, re.M)
    if not match:
        return None
    value = match.group(1).strip()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_signature(summary: str, error_text: str) -> str:
    seed = (summary or error_text or "unknown").splitlines()[0].strip().lower()
    seed = re.sub(r"err-\d{8}-\d+", "ERR-ID", seed)
    seed = re.sub(r"task[-_a-z0-9:]{8,}", "TASK-ID", seed)
    seed = re.sub(r"\s+", " ", seed)
    return seed[:160]


def load_all_error_entries() -> list[dict]:
    seen_ids: set[str] = set()
    records: list[dict] = []
    for path in error_targets():
        if not os.path.exists(path):
            continue
        try:
            text = open(path, "r", encoding="utf-8").read()
        except OSError:
            continue
        for block in split_entries(text):
            match = ENTRY_RE.search(block)
            if not match:
                continue
            err_id = match.group(1)
            if err_id in seen_ids:
                continue
            seen_ids.add(err_id)
            records.append(
                {
                    "id": err_id,
                    "title": match.group(2).strip(),
                    "summary": extract_field(block, "Summary"),
                    "error": extract_field(block, "Error"),
                    "suggested_fix": extract_field(block, "Suggested Fix"),
                    "logged_at": parse_logged_at(block),
                    "priority": re.search(r"^\*\*Priority\*\*:\s*(.+)$", block, re.M).group(1).strip() if re.search(r"^\*\*Priority\*\*:\s*(.+)$", block, re.M) else "medium",
                    "status": re.search(r"^\*\*Status\*\*:\s*(.+)$", block, re.M).group(1).strip() if re.search(r"^\*\*Status\*\*:\s*(.+)$", block, re.M) else "pending",
                    "reproducible": extract_meta(block, "Reproducible"),
                }
            )
    return records


def build_report(records: list[dict]) -> tuple[str, list[dict]]:
    now = datetime.now(timezone.utc).astimezone()
    recent_cutoff = now - timedelta(days=2)
    grouped: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        if record["status"].lower() not in ("pending", "open"):
            continue
        if record["logged_at"] and record["logged_at"] < recent_cutoff:
            continue
        grouped[normalize_signature(record["summary"], record["error"])].append(record)

    ordered_groups = sorted(grouped.items(), key=lambda item: (len(item[1]), max((r["logged_at"] or datetime.min.replace(tzinfo=timezone.utc)) for r in item[1])), reverse=True)

    lines = [
        f"# OctoClaw Nightly Error Review ({now.strftime('%Y-%m-%d')})",
        "",
        f"- Open issues reviewed: {sum(len(items) for _, items in ordered_groups)}",
        f"- Distinct recurring signatures: {len(ordered_groups)}",
        "",
    ]
    promotion_candidates: list[dict] = []
    for signature, items in ordered_groups[:12]:
        exemplar = items[0]
        lines.extend(
            [
                f"## {signature}",
                "",
                f"- Count: {len(items)}",
                f"- Latest: {(max((r['logged_at'] or now) for r in items)).astimezone().isoformat(timespec='seconds')}",
                f"- Priority: {exemplar['priority']}",
                f"- Suggested Fix: {exemplar['suggested_fix'] or '(none)'}",
                "",
                "### Summary",
                exemplar["summary"] or "(no summary)",
                "",
            ]
        )
        if len(items) >= 2:
            promotion_candidates.append(
                {
                    "signature": signature,
                    "count": len(items),
                    "summary": exemplar["summary"] or signature,
                    "suggested_fix": exemplar["suggested_fix"] or "Promote this recurring issue into runtime validation or AGENTS rules.",
                }
            )
    if not ordered_groups:
        lines.append("No open recurring issues found in the last 48 hours.\n")
    return "\n".join(lines).rstrip() + "\n", promotion_candidates


def main() -> int:
    now = datetime.now(timezone.utc).astimezone()
    records = load_all_error_entries()
    report, promotions = build_report(records)

    os.makedirs(SHARED_DIR, exist_ok=True)
    report_path = os.path.join(SHARED_DIR, f"error-review-{now.strftime('%Y%m%d')}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    for candidate in promotions[:5]:
        append_learning_entry(
            category="best_practice",
            summary=f"Recurring OctoClaw issue: {candidate['summary']}",
            details=f"Nightly review found the same issue {candidate['count']} times.\nSignature: {candidate['signature']}",
            suggested_action=candidate["suggested_fix"],
            priority="high" if candidate["count"] >= 3 else "medium",
            source="nightly_error_review",
            sink_type="operator-learning",
            phase="learn",
            evidence_paths=[report_path],
            tags=["octoclaw", "nightly-review", "error-promotion"],
        )

    print(report_path)
    print(f"promoted={min(len(promotions), 5)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
