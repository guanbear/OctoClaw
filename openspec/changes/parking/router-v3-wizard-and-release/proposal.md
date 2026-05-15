# Change: Auto Router V3 — Interactive Wizard, Quota Auto-Poll, Release Polish (PARKED)

Status: parked. Originally split out of `archive/router-v3-0.6.x/` on 2026-05-15.

## Why parked

Auto Router V3 Phase A + B + C and most of D shipped. The remainder (full
interactive wizard, plan quota polling, end-to-end release smoke that needs
30+ shadow samples) cannot be validated without real install traffic. Shipping
the UI and quota loops before any user has exercised the shadow path would
just risk reworking them after first real use.

## What is parked

1. **D1 — full 7-step interactive wizard.** Today there is a non-interactive
   wizard config writer; the design called for a guided 7-step prompt flow with
   provider plan auto-detection. Park until install onboarding feedback shows
   the non-interactive path is insufficient.
2. **D6 — plan quota auto-poll.** Periodically poll provider usage APIs;
   below 10% remaining, automatically switch to non-plan models with a light
   notification. Park until at least one user reports a quota-induced silent
   failure or near-miss.
3. **E1 — end-to-end smoke harness.** Drive 30+ delegate turns and verify
   auto-promotion fires. Park until the runtime is being used at that
   cadence by anyone.

## Trigger to revisit

Any one of:

- ≥ 5 active installs producing ≥ 100 shadow events / week.
- A user request for the interactive wizard (current install path is the
  `octoclawctl init` wizard, which already covers fresh setup).
- A reported quota-related routing failure.

## Non-goals while parked

- Do not re-implement against an empty data set.
- Do not block v0.6.0 release on any of the parked items.
- Do not silently delete the supporting code in `packages/octoclaw-router/`
  (the wizard module, override CLI, and cost report all stay; only the
  parked surfaces are deferred).
