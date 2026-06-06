# OctoClaw Release Checklist

Use this for every public release. The goal is a release where a fresh user (or
an AI agent following `docs/octoclaw-ai-install-runbook.md`) can install
OctoClaw without surprises.

There is no auto version bump. Versions are bumped in a PR, merged, then a tag
triggers `.github/workflows/release.yml`.

---

## 1. Pre-release (in a PR, before tagging)

### 1.1 Version alignment

Every publishable package and `version.txt` must match the intended tag.

```bash
# Show all versions at once
cat version.txt
for p in packages/octoclaw-contracts packages/octoclaw-errors \
         packages/octoclaw-policy packages/octoclaw-router \
         extensions/octoclaw-runtime extensions/octoclaw-status-surface \
         tools/octoclawctl; do
  node -p "'$p ' + require('./$p/package.json').version"
done
```

- [ ] `version.txt` == target version (e.g. `0.6.0`)
- [ ] All 7 packages == target version
- [ ] `tools/octoclawctl/src/install.ts` `DEFAULT_REF` == `v<target>`

> The release workflow's `verify` job fails the build if any of these drift
> from the tag, so this is enforced — but fix it here to avoid a failed
> release run.

### 1.2 Quality gates

```bash
pnpm install --frozen-lockfile
pnpm check        # build + typecheck across all packages
pnpm test         # full vitest suite
git diff --check  # no whitespace/conflict markers
```

- [ ] `pnpm check` clean
- [ ] `pnpm test` green (record the test count in the PR description)
- [ ] No new `: any` introduced (`git grep ': any' -- '*.ts' | wc -l` not higher than baseline)

### 1.3 Docs and changelog

- [ ] `CHANGELOG.md`: move the target version out of `(Unreleased)`, date it
- [ ] `docs/release-notes-v<target>.md` exists (the release workflow attaches it)
- [ ] `README.md` and `README.zh-CN.md` install sections accurate for this version
- [ ] `docs/octoclaw-ai-install-runbook.md` `git checkout v<target>` line updated
- [ ] No personal paths leaked into public docs:
      `git grep -n '/Users/' -- 'docs/*.md' README.md README.zh-CN.md`
      (the local deploy guide is developer-internal; keep public docs clean)

### 1.4 Publish dry-run

Confirm each package would publish the right files and resolve `workspace:*`
to real versions.

```bash
for p in packages/octoclaw-contracts packages/octoclaw-errors \
         packages/octoclaw-policy packages/octoclaw-router \
         extensions/octoclaw-runtime extensions/octoclaw-status-surface \
         tools/octoclawctl; do
  echo "=== $p ==="
  (cd "$p" && pnpm publish --dry-run --no-git-checks --access public 2>&1 | tail -5)
done
```

- [ ] Each dry-run lists `dist/` (and `openclaw.plugin.json` for runtime)
- [ ] No `workspace:*` literals remain in the packed `package.json`
      (pnpm rewrites them on publish; the dry-run output shows the resolved range)
- [ ] `@octoclaw/cli` packs `dist/` and excludes `*.test.*`

### 1.5 Fresh-install smoke (manual, on a clean machine or container)

```bash
git clone https://github.com/guanbear/OctoClaw.git && cd OctoClaw
git checkout v<target>
pnpm install --frozen-lockfile && pnpm build
node tools/octoclawctl/dist/cli.js doctor --format json
```

- [ ] `doctor` reports no `fail` on a clean environment
- [ ] `deploy` into a throwaway `OPENCLAW_HOME` succeeds
- [ ] One IM round-trip gets an ACK (if a test channel is available)

---

## 2. Release (tag and publish)

```bash
# On the merged release commit:
git tag v<target>
git push origin v<target>
```

- [ ] Tag pushed
- [ ] `.github/workflows/release.yml` `verify` job passed
- [ ] `publish` job published all public packages (check npm)
- [ ] `github-release` job created the GitHub Release with notes
- [ ] `NPM_TOKEN` secret was valid (rotate if the publish 401'd)

---

## 3. Post-release verification

```bash
npm view @octoclaw/cli version          # == target
npm install -g @octoclaw/cli@<target>
octoclawctl doctor
```

- [ ] `npm view @octoclaw/cli version` matches the tag
- [ ] `@octoclaw/router`, `@octoclaw/policy`, `@octoclaw/contracts`,
      `@octoclaw/errors`, `@octoclaw/runtime`, `@octoclaw/status-surface`
      all show the new version on npm
- [ ] GitHub Release page renders the notes
- [ ] Open a tracking issue for anything that slipped (do not hotfix silently)

---

## 4. Rollback

If a published version is broken:

```bash
# Deprecate (preferred — never unpublish a version users may depend on)
npm deprecate @octoclaw/cli@<bad> "Broken release, use <good> instead"
```

- [ ] Deprecate the bad version on npm (do not `npm unpublish`)
- [ ] Bump a patch, fix forward, re-release through this checklist
- [ ] Note the bad version in `CHANGELOG.md`

---

## 5. Known release gaps (track, do not silently ship around)

These are limitations a release should be honest about until fixed:

1. **npm-only deploy** is not supported; `@octoclaw/cli install`/`deploy` need
   the repo source. The runbook (§3) and README must say so.
2. **Windows native install** needs WSL (deploy uses `rsync`/`ln`).
3. **Offline install** is not supported (deploy runs `pnpm install`).

When any of these is fixed, update both this checklist and the AI install
runbook in the same PR.
