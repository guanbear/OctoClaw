# OctoClaw Architecture Map

Date: 2026-05-09
Branch: `v0.5.0`
Status: current module map

This document is a navigational map of the current TypeScript-first OctoClaw
line. It complements
[`octoclaw-ts-rebuild-design-v2.md`](./octoclaw-ts-rebuild-design-v2.md) and
the runtime cleanup plan.

## 1. System Map

```mermaid
flowchart TD
  User["User / IM message / OpenClaw session"]
  Gateway["OpenClaw gateway + plugin host"]
  Native["OpenClaw native TaskFlow / sessions_spawn / native announce"]

  subgraph Runtime["extensions/octoclaw-runtime"]
    Entry["extension-entry.ts<br/>hook orchestrator"]
    Shared["extension-entry-shared.ts<br/>hook interfaces and parsing helpers"]
    Helpers["extension-entry-helpers.ts<br/>prompt/status helpers"]
    Plugin["plugin.ts / index.ts<br/>exports and plugin shape"]
    Config["config/index.ts<br/>runtime feature config"]
    Resolve["resolve/*<br/>session, route, judge, recovery, coverage"]
    Grounding["conversation-grounding.ts<br/>prompt grounding"]
    Budget["budgeted-main.ts<br/>main-agent budget state"]
    Ack["ack/*<br/>neutral ACK, route ACK, watchdog"]
    Tools["tools/*<br/>tool manifest, dispatch, status"]
    Delegate["delegate/*<br/>native spawn gate, intent, confirm, preload"]
    Work["work-contract/*<br/>build, materialize, store, project"]
    Ledger["runtime-ledger/*<br/>SQLite metadata, projection, recovery"]
    State["state/*<br/>policy state, task-state cache, native status projection"]
    Replay["replay/*<br/>policy/event replay and guards"]
    IM["im/*<br/>Slack/Feishu/WeChat adapter surface"]
    Adapter["adapter/* + ports/*<br/>native helper, state/webhook surfaces, TaskFlow ports"]
    Payloads["payloads/* + runtime-payloads.ts<br/>briefs, fast reply, delegation packets"]
    Core["core/*<br/>request/delegate/delivery/workflow primitives"]
  end

  subgraph Policy["packages/octoclaw-policy"]
    Intent["intent"]
    Route["route"]
    Judge["judge + judge-schema + judge-prompt"]
    Spec["spec / prompt-builder"]
    Model["model"]
    Roles["roles"]
    Gate["gate"]
    Admission["admission"]
    Caps["caps"]
  end

  subgraph Contracts["packages/octoclaw-contracts"]
    Schemas["schemas"]
    WorkContract["work-contract"]
    DelegateContract["delegate + delegate-context"]
    RouteSeal["route-seal"]
    StatusProjection["status-projection"]
    Results["results / events / telemetry / deliveries"]
    Artifacts["artifacts / thread-binding / completion"]
  end

  subgraph StatusSurface["extensions/octoclaw-status-surface"]
    ReadModel["read-model"]
    ViewModel["view-model"]
    TextRenderer["renderers/text"]
    RichRenderer["renderers/rich"]
    Actions["actions"]
    Operator["operator"]
  end

  subgraph CLI["tools/octoclawctl"]
    CliMain["cli.ts"]
    Install["install / manage / config / platform"]
    Nightly["nightly / review / curate"]
    NightlyEval["nightly-eval"]
    Calibration["calibration"]
    SlackAcceptance["slack-acceptance"]
  end

  JsonSchemas["schemas/*.schema.json"]
  Eval["eval/tasks-*.json"]
  Docs["docs/current + docs/archive"]

  User --> Gateway --> Entry
  Entry --> Shared
  Entry --> Helpers
  Entry --> Config
  Entry --> Resolve
  Entry --> Grounding
  Entry --> Budget
  Entry --> Ack
  Entry --> Tools
  Entry --> Replay
  Entry --> IM
  Entry --> State

  Resolve --> Policy
  Tools --> Delegate
  Tools --> Work
  Delegate --> Native
  Native --> Adapter
  Adapter --> State
  Adapter --> Ledger

  Work --> Contracts
  Work --> Ledger
  Ledger --> State
  State --> StatusSurface
  IM --> StatusSurface
  CLI --> StatusSurface
  CLI --> Runtime

  Policy --> Contracts
  StatusSurface --> Contracts
  JsonSchemas --> Contracts
  Eval --> CLI
  Docs --> Runtime
```

