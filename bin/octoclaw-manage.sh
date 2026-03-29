#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_URL="https://github.com/guanbear/OctoClaw.git"
DEFAULT_REF="codex/release-v0.1.0"
WORKSPACE="${WORKSPACE:-/workspace}"
CHECKOUT_DIR="${CHECKOUT_DIR:-$WORKSPACE/openclaw/repos/octoclaw}"
INSTALL_DIR="${INSTALL_DIR:-$WORKSPACE/openclaw/skills/octopus}"
EXTENSION_INSTALL_MODE="${EXTENSION_INSTALL_MODE:-rsync}"
INSTALL_MODE="${INSTALL_MODE:-auto}"
SOURCE_KIND="${SOURCE_KIND:-github}"
REPO_URL="${REPO_URL:-}"
REF="${REF:-$DEFAULT_REF}"
MAIN_MODEL="${MAIN_MODEL:-}"
SKIP_CRON="${SKIP_CRON:-false}"
SKIP_MAIN_MODEL_SWITCH="${SKIP_MAIN_MODEL_SWITCH:-false}"
CUSTOM_MODEL_OVERRIDES=()

print_usage() {
    cat <<'EOF'
Usage:
  bash bin/octoclaw-manage.sh <install|update|check|status> [options]

Options:
  --source github|gitlab|git|clawhub
  --repo-url URL
  --ref REF
  --checkout-dir PATH
  --install-dir PATH
  --mode auto|custom
  --main-model MODEL
  --custom-model KEY=MODEL
  --extension-install-mode rsync|copy|symlink
  --skip-cron
  --skip-main-model-switch
  -h, --help

Notes:
  - github is the default source and uses the official OctoClaw repo URL.
  - gitlab/git require --repo-url.
  - clawhub is reserved for future support and is not implemented yet.
EOF
}

resolve_repo_url() {
    case "$SOURCE_KIND" in
        github)
            printf '%s\n' "${REPO_URL:-$DEFAULT_REPO_URL}"
            ;;
        gitlab|git)
            if [ -z "$REPO_URL" ]; then
                echo "❌ --repo-url is required for source=$SOURCE_KIND" >&2
                exit 1
            fi
            printf '%s\n' "$REPO_URL"
            ;;
        clawhub)
            echo "❌ clawhub support is not implemented yet; use --source git with a repository URL for now" >&2
            exit 2
            ;;
        *)
            echo "❌ unsupported source: $SOURCE_KIND" >&2
            exit 1
            ;;
    esac
}

resolve_remote_commit() {
    local repo_url="$1"
    local ref="$2"
    local remote_line
    remote_line="$(git ls-remote "$repo_url" "refs/heads/$ref" "refs/tags/$ref" "$ref" | head -n 1 || true)"
    printf '%s\n' "${remote_line%%[[:space:]]*}"
}

ensure_checkout() {
    local repo_url="$1"
    mkdir -p "$(dirname "$CHECKOUT_DIR")"
    if [ ! -d "$CHECKOUT_DIR/.git" ]; then
        git clone --branch "$REF" --single-branch "$repo_url" "$CHECKOUT_DIR"
        return
    fi
    if git -C "$CHECKOUT_DIR" remote get-url origin >/dev/null 2>&1; then
        git -C "$CHECKOUT_DIR" remote set-url origin "$repo_url"
    else
        git -C "$CHECKOUT_DIR" remote add origin "$repo_url"
    fi
    git -C "$CHECKOUT_DIR" fetch origin "$REF"
    git -C "$CHECKOUT_DIR" checkout "$REF"
    git -C "$CHECKOUT_DIR" pull --ff-only origin "$REF"
}

sync_checkout_to_install_dir() {
    if [ "$CHECKOUT_DIR" = "$INSTALL_DIR" ]; then
        return
    fi
    mkdir -p "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR/.git"
    rsync -a --delete \
        --exclude '.git' \
        --exclude '.github' \
        --exclude '.DS_Store' \
        --exclude '__pycache__' \
        "$CHECKOUT_DIR"/ "$INSTALL_DIR"/
}

