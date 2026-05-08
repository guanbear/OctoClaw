---
phase: 3
slug: native-substrate-and-operator-surfaces
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-16
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest + direct Node/ESM smoke commands |
| **Config file** | `tests/` existing unittest/pytest-style suite; no new framework install required |
| **Quick run command** | `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_status_render.py tests/test_task_display.py tests/test_task_anchor_commands.py -q` |
| **Full suite command** | `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_status_render.py tests/test_task_display.py tests/test_task_anchor_commands.py tests/test_octoclaw_runtime_extension.py -q` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_status_render.py tests/test_task_display.py tests/test_task_anchor_commands.py -q`
- **After every plan wave:** Run `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_status_render.py tests/test_task_display.py tests/test_task_anchor_commands.py tests/test_octoclaw_runtime_extension.py -q`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 1 | NATIVE-01 | T-03-01 | Native truth adapter exposes only validated OpenClaw-bound identifiers and runtime state | unit+smoke | `python3 -m pytest tests/test_openclaw_taskflow_adapter.py -q && node --input-type=module -e "import('./extensions/octoclaw-runtime/src/plugin.ts').then((m)=>{const p=m.createOctoClawRuntimePlugin(); console.log(Boolean(p.createAdapter&&p.bindWorkflow&&p.judgeRoute));})"` | ✅ | ⬜ pending |
| 3-01-02 | 01 | 1 | NATIVE-01 | T-03-02 | Runtime wrapper/plugin path uses TS-native adapter as formal truth path without letting legacy projections overwrite truth | unit+smoke | `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q` | ✅ | ⬜ pending |
| 3-02-01 | 02 | 2 | SURF-01 | T-03-03 | Projection contract exposes ownership, workspace, queue, and substrate fields as read-only surface data | unit | `python3 -m pytest tests/test_status_render.py tests/test_task_display.py -q` | ✅ | ⬜ pending |
| 3-02-02 | 02 | 2 | SURF-01 | T-03-04 | Queue/details/timeline views render from shared substrate projections rather than renderer-authored truth | unit | `python3 -m pytest tests/test_task_anchor_commands.py tests/test_task_display.py -q` | ✅ | ⬜ pending |
| 3-03-01 | 03 | 3 | SURF-01 | T-03-05 | IM/display consumers reuse shared projection fields and do not introduce renderer-authored truth | unit | `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