## 2. Package Dependency Direction

```mermaid
flowchart LR
  Contracts["@octoclaw/contracts<br/>stable contract layer"]
  Policy["@octoclaw/policy<br/>decision layer"]
  Runtime["@octoclaw/runtime<br/>OpenClaw plugin runtime"]
  Status["@octoclaw/status-surface<br/>operator read model"]
  Ctl["octoclawctl<br/>operator CLI"]
  Schemas["schemas/*.json"]

  Schemas --> Contracts
  Contracts --> Policy
  Contracts --> Runtime
  Policy --> Runtime
  Contracts --> Status
  Runtime --> Status
  Runtime --> Ctl
  Status --> Ctl
```

Rules:

- `contracts` must not depend on runtime, status, or CLI.
- `policy` can depend on `contracts`; it must not know IM or OpenClaw hooks.
- `runtime` may depend on `contracts` and `policy`; it owns OpenClaw plugin wiring.
- `status-surface` consumes runtime state-surface types and contract projections.
- `octoclawctl` is an operator client, not a runtime truth source.

## 3. Runtime Hook Flow

```mermaid
sequenceDiagram
  participant User as User / IM
  participant Host as OpenClaw plugin host
  participant Entry as extension-entry.ts
  participant Resolve as resolve/*
  participant Policy as @octoclaw/policy
  participant Tools as tools/registration.ts
  participant Ledger as runtime-ledger
  participant Native as sessions_spawn / TaskFlow
  participant IM as im/*
  participant Status as status projection

  User->>Host: inbound turn
  Host->>Entry: before_prompt_build / before_tool_call / agent_end hooks
  Entry->>Resolve: session, grounding, coverage, route context
  Resolve->>Policy: intent, route, judge, role, model
  Policy-->>Resolve: PolicyDecision
  Resolve-->>Entry: reply or delegate decision

  alt reply
    Entry->>IM: ACK/status/final reply as needed
    Entry->>Status: update projection metadata
  else delegate
    Entry->>Tools: octoclaw_dispatch
    Tools->>Ledger: persist WorkContract + NativeSpawnIntent
    Tools-->>Entry: sessionsSpawnArgs
    Entry->>Native: main agent calls native sessions_spawn
    Native-->>Entry: accepted run evidence
    Entry->>Tools: octoclaw_dispatch_confirm
    Tools->>Ledger: bind runId / childSessionKey / native refs
    Native-->>IM: native announce / channel delivery
    Entry->>Status: rebuild/render projection
  end
```

## 4. Truth And Projection

```mermaid
flowchart TD
  Native["OpenClaw native lifecycle<br/>run / flow / child session / announce"]
  Ledger["OctoClaw SQLite metadata ledger<br/>WorkContract, route seal, spawn intent, native refs, events"]
  Replay["replay log<br/>observability and eval"]
  TaskState["task-state.json<br/>generated cache"]
  Projection["StatusProjectionBuilder<br/>runtime-ledger/projection-rebuild + state/native-status-projector"]
  Surface["status/details/queue/timeline<br/>IM footer, octoclaw_status, octoclawctl"]
  Degraded["degraded diagnostics<br/>missing native state, corrupt cache, SQLite unavailable"]

  Native --> Projection
  Ledger --> Projection
  Replay --> Projection
  Projection --> TaskState
  Projection --> Surface
  Projection --> Degraded

  TaskState -. "cache input only during explicit rebuild/import" .-> Projection
```

Current truth rules:

