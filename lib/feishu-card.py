#!/usr/bin/env python3
"""
飞书任务面板卡片工具
用于八爪鱼（OctoClaw）多 Agent 调度器，在飞书 DM 中展示和更新任务状态卡片

用法:
  python3 lib/feishu-card.py send '<tasks_json>'
  python3 lib/feishu-card.py update <message_id> '<tasks_json>'
  python3 lib/feishu-card.py init '<tasks_json>'
  python3 lib/feishu-card.py status <tentacle_name> <new_status> [summary]

tasks_json 格式:
  [{"tentacle":"修臂","emoji":"🔧","task":"修复bug","status":"dispatched","model":"sonnet"}]

status 取值:
  dispatched  → 🟡 已派遣
  running     → 🔄 进行中
  done        → ✅ 已完成
  failed      → ❌ 失败

update 时可加 summary 字段:
  [{"tentacle":"修臂","emoji":"🔧","task":"修复bug","status":"done","summary":"已修复3处"}]

init: 发送卡片并将 message_id + tasks 写入 FEISHU_CARD_STATE_FILE ({WORKSPACE}/tmp/octopus/feishu-card-state.json)
status: 读取 state 文件，更新指定触手状态，更新飞书卡片，写回 state 文件
"""

import sys
import json
import subprocess
import os
import requests
from datetime import datetime
import time

from octopus_config import FEISHU_ALMIGHTY_DIR as OCTO_FEISHU_ALMIGHTY_DIR
from octopus_config import FEISHU_CARD_STATE_FILE

# ── 配置 ──────────────────────────────────────────────────────────────────────
def _get_app_id():
    """从 openclaw 配置动态读取飞书 APP_ID，fallback 到硬编码默认值"""
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
        app_id = (config.get("channels", {})
                       .get("feishu", {})
                       .get("appId") or
                  config.get("channels", {})
                       .get("feishu", {})
                       .get("app_id"))
        if app_id:
            return app_id
    except Exception:
        pass
    return "cli_a90f871e65f8dcc0"  # fallback

APP_ID = _get_app_id()


def get_target_open_id():
    """从 openclaw 配置动态获取飞书用户 open_id"""
    try:
        config_path = os.path.expanduser("~/.openclaw/openclaw.json")
        with open(config_path) as f:
            config = json.load(f)
        # 尝试从 feishu channel 配置读取
        # 从 sessions 找 feishu:dm 的用户
        sessions_path = os.path.expanduser("~/.openclaw/sessions.json")
        if os.path.exists(sessions_path):
            with open(sessions_path) as f:
                sessions = json.load(f)
            for key in sessions:
                if key.startswith("feishu:dm:ou_"):
                    return key.split("feishu:dm:")[1]
    except Exception:
        pass
    return "ou_373285ded0f664b08b43820c32f3d1b7"  # fallback


TARGET_OPEN_ID = get_target_open_id()

STATE_FILE = FEISHU_CARD_STATE_FILE

FEISHU_ALMIGHTY_DIR = OCTO_FEISHU_ALMIGHTY_DIR

FEISHU_API_BASE = "https://open.feishu.cn/open-apis"

# ── 状态映射 ──────────────────────────────────────────────────────────────────
STATUS_MAP = {
    "dispatched": "🟡 已派遣",
    "running":    "🔄 进行中",
    "done":       "✅ 已完成",
    "failed":     "❌ 失败",
    # 兼容旧写法
    "pending":    "🟡 已派遣",
    "success":    "✅ 已完成",
    "error":      "❌ 失败",
}

# ── 模型默认打分 ───────────────────────────────────────────────────────────────
MODEL_DEFAULTS = {
    "opus":   {"cost": 3, "speed": 1},
    "sonnet": {"cost": 2, "speed": 3},
    "gemini": {"cost": 2, "speed": 2},
    "kimi":   {"cost": 1, "speed": 2},
    "glm":    {"cost": 1, "speed": 2},
}


def get_model_score(task: dict) -> tuple:
    """获取任务的 cost 和 speed 分数，支持默认值
    
    Returns:
        (cost_str, speed_str): 如 ("💰", "⚡⚡") 或 ("-", "-")
    """
    model = task.get("model", "").lower()
    defaults = MODEL_DEFAULTS.get(model, {})
    
    cost = task.get("cost", defaults.get("cost", None))
    speed = task.get("speed", defaults.get("speed", None))
    
    cost_str = "💰" * cost if cost in (1, 2, 3) else "-"
    speed_str = "⚡" * speed if speed in (1, 2, 3) else "-"
    
    return cost_str, speed_str


def get_app_secret() -> str:
    """从 ~/.openclaw/openclaw.json 读取 appSecret"""
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    with open(config_path, "r") as f:
        config = json.load(f)
    # 尝试从 feishu channel 配置读取
    secret = (
        config.get("channels", {}).get("feishu", {}).get("appSecret")
        or config.get("appSecret")
    )
    if not secret:
        raise ValueError(f"无法从 {config_path} 读取 appSecret")
    return secret


