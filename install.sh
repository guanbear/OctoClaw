#!/usr/bin/env bash
# 八爪鱼 (Octopus) 安装脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${WORKSPACE:-/workspace}"
OCTOPUS_RULES_VERSION="v1.6.1"
SKILL_ROOT="${SKILL_ROOT:-$SCRIPT_DIR}"

detect_openclaw_workdir() {
    local service_file
    service_file="$(systemctl cat openclaw.service 2>/dev/null || true)"
    if [ -n "$service_file" ]; then
        printf '%s\n' "$service_file" | sed -n 's/^WorkingDirectory=//p' | head -n 1
        return 0
    fi
    return 1
}

detect_agents_workspace() {
    if [ -n "${AGENTS_WORKSPACE:-}" ]; then
        printf '%s\n' "$AGENTS_WORKSPACE"
        return 0
    fi

    if [ -d "$HOME/.openclaw/workspace" ]; then
        printf '%s\n' "$HOME/.openclaw/workspace"
        return 0
    fi

    local detected
    detected="$(detect_openclaw_workdir || true)"
    if [ -n "$detected" ]; then
        printf '%s\n' "$detected"
        return 0
    fi

    printf '%s\n' "$WORKSPACE"
}

AGENTS_WORKSPACE="${AGENTS_WORKSPACE:-$(detect_agents_workspace)}"
AGENTS_FILE="${AGENTS_WORKSPACE}/AGENTS.md"
STATE_DIR="${WORKSPACE}/tmp/octopus"

# ── 加载功能开关配置 ──────────────────────────────────────────────────────────
OCTOPUS_CONFIG="$SCRIPT_DIR/lib/config.sh"
if [ -f "$OCTOPUS_CONFIG" ]; then
    # shellcheck source=/dev/null
    source "$OCTOPUS_CONFIG"
fi
# 默认值（config.sh 不存在时的兜底）
FEATURE_MODEL_PROBE="${FEATURE_MODEL_PROBE:-false}"
FEATURE_OMNIROUTE_PLAN_SYNC="${FEATURE_OMNIROUTE_PLAN_SYNC:-true}"
OMNIROUTE_PLAN_SYNC_INTERVAL_MINUTES="${OMNIROUTE_PLAN_SYNC_INTERVAL_MINUTES:-15}"
PATROL_MODE="${PATROL_MODE:-loop}"
PATROL_INTERVAL="${PATROL_INTERVAL:-60}"
SUPERVISOR_MODE="${SUPERVISOR_MODE:-auto}"
NOTIFICATION_BACKEND="${NOTIFICATION_BACKEND:-auto}"
NOTIFICATION_PANEL_ENABLED="${NOTIFICATION_PANEL_ENABLED:-true}"
NOTIFICATION_EVENT_ENABLED="${NOTIFICATION_EVENT_ENABLED:-true}"
NOTIFICATION_TEXT_ENABLED="${NOTIFICATION_TEXT_ENABLED:-true}"
MAIN_SESSION_CHANNEL="${MAIN_SESSION_CHANNEL:-auto}"
MAIN_SESSION_TARGET="${MAIN_SESSION_TARGET:-}"
MODEL_AUTO_ENABLED="${MODEL_AUTO_ENABLED:-true}"
MODEL_AUTO_PREFER_PRIVATE="${MODEL_AUTO_PREFER_PRIVATE:-false}"
MODEL_AUTO_PREFER_LOW_COST="${MODEL_AUTO_PREFER_LOW_COST:-false}"
RUNNER_ENABLED="${RUNNER_ENABLED:-true}"
RUNNER_POLL_INTERVAL_SECONDS="${RUNNER_POLL_INTERVAL_SECONDS:-3}"
RUNNER_HEARTBEAT_INTERVAL_SECONDS="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-10}"
RUNNER_DEFAULT_TIMEOUT_SECONDS="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}"
RUNNER_MAX_AGE_MINUTES="${RUNNER_MAX_AGE_MINUTES:-120}"
RUNNER_MAX_JOBS_PER_WORKER="${RUNNER_MAX_JOBS_PER_WORKER:-50}"

# ─────────────────────────────────────────────
# 公共辅助：删除 / 禁用 / 启用 cron
# ─────────────────────────────────────────────
_get_gateway_url() {
    python3 -c "
import json
try:
    with open('$HOME/.openclaw/openclaw.json') as f:
        d = json.load(f)
    print('http://localhost:' + str(d.get('port', 3000)))
except Exception:
    print('http://localhost:3000')
" 2>/dev/null
}

_get_gateway_token() {
    python3 -c "
import json
try:
    with open('$HOME/.openclaw/openclaw.json') as f:
        d = json.load(f)
    print(d.get('token', '') or '')
except Exception:
    print('')
" 2>/dev/null
}

_delete_cron_by_name() {
    local cron_name="$1"
    local gw_url gw_token job_id http_code
    gw_url=$(_get_gateway_url)
    gw_token=$(_get_gateway_token)

    # 列出所有 cron，找到 id
    job_id=$(curl -s \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        "$gw_url/api/cron/jobs" 2>/dev/null | \
        python3 -c "
import json, sys
data = json.load(sys.stdin)
jobs = data if isinstance(data, list) else data.get('jobs', [])
for j in jobs:
    if j.get('name') == '$cron_name':
        print(j.get('id',''))
        break
" 2>/dev/null)

    if [ -z "$job_id" ]; then
        echo "ℹ️  未找到 $cron_name cron，跳过"
        return 0
    fi

    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X DELETE \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        "$gw_url/api/cron/jobs/$job_id")

    if [[ "$http_code" == "200" ]] || [[ "$http_code" == "204" ]] || [[ "$http_code" == "404" ]]; then
        echo "✅ 已删除 cron: $cron_name"
    else
        echo "⚠️  删除 $cron_name 失败（HTTP $http_code）"
    fi
}

_disable_cron_by_name() {
    local cron_name="$1"
    local gw_url gw_token job_id http_code
    gw_url=$(_get_gateway_url)
    gw_token=$(_get_gateway_token)

    job_id=$(curl -s \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        "$gw_url/api/cron/jobs" 2>/dev/null | \
        python3 -c "
import json, sys
data = json.load(sys.stdin)
jobs = data if isinstance(data, list) else data.get('jobs', [])
for j in jobs:
    if j.get('name') == '$cron_name':
        print(j.get('id',''))
        break
" 2>/dev/null)

    if [ -z "$job_id" ]; then
        echo "ℹ️  未找到 $cron_name cron，跳过"
        return 0
    fi

    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PATCH \
        -H "Content-Type: application/json" \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        -d '{"enabled": false}' \
        "$gw_url/api/cron/jobs/$job_id")

    if [[ "$http_code" == "200" ]] || [[ "$http_code" == "204" ]]; then
        echo "✅ 已禁用 cron: $cron_name"
    else
        echo "⚠️  禁用 $cron_name 失败（HTTP $http_code），可能需要手动禁用"
    fi
}

_enable_cron_by_name() {
    local cron_name="$1"
    local gw_url gw_token job_id http_code
    gw_url=$(_get_gateway_url)
    gw_token=$(_get_gateway_token)

    job_id=$(curl -s \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        "$gw_url/api/cron/jobs" 2>/dev/null | \
        python3 -c "
import json, sys
data = json.load(sys.stdin)
jobs = data if isinstance(data, list) else data.get('jobs', [])
for j in jobs:
    if j.get('name') == '$cron_name':
        print(j.get('id',''))
        break
" 2>/dev/null)

    if [ -z "$job_id" ]; then
        echo "ℹ️  未找到 $cron_name cron，跳过（可运行 install.sh 重新安装）"
        return 0
    fi

    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PATCH \
        -H "Content-Type: application/json" \
        ${gw_token:+-H "Authorization: Bearer $gw_token"} \
        -d '{"enabled": true}' \
        "$gw_url/api/cron/jobs/$job_id")

    if [[ "$http_code" == "200" ]] || [[ "$http_code" == "204" ]]; then
        echo "✅ 已启用 cron: $cron_name"
    else
        echo "⚠️  启用 $cron_name 失败（HTTP $http_code）"
    fi
}

