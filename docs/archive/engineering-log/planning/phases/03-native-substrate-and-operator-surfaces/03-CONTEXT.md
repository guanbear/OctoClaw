# Phase 3: Native Substrate and Operator Surfaces - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning and execution
**Source:** User planning prompt + canonical Phase 2 summaries/verification

<domain>
## Phase Boundary

Phase 3 performs the formal runtime truth-path cutover that Phase 2 explicitly deferred. It replaces the formal Python runtime adapter path with TypeScript-native runtime adapters bound to OpenClaw native task and flow APIs, then rebuilds operator and IM/display surfaces so they consume substrate-first projection contracts instead of inferring truth from legacy JSON chains or owning separate truth models.

</domain>

<decisions>
## Implementation Decisions

### Locked Decisions
- **D-01**: The formal TypeScript-native runtime adapter cutover happens in Phase 3; Phase 2's JS wrapper and Python adapter are no longer the formal execution truth path after this phase.
- **D-02**: OpenClaw native task and flow truth is the formal execution truth plane and the execution truth path for runtime status, ownership, and flow progression.
- **D-03**: Operator surfaces must be substrate-first for status, details, queue, and timeline views.
- **D-04**: IM and display surfaces must consume shared projection contracts and must not own a separate truth model.
- **D-05**: Phase 2's truth/projection/artifact/telemetry plane separation remains locked; display and telemetry data must not overwrite live truth.
- **D-06**: The latest TS rebuild baseline and completed Phase 2 artifacts are canonical upstream context for Phase 3 planning and implementation.

### the agent's Discretion
- Choose the smallest contract and adapter surface that fully satisfies D-01 through D-05 without reintroducing Python or legacy-JSON authority.
- Reuse existing status/task-anchor/task-display patterns where possible, but rebind them to native substrate projections rather than task-state inference.
- Keep timeline and queue read models operator-friendly in text environments while preserving shared contracts for future richer surfaces.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning Baseline
- `.planning/ROADMAP.md` — Phase 3 goal, success criteria, and dependency on Phase 2.
- `.planning/REQUIREMENTS.md` — `NATIVE-01`, `SURF-01`, and the truth/projection separation requirement context.
- `.planning/STATE.md` — Locked project-level decisions from the TS rebuild baseline and Phase 2 execution history.

### Phase 2 Canonical Upstream
- `.planning/phases/02-runtime-core-and-safe-delegation/02-CONTEXT.md` — Locked Phase 2 architectural decisions, especially native truth and plane separation.
- `.planning/phases/02-runtime-core-and-safe-delegation/02-01-SUMMARY.md` — Contracts and policy package patterns.
- `.planning/phases/02-runtime-core-and-safe-delegation/02-02-SUMMARY.md` — Runtime-core, adapter seam, and delegation metadata patterns.
- `.planning/phases/02-runtime-core-and-safe-delegation/02-03-SUMMARY.md` — Shipped runtime wrapper / TS judge wiring and deferred adapter cutover context.
- `.planning/phases/02-runtime-core-and-safe-delegation/02-04-SUMMARY.md` — Executable runtime-core and delegation metadata patterns consumed by later surfaces.
- `.planning/phases/02-runtime-core-and-safe-delegation/02-VERIFICATION.md` — Explicit record that the formal TS-native runtime adapter cutover was deferred into Phase 3.

### Local Code References
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` — Current TS adapter seam to deepen into the formal native adapter.
- `extensions/octoclaw-runtime/src/plugin.ts` — Current TS runtime plugin seam.
- `extensions/octoclaw-runtime/index.js` — Current shipped wrapper that still carries formal runtime authority before Phase 3 cutover.
- `lib/openclaw_taskflow_adapter.py` — Current Python truth/mirror adapter to retire as formal authority.
- `lib/openclaw_taskflow_runtime_helper.mjs` — Current OpenClaw native runtime helper reference.
- `lib/runtime_snapshot.py` — Current read-model and task/event aggregation path.
- `lib/status_render.py` — Current status/operator text rendering path.
- `lib/task_display.py` — Current shared task anchor/detail/queue/timeline projection surface builder.
- `lib/im_display_contract.py` — Current IM/display contract definitions to align with shared projection truth.
- `extensions/octoclaw-runtime/conversation-control.js` — IM grounding and follow-up fact presentation path that must consume shared projections.

</canonical_refs>

<specifics>
## Specific Ideas

- Formalize a shared TypeScript projection contract for status/details/queue/timeline read models and task anchor substrate summaries.
- Keep operator text surfaces and task-anchor commands, but switch their truth source from legacy task-state inference to substrate-first projections backed by native task/flow facts.
- Ensure IM grounding and display contracts reuse the same projection fields exposed to CLI/operator surfaces.

</specifics>

<deferred>
## Deferred Ideas

- Phase 4 eval-gate activation and advanced routing authority
- Future rich web cockpit or multi-agent board surfaces beyond the Phase 3 operator/IM rebuild
- Any reintroduction of Python or separate IM truth ownership as a stopgap

</deferred>

---

*Phase: 03-native-substrate-and-operator-surfaces*
*Context gathered: 2026-04-16 from prompt scope plus canonical Phase 2 artifacts*