def get_tenant_access_token() -> str:
    """获取飞书 tenant_access_token（使用 feishu-almighty 的 get-user-token 工具）
    
    注意：使用用户应用（路径 B，不带 --default-app），因为 open_id 属于用户应用体系。
    缺省应用会报 open_id cross app 错误。
    """
    tool = os.path.join(FEISHU_ALMIGHTY_DIR, "get-user-token-linux")
    if not os.path.exists(tool):
        # 降级：直接用 appId/appSecret 换 token
        return _get_token_direct()
    
    # 路径 B：用户应用（不带 --default-app）
    result = subprocess.run(
        [tool, "--tenant"],
        capture_output=True, text=True, timeout=60,
        cwd=FEISHU_ALMIGHTY_DIR
    )
    token = result.stdout.strip()
    if not token or "❌" in token or result.returncode != 0:
        # 降级到直接获取
        return _get_token_direct()
    return token


def _get_token_direct() -> str:
    """直接调用飞书 API 获取 tenant_access_token"""
    try:
        app_secret = get_app_secret()
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
        raise RuntimeError(f"读取 appSecret 失败: {e}") from e

    try:
        resp = requests.post(
            f"{FEISHU_API_BASE}/auth/v3/tenant_access_token/internal",
            json={"app_id": APP_ID, "app_secret": app_secret},
            timeout=10
        )
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"请求飞书 token API 失败（网络错误）: {e}") from e

    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError) as e:
        raise RuntimeError(f"飞书 token API 返回非 JSON（HTTP {resp.status_code}）: {resp.text[:200]}") from e

    if data.get("code") != 0:
        raise RuntimeError(f"获取 token 失败 (code={data.get('code')}): {data.get('msg')}")
    return data["tenant_access_token"]


def build_card(tasks: list, sent_at: str = None) -> dict:
    """构建飞书卡片 JSON"""
    if sent_at is None:
        sent_at = datetime.now().strftime("%H:%M")

    # 构建结构化文本（飞书 lark_md 不支持 markdown 表格语法，会显示为原始文本）
    lines = []
    for t in tasks:
        emoji = t.get("emoji", "🦑")
        tentacle = t.get("tentacle", "")
        task_desc = t.get("task", "")
        model = t.get("model", "-")
        status_key = t.get("status", "dispatched")
        status_label = STATUS_MAP.get(status_key, status_key)
        summary = t.get("summary", "")
        
        # 获取成本和速度打分
        cost_str, speed_str = get_model_score(t)
        
        # 如果有 summary，追加到状态后
        if summary:
            status_label = f"{status_label} — {summary}"
        
        # 格式：emoji 触手名 · 任务 · 模型 · 成本/速度 · 状态
        line = f"{emoji} **{tentacle}** · {task_desc} · `{model}`"
        if cost_str != "-" or speed_str != "-":
            line += f" · {cost_str}/{speed_str}"
        line += f"\n    {status_label}"
        lines.append(line)

    table_md = "\n".join(lines)

    # 统计各状态数量
    total = len(tasks)
    done_count = sum(1 for t in tasks if t.get("status") in ("done", "success"))
    failed_count = sum(1 for t in tasks if t.get("status") in ("failed", "error"))
    running_count = sum(1 for t in tasks if t.get("status") in ("running",))
    pending_count = total - done_count - failed_count - running_count

    # 进度摘要
    progress_parts = []
    if pending_count > 0:
        progress_parts.append(f"🟡 {pending_count} 待处理")
    if running_count > 0:
        progress_parts.append(f"🔄 {running_count} 进行中")
    if done_count > 0:
        progress_parts.append(f"✅ {done_count} 已完成")
    if failed_count > 0:
        progress_parts.append(f"❌ {failed_count} 失败")
    progress_str = "  ".join(progress_parts) if progress_parts else "🟡 等待中"

    # 卡片 JSON（飞书卡片 v2 格式）
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {
                "tag": "plain_text",
                "content": "🐙 八爪鱼（OctoClaw）任务派遣"
            },
            "template": "blue"
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": table_md
                }
            },
            {
                "tag": "hr"
            },
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": progress_str
                }
            },
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": f"⏱️ 派遣于 {sent_at}  ·  共 {total} 个触手  ·  快捷动作：发送「八爪鱼状态」查看完整面板"
                    }
                ]
            }
        ]
    }
    return card


def send_task_card(tasks: list, parent_id: str = None) -> str:
    """发送初始任务面板卡片，返回 message_id
    
    Args:
        tasks: 任务列表
        parent_id: 飞书线程 root_id，如指定则将消息发送到该线程下
    """
    token = get_tenant_access_token()
    card = build_card(tasks)
    
    payload = {
        "receive_id": TARGET_OPEN_ID,
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False)
    }
    
    if parent_id is not None:
        payload["root_id"] = parent_id
    
    resp = requests.post(
        f"{FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        },
        json=payload,
        timeout=15
    )
    
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"发送失败 (code={data.get('code')}): {data.get('msg')}\n完整响应: {json.dumps(data, ensure_ascii=False)}")
    
    message_id = data["data"]["message_id"]
    return message_id


