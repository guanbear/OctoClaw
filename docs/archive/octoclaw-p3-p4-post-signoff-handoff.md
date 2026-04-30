# OctoClaw P3/P4 Post-Signoff Execution Handoff

> 状态：after P3 signoff + P4 closeout（2026-04-07）

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
- read-order matrix

## What is now evidenced by follow-up implementation

- `display` = `substrate_first`
- `retrieve` = `substrate_first`
- `observer` = `evidenced_substrate_aware`
- `review` = `evidenced_substrate_aware`

本轮 evidence 以 **OpenClaw 2026.4.5** 已发布 TaskFlow/runtime 源码语义为准：

- operator first read = `flow/task target`
- then `taskSummary` / linked child health / review surface
- artifacts/report/context 退回到补充面

## Recommended next execution scope

### Lane 1 — keep substrate-first surfaces aligned
- preserve `display` read ordering against regressions
- preserve `retrieve` read ordering against regressions
- keep artifact/report UX intact while ensuring it does not overtake substrate truth

### Lane 2 — keep observer/review surfaces evidenced
- preserve the substrate/taskflow-aware observer view
- preserve the review surface beyond `review_requested` event exposure

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
