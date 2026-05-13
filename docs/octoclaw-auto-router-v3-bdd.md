# Auto Router v3 — BDD Scenarios

Date: 2026-05-13
Related: `docs/octoclaw-auto-router-v3-design-2026-05-13.md`, `openspec/changes/router-v3-0.6.x/`

## How to use

Each scenario below is **acceptance criteria**. During implementation:

- Every scenario must become a passing Vitest test
- Scenario IDs like `RT-J-001` are used in commit messages and test names
- When implementation is ambiguous, this document is the tie-breaker
- When this document is ambiguous, STOP and ask — do not guess

## Naming convention

- `RT-J-*` Router / Judge (Semantic Layer)
- `RT-C-*` Router / Capability snapshot
- `RT-S-*` Router / Scoring engine
- `RT-P-*` Router / Promotion (shadow → live)
- `RT-W-*` Router / Wizard
- `RT-O-*` Router / Override
- `RT-$-*` Router / Cost reporting
- `RT-H-*` Router / Health and stability
- `RT-I-*` Router / Invariants (cross-cutting)

## Shared fixtures

All scenarios assume:

- `fixtures/snapshot-v1.json` — a known leaderboard snapshot with 5 models (gpt-5.5, glm-5.1, gpt-5-mini, claude-sonnet, qwen3-coder)
- `fixtures/openclaw-config-v1.json` — OpenClaw with 3 configured models: gpt-5.5, glm-5.1, gpt-5-mini
- `fixtures/judge-outputs/*.json` — pre-recorded judge outputs for common prompts

---

## RT-J: Judge (Semantic Layer)

### RT-J-001: Judge outputs exactly 3 fields on successful call

**Given** a judge model configured with Qwen3 0.6B local endpoint
**And** the prompt "帮我写个 Python 脚本读 CSV"
**When** `router.judge(input)` is called
**Then** the result must have exactly 3 keys: `route`, `confidence`, `complexity`
**And** `route` must be `"reply"` or `"delegate"`
**And** `confidence` must be a number in `[0.0, 1.0]`
**And** `complexity` must be one of `"simple" | "normal" | "complex" | "deep"`
**And** no additional keys exist (no scenario, no complexity_confidence, no reasoning, no thought)

### RT-J-002: Judge parse failure triggers fallback

**Given** the judge endpoint returns `"I think you should delegate this."` (non-JSON)
**When** `router.judge(input)` is called
**Then** the returned object must come from fallback rules
**And** `confidence` must be ≤ 0.5
**And** a `router_judge_fallback` event must be emitted with `reason="parse_failed"`
**And** the judge failure counter for that model must increment

### RT-J-003: Judge timeout triggers fallback

**Given** the judge endpoint does not respond within 2000ms
**When** `router.judge(input)` is called
**Then** the call returns within 2500ms (hard ceiling)
**And** the returned object comes from fallback rules
**And** a `router_judge_fallback` event is emitted with `reason="timeout"`

### RT-J-004: Judge cooldown after repeated failures

**Given** judge has failed 5 times out of the last 10 calls
**When** `router.judge(input)` is called
**Then** the judge model is not called (saves the RTT)
**And** fallback rules are used directly
**And** cooldown persists for 30 minutes
**And** after cooldown expires, judge is tried again on next call

### RT-J-005: Cache hit on identical prompt within same session

**Given** `router.judge({ prompt: "how are you", sessionKey: "s-1", ... })` was called at t=0 and cached
**And** judge cache TTL is 120 seconds
**When** the same input is called at t=60s
**Then** the judge endpoint is NOT called (verify via spy)
**And** the result is byte-identical to the t=0 result
**And** cache hit counter increments

### RT-J-006: Cache miss on different session key

**Given** `router.judge({ prompt: "how are you", sessionKey: "s-1" })` returned a cached result
**When** the same prompt is called with `sessionKey: "s-2"`
**Then** the judge endpoint IS called (fresh judge)
**And** the result goes into cache with the new session key