# ─────────────────────────────────────────────
# patrol-loop 进程管理（loop 模式使用）
# ─────────────────────────────────────────────
_PATROL_LOOP_PID_FILE="$WORKSPACE/tmp/octopus/patrol-loop.pid"
_PATROL_LOOP_LOG="$WORKSPACE/tmp/octopus/patrol.log"
_RUNNER_DAEMON_PID_FILE="$WORKSPACE/tmp/octopus/runner-daemon.pid"
_RUNNER_DAEMON_LOG="$WORKSPACE/tmp/octopus/runner.log"
_RUNNER_HEALTH_FILE="$WORKSPACE/tmp/octopus/runner-health.json"
_SYSTEMD_RUNNER_SERVICE="octoclaw-runner.service"
_SYSTEMD_PATROL_SERVICE="octoclaw-patrol.service"
_SYSTEMD_UNIT_DIR="/etc/systemd/system"

_clear_stale_runtime_state() {
    local pid_file="$1"
    local health_file="${2:-}"
    if [ -f "$pid_file" ]; then
        local old_pid
        old_pid=$(cat "$pid_file" 2>/dev/null || echo "")
        if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$pid_file"
        if [ -n "$health_file" ]; then
            rm -f "$health_file"
        fi
    fi
}

_systemd_available() {
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

_resolve_supervisor_mode() {
    if [ "${SUPERVISOR_MODE:-auto}" = "systemd" ]; then
        printf '%s\n' "systemd"
        return 0
    fi
    if [ "${SUPERVISOR_MODE:-auto}" = "shell" ]; then
        printf '%s\n' "shell"
        return 0
    fi
    if [ "${PATROL_MODE:-loop}" = "loop" ] && _systemd_available; then
        printf '%s\n' "systemd"
        return 0
    fi
    printf '%s\n' "shell"
}

_render_systemd_unit() {
    local template_file="$1"
    local output_file="$2"
    python3 - "$template_file" "$output_file" "$WORKSPACE" "$SKILL_ROOT" "${SUDO_USER:-${USER:-root}}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
workspace = sys.argv[3]
skill_root = sys.argv[4]
run_user = sys.argv[5]

text = template_path.read_text(encoding="utf-8")
text = text.replace("__WORKSPACE__", workspace)
text = text.replace("__SKILL_ROOT__", skill_root)
text = text.replace("__RUN_USER__", run_user)
output_path.write_text(text, encoding="utf-8")
PY
}

_install_systemd_units() {
    if ! _systemd_available; then
        echo "ℹ️  当前环境未检测到 systemd，跳过 systemd 守护安装"
        return 1
    fi

    local template_dir="$SCRIPT_DIR/lib/systemd"
    local runner_template="$template_dir/octoclaw-runner.service"
    local patrol_template="$template_dir/octoclaw-patrol.service"
    local runner_target="$_SYSTEMD_UNIT_DIR/$_SYSTEMD_RUNNER_SERVICE"
    local patrol_target="$_SYSTEMD_UNIT_DIR/$_SYSTEMD_PATROL_SERVICE"

    if [ ! -f "$runner_template" ] || [ ! -f "$patrol_template" ]; then
        echo "⚠️  未找到 systemd unit 模板，跳过"
        return 1
    fi

    _render_systemd_unit "$runner_template" "$runner_target"
    _render_systemd_unit "$patrol_template" "$patrol_target"
    systemctl daemon-reload
    systemctl enable "$_SYSTEMD_RUNNER_SERVICE" "$_SYSTEMD_PATROL_SERVICE" >/dev/null 2>&1 || true
    echo "✅ 已安装 systemd 守护：$_SYSTEMD_RUNNER_SERVICE / $_SYSTEMD_PATROL_SERVICE"
}

_remove_systemd_units() {
    if ! _systemd_available; then
        return 0
    fi
    systemctl disable --now "$_SYSTEMD_RUNNER_SERVICE" "$_SYSTEMD_PATROL_SERVICE" >/dev/null 2>&1 || true
    rm -f "$_SYSTEMD_UNIT_DIR/$_SYSTEMD_RUNNER_SERVICE" "$_SYSTEMD_UNIT_DIR/$_SYSTEMD_PATROL_SERVICE"
    systemctl daemon-reload >/dev/null 2>&1 || true
}

_start_runner_service() {
    local mode
    mode="$(_resolve_supervisor_mode)"
    if [ "$mode" = "systemd" ]; then
        _install_systemd_units || return 1
        systemctl restart "$_SYSTEMD_RUNNER_SERVICE"
        echo "✅ runner 已由 systemd 托管：$_SYSTEMD_RUNNER_SERVICE"
        return 0
    fi
    _start_runner_daemon
}

_stop_runner_service() {
    local mode
    mode="$(_resolve_supervisor_mode)"
    if [ "$mode" = "systemd" ] && _systemd_available; then
        systemctl stop "$_SYSTEMD_RUNNER_SERVICE" >/dev/null 2>&1 || true
        rm -f "$_RUNNER_HEALTH_FILE" "$_RUNNER_DAEMON_PID_FILE"
        echo "✅ runner systemd 服务已停止"
        return 0
    fi
    _stop_runner_daemon
}

_start_patrol_service() {
    local mode
    mode="$(_resolve_supervisor_mode)"
    if [ "$mode" = "systemd" ]; then
        _install_systemd_units || return 1
        systemctl restart "$_SYSTEMD_PATROL_SERVICE"
        echo "✅ patrol 已由 systemd 托管：$_SYSTEMD_PATROL_SERVICE"
        return 0
    fi
    _start_patrol_loop
}

_stop_patrol_service() {
    local mode
    mode="$(_resolve_supervisor_mode)"
    if [ "$mode" = "systemd" ] && _systemd_available; then
        systemctl stop "$_SYSTEMD_PATROL_SERVICE" >/dev/null 2>&1 || true
        rm -f "$_PATROL_LOOP_PID_FILE"
        echo "✅ patrol systemd 服务已停止"
        return 0
    fi
    _stop_patrol_loop
}

_start_patrol_loop() {
    local loop_script="$SCRIPT_DIR/lib/patrol-loop.sh"
    mkdir -p "$WORKSPACE/tmp/octopus"

    # 检查是否已在运行
    if [ -f "$_PATROL_LOOP_PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$_PATROL_LOOP_PID_FILE")
        if kill -0 "$old_pid" 2>/dev/null; then
            echo "ℹ️  patrol-loop 已在运行 (PID=$old_pid)，跳过"
            return 0
        fi
        rm -f "$_PATROL_LOOP_PID_FILE"
    fi

    if [ ! -f "$loop_script" ]; then
        echo "⚠️  未找到 $loop_script，跳过 patrol-loop 启动"
        return 1
    fi

    PATROL_INTERVAL="$PATROL_INTERVAL" setsid bash "$loop_script" >> "$_PATROL_LOOP_LOG" 2>&1 &
    sleep 0.8

    if [ -f "$_PATROL_LOOP_PID_FILE" ]; then
        local new_pid
        new_pid=$(cat "$_PATROL_LOOP_PID_FILE")
        echo "✅ patrol-loop 已启动 (PID=$new_pid)，间隔 ${PATROL_INTERVAL}s，零 token"
    else
        echo "⚠️  patrol-loop 启动失败，请查看日志：$_PATROL_LOOP_LOG"
        return 1
    fi
}

_stop_patrol_loop() {
    if [ -f "$_PATROL_LOOP_PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$_PATROL_LOOP_PID_FILE")
        if kill -0 "$old_pid" 2>/dev/null; then
            kill "$old_pid" 2>/dev/null
            echo "✅ patrol-loop 已停止 (PID=$old_pid)"
        else
            echo "ℹ️  patrol-loop 进程已不存在"
        fi
        rm -f "$_PATROL_LOOP_PID_FILE"
    else
        echo "ℹ️  patrol-loop 未在运行（PID 文件不存在）"
    fi
}

_start_runner_daemon() {
    local daemon_script="$SCRIPT_DIR/lib/runner-daemon.sh"
    mkdir -p "$WORKSPACE/tmp/octopus"

    if [ "${RUNNER_ENABLED:-true}" != "true" ]; then
        echo "ℹ️  RUNNER_ENABLED=false，跳过 runner-daemon 启动"
        return 0
    fi

    _clear_stale_runtime_state "$_RUNNER_DAEMON_PID_FILE" "$_RUNNER_HEALTH_FILE"

    if [ -f "$_RUNNER_DAEMON_PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$_RUNNER_DAEMON_PID_FILE")
        if kill -0 "$old_pid" 2>/dev/null; then
            echo "ℹ️  runner-daemon 已在运行 (PID=$old_pid)，跳过"
            return 0
        fi
    fi

    if [ ! -f "$daemon_script" ]; then
        echo "⚠️  未找到 $daemon_script，跳过 runner-daemon 启动"
        return 1
    fi

    WORKSPACE="$WORKSPACE" \
    RUNNER_POLL_INTERVAL_SECONDS="$RUNNER_POLL_INTERVAL_SECONDS" \
    RUNNER_HEARTBEAT_INTERVAL_SECONDS="$RUNNER_HEARTBEAT_INTERVAL_SECONDS" \
    RUNNER_DEFAULT_TIMEOUT_SECONDS="$RUNNER_DEFAULT_TIMEOUT_SECONDS" \
    RUNNER_MAX_AGE_MINUTES="$RUNNER_MAX_AGE_MINUTES" \
    RUNNER_MAX_JOBS_PER_WORKER="$RUNNER_MAX_JOBS_PER_WORKER" \
    setsid bash "$daemon_script" >> "$_RUNNER_DAEMON_LOG" 2>&1 &
    sleep 0.8

    if [ -f "$_RUNNER_DAEMON_PID_FILE" ]; then
        local new_pid
        new_pid=$(cat "$_RUNNER_DAEMON_PID_FILE")
        echo "✅ runner-daemon 已启动 (PID=$new_pid)"
    else
        echo "⚠️  runner-daemon 启动失败，请查看日志：$_RUNNER_DAEMON_LOG"
        return 1
    fi
}

_stop_runner_daemon() {
    if [ -f "$_RUNNER_DAEMON_PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$_RUNNER_DAEMON_PID_FILE")
        if kill -0 "$old_pid" 2>/dev/null; then
            kill "$old_pid" 2>/dev/null
            echo "✅ runner-daemon 已停止 (PID=$old_pid)"
        else
            echo "ℹ️  runner-daemon 进程已不存在"
        fi
        rm -f "$_RUNNER_DAEMON_PID_FILE"
        rm -f "$_RUNNER_HEALTH_FILE"
    else
        echo "ℹ️  runner-daemon 未在运行（PID 文件不存在）"
    fi
}

# ─────────────────────────────────────────────
# 卸载
# ─────────────────────────────────────────────
do_uninstall() {
    echo ""
    echo "🗑️  卸载八爪鱼..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 1. 停止巡逻（loop 模式停进程，cron 模式删 cron）
    echo "📡 停止巡逻任务..."
    _stop_patrol_service
    _stop_runner_service
    _remove_systemd_units
    _delete_cron_by_name "octopus-patrol"
    _delete_cron_by_name "octopus-probe"
    _delete_cron_by_name "octopus-plan-sync"
    _delete_cron_by_name "octopus-update-check"

    # 2. 从 AGENTS.md 删除规则注入
    if [ -f "$AGENTS_FILE" ]; then
        # 先备份
        local UNINSTALL_TS
        UNINSTALL_TS="$(date +%s)"
        cp "$AGENTS_FILE" "${AGENTS_FILE}.bak.${UNINSTALL_TS}"
        echo "✅ 已备份 AGENTS.md → $(basename "${AGENTS_FILE}.bak.${UNINSTALL_TS}")"
        python3 -c "
import re
with open('$AGENTS_FILE', 'r') as f:
    content = f.read()
# 使用 [^>]* 匹配版本号，兼容 v1.0.3 等带版本的块标记
cleaned = re.sub(
    r'\n<!-- octopus:core-rules[^>]*>.*?<!-- /octopus:core-rules -->\n?',
    '\n',
    content,
    flags=re.DOTALL
)
with open('$AGENTS_FILE', 'w') as f:
    f.write(cleaned)
print('✅ 已从 AGENTS.md 移除规则注入')
" 2>/dev/null || echo "⚠️  AGENTS.md 规则移除失败，请手动删除 octopus:core-rules 块"
    else
        echo "ℹ️  未找到 $AGENTS_FILE，跳过规则清理"
    fi

    # 3. 删除 tmp 目录
    if [ -d "$WORKSPACE/tmp/octopus" ]; then
        rm -rf "$WORKSPACE/tmp/octopus"
        echo "✅ 已删除工作目录 $WORKSPACE/tmp/octopus"
    else
        echo "ℹ️  工作目录不存在，跳过"
    fi

    echo ""
    echo "🎉 八爪鱼已卸载完成"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  请执行 /compact 让规则移除生效"
    echo ""
}

# ─────────────────────────────────────────────
# 关闭（暂停）
# ─────────────────────────────────────────────
do_disable() {
    echo ""
    echo "⏸️  暂停八爪鱼..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 创建标记文件
    mkdir -p "$WORKSPACE/tmp/octopus"
    touch "$WORKSPACE/tmp/octopus/.disabled"
    echo "✅ 已创建禁用标记文件"

    # 停止巡逻
    echo "📡 停止巡逻任务..."
    if [ "${PATROL_MODE:-loop}" = "loop" ]; then
        _stop_patrol_service
    else
        _disable_cron_by_name "octopus-patrol"
    fi
    _stop_runner_service
    _disable_cron_by_name "octopus-probe"
    _disable_cron_by_name "octopus-plan-sync"
    _disable_cron_by_name "octopus-update-check"

    echo ""
    echo "✅ 八爪鱼已暂停（巡逻与 runner 已停止，文件保留）"
    echo "   AGENTS.md 中的规则已保留（但八爪鱼不会主动巡逻）"
    echo "   重新启用：bash $SCRIPT_DIR/install.sh enable"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# ─────────────────────────────────────────────
# 启用
# ─────────────────────────────────────────────
do_enable() {
    echo ""
    echo "▶️  启用八爪鱼..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 移除标记文件
    if [ -f "$WORKSPACE/tmp/octopus/.disabled" ]; then
        rm -f "$WORKSPACE/tmp/octopus/.disabled"
        echo "✅ 已移除禁用标记文件"
    else
        echo "ℹ️  八爪鱼未处于禁用状态"
    fi

    # 重新启动巡逻
    echo "📡 启动巡逻任务..."
    if [ "${PATROL_MODE:-loop}" = "loop" ]; then
        _start_patrol_service
    else
        _enable_cron_by_name "octopus-patrol"
    fi
    _start_runner_service
    _enable_cron_by_name "octopus-probe"
    _enable_cron_by_name "octopus-plan-sync"
    _enable_cron_by_name "octopus-update-check"

    echo ""
    echo "✅ 八爪鱼已重新启用"
    if [ "${PATROL_MODE:-loop}" = "loop" ]; then
        echo "   巡逻守护已恢复（$(_resolve_supervisor_mode)，间隔 ${PATROL_INTERVAL}s）"
    else
        echo "   cron 巡逻和探测任务已恢复"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# ─────────────────────────────────────────────
# 参数路由
# ─────────────────────────────────────────────
case "${1:-}" in
    uninstall|--uninstall|-u)
        do_uninstall
        exit 0
        ;;
    disable|--disable)
        do_disable
        exit 0
        ;;
    enable|--enable)
        do_enable
        exit 0
        ;;