def update_task_card(message_id: str, tasks: list) -> bool:
    """更新已有卡片"""
    token = get_tenant_access_token()
    card = build_card(tasks)
    
    payload = {
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False)
    }
    
    resp = requests.patch(
        f"{FEISHU_API_BASE}/im/v1/messages/{message_id}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        },
        json=payload,
        timeout=15
    )
    
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"更新失败 (code={data.get('code')}): {data.get('msg')}\n完整响应: {json.dumps(data, ensure_ascii=False)}")
    
    return True


def init_task_card(tasks: list) -> str:
    """发送卡片并将 message_id + tasks 写入 state 文件，返回 message_id"""
    message_id = send_task_card(tasks)
    state = {
        "message_id": message_id,
        "tasks": tasks,
        "created_at": int(time.time())
    }
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    print(f"✅ state 已写入: {STATE_FILE}", file=sys.stderr)
    return message_id


def status_update(tentacle_name: str, new_status: str, summary: str = None) -> bool:
    """读取 state 文件，更新指定触手状态，更新卡片，写回 state 文件"""
    if not os.path.exists(STATE_FILE):
        raise FileNotFoundError(f"state 文件不存在: {STATE_FILE}，请先执行 init 命令")
    
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        state = json.load(f)
    
    message_id = state["message_id"]
    tasks = state["tasks"]
    
    # 查找匹配的触手
    matched = False
    for t in tasks:
        if t.get("tentacle") == tentacle_name:
            t["status"] = new_status
            if summary is not None:
                t["summary"] = summary
            elif "summary" in t and new_status in ("running", "dispatched"):
                # 状态回退时清空 summary（可选，保留旧 summary 也无妨）
                pass
            matched = True
            break
    
    if not matched:
        raise ValueError(f"未找到触手: {tentacle_name}，当前触手: {[t.get('tentacle') for t in tasks]}")
    
    # 更新卡片
    update_task_card(message_id, tasks)
    
    # 写回 state 文件
    state["tasks"] = tasks
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    
    print(f"✅ 触手 [{tentacle_name}] 状态已更新为 {new_status}", file=sys.stderr)
    return True


# ── CLI 入口 ──────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1].lower()
    
    if cmd == "send":
        if len(sys.argv) < 3:
            print("用法: python3 feishu-card.py send '<tasks_json>' [parent_id]", file=sys.stderr)
            sys.exit(1)
        tasks = json.loads(sys.argv[2])
        parent_id = sys.argv[3] if len(sys.argv) >= 4 else None
        message_id = send_task_card(tasks, parent_id=parent_id)
        print(message_id)  # stdout 输出 message_id
        print(f"✅ 卡片已发送: {message_id}", file=sys.stderr)
    
    elif cmd == "update":
        if len(sys.argv) < 4:
            print("用法: python3 feishu-card.py update <message_id> '<tasks_json>'", file=sys.stderr)
            sys.exit(1)
        message_id = sys.argv[2]
        tasks = json.loads(sys.argv[3])
        update_task_card(message_id, tasks)
        print(f"✅ 卡片已更新: {message_id}", file=sys.stderr)
    
    elif cmd == "init":
        if len(sys.argv) < 3:
            print("用法: python3 feishu-card.py init '<tasks_json>'", file=sys.stderr)
            sys.exit(1)
        tasks = json.loads(sys.argv[2])
        message_id = init_task_card(tasks)
        print(message_id)  # stdout 输出 message_id
        print(f"✅ 卡片已初始化: {message_id}", file=sys.stderr)
    
    elif cmd == "status":
        if len(sys.argv) < 4:
            print("用法: python3 feishu-card.py status <tentacle_name> <new_status> [summary]", file=sys.stderr)
            sys.exit(1)
        tentacle_name = sys.argv[2]
        new_status = sys.argv[3]
        summary = sys.argv[4] if len(sys.argv) >= 5 else None
        status_update(tentacle_name, new_status, summary)
    
    else:
        print(f"未知命令: {cmd}，支持: send / update / init / status", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except json.JSONDecodeError as e:
        print(f"❌ JSON 解析错误: {e}", file=sys.stderr)
        print("请确认 tasks_json 参数是合法的 JSON 格式", file=sys.stderr)
        sys.exit(2)
    except requests.exceptions.ConnectionError as e:
        print(f"❌ 网络连接失败: {e}", file=sys.stderr)
        print("请确认网络可达且飞书 API 地址正确", file=sys.stderr)
        sys.exit(3)
    except requests.exceptions.Timeout:
        print("❌ 请求超时，飞书 API 无响应", file=sys.stderr)
        sys.exit(4)
    except Exception as e:
        print(f"❌ 未预期错误: {e}", file=sys.stderr)
        sys.exit(1)
