---
phase: 4
slug: eval-gates-and-advanced-routing
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-16
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest / unittest + Node subprocess checks |
| **Config file** | `pyproject.toml` not required for focused module runs; existing repo test layout |
| **Quick run command** | `python3 -m pytest tests/test_replay_validation.py tests/test_harness_gate.py tests/test_acceptance_runtime.py tests/test_router_policy_v2_goldens.py tests/test_policy_judge_shadow_report.py tests/test_compound_plan.py tests/test_auto_router.py -q` |
| **Full suite command** | `python3 lib/harness_gate.py --preset full --format json` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run the most relevant focused pytest command from the per-task map below.
- **After every plan wave:** Run `python3 lib/harness_gate.py --preset full --format json`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | EVAL-01 | T-04-01 / T-04-02 | Replay and delivery evidence catches duplicate / stale recovery regressions without mutating truth data | regression | `python3 -m pytest tests/test_replay_validation.py tests/test_delivery_relay_reconcile.py tests/test_harness_gate.py -q` | ✅ | ✅ green |
| 04-01-02 | 01 | 1 | EVAL-01 | T-04-03 | Acceptance bootstrap remains reproducible and safe for black-box checks | regression | `python3 -m pytest tests/test_acceptance_runtime.py tests/test_harness_gate.py -q` | ✅ | ✅ green |
| 04-02-01 | 02 | 1 | EVAL-01 / AUTO-01 | T-04-04 / T-04-05 | Route-policy goldens and shadow outputs remain contract-valid while recommendation data stays non-authoritative | golden/shadow | `python3 -m pytest tests/test_router_policy_v2_goldens.py tests/test_policy_judge_shadow_report.py tests/test_route_recommendation.py -q` | ✅ | ✅ green |
| 04-02-02 | 02 | 1 | AUTO-01 | T-04-05 | Runtime replay exposes recommendation conflicts and optimization telemetry without overwriting runtime truth | regression | `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q -k "policy_judge or replay or delivery"` | ✅ | ✅ green |
| 04-03-01 | 03 | 2 | AUTO-01 | T-04-06 / T-04-07 | Compound plans validate/schedule/guard before execution and degrade safely when infeasible | unit/regression | `python3 -m pytest tests/test_compound_plan.py tests/test_auto_router_boundary.py -q` | ✅ | ✅ green |
| 04-03-02 | 03 | 2 | AUTO-01 | T-04-07 | Auto-router payloads consume stable policy/runtime facts without introducing a second orchestration authority | unit/regression | `python3 -m pytest tests/test_auto_router.py tests/test_eval_suite.py -q` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready
