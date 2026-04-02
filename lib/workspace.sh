#!/bin/bash

resolve_octoclaw_workspace() {
  local script_dir="${1:-}"
  if [[ -n "${WORKSPACE:-}" ]]; then
    printf '%s\n' "${WORKSPACE}"
    return 0
  fi
  if [[ -n "${OCTOCLAW_WORKSPACE:-}" ]]; then
    printf '%s\n' "${OCTOCLAW_WORKSPACE}"
    return 0
  fi
  if [[ -n "$script_dir" ]]; then
    local skill_root
    skill_root="$(cd "$script_dir/.." && pwd)"
    case "$skill_root" in
      */openclaw/skills/octopus)
        printf '%s\n' "${skill_root%/openclaw/skills/octopus}"
        return 0
        ;;
      */skills/octopus)
        printf '%s\n' "${skill_root%/skills/octopus}"
        return 0
        ;;
    esac
  fi
  if [[ -d "$HOME/.openclaw/workspace" ]]; then
    printf '%s\n' "$HOME/.openclaw/workspace"
    return 0
  fi
  printf '/workspace\n'
}

resolve_octoclaw_python() {
  local candidates=(
    "${OCTOCLAW_PYTHON_BIN:-}"
    "/opt/homebrew/bin/python3"
    "/usr/local/bin/python3"
    "$(command -v python3 2>/dev/null || true)"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'python3\n'
}
