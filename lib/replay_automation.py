#!/usr/bin/env python3
"""Nightly replay automation for OctoClaw observation mode."""

from __future__ import annotations

import argparse
import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from model_health_backfill import run_backfill as run_model_health_backfill
from octopus_config import CONFIG_FILE, DEFAULT_CONFIG, deep_merge, load_json, load_octopus_config, save_json
from replay_curate import curate_cases
from replay_review import build_review_payload
from replay_summary import DEFAULT_REPLAY_LOG, infer_runtime_policy_phase, load_events, render_text, summarize_events


def parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "on"}:
        return True
    if text in {"false", "0", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean value: {value}")


def build_replay_automation(args: argparse.Namespace) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_CONFIG["replay_automation"])
    for field in (
        "enabled",
        "schedule_hour_local",
        "summary_enabled",
        "review_enabled",
        "curate_enabled",
        "llm_review_enabled",
        "llm_review_max_cases",
        "output_dir",
    ):
        value = getattr(args, field, None)
        if value is not None:
            base[field] = value
    return base


def merge_config(config_path: Path, replay_automation: dict[str, Any]) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        data = {}
    merged = deep_merge(data, {"replay_automation": replay_automation})
    if not save_json(str(config_path), merged):
        raise SystemExit(f"failed to write config: {config_path}")
    return merged


def cleanup_config(config_path: Path) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        return {}
    if "replay_automation" in data:
        data.pop("replay_automation", None)
        if not save_json(str(config_path), data):
            raise SystemExit(f"failed to write config: {config_path}")
    return data


def _date_dir(base_dir: Path, now: datetime | None = None) -> Path:
    current = now or datetime.now().astimezone()
    return base_dir / current.strftime("%Y%m%d")


