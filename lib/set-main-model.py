#!/usr/bin/env python3
"""Set OctoClaw main agent session modelOverride."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from octopus_config import MODE_FILE, MODEL_POLICY_FILE, resolve_main_session_key


def load_mode_data() -> dict:
    try:
        with open(MODE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_policy_main_model() -> str:
    try:
        with open(MODEL_POLICY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return str(data.get("main_model", "") or "").strip()
    except Exception:
        return ""


def load_custom_main_model() -> str:
    mode_data = load_mode_data()
    custom_models = mode_data.get("customModels", {})
    if not isinstance(custom_models, dict):
        return ""
    return str(custom_models.get("main", "") or "").strip()


def resolve_session_api_key(main_session: str) -> str:
    text = str(main_session or "").strip()
    if not text:
        return ""
    if text.startswith("agent:main:"):
        return text
    return f"agent:main:{text}"


def set_session_model(model_path: str | None) -> bool:
    main_session = resolve_main_session_key()
    if not main_session:
        print("Error: main session not found", file=sys.stderr)
        return False
    session_key = resolve_session_api_key(main_session)
    try:
        gateway_port = 3000
        gateway_token = ""
        config_path = os.path.expanduser("~/.openclaw/openclaw.json")
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            gateway_cfg = config.get("gateway", {}) if isinstance(config, dict) else {}
            if isinstance(gateway_cfg, dict):
                gateway_port = int(gateway_cfg.get("port", config.get("port", 3000)) or 3000)
                auth_cfg = gateway_cfg.get("auth", {})
                if isinstance(auth_cfg, dict):
                    gateway_token = str(auth_cfg.get("token", "") or "").strip()
            else:
                gateway_port = int(config.get("port", 3000) or 3000)

        url = f"http://localhost:{gateway_port}/api/sessions/{session_key}"
        payload = {"modelOverride": model_path}
        headers = ["-H", "Content-Type: application/json"]
        if gateway_token:
            headers.extend(["-H", f"Authorization: Bearer {gateway_token}"])
        result = subprocess.run(
            [
                "curl",
                "-s",
                "-o",
                "/tmp/octopus-model-switch-result.json",
                "-w",
                "%{http_code}",
                "-X",
                "PATCH",
                url,
                *headers,
                "-d",
                json.dumps(payload, ensure_ascii=False),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.stdout.strip() in {"200", "204"}
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["auto", "custom", "custom_explicit"])
    parser.add_argument("--explicit-model", default="")
    args = parser.parse_args()

    model: str | None
    if args.mode == "custom_explicit":
        model = args.explicit_model.strip()
        if not model:
            print("custom_explicit 模式缺少 --explicit-model", file=sys.stderr)
            sys.exit(1)
    elif args.mode == "custom":
        model = load_custom_main_model()
        if not model:
            print("custom 模式：未设置 main 覆盖，保持现状")
            return
    else:
        model = load_policy_main_model()
        if not model:
            print("auto 模式：未找到 model-policy main_model", file=sys.stderr)
            sys.exit(1)

    if set_session_model(model):
        print(f"✅ 主模型已设置为: {model}（{args.mode} 模式）")
        return
    print("❌ 设置失败", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
