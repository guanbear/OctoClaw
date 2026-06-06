# OctoClaw AI Install Runbook

Audience: an AI coding agent (Claude Code, Codex, Cursor, an OpenClaw agent,
etc.) tasked with installing OctoClaw into a user's OpenClaw environment.

Goal: get OctoClaw installed, deployed, enabled, and verified, with zero
guesswork. Every step has a command and an explicit success check. If a check
fails, stop and report — do not improvise around a failed prerequisite.

> Human operators: this runbook is also valid for you. Run the commands in
> order. The thin interactive wizard (`octoclawctl init`) only asks for things
> a machine cannot decide: secrets, which IM channel, and which judge model.

---

## 0. What OctoClaw is (one paragraph)

OctoClaw is an **OpenClaw extension plugin**, not a standalone app. It installs
into an existing OpenClaw home (`~/.openclaw` by default) as packages under
`~/.openclaw/packages/` and an extension under `~/.openclaw/extensions/`. It
does not run its own server. If OpenClaw is not installed and configured first,
nothing here will work.

---

## 1. Preconditions (check before doing anything)

Run each command. Each must pass before you continue.

```bash
# 1.1 OpenClaw present and recent enough
openclaw --version
# PASS: prints a version >= 2026.5.12
# FAIL: command not found → STOP. Tell the user to install OpenClaw first:
#       https://docs.openclaw.ai

# 1.2 Node.js >= 22
node --version
# PASS: v22.x or higher
# FAIL: STOP. Tell the user to install Node 22+.

# 1.3 OpenClaw home exists
ls "${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
# PASS: file exists
# FAIL: OpenClaw is installed but never configured. Tell the user to run
#       `openclaw onboard` first, then return here.

# 1.4 At least one IM channel configured (production) OR accept local-only
openclaw status --json | grep -i channel
# Informational. OctoClaw is most useful with Slack or Feishu connected, but
# can be installed without one for local testing.
```

Decide the install method based on **whether the user has the repo source**:

- They have a git checkout of `OctoClaw/` → use **Method A (from source)**. This
  is the only fully supported method today (the npm CLI cannot self-deploy yet;
  see §6).
- They only want the published CLI for status/doctor commands → use
  **Method B (npm CLI, limited)**.

---

## 2. Method A — install from source (recommended, full feature)

This is the supported path. The deploy step needs `git`, `pnpm`, `rsync`, and
`ln`, so it works on macOS and Linux. On Windows, use WSL.

```bash
# 2.1 Get the source (skip if the user already has it)
git clone https://github.com/guanbear/OctoClaw.git
cd OctoClaw
git checkout v0.6.0          # use the latest release tag, not a branch

# 2.2 Install deps and build
pnpm install --frozen-lockfile
pnpm build
# PASS: build completes with no error.
# Check: test -d tools/octoclawctl/dist && echo "cli built"

# 2.3 First-run wizard (interactive — asks only for user decisions)
node tools/octoclawctl/dist/cli.js init
# It will ask: openclaw home, judge model (local Ollama Qwen3 0.6B OR remote
# OpenAI-compatible), IM channel + token, then run a verification pass.
# Non-interactive variant for headless installs:
#   node tools/octoclawctl/dist/cli.js init --non-interactive --auto-remote-judge

# 2.4 Deploy packages + extension into the OpenClaw home
node tools/octoclawctl/dist/cli.js deploy --restart \
  --octoclaw-root "$(pwd)" \
  --openclaw-home "${OPENCLAW_HOME:-$HOME/.openclaw}"
# PASS: command exits 0. It rsyncs dist/ into ~/.openclaw/{packages,extensions},
#       symlinks the @octoclaw/* deps, and writes the plugin entry.

# 2.5 Enable the plugin
node tools/octoclawctl/dist/cli.js enable

# 2.6 Verify
node tools/octoclawctl/dist/cli.js doctor --format json
# PASS: every check is "pass" or "warn". Any "fail" → read its hint and fix,
#       then re-run doctor. Do not proceed past a fail.

node tools/octoclawctl/dist/cli.js status
# PASS: prints a status projection without error.
```