esac

# ─────────────────────────────────────────────
# 正常安装流程（无参数）
# ─────────────────────────────────────────────
echo ""
echo "🐙 八爪鱼多 Agent 调度器 v1.2.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "功能特性："
echo "  💪 鲸力手  - 重型任务、大规模批量处理"
echo "  🔍 梭鱼眼  - 搜索调研、信息收集分析"
echo "  ✍️  墨鱼手  - 写作文档、内容创作"
echo "  🔧 螃蟹手  - 代码修改、文件编辑"
echo "  🧪 海胆手  - 测试验证、质量把关"
echo "  📊 章鱼脑  - 数据分析、日志分析"
echo "  🏃 飞鱼腿  - 命令执行、脚本运行（最快！）"
echo "  🐦 鸽  手  - 飞书操作、消息传递"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🐙 安装八爪鱼 (Octopus) skill..."

# 1. 创建工作目录
mkdir -p "$WORKSPACE/tmp/octopus"

# 2. 模式选择引导
echo ""
echo "⚖️  选择调度模式（可随时通过对话切换）："
echo ""
echo "  1) ⚖️  平衡模式（默认）- trivial/simple→GLM，normal→Sonnet，deep→Sonnet"
echo "  2) ⚡ 速度优先          - 所有任务选延迟最低的可用模型"
echo "  3) 🎯 效果优先          - 所有任务使用 Opus"
echo "  4) 💰 成本优先          - 尽量使用 GLM，降低费用"
echo "  5) 🔒 保密模式          - 只用私有模型（GLM）"
echo "  6) 🧠 自动选模          - 根据本地模型、速度、价格与能力自动分配"
echo "  7) 🔧 自定义模式        - 手动为每个触手指定模型（高级用户）"
echo ""
read -p "请输入选择 [1-7，直接回车选平衡模式]: " mode_choice