### RT-J-007: Cache miss after recent execution fingerprint change

**Given** `router.judge(...)` was called and cached with recentExecution={task-1, completed}
**When** the same prompt is called but recentExecution={task-2, completed}
**Then** the judge endpoint IS called
**And** cache key recomputed; old entry untouched

### RT-J-008: Negative confidence result is also cached

**Given** judge returned `{ route: "reply", confidence: 0.3, complexity: "normal" }`
**When** the same input is called again within TTL
**Then** the cached low-confidence result is returned
**And** judge endpoint is NOT called

### RT-J-009: Low confidence invokes fallback application

**Given** judge returned `{ route: "delegate", confidence: 0.5, complexity: "normal" }`
**And** minConfidence threshold is 0.65
**When** the downstream runtime applies the judge result
**Then** the applied route comes from fallback rules (not the judge result)
**And** the judge's raw result is still recorded in shadow event as evidence

### RT-J-010: Status followup bypass — no judge call

**Given** the runtime context has `statusOrProvenanceRequest=true` (from coverage layer)
**When** `router.judge(input)` is called
**Then** the judge model is NOT called
**And** the returned result is `{ route: "reply", confidence: 0.9, complexity: "simple" }` from fallback rules
**And** event `router_judge_skipped` is emitted with `reason="status_or_provenance_request"`

### RT-J-011: Session control bypass — no judge call

**Given** the runtime context has `sessionControlRequest=true`
**When** `router.judge(input)` is called
**Then** the judge model is NOT called
**And** the returned result is `{ route: "reply", confidence: 0.9, complexity: "simple" }`

### RT-J-012: JSON output validation rejects out-of-range values

**Given** judge endpoint returns `{ route: "delegate", confidence: 1.5, complexity: "normal" }`
**When** the result is parsed
**Then** parse is treated as failure (confidence out of [0,1])
**And** fallback rules are used
**And** `router_judge_fallback` event records `reason="validation_failed"`

### RT-J-013: JSON output with extra fields is rejected

**Given** judge endpoint returns `{ route: "delegate", confidence: 0.8, complexity: "normal", scenario: "coding" }`
**When** the result is parsed
**Then** parse is treated as failure (extra field in V1)
**And** fallback rules are used

### RT-J-014: Judge must handle mixed-language prompts

**Given** judge is called with prompt "帮我写 a Python script"
**When** judge returns `{ route: "delegate", confidence: 0.72, complexity: "normal" }`
**Then** the result is accepted (mixed Chinese/English is normal)

### RT-J-015: Judge is stateless — no persistent state between calls

**Given** 100 consecutive calls to `router.judge(...)` with distinct sessions
**Then** no judge state file grows beyond cache size limit (1 MB)
**And** cache has a max entry count (e.g., 1000), and evicts LRU after that

---

## RT-C: Capability Snapshot

### RT-C-001: Packaged snapshot loads on cold start

**Given** OctoClaw is installed fresh (no user refresh ever run)
**When** `router.recommend(...)` is called
**Then** the packaged `leaderboard-snapshot.json` is loaded
**And** all models in the snapshot are available for recommendation

### RT-C-002: Snapshot load failure fails open

**Given** the packaged snapshot file is corrupt (invalid JSON)
**When** router tries to load
**Then** router falls back to an empty capability snapshot (no scores available)
**And** a warning is logged: `[router-lite] snapshot load failed: <error>`
**And** router.recommend() does not throw; it returns `{ ignoredReason: "no_capability_data" }`

### RT-C-003: Snapshot refresh via CLI

**Given** `octoclawctl router capability refresh` is invoked
**When** the command runs
**Then** the following sources are probed in order:
  1. Leaderboard snapshot from GitHub Release (if network available)
  2. OpenRouter API `/api/v1/models`
  3. models.dev API
  4. OpenClaw provider catalog
