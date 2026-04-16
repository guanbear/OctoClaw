#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
MANAGED_WORKSPACE="${WORKSPACE:-${OPENCLAW_HOME}/workspace}"
INSTALL_DIR="${INSTALL_DIR:-${MANAGED_WORKSPACE}/openclaw/skills/octopus}"
CHECKOUT_DIR="${CHECKOUT_DIR:-${MANAGED_WORKSPACE}/openclaw/repos/octoclaw}"
EXTENSION_DIR="${OPENCLAW_HOME}/extensions/octoclaw-runtime"
DISABLED_EXTENSION_DIR="${OPENCLAW_HOME}/extensions-disabled/octoclaw-runtime"
BACKUP_ROOT="${OPENCLAW_HOME}/backups/octoclaw-macmini-ops"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

print_usage() {
    cat <<'EOF'
Usage:
  bash bin/octoclaw-macmini-ops.sh <command>

Commands:
  deploy            Cleanly deploy current working tree into the managed local install
  update            Alias of deploy
  uninstall-clean   Stop runtime, remove managed install, extension, checkout, and runtime state
  start             Start gateway and runner runtime via installed octoclawctl
  stop              Stop gateway and runner runtime via installed octoclawctl
  restart           Restart gateway and runner runtime via installed octoclawctl
  status            Show managed install paths and runtime status

Environment overrides:
  OPENCLAW_HOME     Default: ~/.openclaw
  WORKSPACE         Default: ~/.openclaw/workspace
  INSTALL_DIR       Default: ~/.openclaw/workspace/openclaw/skills/octopus
  CHECKOUT_DIR      Default: ~/.openclaw/workspace/openclaw/repos/octoclaw
EOF
}

log() {
    printf '%s\n' "$*"
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "ERROR: required command not found: $1" >&2
        exit 1
    fi
}

managed_ctl() {
    if [ ! -x "$INSTALL_DIR/bin/octoclawctl.sh" ]; then
        log "ERROR: managed octoclawctl not found: $INSTALL_DIR/bin/octoclawctl.sh" >&2
        exit 1
    fi
    WORKSPACE="$MANAGED_WORKSPACE" bash "$INSTALL_DIR/bin/octoclawctl.sh" "$@"
}

backup_path_for() {
    local target="$1"
    local label="$2"
    if [ ! -e "$target" ]; then
        return 0
    fi
    mkdir -p "$BACKUP_ROOT"
    local dest="$BACKUP_ROOT/${label}-${TIMESTAMP}"
    mv "$target" "$dest"
    log "backup: $target -> $dest"
}

sync_current_tree() {
    require_cmd rsync
    mkdir -p "$INSTALL_DIR"
    rsync -a --delete \
        --exclude '.git' \
        --exclude '.github' \
        --exclude '.DS_Store' \
        --exclude '__pycache__' \
        --exclude 'node_modules' \
        --exclude 'tmp' \
        "$SOURCE_SKILL_ROOT/" "$INSTALL_DIR/"
    log "synced source tree -> $INSTALL_DIR"
}

sync_extension() {
    mkdir -p "${OPENCLAW_HOME}/extensions"
    rsync -a --delete \
        --exclude '.git' \
        --exclude '.DS_Store' \
        --exclude '__pycache__' \
        "$INSTALL_DIR/extensions/octoclaw-runtime/" "$EXTENSION_DIR/"
    log "synced extension -> $EXTENSION_DIR"
}

run_reconcile() {
    WORKSPACE="$MANAGED_WORKSPACE" bash "$INSTALL_DIR/install.sh" reconcile --non-interactive --extension-install-mode rsync
}

stop_runtime_best_effort() {
    if [ -x "$INSTALL_DIR/bin/octoclawctl.sh" ]; then
        WORKSPACE="$MANAGED_WORKSPACE" bash "$INSTALL_DIR/bin/octoclawctl.sh" down all >/dev/null 2>&1 || true
    fi
    if command -v openclaw >/dev/null 2>&1; then
        openclaw gateway stop >/dev/null 2>&1 || true
    fi
}

do_uninstall_clean() {
    log "==> stopping local OctoClaw runtime"
    stop_runtime_best_effort

    if [ -x "$INSTALL_DIR/install.sh" ]; then
        log "==> running managed uninstall hook"
        WORKSPACE="$MANAGED_WORKSPACE" bash "$INSTALL_DIR/install.sh" uninstall >/dev/null 2>&1 || true
    fi

    log "==> backing up managed install artifacts"
    backup_path_for "$INSTALL_DIR" "skill-install"
    backup_path_for "$CHECKOUT_DIR" "source-checkout"
    backup_path_for "$EXTENSION_DIR" "runtime-extension"
    backup_path_for "$DISABLED_EXTENSION_DIR" "runtime-extension-disabled"

    log "==> removing managed runtime state"
    rm -rf "$MANAGED_WORKSPACE/tmp/octopus"
    rm -rf "$MANAGED_WORKSPACE/tmp/octoclaw-mode.json"
    rm -rf "$MANAGED_WORKSPACE/tmp/octoclaw-config.json"
    log "removed runtime state under $MANAGED_WORKSPACE/tmp"
}

do_deploy() {
    log "==> clean uninstall of previous managed OctoClaw"
    do_uninstall_clean

    log "==> deploying current working tree"
    sync_current_tree
    sync_extension

    log "==> reconciling managed install"
    run_reconcile

    log "==> restarting gateway"
    managed_ctl restart openclaw >/dev/null

    log "==> final status"
    managed_ctl status
}

do_status() {
    log "source_skill_root=$SOURCE_SKILL_ROOT"
    log "managed_workspace=$MANAGED_WORKSPACE"
    log "install_dir=$INSTALL_DIR"
    log "checkout_dir=$CHECKOUT_DIR"
    log "extension_dir=$EXTENSION_DIR"
    if [ -x "$INSTALL_DIR/bin/octoclawctl.sh" ]; then
        managed_ctl status
    else
        log "managed install not present"
        if command -v openclaw >/dev/null 2>&1; then
            openclaw gateway status || true
        fi
    fi
}

COMMAND="${1:-help}"

case "$COMMAND" in
    deploy|update)
        do_deploy
        ;;
    uninstall-clean)
        do_uninstall_clean
        ;;
    start)
        managed_ctl up all
        ;;
    stop)
        managed_ctl down all
        ;;
    restart)
        managed_ctl restart all
        ;;
    status)
        do_status
        ;;
    help|-h|--help)
        print_usage
        ;;
    *)
        log "ERROR: unknown command: $COMMAND" >&2
        print_usage >&2
        exit 1
        ;;
esac
