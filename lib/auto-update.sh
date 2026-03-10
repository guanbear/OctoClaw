#!/bin/bash
# auto-update.sh - 八爪鱼自升级脚本
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$SKILL_DIR/lib"
VERSION_FILE="$SKILL_DIR/version.txt"
LOCAL_VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo "0.0.0")"

GITLAB_BASE="https://gitlab.chehejia.com/ai-market/lixiang-skills-marketplace/-/raw/master/packages/octopus"
TASK_STATE_FILE="/workspace/tmp/octopus/task-state.json"

# 读取飞书用户 open_id
get_open_id() {
    python3 -c "
import json, os
f = os.path.expanduser('~/.openclaw/sessions.json')
with open(f) as fp:
    data = json.load(fp)
for k in data:
    if k.startswith('feishu:dm:ou_'):
        print(k.split('feishu:dm:')[1])
        break
" 2>/dev/null || echo ""
}

# 发飞书文字消息
send_feishu_msg() {
    local msg="$1"
    python3 "$LIB_DIR/feishu-card.py" send-text "$msg" 2>/dev/null || true
}

# 从远程 SKILL.md 中读取 stable 字段
get_remote_stable() {
    local skill_md_url="$GITLAB_BASE/SKILL.md"
    local content
    content=$(curl -sf --max-time 15 "$skill_md_url" 2>/dev/null || echo "")
    if [[ -z "$content" ]]; then
        echo "false"
        return
    fi
    # 匹配 stable: true/false（支持 metadata 嵌套和顶层字段）
    local val
    val=$(echo "$content" | grep -E '^\s+stable:|^stable:' | head -1 | awk '{print $2}' | tr -d '\r\n')
    if [[ "$val" == "true" ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# check 子命令：检查是否有新版本
do_check() {
    echo "🔍 检查八爪鱼版本..."

    # 获取远程版本
    REMOTE_VERSION=$(curl -sf "$GITLAB_BASE/version.txt" 2>/dev/null || echo "")

    if [[ -z "$REMOTE_VERSION" ]]; then
        echo "⚠️  无法获取远程版本，跳过"
        return 0
    fi

    echo "本地版本: $LOCAL_VERSION"
    echo "远程版本: $REMOTE_VERSION"

    if [[ "$LOCAL_VERSION" == "$REMOTE_VERSION" ]]; then
        echo "✅ 已是最新版本"
        return 0
    fi

    # 版本比较（简单字符串比较，语义化版本）
    if python3 -c "
from packaging import version
import sys
local = sys.argv[1].lstrip('v')
remote = sys.argv[2].lstrip('v')
sys.exit(0 if version.parse(remote) > version.parse(local) else 1)
" "$LOCAL_VERSION" "$REMOTE_VERSION" 2>/dev/null || \
       [[ "$REMOTE_VERSION" > "$LOCAL_VERSION" ]]; then
        echo "🆕 发现新版本: $REMOTE_VERSION"
        
        # 检查远程版本是否为 stable
        REMOTE_STABLE=$(get_remote_stable)
        echo "远程 stable 标记: $REMOTE_STABLE"
        
        if [[ "$REMOTE_STABLE" == "true" ]]; then
            echo "✅ 新版本为 stable，自动升级..."
            do_upgrade "$REMOTE_VERSION"
        else
            echo "⚠️  新版本不是 stable，发送通知让用户手动决定"
            notify_user_nonstable "$REMOTE_VERSION"
        fi
    else
        echo "✅ 本地版本已是最新或更新"
    fi
}

# 通知用户有新版本（stable 版本已自动升级后的通知，保留向后兼容）
notify_user() {
    local remote_ver="$1"
    notify_user_nonstable "$remote_ver"
}

# 通知用户有非 stable 新版本，需要手动确认升级
notify_user_nonstable() {
    local remote_ver="$1"
    local open_id
    open_id=$(get_open_id)
    
    if [[ -z "$open_id" ]]; then
        echo "⚠️  无法获取用户 open_id，跳过通知"
        return 0
    fi
    
    # 发飞书通知（非 stable，需要手动确认）
    local msg="🐙 八爪鱼有新版本（非 stable）

当前版本：v${LOCAL_VERSION}
最新版本：v${remote_ver}
稳定标记：⚠️ 非 stable（测试版）

此版本尚未标记为 stable，自动升级已跳过。

如果你想升级，请回复「确认升级」；不升级请忽略此消息。"
    
    send_feishu_msg "$msg"
    
    # 写入 pending_confirm
    python3 - "$remote_ver" <<'PYEOF'
import json, os, datetime, sys
f = "/workspace/tmp/octopus/task-state.json"
try:
    with open(f) as fp:
        data = json.load(fp)
except Exception:
    data = {"tasks": [], "updated_at": ""}
remote_ver = sys.argv[1] if len(sys.argv) > 1 else "unknown"
record = {
    "id": f"confirm-{datetime.date.today().strftime('%Y%m%d')}-upgrade-octopus",
    "label": "pending_confirm",
    "status": "pending_confirm",
    "summary": f"等待确认：升级八爪鱼到 v{remote_ver}（非 stable）",
    "spawned_at": datetime.datetime.utcnow().isoformat() + "Z",
    "artifacts": {"action": "upgrade_octopus", "version": remote_ver}
}
# 避免重复写入
existing_ids = {t.get("id") for t in data.get("tasks", [])}
if record["id"] not in existing_ids:
    data["tasks"].append(record)
data["updated_at"] = datetime.datetime.utcnow().isoformat() + "Z"
with open(f, "w") as fp:
    json.dump(data, fp, indent=2, ensure_ascii=False)
PYEOF
    echo "✅ 已通知用户（非 stable），等待手动确认"
}

# do_upgrade 子命令：执行升级
do_upgrade() {
    local remote_ver="${1:-latest}"
    echo "⬇️  开始升级八爪鱼到 v${remote_ver}..."
    
    TMPDIR=$(mktemp -d)
    ZIPFILE="$TMPDIR/octopus-update.zip"
    
    # 下载
    GITLAB_ZIP="https://gitlab.chehejia.com/ai-market/lixiang-skills-marketplace/-/archive/master/lixiang-skills-marketplace-master.zip"
    curl -sL "$GITLAB_ZIP" -o "$ZIPFILE"
    
    # 解压
    cd "$TMPDIR"
    unzip -q "$ZIPFILE"
    EXTRACTED=$(find . -maxdepth 1 -type d | grep -v "^\.$" | head -1)
    
    # 覆盖安装（保留用户配置）
    if [[ -d "$EXTRACTED/packages/octopus" ]]; then
        cp -r "$EXTRACTED/packages/octopus/." "$SKILL_DIR/"
        echo "✅ 文件已更新"
    fi
    
    # 重新注入 AGENTS.md
    bash "$SKILL_DIR/install.sh" inject-only 2>/dev/null || true
    
    # 清理
    rm -rf "$TMPDIR"
    
    send_feishu_msg "✅ 八爪鱼已升级到 v${remote_ver}！"
    echo "✅ 升级完成"
}

# 主入口
case "${1:-check}" in
    check)     do_check ;;
    do_upgrade) do_upgrade "${2:-}" ;;
    *) echo "用法: $0 [check|do_upgrade <version>]"; exit 1 ;;
esac
