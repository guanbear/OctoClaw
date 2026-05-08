# Phase 3: Native Substrate and Operator Surfaces - Research

**Researched:** 2026-04-16
**Status:** Complete
**Question:** What does Phase 3 need in order to plan a full-fidelity cutover from the Python/native-mirror runtime path to a TypeScript-native truth path with substrate-first operator and IM surfaces?

## Summary

Phase 3 should be planned as a three-step cutover:

1. **Make the TypeScript adapter the formal native truth path** by moving OpenClaw bind/create/run interactions and truth projection shaping into `extensions/octoclaw-runtime/src/*`, with the JS wrapper downgraded to compatibility glue instead of truth authority.
2. **Create shared substrate projection contracts** for status, details, queue, and timeline so CLI/operator surfaces render from the same native-backed read model.
3. **Rewire IM/display consumers** (`conversation-control`, task anchors, display contracts) to use those shared projections instead of task-state-only inference.

This phase is architectural and therefore merits explicit research + validation artifacts.

## Existing Patterns Found

### 1. TypeScript runtime seam already exists, but it is placeholder-level
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` already exposes `bindSession`, `createManaged`, and `runTask`.
- Today it returns synthetic values from `RuntimeWorkflowState`; it does **not** yet bind to the native helper or own formal truth shaping.
- `extensions/octoclaw-runtime/src/plugin.ts` already exposes `createAdapter`, `bindWorkflow`, and `judgeRoute`.

**Planning implication:** Phase 3 should extend this seam instead of introducing a second adapter path.

### 2. Python still owns important truth and projection enrichment behavior
- `lib/openclaw_taskflow_adapter.py` currently registers mirror entries, reconciles native bindings, enriches task records with native facts, and manages cleanup/retention.
- The Python adapter distinguishes mirror-only vs managed/bound states and already models substrate state, sync mode, revision, and native task/runtime facts.

**Planning implication:** The TS cutover must either migrate or formally supersede this behavior. It is not enough to merely call the native runtime helper.

### 3. Operator surfaces already have a reusable projection vocabulary
- `lib/task_display.py` already defines shared surface builders for task anchors, details, queue, timeline, artifact explorer, operator surface, and user surface.
- `lib/im_display_contract.py` already declares shared surface roles, action taxonomy, and a `SUBSTRATE_DISPLAY_CONTRACT` with required and forbidden fields.
- `lib/status_render.py` already includes taskflow substrate summary rendering and operator-friendly text views.

**Planning implication:** Phase 3 should preserve these surface APIs where possible, but replace their data source with substrate-first projections rather than task-state-led inference.

### 4. Runtime read-model aggregation currently centers on local projection files
- `lib/runtime_snapshot.py` composes runtime views from `task-state.json`, `runner-queue.json`, task events, delivery relay state, and tmux/runner health.
- It already distinguishes `projection_status` vs `read_model_status` and uses events to override stale projection state.

**Planning implication:** This file is the strongest substrate projection insertion point. Phase 3 should add a native-backed projection layer here or alongside it, then have renderers consume the new projection contract.

### 5. IM grounding is already built around execution facts, not pure chat context
- `extensions/octoclaw-runtime/conversation-control.js` composes a grounded execution-facts block using replay logs, task state, task events, and delivery relay indices.
- It is designed to avoid memory-based answers and already exposes fields like task id, task status, queue pressure, delivery state, runner health, and native task binding.

**Planning implication:** This is a strong candidate for Phase 3 shared projection consumption. It should read one shared substrate projection bundle rather than reconstructing its own truth model.

## Constraints and Non-Negotiables

### User / roadmap locked constraints
- Formal adapter cutover belongs in Phase 3, not later (`D-01`; also deferred from Phase 2 verification).
- OpenClaw native task and flow state is the formal truth plane (`D-02`).
- Status/details/queue/timeline are substrate-first operator surfaces (`D-03`).
- IM/display surfaces must consume shared projection contracts (`D-04`).
- Truth/projection/artifact/telemetry separation must remain intact (`D-05`, plus `RT-02` context).

### Project constraints from prior phases
- Use the established TS packages and ESM-safe explicit imports.
- Preserve the canonical policy stack from Phase 2.
- Do not reintroduce Python live-path growth as a formal product direction.

## Recommended Architecture for Phase 3

## Architectural Responsibility Map

| Layer | Responsibility | Candidate files |
|---|---|---|
| Native truth adapter | Bind TS runtime to OpenClaw native task/flow APIs and shape native truth records | `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts`, `extensions/octoclaw-runtime/src/plugin.ts`, new TS helper/contract files under `extensions/octoclaw-runtime/src/` |
| Shared projection contracts | Define the substrate-first read models consumed by all surfaces | `packages/octoclaw-contracts/src/*` or new projection contract files under that package |
| Projection assembly | Build status/detail/queue/timeline projections from native truth + local supporting indexes | likely `lib/runtime_snapshot.py`, `lib/task_display.py`, related tests |
| Operator displays | Render compact/table/lanes/anchor views from shared projections only | `lib/status_render.py`, `lib/task_display.py`, `lib/task_anchor_commands.py`, CLI tests |
| IM/display consumers | Consume shared projection bundle for task follow-up and display rules | `extensions/octoclaw-runtime/conversation-control.js`, `lib/im_display_contract.py`, IM/runtime tests |

### Native adapter cutover
Recommended approach:
- Keep `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` as the single formal adapter module.
- Extend it to call or wrap the native runtime helper semantics already proven in `lib/openclaw_taskflow_runtime_helper.mjs`.
- Add explicit TS projection output for native flow/task identifiers, sync mode, substrate state, revision, claim owner/controller ownership, workspace state, and delivery/readiness facts.
- Downgrade `lib/openclaw_taskflow_adapter.py` from formal truth authority to compatibility/migration support if still needed by legacy paths.

### Shared substrate projections
Recommended fields derived from existing operator surface usage:
- `task_id`
- `flow_id`
- `state`
- `route`
- `worker_pool`
- `claim_owner`
- `workspace_mode`
- `write_scope_summary`
- `queue_position`
- `substrate_state`
- `substrate_revision`
- `delivery_state`
- `action_availability`
- `timeline_events`
- `artifacts_summary`

These map cleanly onto current consumers in `task_display.py`, `status_render.py`, and `conversation-control.js`.

### Operator surfaces
Recommended cutover sequence:
- First create contract + projection builders.
- Then change status/task display renderers to consume those builders.
- Finally update queue/details/timeline command paths and IM grounding to read the same projection shape.

This avoids a split-brain state where status and IM each compute truth differently.

## Risks and Common Pitfalls

1. **Half-cutover risk**
   - Symptom: TS adapter exists but Python or task-state inference still owns formal truth.
   - Mitigation: Require explicit plan tasks that change the formal source-of-truth path and verification that Python is no longer authoritative for execution truth.

2. **Projection/truth mixing risk**
   - Symptom: Display or telemetry fields become writable truth inputs.
   - Mitigation: Keep contracts explicit about truth vs projection and ensure renderers only consume projection artifacts.

3. **Surface divergence risk**
   - Symptom: CLI/status/timeline and IM grounding report different states for the same task.
   - Mitigation: Reuse one projection builder contract across all surfaces.

4. **Legacy JSON fallback becoming permanent**
   - Symptom: new code still treats `task-state.json` or mirror files as primary truth instead of native truth plus derived projection.
   - Mitigation: Phase 3 verification should assert native task/flow fields are present and operator surfaces surface them directly.

5. **ESM/runtime resolution regressions**
   - Symptom: TS modules cannot be directly imported under the repo's Node ESM path.
   - Mitigation: Continue the explicit `.ts` import pattern established in Phase 2 and keep direct-node smoke tests in verification.

## Discovery Verdict

**Discovery Level:** 2 — Standard Research

Reason:
- This phase performs an architectural cutover and shared contract design.
- It touches native runtime integration, read-model assembly, operator surfaces, and IM consumers.
- Existing code patterns are known, but the authority shift requires deliberate planning.

## Validation Architecture

- **Quick verification lane:** focused Node + pytest commands for adapter contract loading, runtime snapshot/projection assembly, and status/task display rendering.
- **Full verification lane:** combined adapter, runtime extension, status render, task display, and taskflow adapter tests.
- **Critical assertions:**
  1. TS runtime adapter exposes/executes native taskflow binding operations.
  2. Shared projections carry ownership/workspace/substrate fields.
  3. Status/details/queue/timeline surfaces consume the shared projection contract.
  4. IM grounding/display consumers reference the same projection vocabulary.

## Plan Recommendations

Split Phase 3 into **three execute plans**:

1. **Native adapter + truth contracts cutover**
2. **Shared substrate projection + operator surfaces**
3. **IM/display contract rebinding to shared projections**

This keeps each plan within the context budget while covering all roadmap and context items without scope reduction.

## Research Output

- Plan against the existing TS adapter/plugin seam.
- Treat Python taskflow adapter logic as migration input, not a future formal owner.
- Use `runtime_snapshot.py`, `task_display.py`, `status_render.py`, and `conversation-control.js` as the main consumer surfaces to rebind.

---

## RESEARCH COMPLETE
