# OctoClaw P3/P4 Post-Signoff Execution Handoff

> 状态：after P3 signoff + P4 transition signoff（2026-04-06）

## What is now frozen

### P3 frozen
- surface ownership
- interaction state machine
- action taxonomy
- capability matrix
- accepted fallback / gap ledger

### P4 frozen
- native-preferred create posture
- shared substrate display contract
- `create_preference` / `create_status`
- cleanup preview/apply policy
- legacy mirror / fallback inventory framing
- read-order matrix + exception ledger

## What is explicitly **not** frozen as “already complete”

- `display` substrate-first convergence
- `retrieve` substrate-first convergence
- `observer` substrate-first convergence
- `review` substrate-first convergence

这些只能按当前状态继续表述为：

- `display` = `mixed`
- `retrieve` = `mixed`
- `observer` = `not-yet-evidenced`
- `review` = `not-yet-evidenced`

## Recommended next execution scope

### Lane 1 — make mixed surfaces more honestly substrate-first
- tighten `display` read ordering
- tighten `retrieve` read ordering
- keep artifact/report UX intact while reducing mirror/runtime-first ambiguity

### Lane 2 — build explicit substrate-aware observer/review surfaces
- add a substrate/taskflow-aware observer view instead of only runner/count snapshots
- add a review surface that is more than `review_requested` event exposure

### Lane 3 — continue bounded cleanup
- keep cleanup preview-first
- only remove retention-expired terminal mirror entries
- do not broaden cleanup into runtime truth rewrite

## Non-goals

- do not reopen IM/display role boundaries
- do not relitigate capability levels unless code reality changes
- do not pretend Web/UI is already implemented
- do not remove mirror/fallback paths without explicit recovery-value review

## Recommended execution mode

### Default
- use **`ralph`** when doing sequential convergence:
  1. make one surface more substrate-first
  2. verify
  3. update docs/tests
  4. continue

### Escalate to `$team` only if
- `display/retrieve`
- `observer/review`
- `cleanup inventory`

become clearly independent parallel lanes with low overlap.

## Verification expectations for follow-up work

- update tests before or alongside behavior-shaping contract changes
- keep `create_preference` / `create_status` aligned across docs, contract source, and surfaced payloads
- treat exception-ledger shrinkage as something that must be evidenced, not inferred
