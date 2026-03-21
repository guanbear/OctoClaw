#!/usr/bin/env python3
"""Set Octopus main agent session modelOverride."""

import argparse
import json
import os
import subprocess
import sys

from octopus_config import MODEL_POLICY_FILE, resolve_main_session_key

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

MODE_MODEL_MAP = {
    "cost":    "lixiang-glm-5/kivy-glm-5",
    "private": "lixiang-glm-5/kivy-glm-5",
    "balanced": None,   # 清除 override，用全局默认
    "custom":   "KEEP", # 不变
    "auto":     "AUTO",
}

def get_quality_model():
    """quality 模式用 resolve-model.py --tier deep，感知铁甲虾降级"""
    try:
        result = subprocess.run(
            ["python3", os.path.join(SCRIPT_DIR, "resolve-model.py"), "--tier", "deep"],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip()
    except:
        return "vendor-claude-opus-4-6/aws-claude-opus-4-6"

def load_policy_main_model():
    try:
        with open(MODEL_POLICY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("main_model", "")
    except Exception:
        return ""


def set_session_model(model_path):
    """修改主 session 的 modelOverride，model_path=None 则清除。"""
    main_session = resolve_main_session_key()
    if not main_session:
        print("Error: main session not found", file=sys.stderr)
        return False
    try:
        gateway_port = 3000
        config_path = os.path.expanduser("~/.openclaw/openclaw.json")
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            gateway_port = config.get("port", 3000)

        url = f"http://localhost:{gateway_port}/api/sessions/agent:main:{main_session}"
        if model_path is None:
            payload = {"modelOverride": None}
        else:
            payload = {"modelOverride": model_path}
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
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(payload, ensure_ascii=False),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.stdout.strip() in {"200", "204"}
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    parser.add_argument("--explicit-model", default="")
    args = parser.parse_args()
    mode = args.mode

    if mode == "custom":
        print("custom 模式：主模型不变")
        return
    if mode == "custom_explicit":
        model = args.explicit_model.strip()
        if not model:
            print("custom_explicit 模式缺少 --explicit-model", file=sys.stderr)
            sys.exit(1)
        if set_session_model(model):
            print(f"✅ 主模型已设置为: {model}（custom_explicit 模式）")
            return
        print("❌ 设置失败", file=sys.stderr)
        sys.exit(1)

    if mode == "auto":
        model = load_policy_main_model()
        if not model:
            print("auto 模式：未找到 model-policy main_model", file=sys.stderr)
            sys.exit(1)
    elif mode == "quality":
        model = get_quality_model()
    else:
        model = MODE_MODEL_MAP.get(mode)
        if model is None and mode not in MODE_MODEL_MAP:
            print(f"未知模式: {mode}", file=sys.stderr)
            sys.exit(1)

    if set_session_model(model):
        if model:
            print(f"✅ 主模型已设置为: {model}（{mode} 模式）")
        else:
            print(f"✅ 主模型 override 已清除（{mode} 模式，使用全局默认）")
    else:
        print("❌ 设置失败", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
