#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$SKILL_DIR/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$LIB_DIR")"
MANAGER="$SKILL_DIR/bin/octoclaw-manage.sh"
MANIFEST_FILE="$SKILL_DIR/.octoclaw-source.json"
DEFAULT_REPO_URL="${OCTOCLAW_REPO_URL:-https://github.com/guanbear/OctoClaw.git}"
DEFAULT_REF="${OCTOCLAW_REF:-codex/release-v0.1.0}"
DEFAULT_SOURCE_KIND="${OCTOCLAW_SOURCE_KIND:-github}"
DEFAULT_CHECKOUT_DIR="${OCTOCLAW_CHECKOUT_DIR:-$WORKSPACE/openclaw/repos/octoclaw}"
AUTO_UPDATE_ON_CHECK="${OCTOCLAW_AUTO_UPDATE_ON_CHECK:-false}"

read_manifest_field() {
    local field="$1"
    python3 - "$MANIFEST_FILE" "$field" <<'PY' 2>/dev/null || true
import json
import sys

path, field = sys.argv[1:3]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data.get(field, "")
print(value if isinstance(value, str) else "")
PY
}

send_text_notice() {
    local msg="$1"
    if [ -f "$LIB_DIR/feishu-card.py" ]; then
        python3 "$LIB_DIR/feishu-card.py" send-text "$msg" 2>/dev/null || true
    fi
}

resolve_source_kind() {
    local value="${OCTOCLAW_SOURCE_KIND:-}"
    if [ -z "$value" ] && [ -f "$MANIFEST_FILE" ]; then
        value="$(read_manifest_field source_kind)"
    fi
    printf '%s\n' "${value:-$DEFAULT_SOURCE_KIND}"
}

resolve_repo_url() {
    local value="${OCTOCLAW_REPO_URL:-}"
    if [ -z "$value" ] && [ -f "$MANIFEST_FILE" ]; then
        value="$(read_manifest_field repo_url)"
    fi
    printf '%s\n' "${value:-$DEFAULT_REPO_URL}"
}

resolve_ref() {
    local value="${OCTOCLAW_REF:-}"
    if [ -z "$value" ] && [ -f "$MANIFEST_FILE" ]; then
        value="$(read_manifest_field ref)"
    fi
    printf '%s\n' "${value:-$DEFAULT_REF}"
}

resolve_checkout_dir() {
    local value="${OCTOCLAW_CHECKOUT_DIR:-}"
    if [ -z "$value" ] && [ -f "$MANIFEST_FILE" ]; then
        value="$(read_manifest_field checkout_dir)"
    fi
    printf '%s\n' "${value:-$DEFAULT_CHECKOUT_DIR}"
}

manager_args() {
    local args=(
        --source "$(resolve_source_kind)"
        --repo-url "$(resolve_repo_url)"
        --ref "$(resolve_ref)"
        --checkout-dir "$(resolve_checkout_dir)"
        --install-dir "$SKILL_DIR"
    )
    printf '%s\n' "${args[@]}"
}

run_manager() {
    local command="$1"
    shift || true
    bash "$MANAGER" "$command" \
        --source "$(resolve_source_kind)" \
        --repo-url "$(resolve_repo_url)" \
        --ref "$(resolve_ref)" \
        --checkout-dir "$(resolve_checkout_dir)" \
        --install-dir "$SKILL_DIR" \
        "$@"
}

notify_update_available() {
    local local_commit="$1"
    local remote_commit="$2"
    local ref="$3"
    local msg="🐙 OctoClaw 检测到可升级版本

本地提交：${local_commit:-unknown}
远端提交：${remote_commit:-unknown}
跟踪分支：${ref}

如需升级，可执行：
bash $SKILL_DIR/lib/auto-update.sh do_upgrade"
    echo "$msg"
    send_text_notice "$msg"
}

do_check() {
    if [ ! -x "$MANAGER" ]; then
        echo "❌ 未找到 octoclaw-manage.sh：$MANAGER" >&2
        exit 1
    fi

    local output
    output="$(run_manager check)"
    echo "$output"

    local update_available local_commit remote_commit ref
    update_available="$(printf '%s\n' "$output" | awk -F= '/^update_available=/{print $2}' | tail -n 1)"
    local_commit="$(printf '%s\n' "$output" | awk -F= '/^local_commit=/{print $2}' | tail -n 1)"
    remote_commit="$(printf '%s\n' "$output" | awk -F= '/^remote_commit=/{print $2}' | tail -n 1)"
    ref="$(printf '%s\n' "$output" | awk -F= '/^ref=/{print $2}' | tail -n 1)"

    if [ "$update_available" = "true" ]; then
        if [ "$AUTO_UPDATE_ON_CHECK" = "true" ]; then
            do_upgrade
        else
            notify_update_available "$local_commit" "$remote_commit" "$ref"
        fi
    fi
}

do_upgrade() {
    if [ ! -x "$MANAGER" ]; then
        echo "❌ 未找到 octoclaw-manage.sh：$MANAGER" >&2
        exit 1
    fi

    echo "⬇️  开始通过 octoclaw-manage.sh 更新 OctoClaw..."
    run_manager update
    send_text_notice "✅ OctoClaw 已通过新升级链完成更新。"
}

case "${1:-check}" in
    check)
        do_check
        ;;
    do_upgrade|upgrade|update)
        do_upgrade
        ;;
    *)
        echo "用法: $0 [check|do_upgrade]" >&2
        exit 1
        ;;
esac