**And** conflicts (> 20% price delta across sources) are flagged with `conflict: true`
**And** the updated snapshot is written to `~/.openclaw/octoclaw/router-lite/model-intel-snapshot.json`
**And** `snapshotId` increments

### RT-C-004: OpenClaw config change auto-triggers incremental refresh

**Given** router is running with cached snapshot
**And** `~/.openclaw/openclaw.json` is modified (new provider added)
**When** the file system watcher fires
**Then** `refreshCapability({ incremental: true })` is called automatically
**And** the new provider's models are added to snapshot
**And** existing capability data for unchanged models is preserved

### RT-C-005: Unknown model discovered triggers lookup

**Given** the cached snapshot does not contain `deepseek/deepseek-v4`
**And** the user configures this model in OpenClaw
**When** `router.recommend(...)` is called and the unknown model needs capability
**Then** the router tries to fetch capability from OpenRouter/models.dev
**And** if successful, the snapshot is updated incrementally
**And** if not found externally, capability is set to `{ confidence: "low", source: "heuristic" }`

### RT-C-006: Capability data freshness tracking

**Given** a model's capability data was fetched 95 days ago
**When** the snapshot is loaded
**Then** that model is flagged with `stale: true`
**And** it is still usable but with lower confidence weight
**And** `octoclawctl router capability show <model>` displays `⚠ data stale (95 days)`

### RT-C-007: User override of capability score persists across refresh

**Given** user has run `router score override openai/gpt-5.5 complex=75`
**When** `router capability refresh` runs
**Then** the external data is loaded
**But** `openai/gpt-5.5 complex score` remains 75 (user override wins)
**And** the override is stored separately in wizard config, not in snapshot

---

## RT-S: Scoring Engine

### RT-S-001: Recommended model matches complexity tier (deep → frontier)

**Given** judge output is `{ route: "delegate", complexity: "deep", confidence: 0.82 }`
**And** configured models are: gpt-5.5 (frontier), glm-5.1 (standard), gpt-5-mini (mini)
**When** `router.recommend(...)` is called
**Then** `recommendedModel` must be `"openai/gpt-5.5"` (only frontier tier available)
**And** `reasonCodes` must include `"quality_floor_pass:frontier"`
**And** `ignoredReason` must be undefined

### RT-S-002: Recommended model matches complexity tier (simple → mini)

**Given** judge output is `{ route: "delegate", complexity: "simple", confidence: 0.85 }`
**And** configured models are: gpt-5.5, glm-5.1, gpt-5-mini
**When** `router.recommend(...)` is called
**Then** `recommendedModel` must be `"openai/gpt-5-mini"` (cheapest tier that passes floor)
**And** `reasonCodes` must include `"quality_floor_pass:mini"`

### RT-S-003: Unconfigured model never recommended

**Given** snapshot contains `claude-opus-4` with excellent scores
**And** `claude-opus-4` is NOT in OpenClaw configuration
**When** `router.recommend(...)` is called
**Then** `recommendedModel` is never `claude-opus-4`
**And** `rejectedModels` includes `claude-opus-4` with reason `"not_configured"`

### RT-S-004: Cooldown model is excluded

**Given** `gpt-5.5` has `health.cooldown=true` (triggered by failure rate > 20%)
**And** `gpt-5.5` would otherwise be the best match
**When** `router.recommend(...)` is called
**Then** `gpt-5.5` is excluded
**And** `rejectedModels` includes it with reason `"cooldown_active"`
**And** the next best model in the same tier is recommended

### RT-S-005: quotaPressure=unknown is NOT treated as free

**Given** `gpt-5.5` has `plan.quotaPressure="unknown"` and `effectiveCostBand="unknown"`
**And** `glm-5.1` has `plan.quotaPressure="low"` and `effectiveCostBand="free_or_sunk"`
**And** both are in the same tier (assume pretend they are for this test)
**When** scores are computed
**Then** `glm-5.1.cost_score` includes the plan bonus (result: 100)
**And** `gpt-5.5.cost_score` does NOT include plan bonus
**And** `glm-5.1` is recommended

