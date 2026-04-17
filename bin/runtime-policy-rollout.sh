#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
WORKSPACE="${WORKSPACE:-${HOME}/.openclaw/workspace}"
OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-${OPENCLAW_HOME}/openclaw.json}"
CONFIG_FILE="${OCTOCLAW_CONFIG_FILE:-${WORKSPACE}/tmp/octoclaw-config.json}"
PRESET="${RUNTIME_POLICY_PRESET:-conservative}"
EXT_SOURCE="${REPO_ROOT}/extensions/octoclaw-runtime"
EXT_TARGET="${OPENCLAW_HOME}/extensions/octoclaw-runtime"
PACKAGES_SOURCE="${REPO_ROOT}/packages"
PACKAGES_TARGET="${OPENCLAW_HOME}/packages"
DRY_RUN=false
LINK_EXTENSION=true
BACKUP_SUFFIX="$(date +%Y%m%d-%H%M%S)"
EXTRA_ARGS=()

usage() {
    cat <<'EOF'
Usage:
  bin/runtime-policy-rollout.sh install [options]
  bin/runtime-policy-rollout.sh enable [options]
  bin/runtime-policy-rollout.sh disable [options]
  bin/runtime-policy-rollout.sh uninstall [options]
  bin/runtime-policy-rollout.sh show [options]
  bin/runtime-policy-rollout.sh check [options]
  bin/runtime-policy-rollout.sh recommend [options]

Options:
  --preset conservative|guided|enforced
  --workspace PATH
  --openclaw-home PATH
  --openclaw-config PATH
  --config PATH
  --events PATH
  --format text|json
  --phase conservative|guided
  --dry-run
  --no-link-extension
  --enabled BOOL
  --hard-runner-only BOOL
  --route-hint-required BOOL
  --replay-logging BOOL
  --direct-model-override BOOL
  --delegation-enforcement BOOL
  --sticky-lane BOOL
  --hook-before-model-resolve BOOL
  --hook-before-prompt-build BOOL
  --hook-before-tool-call BOOL
  --hook-agent-end BOOL
  --sticky-ttl-minutes N
  --apply-on-followup-only BOOL
  --route-language-packs zh,en[,ja,...]
EOF
}

log() {
    printf '%s\n' "$*"
}

run_cmd() {
    if [ "$DRY_RUN" = true ]; then
        printf 'DRY-RUN:'
        printf ' %q' "$@"
        printf '\n'
        return 0
    fi
    "$@"
}

backup_existing_target() {
    local target="$1"
    local backup
    if [ "$(dirname "$target")" = "${OPENCLAW_HOME}/extensions" ]; then
        local backup_dir="${OPENCLAW_HOME}/extensions-backups"
        run_cmd mkdir -p "$backup_dir"
        backup="${backup_dir}/$(basename "$target").bak.${BACKUP_SUFFIX}"
    else
        backup="${target}.bak.${BACKUP_SUFFIX}"
    fi
    if [ -L "$target" ] || [ -f "$target" ]; then
        run_cmd mv "$target" "$backup"
        log "✅ 已备份现有扩展 → $backup"
    elif [ -d "$target" ]; then
        run_cmd mv "$target" "$backup"
        log "✅ 已备份现有扩展目录 → $backup"
    fi
}

install_extension() {
    [ "$LINK_EXTENSION" = true ] || return 0
    if [ ! -d "$EXT_SOURCE" ]; then
        log "⚠️ 未找到 runtime extension 源目录：$EXT_SOURCE"
        return 1
    fi
    run_cmd mkdir -p "${OPENCLAW_HOME}/extensions"
    if [ -e "$EXT_TARGET" ] || [ -L "$EXT_TARGET" ]; then
        backup_existing_target "$EXT_TARGET"
    fi
    run_cmd cp -R "$EXT_SOURCE" "$EXT_TARGET"
    log "✅ 已安装 runtime extension 目录 → $EXT_TARGET"
    if [ -d "$PACKAGES_SOURCE" ]; then
        run_cmd mkdir -p "$PACKAGES_TARGET"
        run_cmd rsync -a --delete \
            --exclude '.git' \
            --exclude '.DS_Store' \
            --exclude '__pycache__' \
            --exclude 'node_modules' \
            "$PACKAGES_SOURCE/" "$PACKAGES_TARGET/"
        log "✅ 已安装共享 packages → $PACKAGES_TARGET"
    else
        log "⚠️ 未找到共享 packages 源目录：$PACKAGES_SOURCE"
    fi
}

