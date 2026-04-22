#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT_DEFAULT="/Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw"
OPENCLAW_HOME_DEFAULT="/Users/guanbear/.openclaw"
BRANCH_DEFAULT="release/0.3.0-ts-rebuild"
PATH_PREFIX_DEFAULT="/Users/guanbear/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

repo_root="${OPENCLAW_REPO_ROOT:-$REPO_ROOT_DEFAULT}"
openclaw_home="${OPENCLAW_HOME:-$OPENCLAW_HOME_DEFAULT}"
branch="${OPENCLAW_BRANCH:-$BRANCH_DEFAULT}"
path_prefix="${OPENCLAW_UPDATE_PATH_PREFIX:-$PATH_PREFIX_DEFAULT}"

skip_install=0
skip_build=0
skip_pull=0
restart_flag="--restart"

usage() {
  cat <<EOF
Usage:
  bash bin/update-openclaw-macmini.sh [options]

Options:
  --repo-root PATH      Override OctoClaw repo root
  --openclaw-home PATH  Override OpenClaw home
  --branch NAME         Branch to pull before deploy
  --skip-install        Skip 'pnpm install'
  --skip-build          Skip 'pnpm -r run build' and pass --skip-build to deploy
  --skip-pull           Skip 'git fetch/pull' and deploy current local checkout
  --no-restart          Deploy without restarting gateway/node
  -h, --help            Show this help

Environment overrides:
  OPENCLAW_REPO_ROOT
  OPENCLAW_HOME
  OPENCLAW_BRANCH
  OPENCLAW_UPDATE_PATH_PREFIX
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="$2"
      shift 2
      ;;
    --openclaw-home)
      openclaw_home="$2"
      shift 2
      ;;
    --branch)
      branch="$2"
      shift 2
      ;;
    --skip-install)
      skip_install=1
      shift
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --skip-pull)
      skip_pull=1
      shift
      ;;
    --no-restart)
      restart_flag=""
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

export PATH="${path_prefix}:${PATH:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd pnpm

if [[ ! -d "$repo_root/.git" ]]; then
  printf 'Repo root is not a git checkout: %s\n' "$repo_root" >&2
  exit 1
fi

cd "$repo_root"

printf '\n==> Repo\n'
printf 'repo_root=%s\n' "$repo_root"
printf 'openclaw_home=%s\n' "$openclaw_home"
printf 'branch=%s\n' "$branch"

printf '\n==> Pull latest\n'
if [[ "$skip_pull" -eq 1 ]]; then
  printf 'skip_pull=true; using current local checkout\n'
else
  if [[ -n "$(git status --porcelain)" ]]; then
    printf 'Working tree is dirty; refusing to pull.\n' >&2
    printf 'Commit/stash your changes first, or rerun with --skip-pull to deploy current checkout.\n' >&2
    exit 1
  fi

  git fetch origin "$branch"
  git checkout "$branch"
  git pull --ff-only origin "$branch"
fi

if [[ "$skip_install" -eq 0 ]]; then
  printf '\n==> Install dependencies\n'
  pnpm install
fi

if [[ "$skip_build" -eq 0 ]]; then
  printf '\n==> Build workspace\n'
  pnpm -r run build
fi

printf '\n==> Deploy and restart\n'
deploy_args=(
  tools/install/dist/index.js
  deploy
  --skip-build
  --openclaw-home "$openclaw_home"
  --octoclaw-root "$repo_root"
)

if [[ -n "$restart_flag" ]]; then
  deploy_args+=("$restart_flag")
fi

node "${deploy_args[@]}"

printf '\n==> Managed status\n'
node tools/manage/dist/index.js status --openclaw-home "$openclaw_home"
