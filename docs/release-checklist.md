# OctoClaw Release Checklist

This checklist is the release gate for the `0.6.x` line. It is intentionally operational: every checked item should have command output, a report path, or a human smoke result attached in the release issue or tag notes.

## Release Target

- OpenClaw: `>= 2026.5.12`
- Node.js: `>= 22`
- Package: `@octoclaw/cli`
- Primary runtime: OpenClaw native TaskFlow
- Supported production IM targets for this release:
  - Slack: live-smoked
  - Feishu: supported adapter and cards; target-machine smoke required before calling a Feishu-only migration complete

## Preflight

- [ ] Confirm working tree is clean except intentional release files.
- [ ] Confirm branch and remote:

```bash
git status --short
git branch --show-current
git remote -v
```

- [ ] Confirm OpenClaw and Node versions:

```bash
openclaw --version
node --version
```

- [ ] Confirm package metadata:

```bash
pnpm --filter @octoclaw/cli pack --pack-destination /tmp/octoclaw-pack
tar -tzf /tmp/octoclaw-pack/*.tgz | sort | sed -n '1,120p'
ls -lh /tmp/octoclaw-pack/*.tgz
```

Expected:

- package contains `README.md`, `LICENSE`, and `dist/`
- package does not contain compiled test files such as `dist/**/*.test.*`
- package size is recorded in release notes

## Build And Test Gate

- [ ] Typecheck/build all packages:

```bash
pnpm check
```

- [ ] Run full test suite:

```bash
pnpm test
```

- [ ] Check whitespace and patch hygiene:

```bash
git diff --check
```

- [ ] Run GitNexus change detection before commit:

```bash
npx gitnexus detect-changes -r OctoClaw
```

## Deploy Gate

- [ ] Deploy into the local OpenClaw environment:

```bash
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart
```

Expected readiness:

- `openclaw`: pass
- `runtime_plugin`: pass
- `judge`: pass or explicitly accepted warn with remote judge plan
- `im.slack`: pass on Slack release machine
- `im.feishu`: pass on Feishu release machine, warn is acceptable only on Slack-only machines
- `router_wizard`: pass
- `status_panel`: pass

## Slack Live Smoke

- [ ] Run full live Slack smoke:

```bash
set -a
source ~/.openclaw/octoclaw-slack-acceptance.env >/dev/null 2>&1
set +a
node tools/octoclawctl/dist/cli.js stability full \
  --output-dir ~/.openclaw/reports \
  --config ~/.openclaw/octoclaw-slack-acceptance-config.json \
  --format json
```

Expected:

- `overallGate=pass`
- `failureCount=0`
- `slack_delivery=pass`
- `delegate.parallel_two_children_status=pass`
- `wizard_contract=pass`
- `provider_resilience=pass`

Record the generated JSON and Markdown report paths.

## Feishu Target Smoke

Run this on the Feishu-only target machine before marking migration ready.

- [ ] Configure Feishu app credentials through `octoclawctl init` or OpenClaw plugin config.
- [ ] Run:

```bash
octoclawctl doctor
```

Expected:

- `runtime_plugin=pass`
- `im.feishu=pass`
- `status_panel=pass`
- `router_wizard=pass` or clear setup prompt appears

- [ ] In Feishu, send:

```text
你现在用的是什么模型
```

Expected: a normal final reply with route/model footer when available.

- [ ] In Feishu, trigger status:

```text
看下 OctoClaw 状态面板
```

Expected: Feishu card or text fallback. It must not invent child sessions.

- [ ] If router setup is incomplete, trigger:

```text
重新配置 Auto Router
```

Expected: onboarding card appears; duplicate clicks are idempotent.

## Migration Gate

- [ ] Fresh or migrated machine can run without local judge.
- [ ] `octoclawctl init --auto-remote-judge` offers a remote OpenAI-compatible judge path.
- [ ] Recommended remote judge candidates are documented:
  - `gpt-5.4-mini`
  - `glm-4.5-air`
  - `xiaomi/mimo-v2-flash`
  - `deepseek/deepseek-v4-flash`
- [ ] Remote judge config does not store secrets in router wizard state.
- [ ] Auto Router wizard remains thin: it asks only for user-authorized choices and config writes.

## Release Notes Gate

- [ ] Update `docs/release-notes-v0.6.0.md`.
- [ ] Include:
  - verified OpenClaw version
  - package size
  - last full test result
  - last Slack full smoke report path
  - Feishu target-smoke status
  - known limitations

## Tag And Publish

- [ ] Commit release docs and metadata.
- [ ] Push branch.
- [ ] Create tag only after all required gates pass:

```bash
git tag -a v0.6.0 -m "OctoClaw v0.6.0"
git push origin v0.6.0
```

- [ ] Publish package only from a clean verified checkout:

```bash
pnpm --filter @octoclaw/cli publish --access public
```

