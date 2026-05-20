# BDD: Stability Smoke v2

## Case Pack And Catalog

### SSV2-001: Catalog Post-Deploy Pack Loads

**Given** Stability Smoke v2 is installed

**When** the post-deploy catalog pack is loaded

**Then** it contains `reply_core.simple_chat`, `streaming_core.long_reply`, `delegate_core.native_final`, `footer_truth.current_model`, and `status_core.read_only`

**And** every case has severity `blocker` or `major`

### SSV2-002: Invalid AI Case Pack Fails Closed

**Given** GLM-5.1 returns a case pack with an unknown mode

**When** the pack is validated

**Then** the pack is rejected

**And** the nightly catalog pack is used instead

**And** the report records `smoke_spec_mismatch`

### SSV2-003: Live Case Cap Is Enforced

**Given** the nightly config allows at most 8 live Slack cases

**When** an AI-generated pack contains 12 live Slack cases

**Then** validation fails closed

**And** no extra live Slack prompts are sent

### SSV2-004: Secrets Are Redacted From Reports

**Given** a failure packet contains a token-like string in an error message

**When** the stability report is written

**Then** the token value is replaced with `[REDACTED]`

**And** the report does not contain full prompts or raw transcripts

## Slack Evidence

### SSV2-010: Reply Core Does Not Spawn

**Given** the live Slack case `reply_core.simple_chat` is run

**When** OctoClaw replies

**Then** the reply is in the same thread

**And** no spawn evidence exists

**And** the footer route is `reply`

### SSV2-011: Streaming Does Not Emit Misleading ACK

**Given** Slack streaming partial mode is enabled

**When** the live Slack case `streaming_core.long_reply` is run

**Then** OctoClaw does not send `任务已启动。`

**And** it does not send `还没好，再等等`

**And** the final response is delivered

### SSV2-012: Delegate Requires Native Spawn Evidence

**Given** the live Slack case `delegate_core.native_final` is run

**When** the final reply is accepted

**Then** replay evidence includes WorkContract id

**And** replay evidence includes spawn intent id

**And** replay evidence includes child session key

**And** footer `via` is `native_announce`

### SSV2-013: Delegate Footer Without Spawn Fails

**Given** a Slack transcript contains footer `route=delegate`

**But** replay evidence has no spawn intent or child session

**When** Stability Smoke v2 scores the case

**Then** the case fails with `delegate_footer_without_spawn`

### SSV2-014: Native Final Duplicate Is A Failure

**Given** native child final was delivered

**And** a parent echo appears after the native final

**When** the case is scored

**Then** the case fails with `parent_echo_after_native_final`

### SSV2-015: Footer Model Must Match Replay Truth

**Given** replay records the final model as `zhipu/GLM-5.1`

**When** Slack footer says `model=cliproxyapi/gpt-5.5`

**Then** the case fails with `model_footer_mismatch`

## Synthetic And Replay Stability

### SSV2-020: Escaped Spawn JSON Regression Is Covered

**Given** a synthetic delegate spawn argument contains copied planner JSON with double-escaped newlines

**When** spawn intent matching is scored

**Then** the intent is accepted if canonical content matches

**And** no `spawn_missing` failure is emitted

### SSV2-021: Late ACK Is Classified Separately

**Given** accepted delegate ACK arrives after the case ACK deadline

**When** the case final still succeeds

**Then** the case emits `ack_late`

**And** the report keeps final delivery evidence

### SSV2-022: Provider 402 Is Not A Bare Slack Reply

**Given** a model call returns provider 402

**When** fallback is available

**Then** OctoClaw falls back or reports a clear fallback reason

**And** Slack does not receive only `402 status code (no body)`

### SSV2-023: Previous Run Shutting Down Is Classified

**Given** OpenClaw returns `Previous run is still shutting down`

**When** a Slack request is sent during restart

**Then** Stability Smoke v2 emits `gateway_restart_drop`

**And** the report includes the restart-window timing

### SSV2-024: Wizard Start Cannot Immediately Complete

**Given** the wizard start button is clicked

**When** wizard state is fresh or reset

**Then** the next visible state is the first question

**And** the case fails with `wizard_flow_stuck` if it jumps directly to completed

### SSV2-025: Replay Missing Makes Replay Lanes Unknown

**Given** live Slack cases run successfully

**But** the replay file is missing

**When** the stability report is generated

**Then** live Slack lanes can pass

**And** replay-backed lanes are `unknown`, not fake pass

### SSV2-026: Existing Nightly Classifiers Are Reused

**Given** a replay file contains route, ACK, transition, delegation, and delivery events

**When** nightly stability runs

**Then** the stability report includes the existing nightly lane results

**And** it does not duplicate incompatible replay classification logic

## Router And Wizard

### SSV2-030: Simple Model Choice Uses Current Router State

**Given** router wizard config and OpenClaw model list are available

**When** a simple delegate case is scored

**Then** the expected model is computed from config, health, availability, and fallback order

**And** the expected model is not hard-coded in the test

### SSV2-031: Cooldown Excludes A Model From Expected Live Choice

**Given** `cliproxyapi/gpt-5.5` is in cooldown

**When** a deep delegate case is scored

**Then** `cliproxyapi/gpt-5.5` is not the expected live model

**And** the report includes the cooldown reason

### SSV2-032: Unconfigured Discovered Model Cannot Be Expected Live

**Given** `cliproxyapi/gpt-5.4-mini` is discovered but not configured

**When** model choice expectation is computed

**Then** it can be reported as a proposal candidate

**But** it cannot be the expected live model

### SSV2-033: Wizard Duplicate Click Is Idempotent

**Given** a wizard step has already been answered

**When** the same button click is replayed

**Then** the reply says `这一步已经回答过`

**And** stored answers are unchanged

### SSV2-034: Wizard Check Does Not Block Routing

**Given** the wizard state file is corrupt

**When** a normal Slack reply case runs

**Then** routing still proceeds

**And** the wizard lane records a failure or warning

## AI Review

### SSV2-040: GLM Generates The Nightly Case Pack

**Given** recent report and replay summaries are available

**When** nightly case selection runs

**Then** GLM-5.1 is used by default

**And** the generated pack is schema-validated before execution

### SSV2-041: Low Confidence Escalates Review To GPT

**Given** GLM-5.1 returns a valid pack but low confidence diagnosis

**When** review is run

**Then** GPT-5.5 may be used for review

**And** the number of live Slack cases is not increased by escalation

### SSV2-042: Environment Issue Does Not Trigger Fix Draft

**Given** the only blocker is missing Slack token

**When** AI review classifies failures

**Then** the failure is `environment_issue`

**And** fix-draft is skipped

### SSV2-043: Runtime Bug Can Trigger Fix Draft

**Given** a blocker failure is classified as `runtime_bug`

**And** it has replay evidence and a focused owner area

**When** fix-draft runs

**Then** Codex receives the failure packet and related files

**And** it must not commit, push, deploy, restart Gateway, or mutate OpenClaw config

### SSV2-044: Large Or Risky Fix Draft Needs Human Review

**Given** fix-draft produces a patch touching more than 5 files

**Or** it changes more than 300 lines

**Or** it touches runtime delegate, ACK, or router hot paths

**When** the draft is scored

**Then** it is marked `needs_human_review`

**And** no commit or deploy action is attempted

### SSV2-045: Passing Fix Draft Still Requires User Confirmation

**Given** fix-draft produces a small patch

**And** targeted validation passes

**When** the nightly Slack summary is posted

**Then** it asks the user to confirm before commit/deploy

**And** the scheduled job stops without committing

### SSV2-046: AI Review Does Not Use Raw Transcript

**Given** a Slack acceptance report contains transcript text

**When** the AI review prompt is built

**Then** the prompt includes structured failure packets only

**And** it excludes raw transcript and worker chain-of-thought fields

## Scheduling

### SSV2-050: Post-Deploy Command Runs Core Live Pack

**Given** Slack acceptance env is configured

**When** `octoclawctl stability post-deploy` runs

**Then** it runs only the core live Slack pack

**And** it fails on any blocker case failure

### SSV2-051: Nightly Command Runs Mixed Evidence

**Given** nightly stability is scheduled

**When** `octoclawctl stability nightly` runs

**Then** it runs selected live Slack cases, synthetic fixtures, replay lanes, router model checks, wizard checks, and AI review

### SSV2-052: Full Acceptance Runs Every 3 Days

**Given** the OpenClaw scheduled task is installed

**When** full acceptance is configured

**Then** its cadence is every 3 days

**And** it runs the broader wizard, provider, restart, and failure-injection scenarios

### SSV2-053: Missing Slack Env Still Runs Non-Live Lanes

**Given** Slack token env is missing

**When** nightly stability runs

**Then** live Slack cases are skipped as `environment_unhealthy`

**And** synthetic, replay, router, wizard, and AI review lanes still run where possible

### SSV2-054: Scheduled Task Posts Compact Slack Summary

**Given** nightly stability writes a report

**When** scheduled delivery runs

**Then** it posts a compact sanitized Slack summary

**And** the summary links or points to local artifact paths