remove_extension() {
    if [ -L "$EXT_TARGET" ] || [ -d "$EXT_TARGET" ] || [ -f "$EXT_TARGET" ]; then
        backup_existing_target "$EXT_TARGET"
    else
        log "ℹ️  runtime extension 未安装，跳过"
    fi
}

merge_config() {
    local enabled_arg=()
    if [ "$1" != "__keep__" ]; then
        enabled_arg=(--enabled "$1")
    fi
    local cmd=(
        "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" merge-config
        --config "$CONFIG_FILE"
        --preset "$PRESET"
    )
    if [ ${#enabled_arg[@]} -gt 0 ]; then
        cmd+=("${enabled_arg[@]}")
    fi
    if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
        cmd+=("${EXTRA_ARGS[@]}")
    fi
    run_cmd mkdir -p "$(dirname "$CONFIG_FILE")"
    run_cmd "${cmd[@]}"
}

merge_openclaw_plugin_config() {
    run_cmd mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        run_cmd printf '%s\n' '{}' > "$OPENCLAW_CONFIG"
    fi
    run_cmd "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" merge-openclaw-plugin --config "$OPENCLAW_CONFIG" --octoclaw-root "$REPO_ROOT"
}

show_config() {
    run_cmd "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" show-config --config "$CONFIG_FILE"
}

check_replay() {
    local cmd=(
        "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" check
        --config "$CONFIG_FILE"
    )
    if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
        cmd+=("${EXTRA_ARGS[@]}")
    fi
    run_cmd "${cmd[@]}"
}

recommend_preset() {
    local cmd=(
        "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" recommend
        --config "$CONFIG_FILE"
    )
    if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
        cmd+=("${EXTRA_ARGS[@]}")
    fi
    run_cmd "${cmd[@]}"
}

cleanup_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        log "ℹ️  未找到配置文件，跳过"
        return 0
    fi
    local backup="${CONFIG_FILE}.bak.${BACKUP_SUFFIX}"
    run_cmd cp "$CONFIG_FILE" "$backup"
    log "✅ 已备份配置 → $backup"
    run_cmd "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" cleanup-config --config "$CONFIG_FILE"
}

cleanup_openclaw_plugin_config() {
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        log "ℹ️  未找到 OpenClaw 配置文件，跳过插件配置清理"
        return 0
    fi
    local backup="${OPENCLAW_CONFIG}.bak.${BACKUP_SUFFIX}"
    run_cmd cp "$OPENCLAW_CONFIG" "$backup"
    log "✅ 已备份 OpenClaw 配置 → $backup"
    run_cmd "$PYTHON_BIN" "${REPO_ROOT}/lib/runtime_policy_rollout.py" cleanup-openclaw-plugin --config "$OPENCLAW_CONFIG"
}

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
    usage
    exit 1
fi
shift

while [ $# -gt 0 ]; do
    case "$1" in
        --preset)
            PRESET="$2"
            shift 2
            ;;
        --workspace)
            WORKSPACE="$2"
            CONFIG_FILE="${WORKSPACE}/tmp/octoclaw-config.json"
            shift 2
            ;;
        --openclaw-home)
            OPENCLAW_HOME="$2"
            EXT_TARGET="${OPENCLAW_HOME}/extensions/octoclaw-runtime"
            shift 2
            ;;
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --events|--format|--phase)
            EXTRA_ARGS+=("$1" "$2")
            shift 2
            ;;
        --openclaw-config)
            OPENCLAW_CONFIG="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --no-link-extension)
            LINK_EXTENSION=false
            shift
            ;;
        --enabled|--hard-runner-only|--route-hint-required|--replay-logging|--direct-model-override|--delegation-enforcement|--sticky-lane|--hook-before-model-resolve|--hook-before-prompt-build|--hook-before-tool-call|--hook-agent-end|--sticky-ttl-minutes|--apply-on-followup-only|--route-language-packs)
            EXTRA_ARGS+=("$1" "$2")
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

case "$COMMAND" in
    install)
        install_extension
        merge_openclaw_plugin_config
        merge_config true
        ;;
    enable)
        merge_openclaw_plugin_config
        merge_config true
        ;;
    disable)
        EXTRA_ARGS+=(--route-hint-required false --direct-model-override false --delegation-enforcement false --hook-before-model-resolve false --hook-before-tool-call false)
        merge_config false
        ;;
    uninstall)
        remove_extension
        cleanup_openclaw_plugin_config
        cleanup_config
        ;;
    show)
        show_config
        ;;
    check)
        check_replay
        ;;
    recommend)
        recommend_preset
        ;;
    *)
        log "Unknown command: $COMMAND"
        usage
        exit 1
        ;;
esac