# 自定义模式用关联数组存储用户为每个触手指定的模型
declare -A CUSTOM_MODELS
MAIN_MODEL=""

case "$mode_choice" in
    2) MODE="speed" ;;
    3) MODE="quality" ;;
    4) MODE="cost" ;;
    5) MODE="private" ;;
    6) MODE="auto" ;;
    7)
        MODE="custom"
        MODE_LABEL="🔧 自定义模式"
        echo ""
        echo "🔧 自定义模式：为每个触手指定模型（直接回车跳过使用平衡模式默认值）"
        echo "可用模型示例：vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6"
        echo "             lixiang-kimi-2-5/kivy-kimi-k2_5"
        echo ""
        for LABEL in octopus-power octopus-scout octopus-writer octopus-fix octopus-test octopus-analyze octopus-runner octopus-feishu; do
            case $LABEL in
                octopus-power)   NAME="💪 鲸力手" ;;
                octopus-scout)   NAME="🔍 梭鱼眼" ;;
                octopus-writer)  NAME="✍️  墨鱼手" ;;
                octopus-fix)     NAME="🔧 螃蟹手" ;;
                octopus-test)    NAME="🧪 海胆手" ;;
                octopus-analyze) NAME="📊 章鱼脑" ;;
                octopus-runner)  NAME="🏃 飞鱼腿" ;;
                octopus-feishu)  NAME="🐦 鸽  手" ;;
            esac
            read -p "  $NAME ($LABEL): " CUSTOM_MODEL
            if [ -n "$CUSTOM_MODEL" ]; then
                CUSTOM_MODELS[$LABEL]="$CUSTOM_MODEL"
            fi
        done
        read -p "  🤖 主 Agent (main): " MAIN_MODEL
        ;;
    *) MODE="balanced" ;;
esac

# 写入模式文件（包含完整模式定义）
MODE_FILE="$WORKSPACE/tmp/octopus-mode.json"
mkdir -p "$WORKSPACE/tmp"

if [ "$MODE" = "custom" ]; then
    # 使用 python3 安全生成 JSON（避免 bash 字符串拼接导致 JSON 格式错误）
    CUSTOM_PAIRS=""
    for KEY in "${!CUSTOM_MODELS[@]}"; do
        CUSTOM_PAIRS+="${KEY}=${CUSTOM_MODELS[$KEY]}"$'\n'
    done
    if [ -n "$MAIN_MODEL" ]; then
        CUSTOM_PAIRS+="main=${MAIN_MODEL}"$'\n'
    fi

    OCTOPUS_MODE_JSON=$(CUSTOM_PAIRS="$CUSTOM_PAIRS" python3 -c "
import json, sys, os
from datetime import datetime, timezone

pairs_raw = os.environ.get('CUSTOM_PAIRS', '')
custom_models = {}
for line in pairs_raw.strip().split('\n'):
    if '=' in line:
        k, v = line.split('=', 1)
        custom_models[k.strip()] = v.strip()

mode = {
    'mode': 'custom',
    'customModels': custom_models,
    'updated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'description': '自定义模式：每个触手使用指定模型，未指定的 fallback 平衡模式',
    'modes': {
        'speed': {'trivial': 'dynamic_fastest', 'simple': 'dynamic_fastest', 'normal': 'dynamic_fastest', 'deep': 'dynamic_fastest', 'concurrency': 5},
        'quality': {'trivial': 'claudeopus', 'simple': 'claudeopus', 'normal': 'claudeopus', 'deep': 'claudeopus', 'concurrency': 3},
        'cost': {'trivial': 'kimi', 'simple': 'sonnet', 'normal': 'sonnet', 'deep': 'sonnet', 'concurrency': 3},
        'balanced': {'trivial': 'kimi', 'simple': 'sonnet', 'normal': 'sonnet', 'deep': 'claudeopus', 'concurrency': 5},
        'private': {'trivial': 'kimi', 'simple': 'kimi', 'normal': 'kimi', 'deep': 'claudeopus', 'concurrency': 5, 'autoPrivate': True},
        'auto': {'trivial': 'auto', 'simple': 'auto', 'normal': 'auto', 'deep': 'auto', 'concurrency': 5}
    }
}
print(json.dumps(mode, ensure_ascii=False, indent=2))
" 2>/dev/null)
    echo "$OCTOPUS_MODE_JSON" > "$MODE_FILE"
else
    case "$MODE" in
        balanced) MODE_DESC='平衡模式：轻任务用低成本模型，复杂任务用高质量模型' ;;
        speed)    MODE_DESC='速度优先：所有任务选延迟最低的可用模型' ;;
        quality)  MODE_DESC='效果优先：所有任务使用 Opus' ;;
        cost)     MODE_DESC='成本优先：尽量使用 GLM，降低费用' ;;
        private)  MODE_DESC='保密模式：只用私有模型（GLM）' ;;
        auto)     MODE_DESC='自动选模：根据本地模型、速度、价格和能力动态分配' ;;
        *)        MODE_DESC="$MODE" ;;
    esac
    cat > "$MODE_FILE" << EOF
{
  "mode": "$MODE",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "description": "$MODE_DESC",
  "modes": {
    "speed": {"trivial": "dynamic_fastest", "simple": "dynamic_fastest", "normal": "dynamic_fastest", "deep": "dynamic_fastest", "concurrency": 5},
    "quality": {"trivial": "claudeopus", "simple": "claudeopus", "normal": "claudeopus", "deep": "claudeopus", "concurrency": 3},
    "cost": {"trivial": "glm", "simple": "sonnet", "normal": "sonnet", "deep": "sonnet", "concurrency": 3},
    "balanced": {"trivial": "glm", "simple": "sonnet", "normal": "sonnet", "deep": "claudeopus", "concurrency": 5},
    "private": {"trivial": "glm", "simple": "kimi", "normal": "kimi", "deep": "claudeopus", "concurrency": 5, "autoPrivate": true},
    "auto": {"trivial": "auto", "simple": "auto", "normal": "auto", "deep": "auto", "concurrency": 5}
  }
}
EOF
fi

