#!/usr/bin/env python3
"""Read a compact excerpt from a shared report file."""

from __future__ import annotations

import argparse
import json
import os


def build_excerpt(path: str, max_lines: int, max_chars: int) -> dict:
    if not os.path.exists(path):
        return {"path": path, "exists": False, "excerpt": "", "truncated": False}

    lines: list[str] = []
    total_chars = 0
    truncated = False
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line and not lines:
                continue
            if len(lines) >= max_lines:
                truncated = True
                break
            if total_chars + len(line) + 1 > max_chars:
                remaining = max_chars - total_chars
                if remaining > 8:
                    lines.append(line[: remaining - 1].rstrip() + "…")
                truncated = True
                break
            lines.append(line)
            total_chars += len(line) + 1

    excerpt = "\n".join(lines).strip()
    return {
        "path": path,
        "exists": True,
        "excerpt": excerpt,
        "truncated": truncated,
        "line_count": len(lines),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read a compact shared report excerpt")
    parser.add_argument("--path", required=True)
    parser.add_argument("--max-lines", type=int, default=18)
    parser.add_argument("--max-chars", type=int, default=1400)
    args = parser.parse_args()
    print(json.dumps(build_excerpt(args.path, args.max_lines, args.max_chars), ensure_ascii=False))


if __name__ == "__main__":
    main()
