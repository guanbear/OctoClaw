#!/usr/bin/env python3
"""
set-main-model.py - 根据八爪鱼模式设置主 Agent 的 session modelOverride
用法：python3 set-main-model.py --mode cost
      python3 set-main-model.py --mode balanced  # 清除 override
"""
import json, os, sys, subprocess, argparse

SESSIONS_FILE = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
MODE_FILE = "/workspace/tmp/octopus-mode.json"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

MODE_MODEL_MAP = {
    "cost":    "lixiang-glm-5/kivy-glm-5",
    "private": "lixiang-glm-5/kivy-glm-5",
    "balanced": None,   # 清除 override，用全局默认
    "custom":   "KEEP", # 不变
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

def set_session_model(model_path):
    """修改 feishu:dm session 的 modelOverride，model_path=None 则清除"""
    if not os.path.exists(SESSIONS_FILE):
        print(f"Error: sessions.json not found at {SESSIONS_FILE}", file=sys.stderr)
        return False
    try:
        with open(SESSIONS_FILE) as f:
            sessions = json.load(f)
        changed = False
        for key in sessions:
            if "feishu:dm:" in key:
                if model_path is None:
                    if "modelOverride" in sessions[key]:
                        del sessions[key]["modelOverride"]
                        changed = True
                else:
                    sessions[key]["modelOverride"] = model_path
                    changed = True
        if changed:
            tmp = SESSIONS_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(sessions, f, indent=2, ensure_ascii=False)
            os.replace(tmp, SESSIONS_FILE)
        return True
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    args = parser.parse_args()
    mode = args.mode

    if mode == "custom":
        print("custom 模式：主模型不变")
        return

    if mode == "quality":
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