write_source_manifest() {
    local repo_url="$1"
    local commit="$2"
    local manifest_path="$INSTALL_DIR/.octoclaw-source.json"
    python3 - "$manifest_path" "$SOURCE_KIND" "$repo_url" "$REF" "$CHECKOUT_DIR" "$INSTALL_DIR" "$commit" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, source_kind, repo_url, ref, checkout_dir, install_dir, commit = sys.argv[1:8]
payload = {
    "source_kind": source_kind,
    "repo_url": repo_url,
    "ref": ref,
    "checkout_dir": checkout_dir,
    "install_dir": install_dir,
    "commit": commit,
    "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=2)
PY
}

run_reconcile() {
    local args=(
        reconcile
        --non-interactive
        --mode "$INSTALL_MODE"
        --extension-install-mode "$EXTENSION_INSTALL_MODE"
    )
    if [ -n "$MAIN_MODEL" ]; then
        args+=(--main-model "$MAIN_MODEL")
    fi
    if [ "$SKIP_CRON" = "true" ]; then
        args+=(--skip-cron)
    fi
    if [ "$SKIP_MAIN_MODEL_SWITCH" = "true" ]; then
        args+=(--skip-main-model-switch)
    fi
    for override in "${CUSTOM_MODEL_OVERRIDES[@]-}"; do
        args+=(--custom-model "$override")
    done
    bash "$INSTALL_DIR/install.sh" "${args[@]}"
}

COMMAND="${1:-help}"
if [ $# -gt 0 ]; then
    shift
fi

while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            SOURCE_KIND="${2:-github}"
            shift 2
            ;;
        --repo-url)
            REPO_URL="${2:-}"
            shift 2
            ;;
        --ref)
            REF="${2:-$DEFAULT_REF}"
            shift 2
            ;;
        --checkout-dir)
            CHECKOUT_DIR="${2:-$CHECKOUT_DIR}"
            shift 2
            ;;
        --install-dir)
            INSTALL_DIR="${2:-$INSTALL_DIR}"
            shift 2
            ;;
        --mode)
            INSTALL_MODE="${2:-auto}"
            shift 2
            ;;
        --main-model)
            MAIN_MODEL="${2:-}"
            shift 2
            ;;
        --custom-model)
            CUSTOM_MODEL_OVERRIDES+=("${2:-}")
            shift 2
            ;;
        --extension-install-mode)
            EXTENSION_INSTALL_MODE="${2:-rsync}"
            shift 2
            ;;
        --skip-cron)
            SKIP_CRON="true"
            shift
            ;;
        --skip-main-model-switch)
            SKIP_MAIN_MODEL_SWITCH="true"
            shift
            ;;
        -h|--help|help)
            print_usage
            exit 0
            ;;
        *)
            echo "❌ unknown option: $1" >&2
            print_usage >&2
            exit 1
            ;;
    esac
done

REPO_URL="$(resolve_repo_url)"

case "$COMMAND" in
    install|update)
        ensure_checkout "$REPO_URL"
        sync_checkout_to_install_dir
        write_source_manifest "$REPO_URL" "$(git -C "$CHECKOUT_DIR" rev-parse HEAD)"
        run_reconcile
        ;;
    check)
        local_commit=""
        if [ -d "$CHECKOUT_DIR/.git" ]; then
            local_commit="$(git -C "$CHECKOUT_DIR" rev-parse HEAD)"
        elif [ -f "$INSTALL_DIR/.octoclaw-source.json" ]; then
            local_commit="$(python3 -c "import json; print(json.load(open('$INSTALL_DIR/.octoclaw-source.json')).get('commit',''))" 2>/dev/null || true)"
        fi
        remote_commit="$(resolve_remote_commit "$REPO_URL" "$REF")"
        echo "source=$SOURCE_KIND"
        echo "repo_url=$REPO_URL"
        echo "ref=$REF"
        echo "local_commit=${local_commit:-unknown}"
        echo "remote_commit=${remote_commit:-unknown}"
        if [ -n "$remote_commit" ] && [ -n "$local_commit" ] && [ "$remote_commit" = "$local_commit" ]; then
            echo "update_available=false"
        else
            echo "update_available=true"
        fi
        ;;
    status)
        echo "source=$SOURCE_KIND"
        echo "repo_url=$REPO_URL"
        echo "ref=$REF"
        echo "checkout_dir=$CHECKOUT_DIR"
        echo "install_dir=$INSTALL_DIR"
        if [ -d "$CHECKOUT_DIR/.git" ]; then
            echo "checkout_commit=$(git -C "$CHECKOUT_DIR" rev-parse HEAD)"
            echo "checkout_branch=$(git -C "$CHECKOUT_DIR" branch --show-current)"
        fi
        if [ -f "$INSTALL_DIR/.octoclaw-source.json" ]; then
            echo "manifest=$INSTALL_DIR/.octoclaw-source.json"
        fi
        ;;
    *)
        print_usage >&2
        exit 1
        ;;
esac