### 2.7 Success criteria for Method A

All of these must be true:

- [ ] `doctor` reports no `fail`
- [ ] `~/.openclaw/extensions/octoclaw-runtime/dist/extension-entry.js` exists
- [ ] `~/.openclaw/openclaw.json` has `plugins.entries.octoclaw-runtime.enabled = true`
- [ ] `status` runs without throwing
- [ ] One real message to the configured IM channel gets an ACK

---

## 3. Method B — published npm CLI (limited: status/doctor only)

> Current limitation (v0.6.0): the published `@octoclaw/cli` package lists its
> `@octoclaw/*` runtime packages as optional peer deps and does not bundle the
> deployable `dist/`. So `install` / `deploy` from the npm package **cannot
> place the runtime into OpenClaw**. Use Method B only for the read-only
> operator commands (`doctor`, `status`, `details`, `queue`, `timeline`).
> Full npm-only deploy is tracked in §6.

```bash
npm install -g @octoclaw/cli
octoclawctl doctor          # works: environment checks
octoclawctl status          # works once the runtime is deployed via Method A
```

If a user expects `npm install -g @octoclaw/cli` to fully install OctoClaw,
tell them that is not yet supported and point them to Method A.

---

## 4. Judge model setup (required for routing)

OctoClaw routes with a small "judge" model. Pick one:

### Option 1 — local, free (recommended)

```bash
# Requires Ollama (https://ollama.com)
ollama pull qwen3:0.6b
# Then in `octoclawctl init`, choose "local Ollama" and model "qwen3:0.6b".
```

### Option 2 — remote, cheap

In `octoclawctl init`, choose "remote OpenAI-compatible" and a small model such
as `gpt-5.4-mini`. The judge requires: p95 < 1s, can disable thinking, JSON
parse > 99%, cost < $0.0001/call.

Verify the judge after install:

```bash
node tools/octoclawctl/dist/cli.js router judge test "帮我看下这个函数"
# PASS: prints { route, confidence, complexity } as valid JSON.
```

---

## 5. Common failure modes and fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `openclaw: command not found` | OpenClaw not installed | Install OpenClaw first; this is a prerequisite, not part of OctoClaw |
| `deploy` fails on `rsync`/`ln` | Windows shell | Use WSL, or macOS/Linux |
| `doctor` shows judge `fail` | No judge configured / Ollama not running | `ollama serve` + `ollama pull qwen3:0.6b`, or pick remote judge in `init` |
| Plugin not loading after deploy | `enabled` not set | `octoclawctl enable`, then restart OpenClaw gateway |
| `status` empty | No tasks yet | Expected on a fresh install; send one IM message to confirm |
| Version mismatch warnings | Installed an old tag | `git checkout v0.6.0 && pnpm build && octoclawctl deploy --restart` |

---

## 6. Known gaps (read before promising npm-only install)

These are tracked for a future release. Do not tell a user they work today:

1. **npm-only deploy**: the published CLI cannot deploy the runtime; source
   checkout is required (§3).
2. **Windows native**: deploy uses `rsync`/`ln`; Windows needs WSL.
3. **Offline install**: deploy runs `pnpm install`, so a network connection is
   required during install.

---

## 7. Uninstall

```bash
node tools/octoclawctl/dist/cli.js disable
node tools/octoclawctl/dist/cli.js uninstall \
  --openclaw-home "${OPENCLAW_HOME:-$HOME/.openclaw}"
# Removes ~/.openclaw/{extensions,packages}/octoclaw-* and the plugin entry.
# Does not touch your OpenClaw config beyond removing the octoclaw-runtime entry.
```

---

## 8. Quick reference (after install)

```bash
octoclawctl status                  # current projection
octoclawctl doctor                  # release readiness
octoclawctl details <task-id>       # per-task detail
octoclawctl queue                   # running / queued
octoclawctl timeline --task-id <id> # step-by-step trace
octoclawctl health --model          # per-model health / cooldown
octoclawctl router judge test "..." # verify judge output
octoclawctl router model-intel refresh
```