case "$MODE" in
    balanced) MODE_LABEL='⚖️  平衡模式' ;;
    speed)    MODE_LABEL='⚡ 速度优先' ;;
    quality)  MODE_LABEL='🎯 效果优先' ;;
    cost)     MODE_LABEL='💰 成本优先' ;;
    private)  MODE_LABEL='🔒 保密模式' ;;
    auto)     MODE_LABEL='🧠 自动选模' ;;
    custom)   MODE_LABEL='🔧 自定义模式' ;;
esac
echo "✅ 已设置为 $MODE_LABEL"

OCTOPUS_CONFIG_FILE="$WORKSPACE/tmp/octopus-config.json"
python3 - << EOF
import json
from datetime import datetime, timezone

cfg = {
  "version": "v1.2.0",
  "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "notification": {
    "backend": "${NOTIFICATION_BACKEND}",
    "panel_enabled": "${NOTIFICATION_PANEL_ENABLED}".lower() == "true",
    "event_enabled": "${NOTIFICATION_EVENT_ENABLED}".lower() == "true",
    "text_enabled": "${NOTIFICATION_TEXT_ENABLED}".lower() == "true",
  },
  "main_session": {
    "channel": "${MAIN_SESSION_CHANNEL}",
    "target": "${MAIN_SESSION_TARGET}",
    "session_key": "",
  },
  "model_auto": {
    "enabled": "${MODEL_AUTO_ENABLED}".lower() == "true",
    "prefer_private": "${MODEL_AUTO_PREFER_PRIVATE}".lower() == "true",
    "prefer_low_cost": "${MODEL_AUTO_PREFER_LOW_COST}".lower() == "true",
  }
}
with open("${OCTOPUS_CONFIG_FILE}", "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
print("✅ 已写入统一配置 octopus-config.json")
EOF

echo "💰 正在初始化统一价格源..."
python3 - << EOF
import sys
sys.path.insert(0, "${SCRIPT_DIR}/lib")
from model_pricing import ensure_pricing_file, MODEL_PRICING_FILE
ensure_pricing_file()
print(f"✅ 已初始化价格文件: {MODEL_PRICING_FILE}")
EOF

# 自动切换主 Agent 模型
switch_main_agent_model() {
    local mode="$1"
    local explicit_model="${2:-}"  # 可选：自定义模式时直接传入目标模型

    # 检查铁甲虾是否正在守护降级状态，避免冲突
    if [ -f "/tmp/ironclaw-model-guard-override.json" ]; then
        GUARDED=$(python3 -c "import json; d=json.load(open('/tmp/ironclaw-model-guard-override.json')); print(d.get('guarded','false'))" 2>/dev/null)
        if [ "$GUARDED" = "True" ] || [ "$GUARDED" = "true" ]; then
            echo "⚠️  铁甲虾正在守护模型降级状态，跳过主 Agent 模型切换（避免冲突）"
            echo "   当前降级模型将继续使用，铁甲虾恢复后可重新切换模式"
            return 0
        fi
    fi

    local script="$SCRIPT_DIR/lib/set-main-model.py"
    local cmd=(python3 "$script" --mode "$mode")
    if [[ -n "$explicit_model" ]]; then
        cmd+=(--explicit-model "$explicit_model")
    fi
    if "${cmd[@]}"; then
        echo "✅ 主 Agent 模型切换脚本执行完成"
    else
        echo "⚠️  主 Agent 模型切换失败，将在下次会话或下轮 patrol 再尝试"
    fi
}

# 自定义模式：如果用户指定了主 Agent 模型，直接传入；否则 fallback balanced
if [ "$MODE" = "custom" ] && [ -n "$MAIN_MODEL" ]; then
    switch_main_agent_model "custom_explicit" "$MAIN_MODEL"
else
    switch_main_agent_model "$MODE"
fi

# 3. 检查 python3 和 requests 库（仅 Feishu 通知后端依赖）
ACTIVE_NOTIFICATION_BACKEND=$(python3 - << EOF
import sys
sys.path.insert(0, "${SCRIPT_DIR}/lib")
from octopus_config import get_notification_backend
print(get_notification_backend())
EOF
)
if [ "$ACTIVE_NOTIFICATION_BACKEND" = "feishu" ]; then
    if command -v python3 &>/dev/null; then
        if python3 -c "import requests" 2>/dev/null; then
            echo "✅ Python3 + requests 已就绪"
        else
            echo "⚠️  缺少 requests 库，尝试安装..."
            pip3 install requests --quiet && echo "✅ requests 安装成功" || echo "❌ requests 安装失败，飞书通知可能无法使用"
        fi
    else
        echo "⚠️  未找到 python3，飞书通知将无法使用"
    fi
else
    echo "ℹ️  当前通知后端为 $ACTIVE_NOTIFICATION_BACKEND，跳过飞书依赖检查"
fi

# 4. 启动巡逻（loop 模式：零 token 进程；cron 模式：openclaw cron）
install_patrol_cron() {

    # ── loop 模式（默认）：零 token，直接启动常驻进程 ──────────────────────────
    if [ "${PATROL_MODE:-loop}" = "loop" ]; then
        echo "🔄 巡逻模式：loop（零 token），间隔 ${PATROL_INTERVAL}s"

        # 迁移：若旧版已注册 octopus-patrol cron，删除它（避免重复运行浪费 token）
        if command -v openclaw &>/dev/null && openclaw cron list 2>/dev/null | grep -q "octopus-patrol"; then
            echo "ℹ️  检测到旧版 octopus-patrol cron，迁移删除中..."
            _delete_cron_by_name "octopus-patrol"
        fi

        _start_patrol_service
        _start_runner_service

        # 注册每日版本检查 cron（仅版本检查，每天一次，token 消耗可忽略）
        if ! command -v openclaw &>/dev/null; then
            echo "⚠️  openclaw CLI 未找到，跳过版本检查 cron 注册"
            return 0
        fi
        echo "📡 注册八爪鱼版本检查 cron（每天09:00 Asia/Shanghai）..."
        if openclaw cron list 2>/dev/null | grep -q "octopus-update-check"; then
            echo "ℹ️  octopus-update-check cron 已存在，跳过"
            return 0
        fi
    else
        # ── cron 模式：通过 openclaw cron，每次触发消耗 ~500-1000 token ──────────
        echo "🔄 巡逻模式：cron（每1分钟，消耗 token）"

        # 检查 openclaw CLI 是否可用
        if ! command -v openclaw &>/dev/null; then
            echo "⚠️  openclaw CLI 未找到，跳过 cron 注册（可手动注册）"
            return 0
        fi

        # 读取用户飞书 open_id
        USER_OPEN_ID=$(python3 -c "
import json, sys
try:
    with open('$HOME/.openclaw/sessions.json') as f:
        data = json.load(f)
    keys = [k for k in data.keys() if 'feishu:dm:ou_' in k]
    print(keys[0].split('feishu:dm:')[1] if keys else '')
except Exception:
    print('')
" 2>/dev/null)

        # 注册 octopus-patrol cron
        if openclaw cron list 2>/dev/null | grep -q "octopus-patrol"; then
            echo "ℹ️  octopus-patrol cron 已存在，跳过"
        else
            if [[ -n "$USER_OPEN_ID" ]]; then
                DELIVERY_OPTS="--announce --channel feishu --to user:${USER_OPEN_ID}"
                echo "ℹ️  patrol delivery → 飞书私信 user:${USER_OPEN_ID}"
            else
                DELIVERY_OPTS="--announce --channel feishu"
                echo "⚠️  未获取到 open_id，patrol delivery fallback → feishu announce"
            fi

            PATROL_MSG='运行八爪鱼巡逻脚本，检查任务状态，有异常则发飞书卡片。

执行以下命令：
```bash
python3 /workspace/openclaw/skills/octopus/lib/patrol.py
```

执行完成后直接结束，无需回复或发送任何其他通知。'

            if openclaw cron add \
                --name octopus-patrol \
                --every 1m \
                --session isolated \
                --timeout-seconds 60 \
                $DELIVERY_OPTS \
                --message "$PATROL_MSG" 2>/dev/null; then
                echo "✅ octopus-patrol cron 注册成功（每1分钟，cron 模式）"
            else
                echo "⚠️  cron 注册失败，可手动在 OpenClaw 中添加"
            fi
        fi

        echo "📡 注册八爪鱼版本检查 cron（每天09:00 Asia/Shanghai）..."
        if openclaw cron list 2>/dev/null | grep -q "octopus-update-check"; then
            echo "ℹ️  octopus-update-check cron 已存在，跳过"
            return 0
        fi
    fi
    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:3000}"
    GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

    UPDATE_CHECK_PAYLOAD='{
  "name": "octopus-update-check",
  "schedule": {"kind": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
  "payload": {
    "kind": "agentTurn",
    "message": "执行八爪鱼版本检查：bash /workspace/openclaw/skills/octopus/lib/auto-update.sh check 2>&1",
    "timeoutSeconds": 120
  },
  "delivery": {"mode": "none"},
  "sessionTarget": "isolated",
  "enabled": true
}'

    HTTP_CODE=$(curl -s -o /tmp/octopus-update-cron-result.json -w "%{http_code}" \
        -X POST "$GATEWAY_URL/api/cron/jobs" \
        -H "Content-Type: application/json" \
        ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
        -d "$UPDATE_CHECK_PAYLOAD")

    if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "201" ]]; then
        echo "✅ octopus-update-check cron 注册成功（每天09:00 Asia/Shanghai 自动检查新版本）"
    else
        echo "⚠️  版本检查 cron 注册失败（HTTP $HTTP_CODE），可手动在 OpenClaw 中添加"
        cat /tmp/octopus-update-cron-result.json 2>/dev/null
    fi
}

