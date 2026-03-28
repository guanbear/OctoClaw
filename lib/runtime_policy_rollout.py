#!/usr/bin/env python3
"""Runtime policy rollout helpers for OctoClaw."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

from octopus_config import DEFAULT_CONFIG, deep_merge, load_json, save_json


PRESETS: dict[str, dict[str, Any]] = {
    "conservative": {
        "enabled": True,
        "switches": {
            "hard_runner_only": True,
            "route_hint_required": False,
            "replay_logging": True,
            "direct_model_override": False,
            "delegation_enforcement": False,
        },
        "route_stickiness": {
            "enabled": False,
        },
        "hooks": {
            "before_model_resolve": False,
            "before_prompt_build": True,
            "before_tool_call": False,
            "agent_end": True,
        },
    },
    "guided": {
        "enabled": True,
        "switches": {
            "hard_runner_only": True,
            "route_hint_required": True,
            "replay_logging": True,
            "direct_model_override": False,
            "delegation_enforcement": False,
        },
        "route_stickiness": {
            "enabled": True,
        },
        "hooks": {
            "before_model_resolve": False,
            "before_prompt_build": True,
            "before_tool_call": True,
            "agent_end": True,
        },
    },
    "enforced": {
        "enabled": True,
        "switches": {
            "hard_runner_only": True,
            "route_hint_required": True,
            "replay_logging": True,
            "direct_model_override": True,
            "delegation_enforcement": True,
        },
        "route_stickiness": {
            "enabled": True,
        },
        "hooks": {
            "before_model_resolve": True,
            "before_prompt_build": True,
            "before_tool_call": True,
            "agent_end": True,
        },
    },
}
PLUGIN_ID = "octoclaw-runtime"


def parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes", "on"}:
        return True
    if text in {"false", "0", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean value: {value}")


def parse_csv_list(value: str | None) -> list[str] | None:
    if value is None:
        return None
    parts = [item.strip() for item in str(value).split(",")]
    return [item for item in parts if item]


def add_bool_overrides(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--enabled", type=parse_bool)
    parser.add_argument("--hard-runner-only", dest="hard_runner_only", type=parse_bool)
    parser.add_argument("--route-hint-required", dest="route_hint_required", type=parse_bool)
    parser.add_argument("--replay-logging", dest="replay_logging", type=parse_bool)
    parser.add_argument("--direct-model-override", dest="direct_model_override", type=parse_bool)
    parser.add_argument("--delegation-enforcement", dest="delegation_enforcement", type=parse_bool)
    parser.add_argument("--sticky-lane", dest="sticky_lane", type=parse_bool)
    parser.add_argument("--hook-before-model-resolve", dest="hook_before_model_resolve", type=parse_bool)
    parser.add_argument("--hook-before-prompt-build", dest="hook_before_prompt_build", type=parse_bool)
    parser.add_argument("--hook-before-tool-call", dest="hook_before_tool_call", type=parse_bool)
    parser.add_argument("--hook-agent-end", dest="hook_agent_end", type=parse_bool)
    parser.add_argument("--sticky-ttl-minutes", dest="sticky_ttl_minutes", type=int)
    parser.add_argument("--apply-on-followup-only", dest="apply_on_followup_only", type=parse_bool)
    parser.add_argument("--route-language-packs", dest="route_language_packs", type=parse_csv_list)


def build_runtime_policy(args: argparse.Namespace) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_CONFIG["runtime_policy"])
    preset = getattr(args, "preset", None) or "conservative"
    base = deep_merge(base, copy.deepcopy(PRESETS[preset]))

    if args.enabled is not None:
        base["enabled"] = args.enabled

    switches = base.setdefault("switches", {})
    hooks = base.setdefault("hooks", {})
    route_stickiness = base.setdefault("route_stickiness", {})
    route_language_packs = base.setdefault("route_language_packs", {})

    for field in (
        "hard_runner_only",
        "route_hint_required",
        "replay_logging",
        "direct_model_override",
        "delegation_enforcement",
    ):
        value = getattr(args, field, None)
        if value is not None:
            switches[field] = value

    hook_map = {
        "hook_before_model_resolve": "before_model_resolve",
        "hook_before_prompt_build": "before_prompt_build",
        "hook_before_tool_call": "before_tool_call",
        "hook_agent_end": "agent_end",
    }
    for arg_name, hook_name in hook_map.items():
        value = getattr(args, arg_name, None)
        if value is not None:
            hooks[hook_name] = value

    if args.sticky_lane is not None:
        route_stickiness["enabled"] = args.sticky_lane
    if args.sticky_ttl_minutes is not None:
        route_stickiness["ttl_minutes"] = args.sticky_ttl_minutes
    if args.apply_on_followup_only is not None:
        route_stickiness["apply_on_followup_only"] = args.apply_on_followup_only
    if args.route_language_packs is not None:
        route_language_packs["enabled"] = args.route_language_packs

    return base


def merge_config(config_path: Path, runtime_policy: dict[str, Any]) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        data = {}
    merged = deep_merge(data, {"runtime_policy": runtime_policy})
    if not save_json(str(config_path), merged):
        raise SystemExit(f"failed to write config: {config_path}")
    return merged


def cleanup_config(config_path: Path) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        return {}
    if "runtime_policy" in data:
        data.pop("runtime_policy", None)
        if not save_json(str(config_path), data):
            raise SystemExit(f"failed to write config: {config_path}")
    return data


def merge_openclaw_plugin_config(config_path: Path, octoclaw_root: str | None = None) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        data = {}

    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}

    plugins["enabled"] = True

    allow = plugins.get("allow")
    allow_list = [str(item) for item in allow] if isinstance(allow, list) else []
    if PLUGIN_ID not in allow_list:
        allow_list.append(PLUGIN_ID)
    plugins["allow"] = allow_list

    entries = plugins.get("entries")
    if not isinstance(entries, dict):
        entries = {}
    entry = entries.get(PLUGIN_ID)
    if not isinstance(entry, dict):
        entry = {}
    entry["enabled"] = True
    entry_config = entry.get("config")
    if not isinstance(entry_config, dict):
        entry_config = {}
    if octoclaw_root:
        entry_config["octoclawRoot"] = octoclaw_root
    entry["config"] = entry_config
    hooks = entry.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    hooks["allowPromptInjection"] = True
    entry["hooks"] = hooks
    entries[PLUGIN_ID] = entry
    plugins["entries"] = entries

    data["plugins"] = plugins
    if not save_json(str(config_path), data):
        raise SystemExit(f"failed to write config: {config_path}")
    return data


def cleanup_openclaw_plugin_config(config_path: Path) -> dict[str, Any]:
    data = load_json(str(config_path))
    if not isinstance(data, dict):
        return {}

    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        return data

    allow = plugins.get("allow")
    if isinstance(allow, list):
        plugins["allow"] = [item for item in allow if str(item) != PLUGIN_ID]

    entries = plugins.get("entries")
    if isinstance(entries, dict):
        entries.pop(PLUGIN_ID, None)
        plugins["entries"] = entries

    data["plugins"] = plugins
    if not save_json(str(config_path), data):
        raise SystemExit(f"failed to write config: {config_path}")
    return data


def show_runtime_policy(config_path: Path) -> dict[str, Any]:
    data = load_json(str(config_path))
    if isinstance(data, dict):
        runtime_policy = data.get("runtime_policy")
        if isinstance(runtime_policy, dict):
            return runtime_policy
    return {}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage OctoClaw runtime-policy rollout config.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    merge_parser = subparsers.add_parser("merge-config")
    merge_parser.add_argument("--config", required=True)
    merge_parser.add_argument("--preset", choices=sorted(PRESETS.keys()), default="conservative")
    add_bool_overrides(merge_parser)

    render_parser = subparsers.add_parser("render-policy")
    render_parser.add_argument("--preset", choices=sorted(PRESETS.keys()), default="conservative")
    add_bool_overrides(render_parser)

    cleanup_parser = subparsers.add_parser("cleanup-config")
    cleanup_parser.add_argument("--config", required=True)

    show_parser = subparsers.add_parser("show-config")
    show_parser.add_argument("--config", required=True)

    merge_plugin_parser = subparsers.add_parser("merge-openclaw-plugin")
    merge_plugin_parser.add_argument("--config", required=True)
    merge_plugin_parser.add_argument("--octoclaw-root")

    cleanup_plugin_parser = subparsers.add_parser("cleanup-openclaw-plugin")
    cleanup_plugin_parser.add_argument("--config", required=True)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "merge-config":
        runtime_policy = build_runtime_policy(args)
        merged = merge_config(Path(args.config), runtime_policy)
        print(json.dumps(merged.get("runtime_policy", {}), ensure_ascii=False, indent=2))
        return 0
    if args.command == "render-policy":
        print(json.dumps(build_runtime_policy(args), ensure_ascii=False, indent=2))
        return 0
    if args.command == "cleanup-config":
        cleanup_config(Path(args.config))
        print(json.dumps({"removed": "runtime_policy"}, ensure_ascii=False, indent=2))
        return 0
    if args.command == "show-config":
        print(json.dumps(show_runtime_policy(Path(args.config)), ensure_ascii=False, indent=2))
        return 0
    if args.command == "merge-openclaw-plugin":
        merged = merge_openclaw_plugin_config(Path(args.config), args.octoclaw_root)
        print(json.dumps(merged.get("plugins", {}), ensure_ascii=False, indent=2))
        return 0
    if args.command == "cleanup-openclaw-plugin":
        cleaned = cleanup_openclaw_plugin_config(Path(args.config))
        print(json.dumps(cleaned.get("plugins", {}), ensure_ascii=False, indent=2))
        return 0
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