def _write_json(path: Path, payload: dict[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def build_llm_review_packet(
    *,
    phase: str,
    summary_payload: dict[str, Any] | None,
    review_payloads: dict[str, dict[str, Any]],
    curated_sets: dict[str, list[dict[str, Any]]],
    max_cases: int,
) -> dict[str, Any]:
    ordered_focus = ("blocked", "missing_hint", "route_changed", "delegated")
    selected_cases: list[dict[str, Any]] = []
    for focus in ordered_focus:
        for case in curated_sets.get(focus, []):
            selected_cases.append({**case, "focus": focus})
            if len(selected_cases) >= max_cases:
                break
        if len(selected_cases) >= max_cases:
            break

    summary_snapshot = {}
    if isinstance(summary_payload, dict):
        summary_snapshot = {
            "task_metrics": summary_payload.get("task_metrics", {}),
            "route_hint_metrics": summary_payload.get("route_hint_metrics", {}),
            "tool_metrics": summary_payload.get("tool_metrics", {}),
            "promotion": summary_payload.get("promotion", {}),
            "observed_language_packs": summary_payload.get("observed_language_packs", {}),
        }

    review_counts = {
        focus: len((review_payloads.get(focus, {}) or {}).get("records", []) or [])
        for focus in ordered_focus
    }
    curated_counts = {focus: len(curated_sets.get(focus, [])) for focus in ordered_focus}

    return {
        "schema_version": "octoclaw.replay_automation.llm_review_packet/v1",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "phase": phase,
        "instructions": {
            "goal": "Review nightly OctoClaw replay signals and summarize routing mistakes, sticky-lane surprises, and candidate experience learnings without changing production rules.",
            "deliverables": [
                "Top routing mistakes or near-misses",
                "Patterns worth promoting into replay fixtures or eval cases",
                "Safe rule/policy suggestions for human review",
                "Experience notes worth carrying forward into docs or labels",
            ],
            "guardrails": [
                "Do not propose automatic rule changes as already applied.",
                "Do not assume every blocked event is a bug; distinguish healthy enforcement from friction.",
                "Prefer conservative suggestions when sample size is small.",
            ],
        },
        "summary_snapshot": summary_snapshot,
        "review_counts": review_counts,
        "curated_counts": curated_counts,
        "cases": selected_cases,
    }


def render_llm_review_prompt(packet: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# OctoClaw Nightly Replay Review",
            "",
            "You are reviewing OctoClaw nightly replay outputs.",
            "Produce a concise operator-facing review report. Do not change rules automatically.",
            "",
            "Required sections:",
            "1. Executive Summary",
            "2. Healthy Enforcement vs Possible Misroutes",
            "3. Patterns To Label Or Promote Into Eval",
            "4. Candidate Human-Reviewed Policy Tweaks",
            "5. Experience Notes Worth Keeping",
            "",
            "Use the attached packet JSON as the only source of truth.",
            f"- phase: {packet.get('phase', '')}",
            f"- generated_at: {packet.get('generated_at', '')}",
            f"- cases: {len(packet.get('cases', []) or [])}",
            "",
            "Output markdown only.",
        ]
    )


def render_llm_review_report(packet: dict[str, Any]) -> str:
    review_counts = packet.get("review_counts", {}) or {}
    curated_counts = packet.get("curated_counts", {}) or {}
    summary_snapshot = packet.get("summary_snapshot", {}) or {}
    promotion = summary_snapshot.get("promotion", {}) or {}
    task_metrics = summary_snapshot.get("task_metrics", {}) or {}
    tool_metrics = summary_snapshot.get("tool_metrics", {}) or {}
    observed_packs = summary_snapshot.get("observed_language_packs", {}) or {}

    lines = [
        f"# OctoClaw Nightly Replay Review ({packet.get('generated_at', '')[:10]})",
        "",
        "## Snapshot",
        f"- Phase: `{packet.get('phase', '')}`",
        f"- Task events: `{task_metrics.get('task_event_count', 0)}`",
        f"- Routes: `{json.dumps(task_metrics.get('route_counts', {}), ensure_ascii=False)}`",
        f"- Blocked sessions rate: `{tool_metrics.get('blocked_session_rate', 'n/a')}`",
        f"- Observed language packs: `{json.dumps(observed_packs, ensure_ascii=False)}`",
        f"- Suggested preset: `{promotion.get('target', packet.get('phase', 'conservative')) if promotion.get('ready') else packet.get('phase', 'conservative')}`",
        "",
        "## Review Buckets",
        f"- blocked: `{review_counts.get('blocked', 0)}` reviewed / `{curated_counts.get('blocked', 0)}` curated",
        f"- missing_hint: `{review_counts.get('missing_hint', 0)}` reviewed / `{curated_counts.get('missing_hint', 0)}` curated",
        f"- route_changed: `{review_counts.get('route_changed', 0)}` reviewed / `{curated_counts.get('route_changed', 0)}` curated",
        f"- delegated: `{review_counts.get('delegated', 0)}` reviewed / `{curated_counts.get('delegated', 0)}` curated",
        "",
        "## Human Review Focus",
        "- Distinguish healthy delegation enforcement from frustrating false positives.",
        "- Look for short follow-up acknowledgements that should have inherited a prior lane.",
        "- Promote only repeated, high-confidence patterns into eval fixtures.",
        "- Keep policy changes as suggestions for human review, not automatic edits.",
        "",
        "## Attached Packet",
        f"- cases included: `{len(packet.get('cases', []) or [])}`",
        "- use `llm-review-packet.json` with a strong model if you want a richer nightly review.",
    ]
    return "\n".join(lines)


def run_replay_automation(
    *,
    config: dict[str, Any],
    events_path: Path,
    output_dir: Path,
    openclaw_log: Path | None = None,
    force: bool = False,
) -> dict[str, Any]:
    replay_cfg = config.get("replay_automation", {}) if isinstance(config, dict) else {}
    runtime_policy = config.get("runtime_policy", {}) if isinstance(config, dict) else {}

    enabled = bool(replay_cfg.get("enabled", False))
    if not enabled and not force:
        return {
            "enabled": False,
            "forced": False,
            "skipped": True,
            "reason": "replay_automation.disabled",
            "events_path": str(events_path),
            "output_dir": str(output_dir),
        }

    if not events_path.exists():
        return {
            "enabled": enabled,
            "forced": bool(force),
            "skipped": True,
            "reason": "replay_log_missing",
            "events_path": str(events_path),
            "output_dir": str(output_dir),
        }

    events, source_format, invalid_lines = load_events(events_path)
    phase = infer_runtime_policy_phase(runtime_policy if isinstance(runtime_policy, dict) else {})
    dated_dir = _date_dir(output_dir)
    dated_dir.mkdir(parents=True, exist_ok=True)

    generated: dict[str, str] = {}

    backfill_result = run_model_health_backfill(
        log_file=str(openclaw_log) if openclaw_log else "",
        log_dir="",
        health_file="",
    )
    backfill_json = dated_dir / "model-health-backfill.json"
    _write_json(backfill_json, backfill_result)
    generated["model_health_backfill_json"] = str(backfill_json)

    summary_payload = None
    if bool(replay_cfg.get("summary_enabled", True)):
        summary_payload = summarize_events(
            events,
            source_path=str(events_path),
            source_format=source_format,
            invalid_lines=invalid_lines,
            phase=phase if phase in {"conservative", "guided"} else "guided",
            min_policy_events=30,
            min_runner_events=3,
            min_delegated_events=10,
            max_blocked_session_rate=0.15,
            min_route_hint_submission_rate=0.85,
        )
        summary_json = dated_dir / "summary.json"
        summary_text = dated_dir / "summary.txt"
        _write_json(summary_json, summary_payload)
        _write_text(summary_text, render_text(summary_payload))
        generated["summary_json"] = str(summary_json)
        generated["summary_text"] = str(summary_text)

    review_payloads: dict[str, dict[str, Any]] = {}
    if bool(replay_cfg.get("review_enabled", True)):
        for focus in ("blocked", "missing_hint", "route_changed", "delegated"):
            payload = build_review_payload(
                events,
                source_path=str(events_path),
                source_format=source_format,
                invalid_lines=invalid_lines,
                focus=focus,
                route="",
                tag="",
                limit=50,
                offset=0,
            )
            review_payloads[focus] = payload
            path = dated_dir / f"review-{focus}.json"
            _write_json(path, payload)
            generated[f"review_{focus}_json"] = str(path)

    curated_sets: dict[str, list[dict[str, Any]]] = {}
    if bool(replay_cfg.get("curate_enabled", True)):
        if review_payloads:
            curated_sets["blocked"] = curate_cases(review_payloads["blocked"]["records"], dedupe_by="prompt", include_events=True)
            curated_sets["missing_hint"] = curate_cases(review_payloads["missing_hint"]["records"], dedupe_by="prompt", include_events=True)
            curated_sets["route_changed"] = curate_cases(review_payloads["route_changed"]["records"], dedupe_by="prompt", include_events=True)
            curated_sets["delegated"] = curate_cases(review_payloads["delegated"]["records"], dedupe_by="prompt", include_events=True)
        else:
            payload = build_review_payload(
                events,
                source_path=str(events_path),
                source_format=source_format,
                invalid_lines=invalid_lines,
                focus="all",
                route="",
                tag="",
                limit=200,
                offset=0,
            )
            curated_sets["all"] = curate_cases(payload["records"], dedupe_by="prompt", include_events=True)

        for name, cases in curated_sets.items():
            path = dated_dir / f"curated-{name}.json"
            _write_json(
                path,
                {
                    "name": name,
                    "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "cases": cases,
                },
            )
            generated[f"curated_{name}_json"] = str(path)

    if bool(replay_cfg.get("llm_review_enabled", False)):
        packet = build_llm_review_packet(
            phase=phase,
            summary_payload=summary_payload,
            review_payloads=review_payloads,
            curated_sets=curated_sets,
            max_cases=int(replay_cfg.get("llm_review_max_cases", 24) or 24),
        )
        packet_path = dated_dir / "llm-review-packet.json"
        prompt_path = dated_dir / "llm-review-prompt.md"
        report_path = dated_dir / "llm-review-report.md"
        _write_json(packet_path, packet)
        _write_text(prompt_path, render_llm_review_prompt(packet))
        _write_text(report_path, render_llm_review_report(packet))
        generated["llm_review_packet_json"] = str(packet_path)
        generated["llm_review_prompt_md"] = str(prompt_path)
        generated["llm_review_report_md"] = str(report_path)

    manifest = {
        "enabled": enabled,
        "forced": bool(force),
        "skipped": False,
        "phase": phase,
        "events_path": str(events_path),
        "output_dir": str(dated_dir),
        "events_count": len(events),
        "generated": generated,
    }
    manifest_path = dated_dir / "manifest.json"
    _write_json(manifest_path, manifest)
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def render_cron_command(config_path: Path, events_path: Path) -> str:
    script = Path(__file__).resolve()
    return f'python3 {script} run --config "{config_path}" --events "{events_path}"'


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Nightly replay automation for OctoClaw")
    subparsers = parser.add_subparsers(dest="command", required=True)

    merge = subparsers.add_parser("merge-config")
    merge.add_argument("--config", required=True)
    merge.add_argument("--enabled", type=parse_bool)
    merge.add_argument("--schedule-hour-local", dest="schedule_hour_local", type=int)
    merge.add_argument("--summary-enabled", dest="summary_enabled", type=parse_bool)
    merge.add_argument("--review-enabled", dest="review_enabled", type=parse_bool)
    merge.add_argument("--curate-enabled", dest="curate_enabled", type=parse_bool)
    merge.add_argument("--llm-review-enabled", dest="llm_review_enabled", type=parse_bool)
    merge.add_argument("--llm-review-max-cases", dest="llm_review_max_cases", type=int)
    merge.add_argument("--output-dir", dest="output_dir")

    cleanup = subparsers.add_parser("cleanup-config")
    cleanup.add_argument("--config", required=True)

    show = subparsers.add_parser("show-config")
    show.add_argument("--config", default="")

    run = subparsers.add_parser("run")
    run.add_argument("--config", default="")
    run.add_argument("--events", default=str(DEFAULT_REPLAY_LOG))
    run.add_argument("--openclaw-log", default="")
    run.add_argument("--output-dir", default="")
    run.add_argument("--format", choices=("text", "json"), default="text")
    run.add_argument("--force", action="store_true")

    cron = subparsers.add_parser("render-cron")
    cron.add_argument("--config", default="")
    cron.add_argument("--events", default=str(DEFAULT_REPLAY_LOG))
    cron.add_argument("--openclaw-log", default="")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "merge-config":
        merged = merge_config(Path(args.config).expanduser().resolve(), build_replay_automation(args))
        print(json.dumps(merged.get("replay_automation", {}), ensure_ascii=False, indent=2))
        return 0

    if args.command == "cleanup-config":
        cleaned = cleanup_config(Path(args.config).expanduser().resolve())
        print(json.dumps(cleaned.get("replay_automation", {}), ensure_ascii=False, indent=2))
        return 0

    if args.command == "show-config":
        if args.config:
            raw = load_json(str(Path(args.config).expanduser().resolve()))
            config = deep_merge(DEFAULT_CONFIG, raw) if isinstance(raw, dict) else json.loads(json.dumps(DEFAULT_CONFIG))
        else:
            config = load_octopus_config()
        print(json.dumps(config.get("replay_automation", {}), ensure_ascii=False, indent=2))
        return 0

    if args.command == "render-cron":
        config_path = Path(args.config).expanduser().resolve() if args.config else Path(CONFIG_FILE).expanduser().resolve()
        command = render_cron_command(config_path=config_path, events_path=Path(args.events).expanduser().resolve())
        if args.openclaw_log:
            command += f' --openclaw-log "{Path(args.openclaw_log).expanduser().resolve()}"'
        print(command)
        return 0

    if args.command == "run":
        if args.config:
            raw = load_json(str(Path(args.config).expanduser().resolve()))
            config = deep_merge(DEFAULT_CONFIG, raw) if isinstance(raw, dict) else json.loads(json.dumps(DEFAULT_CONFIG))
        else:
            config = load_octopus_config()
        replay_cfg = config.get("replay_automation", {}) if isinstance(config, dict) else {}
        output_dir = Path(args.output_dir or replay_cfg.get("output_dir") or DEFAULT_CONFIG["replay_automation"]["output_dir"]).expanduser().resolve()
        manifest = run_replay_automation(
            config=config,
            events_path=Path(args.events).expanduser().resolve(),
            output_dir=output_dir,
            openclaw_log=Path(args.openclaw_log).expanduser().resolve() if args.openclaw_log else None,
            force=args.force,
        )
        if args.format == "json":
            print(json.dumps(manifest, ensure_ascii=False, indent=2))
        else:
            if manifest.get("skipped"):
                print(f"OctoClaw Replay Automation skipped: {manifest.get('reason')}")
            else:
                print(
                    "OctoClaw Replay Automation\n"
                    f"- phase: {manifest.get('phase')}\n"
                    f"- events: {manifest.get('events_count')}\n"
                    f"- forced: {'yes' if manifest.get('forced') else 'no'}\n"
                    f"- output: {manifest.get('output_dir')}\n"
                    f"- manifest: {manifest.get('manifest_path')}"
                )
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