install_patrol_cron

# 注册模型延迟探测 cron（每15分钟，错峰 anchorMs=450000，仅在铁甲虾没有探测 cron 时才注册）
install_probe_cron() {
    local IRONCLAW_BIN="$WORKSPACE/openclaw/skills/ironclaw/bin/ironclaw"

    # ── FEATURE_MODEL_PROBE 开关（默认 false）────────────────────────────────
    if [ "${FEATURE_MODEL_PROBE:-false}" != "true" ]; then
        echo "ℹ️  FEATURE_MODEL_PROBE=false，跳过 octopus-probe cron 注册（默认关闭）"
        echo "    若需启用，请将 lib/config.sh 中 FEATURE_MODEL_PROBE 改为 true 后重新运行 install.sh"
        return 0
    fi

    # 检查 openclaw CLI 是否可用
    if ! command -v openclaw &>/dev/null; then
        echo "⚠️  openclaw CLI 未找到，跳过 cron 注册（可手动注册）"
        return 0
    fi

    # 检查铁甲虾是否已有探测 cron（以铁甲虾为准，避免重复写文件）
    if openclaw cron list 2>/dev/null | grep -q "ironclaw-probe\|latency-probe"; then
        echo "ℹ️  铁甲虾已有模型探测 cron，跳过重复注册"
        return 0
    fi

    # 检查铁甲虾二进制是否存在（说明铁甲虾已安装，其 guardian 会做探测）
    if [ -f "$IRONCLAW_BIN" ]; then
        echo "ℹ️  检测到铁甲虾已安装，跳过模型探测 cron（使用铁甲虾的探测数据）"
        return 0
    fi

    echo "📡 注册模型延迟探测 cron（每15分钟，时间戳复用策略）..."

    # 检查是否已存在
    if openclaw cron list 2>/dev/null | grep -q "octopus-probe"; then
        echo "ℹ️  octopus-probe cron 已存在，跳过"
        return 0
    fi

    # 通过 Gateway REST API 注册
    # anchorMs=0（标准对齐），everyMs=900000（每15分钟）
    # 无需错峰：probe-models.sh 自带时间戳检查，若文件在 20 分钟内已更新则跳过，重复触发安全无害
    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:3000}"
    GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

    PROBE_PAYLOAD='{
  "name": "octopus-probe",
  "schedule": {"kind": "every", "everyMs": 900000, "anchorMs": 0},
  "payload": {
    "kind": "agentTurn",
    "message": "运行模型延迟探测脚本，更新延迟数据供八爪鱼调度使用。\n\n执行以下命令：\n```bash\nbash /workspace/openclaw/skills/octopus/lib/probe-models.sh\n```\n\n执行完成后直接结束，无需回复或发送任何通知。",
    "timeoutSeconds": 120
  },
  "delivery": {"mode": "none"},
  "sessionTarget": "isolated",
  "enabled": true
}'

    HTTP_CODE=$(curl -s -o /tmp/octopus-probe-cron-result.json -w "%{http_code}" \
        -X POST "$GATEWAY_URL/api/cron/jobs" \
        -H "Content-Type: application/json" \
        ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
        -d "$PROBE_PAYLOAD")

    if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "201" ]]; then
        echo "✅ octopus-probe cron 注册成功（每15分钟，时间戳复用策略）"
    else
        echo "⚠️  cron 注册失败（HTTP $HTTP_CODE），可手动在 OpenClaw 中添加（每15分钟运行 probe-models.sh）"
        cat /tmp/octopus-probe-cron-result.json 2>/dev/null
    fi
}

install_probe_cron

install_plan_sync_cron() {
    if [ "${FEATURE_OMNIROUTE_PLAN_SYNC:-true}" != "true" ]; then
        echo "ℹ️  FEATURE_OMNIROUTE_PLAN_SYNC=false，跳过 octopus-plan-sync cron 注册"
        return 0
    fi

    if ! command -v openclaw &>/dev/null; then
        echo "⚠️  openclaw CLI 未找到，跳过 octopus-plan-sync cron 注册"
        return 0
    fi

    if ! command -v omniroute &>/dev/null; then
        echo "ℹ️  未检测到 omniroute，跳过 octopus-plan-sync cron 注册"
        return 0
    fi

    local interval_minutes every_ms
    interval_minutes="${OMNIROUTE_PLAN_SYNC_INTERVAL_MINUTES:-15}"
    every_ms=$(( interval_minutes * 60 * 1000 ))

    echo "📡 注册 Omniroute 套餐状态同步 cron（每${interval_minutes}分钟）..."

    if openclaw cron list 2>/dev/null | grep -q "octopus-plan-sync"; then
        echo "ℹ️  octopus-plan-sync cron 已存在，跳过"
        return 0
    fi

    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:3000}"
    GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

    PLAN_SYNC_PAYLOAD="$(cat <<JSON
{
  "name": "octopus-plan-sync",
  "schedule": {"kind": "every", "everyMs": ${every_ms}, "anchorMs": 0},
  "payload": {
    "kind": "agentTurn",
    "message": "同步 Omniroute 套餐状态并刷新 OctoClaw 自动选模策略。\\n\\n执行以下命令：\\n```bash\\ncd /workspace/openclaw/skills/octopus && WORKSPACE=/workspace PYTHONPATH=/workspace/openclaw/skills/octopus/lib python3 ./lib/sync-omniroute-plan.py sync && WORKSPACE=/workspace python3 ./lib/model-intel.py refresh --mode auto\\n```\\n\\n执行完成后直接结束，无需回复或发送任何通知。",
    "timeoutSeconds": 120
  },
  "delivery": {"mode": "none"},
  "sessionTarget": "isolated",
  "enabled": true
}
JSON
)"

    HTTP_CODE=$(curl -s -o /tmp/octopus-plan-sync-cron-result.json -w "%{http_code}" \
        -X POST "$GATEWAY_URL/api/cron/jobs" \
        -H "Content-Type: application/json" \
        ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
        -d "$PLAN_SYNC_PAYLOAD")

    if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "201" ]]; then
        echo "✅ octopus-plan-sync cron 注册成功（每${interval_minutes}分钟）"
    else
        echo "⚠️  octopus-plan-sync cron 注册失败（HTTP $HTTP_CODE）"
        cat /tmp/octopus-plan-sync-cron-result.json 2>/dev/null
    fi
}

