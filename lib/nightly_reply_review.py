#!/usr/bin/env python3
"""Nightly AI-assisted review for Slack reply/delegation quality."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from octopus_config import WORKSPACE


DEFAULT_TIMEZONE = "Asia/Shanghai"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nightly Slack reply/delegation review")
    parser.add_argument("--packet", required=True)
    parser.add_argument("--day", default="")
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--repo-root", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--prompt-output", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--agent", default="main")
    parser.add_argument("--thinking", default="medium")
    parser.add_argument("--skip-agent", action="store_true")
    return parser.parse_args()


def build_prompt(packet: dict, *, day: str, timezone: str) -> str:
    cases = packet.get("cases") or []
    case_lines: list[str] = []
    for index, case in enumerate(cases, start=1):
        policy = case.get("policy") or {}
        dispatch = case.get("dispatch") or {}
        case_lines.extend(
            [
                f"## Case {index}",
                f"- session_key: {case.get('session_key')}",
                f"- user_timestamp: {case.get('user_timestamp')}",
                f"- assistant_timestamp: {case.get('assistant_timestamp')}",
                f"- route: {policy.get('route') or '(none)'}",
                f"- system_preferred_route: {policy.get('system_preferred_route') or '(none)'}",
                f"- worker_pool: {policy.get('worker_pool') or dispatch.get('worker_pool') or '(none)'}",
                f"- dispatch_called: {bool(dispatch.get('called'))}",
                "",
                "### User Prompt",
                case.get("user_prompt") or "(empty)",
                "",
                "### Assistant Reply",
                case.get("assistant_reply") or "(empty)",
                "",
            ]
        )
    if not case_lines:
        case_lines.extend(["No usable Slack reply cases were found for the requested day.", ""])

    return "\n".join(
        [
            f"You are reviewing OctoClaw Slack conversations for {day} ({timezone}).",
            "Focus on reply quality, delegation quality, and concrete product/runtime bugs.",
            "Do not rewrite the whole system. Be specific, actionable, and concise.",
            "",
            "Return a Markdown report with exactly these sections:",
            "1. # Daily Reply Review",
            "2. ## Executive Summary",
            "3. ## Reply Quality Findings",
            "4. ## Delegation Quality Findings",
            "5. ## Bugs / Regressions",
            "6. ## Improvement Suggestions",
            "7. ## Best Cases Worth Keeping",
            "",
            "Rules:",
            "- Prioritize real defects, user-visible confusion, and delegation mismatches.",
            "- Call out when a reply was too vague, overlong, under-informative, or failed to close the loop.",
            "- Call out when route/worker choice looked wrong or missing.",
            "- If evidence is insufficient, say so explicitly.",
            "- Use short bullets.",
            "",
            f"Packet summary: sessions_considered={packet.get('sessions_considered', 0)}, case_count={packet.get('case_count', 0)}",
            "",
            "## Cases",
            "",
            *case_lines,
        ]
    ).strip() + "\n"


def extract_text_result(payload: dict) -> str:
    if not isinstance(payload, dict):
        return ""
    payloads = payload.get("payloads")
    if isinstance(payloads, list):
        texts = []
        for item in payloads:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        if texts:
            return "\n\n".join(texts)
    text = payload.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    response = payload.get("response")
    if isinstance(response, dict):
        text = response.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()
    message = payload.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    return json.dumps(payload, ensure_ascii=False, indent=2)


def run_openclaw_review(*, prompt: str, agent: str, session_id: str, thinking: str) -> str:
    result = subprocess.run(
        [
            "openclaw",
            "agent",
            "--agent",
            agent,
            "--session-id",
            session_id,
            "--thinking",
            thinking,
            "--message",
            prompt,
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip() or "openclaw agent failed")
    payload = json.loads(result.stdout or "{}")
    return extract_text_result(payload)


def main() -> int:
    args = parse_args()
    tz = ZoneInfo(args.timezone or DEFAULT_TIMEZONE)
    day = args.day or (datetime.now(tz) - timedelta(days=1)).strftime("%Y-%m-%d")
    repo_root = Path(args.repo_root or os.getcwd()).expanduser().resolve()
    output = Path(args.output or (repo_root / "reports" / "reply-review" / f"{day}.md")).expanduser().resolve()
    prompt_output = Path(args.prompt_output or (repo_root / "reports" / "reply-review" / "packets" / f"{day}.prompt.md")).expanduser().resolve()
    session_id = args.session_id or f"octoclaw-reply-review-{day}"

    packet = json.loads(Path(args.packet).expanduser().resolve().read_text())
    prompt = build_prompt(packet, day=day, timezone=str(tz))

    prompt_output.parent.mkdir(parents=True, exist_ok=True)
    prompt_output.write_text(prompt, encoding="utf-8")

    if args.skip_agent:
        report = "\n".join(
            [
                f"# Daily Reply Review ({day})",
                "",
                "- Agent review skipped (`--skip-agent`).",
                "- Prompt packet was generated successfully.",
                "",
                "## Next Step",
                "",
                "- Run without `--skip-agent` to let OpenClaw write the full review.",
                "",
            ]
        )
    else:
        report = run_openclaw_review(prompt=prompt, agent=args.agent, session_id=session_id, thinking=args.thinking)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(report.rstrip() + "\n", encoding="utf-8")
    print(str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