- Native TaskFlow owns execution lifecycle.
- SQLite owns OctoClaw metadata and audit facts.
- `task-state.json` is generated and rebuildable.
- Replay can explain what happened; it cannot create execution truth.
- Missing/corrupt task-state should produce rebuild or degraded status, not an
  empty task list.

## 5. Runtime Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `extension-entry.ts` | Main hook orchestrator; wires prompt, tool, ACK, IM, replay, state, and native confirm behavior. |
| `extension-entry-shared.ts` | Shared hook interfaces, record coercion, and small parsing helpers. |
| `extension-entry-helpers.ts` | Prompt context projection, delegate status queries, reaction ACK config. |
| `plugin.ts` / `index.ts` | Package export and OpenClaw plugin entry. |
| `config/index.ts` | Feature config: planner backend, speculative preload, ledger flags, ACK settings. |
| `resolve/session.ts` | Session boundaries, state keys, managed-agent context, policy metadata. |
| `resolve/policy-resolver.ts` | Main policy resolution: local rules, judge, route, role, model, coverage. |
| `resolve/llm-judge.ts` | Judge context packet and optional LLM judge call. |
| `resolve/route-seal.ts` | Builds/verifies route seal metadata. |
| `resolve/runtime-recovery.ts` | Recovery classification and runtime anomaly facts. |
| `conversation-grounding.ts` | Builds prompt grounding from durable status/projection facts. |
| `budgeted-main.ts` | Budgeted main-agent escalation state. |
| `ack/*` | Neutral ACK, route commit ACK, timing/dedupe, watchdog, transition notices. |
| `delegate/native-spawn-intent.ts` | Native spawn intent shape and planner/confirm handshake data. |
| `delegate/native-spawn-gate.ts` | Validates native spawn/send gates before execution. |
| `delegate/native-spawn-confirm.ts` | Confirms accepted native spawn evidence. |
| `delegate/speculative-preload.ts` | Optional 0.5.1 planner preload hints. |
| `tools/registration.ts` | Tool manifest and handlers: route, dispatch, confirm, task action, status, recovery. |
| `tools/dispatch-logic.ts` | Shared dispatch validation and planner logic. |
| `tools/runtime-status.ts` | Builds runtime status output. |
| `work-contract/*` | WorkContract builders, materializer, continuity, native adapter, store, projectors. |
| `runtime-ledger/*` | SQLite migrations, feature flags, projection rebuild, crash recovery, scheduler, shadow diff. |
| `state/*` | Policy state cache, task-state cache, native status projector, retention. |
| `im/*` | IM adapter interface, send path, Slack thread anchor, projection footer. |
| `adapter/*` | Native helper bridge, runtime TaskFlow adapter, webhook/state surfaces. |
| `ports/*` | TaskFlow port abstractions and OpenClaw port adapters. |
| `replay/*` | Replay append/read helpers and message/tool guards. |
| `payloads/*` | Delegation briefs, materialization payloads, fast reply packets. |
| `core/*` | Lower-level request/delegate/delivery/workflow primitives. |

## 6. Policy Package Responsibilities

| Module | Responsibility |
|--------|----------------|
| `intent` | Intent classification helpers. |
| `route` | Live route authority: `reply | delegate`. |
| `judge` | Policy judge input/output and coordination mode helpers. |
| `judge-schema` | Judge JSON schema validation. |
| `judge-prompt` | Judge prompt assembly. |
| `spec` | Canonical decision policy spec and prompt builder. |
| `model` | Model profile/backend resolution. |
| `roles` | Policy role selection. |
| `gate` | Hard boundary checks. |
| `admission` | Scope/workspace admission decisions. |
| `caps` | Worker pool / capability mapping. |
| `compound` | Compound task helpers. |

## 7. Contract Package Responsibilities