install_plan_sync_cron

# 5. 首次模型延迟探测
if [[ ! -f "/tmp/ironclaw-model-latency.json" ]]; then
    echo ""
    echo "🔍 正在探测模型延迟（首次安装）..."
    if [ -f "/workspace/openclaw/skills/ironclaw/bin/ironclaw" ]; then
        /workspace/openclaw/skills/ironclaw/bin/ironclaw model probe 2>/dev/null && echo "✅ 模型延迟探测完成" || echo "⚠️  探测跳过（铁甲虾未安装）"
    else
        if [ -f "$WORKSPACE/openclaw/skills/octopus/lib/probe-models.sh" ]; then
            bash "$WORKSPACE/openclaw/skills/octopus/lib/probe-models.sh" 2>/dev/null && echo "✅ 模型延迟探测完成（八爪鱼自探测）" || echo "⚠️  探测脚本执行失败，延迟数据将由 octopus-probe cron 定期更新"
        else
            echo "⚠️  未检测到铁甲虾，跳过模型延迟探测（将由 octopus-probe cron 每15分钟自动探测）"
        fi
    fi
fi

# 按角色分类写入别名文件
echo ""
echo "📝 正在写入模型别名文件..."
python3 - << 'EOF'
import datetime
import json
import os
import subprocess

alias_file = "/workspace/tmp/octopus-model-aliases.json"

