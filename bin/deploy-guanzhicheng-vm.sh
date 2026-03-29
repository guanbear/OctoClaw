#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:-root@guanzhicheng.com}"
BRANCH="${BRANCH:-codex/release-v0.1.0}"
REMOTE_REPO_URL="${REMOTE_REPO_URL:-https://github.com/guanbear/OctoClaw.git}"
REMOTE_REPO_DIR="${REMOTE_REPO_DIR:-/workspace/openclaw/repos/octoclaw}"
REMOTE_SKILL_DIR="${REMOTE_SKILL_DIR:-/workspace/openclaw/skills/octopus}"
REMOTE_EXTENSION_DIR="${REMOTE_EXTENSION_DIR:-/root/.openclaw/extensions/octoclaw-runtime}"

ssh "$VM_HOST" \
  BRANCH="$BRANCH" \
  REMOTE_REPO_URL="$REMOTE_REPO_URL" \
  REMOTE_REPO_DIR="$REMOTE_REPO_DIR" \
  REMOTE_SKILL_DIR="$REMOTE_SKILL_DIR" \
  REMOTE_EXTENSION_DIR="$REMOTE_EXTENSION_DIR" \
  'bash -s' <<'REMOTE'
set -euo pipefail

stamp="$(date +%Y%m%d-%H%M%S)"
stop_service() {
  service_name="$1"
  systemctl stop "$service_name" || true
  for _ in $(seq 1 20); do
    state="$(systemctl is-active "$service_name" 2>/dev/null || true)"
    if [ "$state" = "inactive" ] || [ "$state" = "failed" ]; then
      return 0
    fi
    sleep 1
  done
  systemctl kill --kill-who=all "$service_name" || true
  for _ in $(seq 1 10); do
    state="$(systemctl is-active "$service_name" 2>/dev/null || true)"
    if [ "$state" = "inactive" ] || [ "$state" = "failed" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

mkdir -p "$(dirname "$REMOTE_REPO_DIR")" "$(dirname "$REMOTE_SKILL_DIR")" "$(dirname "$REMOTE_EXTENSION_DIR")"

if [ ! -d "$REMOTE_REPO_DIR/.git" ] && [ -d "$REMOTE_SKILL_DIR/.git" ]; then
  mv "$REMOTE_SKILL_DIR" "$REMOTE_REPO_DIR"
fi

if [ ! -d "$REMOTE_REPO_DIR/.git" ]; then
  git clone --branch "$BRANCH" --single-branch "$REMOTE_REPO_URL" "$REMOTE_REPO_DIR"
else
  git -C "$REMOTE_REPO_DIR" fetch origin "$BRANCH"
  git -C "$REMOTE_REPO_DIR" checkout "$BRANCH"
  git -C "$REMOTE_REPO_DIR" pull --ff-only origin "$BRANCH"
fi

if mountpoint -q "$REMOTE_EXTENSION_DIR"; then
  umount "$REMOTE_EXTENSION_DIR"
fi

if [ -L "$REMOTE_EXTENSION_DIR" ]; then
  rm -f "$REMOTE_EXTENSION_DIR"
fi

if [ -d "$REMOTE_SKILL_DIR/.git" ]; then
  mv "$REMOTE_SKILL_DIR" "${REMOTE_SKILL_DIR}.runtime-backup-${stamp}"
fi

mkdir -p "$REMOTE_SKILL_DIR" "$REMOTE_EXTENSION_DIR"
rm -rf "$REMOTE_SKILL_DIR/.git" "$REMOTE_EXTENSION_DIR/.git"

stop_service openclaw.service
stop_service octoclaw-runner.service
stop_service octoclaw-patrol.service

rsync -a --delete \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.DS_Store' \
  --exclude '__pycache__' \
  "$REMOTE_REPO_DIR"/ "$REMOTE_SKILL_DIR"/

rsync -a --delete \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '__pycache__' \
  "$REMOTE_REPO_DIR/extensions/octoclaw-runtime"/ "$REMOTE_EXTENSION_DIR"/

systemctl start openclaw.service
systemctl start octoclaw-runner.service
systemctl start octoclaw-patrol.service

echo "repo_commit=$(git -C "$REMOTE_REPO_DIR" rev-parse HEAD)"
echo "repo_branch=$(git -C "$REMOTE_REPO_DIR" branch --show-current)"
echo "services=$(systemctl is-active openclaw.service octoclaw-runner.service octoclaw-patrol.service | paste -sd, -)"
REMOTE