### RT-S-006: Tool requirement filters out models without tool_use

**Given** judge says `complex` but runtime signals `needsTools=true`
**And** model A has `capability.toolUse="no"`
**And** model B has `capability.toolUse="yes"`
**When** `router.recommend(...)` is called
**Then** model A is in `rejectedModels` with reason `"tool_support_insufficient"`
**And** model B is preferred

### RT-S-007: Balanced mode weights are 35/20/20/15/10

**Given** three models with known capability/cost/stability/speed values
**When** scoring runs in `balanced` mode (V1 default)
**Then** the final score is:
  `capability_score × 0.35 + quality_floor_pass × 0.20 + cost_score × 0.20 + stability_score × 0.15 + speed_score × 0.10`
**And** the winner matches pre-calculated expected result

### RT-S-008: User override beats scoring

**Given** `openai/gpt-5.5` has the highest normal score
**And** user has run `router model ban openai/gpt-5.5 --for normal`
**When** `router.recommend(...)` is called for complexity=normal
**Then** `gpt-5.5` is excluded
**And** the next best model is recommended
**And** `reasonCodes` includes `"user_ban_active"`

### RT-S-009: Dispreferred model loses tie-breakers

**Given** two models have identical scores
**And** user has marked one as `dispreferred-for: normal`
**When** scoring runs
**Then** the non-dispreferred model wins
**And** `reasonCodes` includes `"user_dispreferred_tiebreak"`

### RT-S-010: Ignored reasons are emitted clearly

For each of the following, `ignoredReason` in recommendation output must match:
- All models unconfigured → `"all_unconfigured"`
- All models in cooldown → `"all_cooldown"`
- No model meets quality floor → `"no_quality_floor_match"`
- Missing capability data → `"no_capability_data"`
- User banned all tier matches → `"all_banned"`

---

## RT-P: Promotion (Shadow → Live)

### RT-P-001: New model starts in shadow state

**Given** `deepseek/deepseek-v4` is newly configured
**When** the first `router.recommend(...)` includes it as a candidate
**Then** its promotion state is `"shadow"` (not `"live"`)
**And** it doesn't replace existing live recommendations
**And** shadow events still record it as a comparison

### RT-P-002: Auto-promotion after 30+ samples with good data

**Given** `deepseek/deepseek-v4` shadow events show:
  - 35 samples
  - success_rate_delta = -1% (within tolerance)
  - cost_delta = -15% (cheaper)
  - quality_regression = 3%
**When** the daily auto-promotion evaluator runs
**Then** `deepseek/deepseek-v4` is promoted to live
**And** an event `router_auto_promotion` is emitted with:
  - `model: "deepseek/deepseek-v4"`
  - `tier: "normal"`
  - `evidence: { samples: 35, success_delta: -0.01, cost_delta: -0.15 }`
**And** the decision is visible in `octoclawctl router decisions`

### RT-P-003: Insufficient samples — hold