try:
    result = subprocess.run(
        ["openclaw", "models", "list", "--json"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    raw = json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []
except Exception:
    raw = []

ids = []
if isinstance(raw, list):
    ids = [m for m in raw if isinstance(m, str)]
elif isinstance(raw, dict):
    if isinstance(raw.get("models"), list):
        ids = [m.get("key", "") for m in raw["models"] if isinstance(m, dict)]
    else:
        ids = list(raw.keys())

def pick(patterns):
    for model_id in ids:
        lower = model_id.lower()
        if any(p in lower for p in patterns):
            return model_id
    return ""

glm = pick(["glm-4.7", "glm4.7", "kivy-glm-4.7", "glm-5", "kivy-glm-5", "glm"])
cheap = pick(["minimax", "m2.7", "kimi", "glm-4.7", "glm"])
coding = pick(["gpt-5.4", "glm-5", "sonnet", "glm-4.7", "minimax"])
deep = pick(["gpt-5.4", "glm-5", "opus", "sonnet", "minimax"])

data = json.load(open(alias_file)) if os.path.exists(alias_file) else {}
if cheap:
    data.update({"trivial": cheap, "simple": cheap})
if glm:
    data["normal"] = glm
if coding:
    data.update({"hard": coding, "normal_fallback": coding})
if deep:
    data.update({"deep": deep, "deep_quality": deep})
data["updated_at"] = datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z")
os.makedirs(os.path.dirname(alias_file), exist_ok=True)
with open(alias_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print(f"✅ 别名文件已更新: cheap={cheap or '未找到'}, normal={glm or '未找到'}, hard={coding or '未找到'}, deep={deep or '未找到'}")
EOF

echo "🧠 正在生成自动选模情报..."
if python3 "$SCRIPT_DIR/lib/sync-speed-metrics.py" sync >/tmp/octopus-speed-sync.json 2>/tmp/octopus-speed-sync.err; then
    cat /tmp/octopus-speed-sync.json
else
    echo "⚠️  speed metrics 同步失败：$(cat /tmp/octopus-speed-sync.err 2>/dev/null)"
fi
if python3 "$SCRIPT_DIR/lib/model-intel.py" refresh --mode "$MODE" >/tmp/octopus-model-intel.json 2>/tmp/octopus-model-intel.err; then
    cat /tmp/octopus-model-intel.json
else
    echo "⚠️  model-intel 生成失败：$(cat /tmp/octopus-model-intel.err 2>/dev/null)"
fi

# ─────────────────────────────────────────────
# 自动注入 octopus:core-rules 到 AGENTS.md
# ─────────────────────────────────────────────
inject_agents_md() {
    if [ ! -f "$AGENTS_FILE" ]; then
        mkdir -p "$AGENTS_WORKSPACE"
        cat > "$AGENTS_FILE" <<'EOF'
# Workspace instructions

EOF
        echo "✅ 已创建 AGENTS.md: $AGENTS_FILE"
    fi

    # 备份（无论新装还是升级都备份）
    local BACKUP="$AGENTS_FILE.bak.$(date +%s)"
    cp "$AGENTS_FILE" "$BACKUP"

    # 检测已安装版本
    CURRENT_VER=$(grep -o 'octopus:core-rules v[0-9.]*' "$AGENTS_FILE" 2>/dev/null | head -1 | grep -o 'v[0-9.]*' || echo "")
    INSTALL_VER="$OCTOPUS_RULES_VERSION"

    if [ "$CURRENT_VER" = "$INSTALL_VER" ]; then
        echo "ℹ️  octopus:core-rules 已是最新版 $INSTALL_VER，跳过注入"
        return 0
    elif [ -n "$CURRENT_VER" ]; then
        echo "🔄 检测到旧版规则 $CURRENT_VER，升级到 $INSTALL_VER..."
        # 备份 + 删除旧块 + 注入新块
        python3 -c "
import re, sys
with open('$AGENTS_FILE', 'r') as f:
    content = f.read()
# 删除旧的 octopus:core-rules 块（含版本号或不含版本号）
cleaned = re.sub(r'\n<!-- octopus:core-rules[^>]*>.*?<!-- /octopus:core-rules -->\n?', '\n', content, flags=re.DOTALL)
with open('$AGENTS_FILE', 'w') as f:
    f.write(cleaned)
print('✅ 旧版规则已清除')
"
        echo "✅ 已备份并清除旧版 AGENTS.md → $(basename $BACKUP)"
    elif grep -q "<!-- octopus:core-rules -->" "$AGENTS_FILE" 2>/dev/null; then
        echo "🔄 检测到无版本号的旧版规则，升级到 $INSTALL_VER..."
        # 备份 + 删除旧块 + 注入新块
        python3 -c "
import re, sys
with open('$AGENTS_FILE', 'r') as f:
    content = f.read()
cleaned = re.sub(r'\n<!-- octopus:core-rules -->.*?<!-- /octopus:core-rules -->\n?', '\n', content, flags=re.DOTALL)
with open('$AGENTS_FILE', 'w') as f:
    f.write(cleaned)
print('✅ 无版本号旧规则已清除')
"
        echo "✅ 已备份并清除旧版 AGENTS.md → $(basename $BACKUP)"
    else
        echo "✅ 首次安装 octopus:core-rules $INSTALL_VER，已备份 AGENTS.md → $(basename $BACKUP)"
    fi

    # 注入新版规则（在文件末尾追加）
    local RULES_TMP
    RULES_TMP="$(mktemp)"
    cat > "$RULES_TMP" <<'OCTOPUS_RULES'

<!-- octopus:core-rules __RULES_VERSION__ -->
## 🐙 八爪鱼核心原则（始终生效）

### 🚨 核心铁律

- 收到用户消息，第一个输出必须是文字，禁止先做工具调用
- 唯一允许的首轮工具例外：`sessions_spawn` 与 `cron.run("octopus-patrol")`
- 30 秒内纯文字能高质量完成 → 直答；否则先 route
- 同文件写操作必须串行；强依赖任务必须等待上游结果
- 所有 spawn 完成后，turn 末尾统一调用一次 `cron.run("octopus-patrol")`

### route / dispatch 规范

- `direct` 不是默认值，而是白名单：只有低风险、低上下文、无需工具、单轮可高质量完成的任务才允许主 Agent 直接处理
- 其余任务先做 route 判断，不要主 Agent 自己临场拍板
- 若 `octoclaw_route` / `octoclaw_dispatch` / `octoclaw_status` 工具可用，优先调用工具
- 若查询「八爪鱼状态」或调用 `octoclaw_status` / `/octostatus`，必须原样返回完整状态面板，不要再摘要、改写或自行压缩
- 默认状态视图必须使用 `compact`；只有用户明确要求“表格 / table / lanes / 泳道”时，才允许改用 `table` 或 `lanes`
- 若工具不可用，回退到脚本：
  - route：`python3 __SKILL_ROOT__/lib/octoclaw_route.py --task "..."`
  - dispatch：`python3 __SKILL_ROOT__/lib/dispatch_task.py --task "..."`
  - status：`bash __SKILL_ROOT__/lib/status.sh --format compact`
- 任何会使用本机工具、读取日志/状态、检查端口/服务/进程/磁盘/内存/版本、或会显著拉长主上下文的任务，都应先走 `octoclaw_dispatch`，不要主 Agent 直接执行
- `octoclaw_dispatch` 可以直接接自然语言本机检查任务；若命中 runner playbook，会自动下沉到常驻 runner
- 多步调研、编码、改文件、长执行、高风险分析，优先 route 到 `spawn_single` 或 `spawn_multi`
- 若 route 返回 `runner` / `spawn_single` / `spawn_multi`，主 Agent 不要绕开结果自己改用原生工具
- 子任务派发优先走 `python3 __SKILL_ROOT__/lib/octoclaw_spawn.py --task "..."`，不要手写零散 `sessions_spawn` 参数

### spawn 规范

- label：`octopus-power/scout/writer/fix/test/analyze/runner/feishu`
- 查询状态、轻 shell、日志检查、curl/grep/head/tail 这类快任务，命中后优先走 runner，不再直接 spawn 子 Agent
- task 描述遵循【上下文】【目标】【要求】，尽量短；大输出写 `__STATE_DIR__/shared/{task_id}.md`
- 子 Agent 开始前必须写 task-state，结束时必须输出 `---RESULT---`
- 详细状态写入和 RESULT 模板以 `__SKILL_ROOT__/lib/spawn-template.md` 为准
- `octoclaw_spawn.py` 负责统一生成 task-state 注册、RESULT 契约、共享文件路径和兼容参数
- 并发上限：balanced/private/auto ≤5，quality/cost ≤3；高价模型同时运行 ≤3
- 若使用 `sessions_spawn`：
  - `runtime=subagent` 时**禁止**传 `streamTo`
  - 只有 `runtime=acp` 且当前通道明确支持 ACP 会话绑定时，才允许 `streamTo`
  - Slack / 普通子任务默认按普通 `subagent` 处理，不要假设支持 ACP 回流
- 若 spawn / route / dispatch 失败：
  - 只给用户回一条简短状态，不要连续播报内部重试过程
  - 不要输出内部犹豫文本、调试思路或英语自言自语
  - 先把错误写入 `.learnings/ERRORS.md` / task-state，再决定是否回退到主会话直接执行

### 触手名字

💪鲸力手·power | 🔍梭鱼眼·scout | ✍️墨鱼手·writer | 🔧螃蟹手·fix | 🧪海胆手·test | 📊章鱼脑·analyze | 🏃飞鱼腿·runner | 🐦鸽手·feishu

### 任务分级与模型选择

- 级别：`trivial/simple/normal/hard/deep`
- 选模优先读 `__STATE_DIR__/model-policy.json`（auto 模式），否则读 `octopus-mode.json` + `octopus-model-aliases.json`
- `runner` 优先低首 token 延迟；`fix/test` 优先 coding；`analyze/power` 优先深度能力
- 用户临时要求“最强/不惜成本”可升高模型；“保密/私有”优先私有模型

### 模型降级（铁甲虾协作）

- spawn 前检查 `/tmp/ironclaw-model-guard-override.json`，必要时改用降级模型

### 任务状态（task-state.json）

- 文件：`__STATE_DIR__/task-state.json`
- 子 Agent 负责开始时写 `running`，结束时写 `done/failed`
- 最终输出必须以 `---RESULT---` 开头，否则视为未完成

### 监督与重派

- 收到 announce 后检查是否异常；升级链：低成本模型失败 → 中档 → 高档 → 通知用户
- 避免重复回复同一 announce；错误经验沉淀写回 Octopus 相关记录
<!-- /octopus:core-rules -->
OCTOPUS_RULES
    python3 - "$RULES_TMP" "$SKILL_ROOT" "$STATE_DIR" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
skill_root = sys.argv[2]
state_dir = sys.argv[3]
text = path.read_text(encoding="utf-8")
text = text.replace("__SKILL_ROOT__", skill_root)
text = text.replace("__STATE_DIR__", state_dir)
text = text.replace("__RULES_VERSION__", "v1.6.1")
path.write_text(text, encoding="utf-8")
PY
    cat "$RULES_TMP" >> "$AGENTS_FILE"
    rm -f "$RULES_TMP"

    echo "✅ octopus:core-rules 已注入（最新版）→ $AGENTS_FILE"
}

install_runtime_extension() {
    local extensions_dir="${HOME}/.openclaw/extensions"
    local source_dir="${SKILL_ROOT}/extensions/octoclaw-runtime"
    local target_dir="${extensions_dir}/octoclaw-runtime"

    if [ ! -d "$source_dir" ]; then
        echo "⚠️ 未找到 runtime extension 目录，跳过工具化接管安装"
        return
    fi

    mkdir -p "$extensions_dir"
    if [ -L "$target_dir" ] || [ -d "$target_dir" ]; then
        rm -rf "$target_dir"
    fi
    ln -s "$source_dir" "$target_dir"
    echo "✅ 已安装 runtime extension → $target_dir"
}

# 自动注入 octopus:core-rules 到 AGENTS.md（在展示安装完成之前，确保规则已就绪）
inject_agents_md
install_runtime_extension

echo ""
echo "🎉 八爪鱼安装完成！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 工作目录已创建"
echo "✅ 通知后端：$ACTIVE_NOTIFICATION_BACKEND"
if [ "${PATROL_MODE:-loop}" = "loop" ]; then
    echo "✅ 巡逻模式：零 token loop（$(_resolve_supervisor_mode)，间隔 ${PATROL_INTERVAL}s）"
    if [ "${RUNNER_ENABLED:-true}" = "true" ]; then
        echo "✅ 飞鱼腿模式：常驻 runner（$(_resolve_supervisor_mode) 托管）"
    else
        echo "ℹ️  飞鱼腿模式：已禁用"
    fi
else
    echo "✅ 巡逻模式：cron（每分钟触发，消耗 token）"
fi
echo "✅ 调度规则已注入：$AGENTS_FILE"
echo "✅ 调度模式：$MODE_LABEL"

# 读取并展示主 Agent 模型
MAIN_MODEL_DISPLAY=$(python3 -c "
import json
try:
    if '$MODE' == 'auto':
        with open('$WORKSPACE/tmp/octopus/model-policy.json') as f:
            data = json.load(f)
        print(data.get('main_model', '（未生成）'))
    elif '$MODE' == 'custom' and '$MAIN_MODEL':
        print('$MAIN_MODEL')
    else:
        print('（按当前默认 / override）')
except Exception:
    print('（未知）')
" 2>/dev/null)
echo "🤖 主 Agent 模型：$MAIN_MODEL_DISPLAY"
echo ""
echo "💬 快速上手："
echo "  • 直接说任务，八爪鱼自动调度触手并行处理"
echo "  • 说「八爪鱼状态」查看当前任务进度面板"
echo "  • 说「切换到效果优先模式」调整模型策略"
echo "  • 给触手起昵称：「把螃蟹手改名叫修复手」"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔄 最后一步：发送 /compact 让调度规则立即生效"
echo "   （不执行也可以，下次新对话自动生效）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
