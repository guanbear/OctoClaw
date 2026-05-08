# Phase 2: Runtime Core and Safe Delegation - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning and execution
**Source:** Remote design branch `origin/codex/docs-ts-rebuild-plan-2026-04-15`

<domain>
## Phase Boundary

Phase 2 is the first executable rebuild slice. It must establish the TypeScript contracts, guarded policy core, runtime ownership model, and safe delegation primitives for the minimal live path. The live path is limited to `reply`, `delegate.single`, and `observe`. Compound routing stays out of live authority for this phase.

</domain>

<decisions>
## Implementation Decisions

### Locked Architecture Decisions
- Formal product code for the rebuild is written in TypeScript, not new Python live-path modules.
- The execution truth source is OpenClaw native task and flow state, with projections and telemetry kept separate from truth.
- The runtime uses one orchestration layer with ingress orchestration, workflow orchestration, and reconcile or recovery as a compensation subdomain, not as a second system.

### Locked Runtime Safety Decisions
- Runtime contracts must include idempotency keys, delivery receipts, claim and lease ownership metadata, telemetry, and task packet structures.
- Delegated work must carry `read_scope`, `write_scope`, and `workspace_mode`.
- Overlapping writes in `shared_workspace` are serialized by default.
- Delivery must use an outbox and receipt model rather than direct side-effect-only sends.
- Deadline handling is split into queue, start, progress, runtime, and delivery deadlines.

### Locked Policy Decisions
- The live route decision stack is `route -> role -> backend -> workspace_mode -> model_profile`.
- Semantic routing is judge-first, not keyword-first.
- Hard-boundary rules are allowed only for explicit control actions, anchor or thread binding, permission edges, and similar non-semantic guardrails.

</decisions>

<canonical_refs>
## Canonical References

Downstream execution should treat the following as canonical inputs for this phase, even if some of them currently exist only on the remote docs branch.

### Remote Design Baseline
- `origin/codex/docs-ts-rebuild-plan-2026-04-15:docs/octoclaw-ts-rebuild-design-v1.md` — TS rebuild architecture baseline, data-plane separation, orchestration scope, decision stack, and runtime safety constraints.
- `origin/codex/docs-ts-rebuild-plan-2026-04-15:docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md` — Workstream breakdown for contracts, policy core, runtime core, runtime adapter, delegation, status surface, and eval gates.

### Local Code References
- `extensions/octoclaw-runtime/index.js` — current oversized JS runtime entrypoint that the rebuild must split instead of extending.
- `extensions/octoclaw-runtime/policy/decide.js` — current route and decision logic to mine for TypeScript migration targets.
- `extensions/octoclaw-runtime/policy/route.js` — current route logic to mine for TypeScript migration targets.
- `extensions/octoclaw-runtime/conversation-control.js` — current conversation control behavior to preserve semantically while changing implementation form.
- `lib/dispatch_task.py` — current Python dispatch path that the rebuild replaces as formal runtime architecture.
- `lib/openclaw_taskflow_adapter.py` — current Python adapter to replace with the formal TypeScript runtime adapter.
- `lib/openclaw_taskflow_runtime_helper.mjs` — current runtime seam reference for native task and flow interaction.

</canonical_refs>

<specifics>
## Specific Ideas

- Build `packages/octoclaw-contracts`, `packages/octoclaw-policy`, and `packages/octoclaw-runtime-core` first.
- Add runtime adapter and delegation plugin seams during the same phase only where needed to make ownership and safety contracts executable.
- Treat `claim_owner`, `lease_state`, `workspace_mode`, and `write_scope_summary` as first-class operator surface fields, even if richer surfaces arrive later.

</specifics>

<deferred>
## Deferred Ideas

- `delegate.compound` live execution
- auto-router live authority
- heavy or research profiles beyond the current fixed role and profile baseline
- richer multi-agent board and cockpit surfaces

</deferred>

---

*Phase: 02-runtime-core-and-safe-delegation*
*Context gathered: 2026-04-16 from the latest TS rebuild design branch*