**Given** shadow has only 15 samples for a candidate
**When** auto-promotion runs
**Then** the candidate remains in `"shadow"` state
**And** event `router_promotion_held` is emitted with `reason="insufficient_samples"`
**And** no warning to user (it's normal)

### RT-P-004: Quality regression > 5% — permanent failure

**Given** shadow samples show `quality_regression = 7%`
**When** auto-promotion runs
**Then** the candidate is marked `"failed"` permanently
**And** retry is blocked for 30 days
**And** event `router_promotion_rejected` with `reason="quality_regression"` is emitted

### RT-P-005: Cost delta not negative — rejected

**Given** shadow samples show `cost_delta >= 0` (same or more expensive)
**When** auto-promotion runs
**Then** the candidate is not promoted (even if quality is fine)
**And** event `router_promotion_rejected` with `reason="no_cost_benefit"` is emitted

### RT-P-006: Max 1 promotion per day enforced

**Given** two candidates both meet promotion criteria on the same day
**When** auto-promotion runs
**Then** only one is promoted
**And** the other is queued for the next day
**And** event indicates `daily_limit_reached`

### RT-P-007: Promoted model can revert if data degrades

**Given** `deepseek/deepseek-v4` was promoted to live 7 days ago
**And** recent 7-day data shows failure rate > 20%
**When** nightly review runs
**Then** the model is reverted to `"shadow"` state
**And** event `router_promotion_reverted` with `reason="failure_rate_exceeded"` is emitted
**And** retry blocked for 30 days

### RT-P-008: Decisions CLI shows full audit

**Given** 5 promotions happened over 3 days
**When** `octoclawctl router decisions --since 7d` is called
**Then** the output lists all 5 events
**And** each shows: `model`, `tier`, `decision`, `reason`, `evidence`, `since`
**And** format supports `--format json` for scripting

---

## RT-W: Wizard

### RT-W-001: First-run wizard completes without crash

**Given** a fresh install with 3 models configured in OpenClaw
**When** `octoclawctl router wizard` is run and all prompts are answered with defaults
**Then** the wizard completes successfully
**And** `~/.openclaw/octoclaw/router-wizard.json` is written
**And** the file conforms to `RouterWizardConfigSchema`

### RT-W-002: Plan detection offers heuristic for common patterns

**Given** OpenClaw has model `openai/codex-chat-2024-12`
**When** wizard reaches Step 2 (plan confirmation)
**Then** for this model, the default answer offered is `isPlan: true` (based on `codex-*` pattern)
**And** user can override

### RT-W-003: Same-provider discovery adds new models on yes

**Given** OpenClaw has `openai/gpt-5.5` configured
**And** snapshot indicates `openai/gpt-5-mini` and `openai/gpt-5-nano` are available
**When** wizard reaches Step 7 and user answers `y`
**Then** `gpt-5-mini` and `gpt-5-nano` are added to configured allowlist
**And** they enter shadow state immediately

### RT-W-004: Budget entry validates format

**Given** wizard Step 3 prompts for budget
**When** user enters `"abc"` (invalid)
**Then** wizard prints error and re-prompts
**And** accepts: `100`, `100.50`, `$100`, `100 USD` (any of these work)
**And** stores canonical `{ monthly: 100.50, currency: "USD" }`

### RT-W-005: Incremental mode only asks for new models

**Given** wizard was completed with 3 models
**And** later OpenClaw adds a new model `mistral/medium-3`
**When** `octoclawctl router wizard --incremental` is run
**Then** wizard only asks about `mistral/medium-3`
**And** existing answers for other 3 models are preserved
**And** wizard file has both sets merged

### RT-W-006: Restricted models list is respected by recommend

**Given** wizard saved `restrictedModels: ["anthropic/claude-opus-4"]`
**When** `router.recommend(...)` runs
**Then** `claude-opus-4` is never recommended, even if it matches
**And** `rejectedModels` includes it with reason `"user_restricted"`

### RT-W-007: Privacy=local-only filters cloud models

**Given** wizard saved `privacy: "local_only"`
**When** `router.recommend(...)` runs
**Then** all cloud models (openai/*, anthropic/*, etc.) are filtered
**And** only local models (ollama/*, custom on-prem endpoints) are considered

---

## RT-O: User Override

### RT-O-001: Score override takes effect immediately

**Given** `router score override openai/gpt-5.5 complex=75` was executed
**When** the next `router.recommend(...)` for complexity=complex runs
**Then** `gpt-5.5`'s capability_score for the `complex` tier is 75 (not the snapshot value)
**And** the override is persisted to wizard config

### RT-O-002: Dispreferred is soft — only breaks ties

**Given** `gpt-5.5` is dispreferred-for `normal`
**And** `gpt-5.5` scores 85, while `glm-5.1` scores 82
**When** `router.recommend(...)` runs for complexity=normal
**Then** `gpt-5.5` is still recommended (its score is higher)
**Because** dispreferred only loses ties, not beats in score

### RT-O-003: Ban is hard — excludes completely

**Given** `gpt-5.5` is banned-for `normal`
**And** `gpt-5.5` scores 95, while `glm-5.1` scores 80
**When** `router.recommend(...)` runs for complexity=normal
**Then** `gpt-5.5` is excluded from the candidate set
**And** `glm-5.1` wins despite having a lower score
**And** `reasonCodes` includes `"user_ban_active"`

### RT-O-004: Score reset removes override

**Given** user had `gpt-5.5 complex=75` override
**When** `router score reset openai/gpt-5.5` is run
**Then** the override is cleared
**And** subsequent scoring uses the snapshot value

### RT-O-005: Override list is visible via CLI

**Given** user has made 3 overrides and 1 ban
**When** `octoclawctl router model list-overrides` is run
**Then** all 4 are shown with: model, tier, type, value, reason, since

---

## RT-$: Cost Reporting

### RT-$-001: Cost event recorded per API call

**Given** a delegate turn completes using `gpt-5.5`
**When** the task finishes successfully
**Then** a row is inserted into `cost.sqlite` with:
  - `ts` = completion timestamp
  - `model` = "openai/gpt-5.5"
  - `complexity` = "deep"
  - `input_tokens`, `output_tokens` = actual counts from API response
  - `cost_usd` = computed from pricing × tokens
  - `outcome` = "success"
  - `is_plan_call` = 0 or 1 based on plan info

### RT-$-002: Cost report groups by model

**Given** 100 events spread across 3 models: 50 gpt-5.5, 30 glm-5.1, 20 gpt-5-mini
**When** `octoclawctl router cost report --period 7d` runs
**Then** the output has a "by model" section
**And** each model shows total and percentage
**And** total matches sum of components

### RT-$-003: Cost report groups by complexity

**Given** events are spread across `simple: 20`, `normal: 50`, `complex: 25`, `deep: 5`
**When** cost report runs
**Then** the output has a "by complexity" section
**And** totals per tier are correct

### RT-$-004: Month-end prediction is shown

**Given** 7 days of spending: average $5/day
**And** today is day 20 of the month
**When** cost report runs
**Then** prediction for month-end is shown as `$5 × 30 = $150`
**And** the prediction uses a linear regression on 7-day data

### RT-$-005: Budget warning at 80% threshold

**Given** monthly budget is `$100`
**And** month-to-date spend is `$82`
**When** a delegate turn completes (which pushes total to $84)
**Then** the runtime emits a light notification (Slack or log)
**And** the notification includes "Budget 84% used ($84/$100)"

### RT-$-006: Budget exceeded triggers cost_first fallback

**Given** monthly budget is `$100`
**And** month-to-date spend is `$102`
**When** `router.recommend(...)` is called
**Then** only `plan-included` models are considered
**And** `reasonCodes` includes `"budget_exceeded_plan_only"`
**And** if no plan-included model available, `ignoredReason: "budget_exceeded_no_plan"`

### RT-$-007: Corrupted cost SQLite doesn't block router

**Given** `cost.sqlite` is corrupt
**When** `router.recommend(...)` is called
**Then** recommendation still works (cost score is treated as neutral)
**And** an error is logged
**And** cost report shows empty until cost.sqlite is restored

---

## RT-H: Health and Stability

### RT-H-001: Failure rate triggers cooldown at 20%

**Given** `gpt-5.5` has 10 consecutive calls, 3 of which are 5xx errors
**When** the health tracker updates
**Then** `gpt-5.5.health.recentFailureRate` ≥ 0.20
**And** `gpt-5.5.health.cooldown` = true
**And** cooldown TTL is 30 minutes

### RT-H-002: Rate limit triggers immediate cooldown

**Given** `gpt-5.5` returns 429 on one call
**When** health tracker updates
**Then** `gpt-5.5.health.cooldown` = true immediately (no 20% threshold needed for rate limits)
**And** cooldown TTL is 10 minutes (rate limits recover fast)

### RT-H-003: Cooldown expires and model is tried again

**Given** `gpt-5.5` entered cooldown 31 minutes ago
**When** `router.recommend(...)` is called
**Then** `gpt-5.5` is eligible again
**And** if it fails on next call, cooldown re-triggers

### RT-H-004: Slow model is downweighted but not excluded

**Given** `glm-5.1`'s p95 first-token time is `1500ms` (baseline was `800ms` — 2x slow)
**When** scoring runs
**Then** `glm-5.1.speed_score` is lowered by 20 points
**But** `glm-5.1` remains eligible (not excluded)

### RT-H-005: Equal-capability switch on instability

**Given** `gpt-5.5` (frontier) enters cooldown
**And** `claude-sonnet` (frontier) is healthy
**When** `router.recommend(...)` is called for complexity=deep
**Then** `claude-sonnet` is recommended (same tier, different provider)
**And** `reasonCodes` includes `"switched_provider_for_stability"`

---

## RT-I: Invariants (Cross-cutting)

### RT-I-001: Sub-agent model is shown in IM footer

**Given** a delegated task uses `openai/gpt-5-mini`
**When** the delegate notification is sent to Slack
**Then** the footer includes `Model: openai/gpt-5-mini`
**And** the footer is not empty

### RT-I-002: Main agent model is never silently switched

**Given** main agent is running `anthropic/claude-opus-4`
**When** Auto Router recommends switching to `claude-sonnet`
**Then** the main agent continues to use `claude-opus-4`
**And** the recommendation is logged but not applied
**And** `octoclawctl router recommendations` shows the suggestion

### RT-I-003: Shadow failure never affects live route

**Given** shadow event emission fails (disk full)
**When** a normal delegate turn happens
**Then** the live route (reply or delegate with recommended model) proceeds normally
**And** an error is logged
**And** the live decision result is byte-identical to a case where shadow succeeded

### RT-I-004: Judge failure never blocks the main flow

**Given** judge returns a parse failure
**When** `router.recommend(...)` is called
**Then** fallback rules are applied
**And** router still returns a valid recommendation
**And** the flow continues

### RT-I-005: No network call in user-message hot path

**Given** a user message arrives
**When** `router.recommend(...)` runs within the message-processing hot path
**Then** NO external HTTP calls are made (verify via HTTP spy)
**Only exceptions**:
- Local judge endpoint (if configured)
- That's it

### RT-I-006: All routing data stays local in V1

**Given** router has been running for days
**When** we scan all outbound requests from the router subsystem
**Then** no requests to any non-configured endpoint are observed
**(Specifically no telemetry servers, no data collection endpoints)**

---

## Test Organization

Each scenario maps to a specific test file:

```
packages/octoclaw-router/src/
  __tests__/
    semantic/
      judge-output.test.ts           # RT-J-001..015
    decision/
      capability.test.ts             # RT-C-001..007
      scoring.test.ts                # RT-S-001..010
      promotion.test.ts              # RT-P-001..008
      health.test.ts                 # RT-H-001..005
    integration/
      invariants.test.ts             # RT-I-001..006
      cost.test.ts                   # RT-$-001..007
      override.test.ts               # RT-O-001..005
      wizard.test.ts                 # RT-W-001..007
```

## Running all BDD tests

```bash
pnpm --filter @octoclaw/router test
# or for watch mode
pnpm --filter @octoclaw/router test:watch
```

All 70+ scenarios must pass before V1 is released.

---

## What to do when a scenario is ambiguous

**STOP and ask.** Do not guess. Examples of ambiguity:

- "Nominal value" but no numerical spec
- "Reasonable" without bounds
- "Should" without failure mode
- Edge case not covered

Ask via an issue/PR comment before implementing.