| Module | Responsibility |
|--------|----------------|
| `schemas` | Contract envelope and shared schema constants. |
| `work-contract` | WorkContract, delegate/reply contracts, route metadata, coverage. |
| `delegate` | Delegate task, attempt, progress, recovery, status packets. |
| `delegate-context` | Handoff packets, artifacts, budget reports. |
| `route-seal` | Route seal schema and validation. |
| `status-projection` | Task status projection builder contracts. |
| `deliveries` | Delivery envelope/receipt contracts. |
| `events` | Runtime event shapes. |
| `telemetry` | Optimization telemetry contracts. |
| `results` | Status surface result/view-model types. |
| `artifacts` | Artifact references and native-truth artifact kinds. |
| `thread-binding` | Thread/session binding metadata. |
| `completion` | Historical completion result contract; not normal planner runtime. |

## 8. Status Surface And CLI

```mermaid
flowchart TD
  RuntimeSurface["@octoclaw/runtime/state-surface<br/>RuntimeStateSurfaceRecord"]
  Contracts["@octoclaw/contracts<br/>StatusSurfaceViewModel, WorkContract, DelegateProgressEvent"]

  Read["status-surface/read-model"]
  View["status-surface/view-model"]
  Text["status-surface/renderers/text"]
  Rich["status-surface/renderers/rich"]
  Actions["status-surface/actions"]
  Operator["status-surface/operator"]

  CLI["octoclawctl cli.ts"]
  Install["install/config/manage/platform"]
  Nightly["nightly/review/curate"]
  Eval["nightly-eval"]
  Cal["calibration"]
  Slack["slack-acceptance"]

  RuntimeSurface --> Read
  Contracts --> Read
  Read --> View
  View --> Text
  View --> Rich
  Read --> Actions
  Read --> Operator

  Text --> CLI
  Rich --> CLI
  Actions --> CLI
  Operator --> CLI
  Install --> CLI
  Nightly --> CLI
  Eval --> CLI
  Cal --> CLI
  Slack --> CLI
```

CLI responsibilities:

- `install`, `deploy`, `enable`, `disable`, `status`: operator lifecycle.
- `details`, `queue`, `timeline`, `patrol`, `repair`: status/operator surface.
- `nightly`, `review`, `curate`, `nightly-eval`, `promote`: feedback loop.
- `slack-acceptance`: live IM acceptance harness when credentials exist.
- `calibration`: calibration gates and reports.

## 9. Removed Legacy Paths

The current line must not depend on these paths:

| Legacy path | Current replacement |
|-------------|---------------------|
| `octoclaw_spawn` public tool | `octoclaw_dispatch` + native `sessions_spawn` + `octoclaw_dispatch_confirm` |
| plugin `runtime.subagent.run()` fallback | native planner/confirm path |
| fake detached runtime | fail closed if host has no real native runtime |
| child completion file as final protocol | OpenClaw native announce/channel delivery |
| child-finalizer recovery loop | native lifecycle + projection/recovery diagnostics |
| JSON delivery outbox for new runtime | native delivery metadata + replay/projection |
| task-state as durable truth | SQLite metadata ledger + native lifecycle |

## 10. High-Risk Files

These files are legitimate hotspots and should be split carefully, not casually
rewritten:

| File | Risk |
|------|------|
| `extensions/octoclaw-runtime/src/extension-entry.ts` | Very broad hook orchestration; changes can affect ACK, dispatch, prompt, IM, and replay. |
| `extensions/octoclaw-runtime/src/tools/registration.ts` | Tool manifest and handler hub; changes can alter user-visible tool behavior. |
| `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` | Policy/judge/model route behavior. |
| `extensions/octoclaw-runtime/src/work-contract/store.ts` | Metadata truth read/write path. |
| `extensions/octoclaw-runtime/src/runtime-ledger/index.ts` | SQLite schema and migrations. |
| `tools/octoclawctl/src/cli.ts` | Operator command entry. |

## 11. Audit Commands

```bash
pnpm check
pnpm test
git diff --check
rg "octoclaw_spawn|runtime\\.subagent\\.run|child-finalizer|flushDeliveryOutbox|appendToDeliveryOutbox" extensions/octoclaw-runtime/src
rg "v1\\.5\\.0|0\\.1\\.0|0\\.3\\.0" README.md README.zh-CN.md version.txt packages extensions tools
```
