# Design

## Truth Model

- OpenClaw native `sessions_spawn` owns child session creation and native announce/delivery.
- OpenClaw native `sessions_send` owns continuation turns into an already-created session.
- `NativeSpawnIntent` owns OctoClaw authorization for both new spawn and speculative send handshakes.
- WorkContract stores semantic delegation data and accepted native refs only after confirm.
- ACK/footer/status remain projections and must not create execution facts.

## P0: SR-P1 Soft-Budget Recovery

The SR-P1 30s value is a soft main execution budget, not a user-visible SLA and not a hard interrupt. The timer starts after `before_prompt_build` has completed and the route bucket is `budgeted_main_then_delegate`.

When the soft budget expires:

- OctoClaw records `budgeted_main_escalated_pending`.
- If the main agent has already produced a final reply, OctoClaw records `budgeted_main_completed_late` and does not spawn.
- A later prompt-injection point adds a soft-budget notice, not a forced delegate instruction.
- The main agent may use one lightweight read-only tool to finish.
- Skill preparation reads such as `skills/*/SKILL.md` do not consume the real read-only allowance.
- Write tools, long commands, multi-step tools, tests/build/review/validation, or a second real read-only tool escalate by requiring `octoclaw_dispatch`.

Escalation still uses the existing native planner path:

```text
octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm
```

It must not direct spawn and must not send accepted ACK before confirm.

## P1: Scheme B Speculative Preload

Scheme B targets child bootstrap latency only. It does not solve parent model startup/prep latency and does not replace before-dispatch fast delegate work.

The feature is guarded by:

```text
OCTOCLAW_SPECULATIVE_PRELOAD=1
```

or by explicit runtime plugin config:

```text
pluginConfig.speculativePreload=true
```

Default is off. The plugin config path exists because live OpenClaw hook workers may not reliably inherit temporary LaunchAgent environment changes during controlled smoke runs.

### Hint Injection

`before_prompt_build` may inject an `OCTOCLAW_SPECULATIVE_SPAWN_HINT` only when all are true:

- speculative preload flag is enabled;
- the flag came from environment or explicit plugin config;
- spawn backend is planner;
- runtime route decision is already delegate;
- current policy state has no non-stale speculative preload state.

The trigger is the runtime decision, not bare user text or keyword matching.

### Standby Spawn Shape

Speculative standby spawn is allowed only for a fixed safe shape:

```json
{
  "task": "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
  "label": "octoclaw-speculative-...",
  "runtime": "subagent",
  "mode": "session",
  "thread": true,
  "cleanup": "keep",
  "sandbox": "inherit",
  "context": "isolated",
  "lightContext": true
}
```

The gate checks exact standby task text, label prefix, `mode="session"`, `thread=true`, `context="isolated"`, and `lightContext=true`.

### Dispatch To Speculative Session

If standby spawn has reached `ready`, `octoclaw_dispatch` creates a pending `NativeSpawnIntent` with:

```text
dispatchMode = "send_to_speculative"
```

The dispatch response includes:

- `dispatchMode=send_to_speculative`;
- `nextTool=sessions_send`;
- `sessionsSendArgs`;
- normal `spawnIntentId`, `workContractId`, canonical hash, TTL, and confirm tool.

`spawn_call_started` means only that the speculative `sessions_spawn` tool call was allowed and started. It is not enough to send user work. `after_tool_call` must observe an accepted native result and mark the speculative state `ready`; failed or unsupported standby spawns become `stale`.

If standby state is missing, stale, failed, or only `spawn_call_started`, dispatch falls back to normal `dispatchMode=new_spawn` and `sessionsSpawnArgs`.

### Gate Separation

Ordinary `sessions_spawn` gate only matches `dispatchMode=new_spawn` pending intents.

Speculative `sessions_send` gate only matches `dispatchMode=send_to_speculative` pending intents.

This separation prevents a newer standby/send intent from masking an older ordinary spawn intent or vice versa.

### Confirm And ACK

`octoclaw_dispatch_confirm` handles accepted native results from either `sessions_spawn` or `sessions_send` because both return accepted status plus run/session evidence.

Confirm semantics do not change:

- accepted status requires non-empty `runId`;
- WorkContract native refs are written before success is returned;
- failures fail closed;
- accepted ACK is sent only after confirm succeeds.

## P2: Live Validation

P2 requires real Slack artifacts with speculative preload flag enabled and then disabled/restored after validation.

Required evidence:

- `speculative_preload_hint_injected`;
- `speculative_preload_spawn_allowed`;
- `speculative_preload_spawn_ready`;
- `dispatchMode=send_to_speculative`;
- `sessions_send_intent_allowed`;
- `dispatch_confirm_completed ok=true`;
- native intent reaches accepted with non-empty `runId`;
- WorkContract native refs include run/session refs;
- final footer `via=native_announce`;
- `completion_file_timeout=0`;
- duplicate final count `0`;
- neutral ACK, accepted ACK, task-start, and final latency fields.

## Rollout

0.5.1 P1 can ship as default-off code. Any default enablement or allowlist rollout is P3 and requires P2 live evidence first.
