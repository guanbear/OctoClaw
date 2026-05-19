# BDD: Migration Onboarding, Judge Presets, And Feishu

## MOF-001: GPT Mini Judge Preset Is Offered

**Given** the user runs interactive `octoclawctl init`

**When** the Judge model step is rendered

**Then** the choices include `gpt-5.4-mini`

**And** the label says it is remote, cheap, fast, and no-reasoning

**And** `glm-4.7` is not offered as a preset

## MOF-002: GPT Mini Judge Preset Stores Remote Config

**Given** a compatible OpenAI-style provider is configured in OpenClaw

**When** the user selects the `gpt-5.4-mini` Judge preset

**Then** OctoClaw stores `judge.enabled=true`

**And** it stores `judge.modelId="gpt-5.4-mini"`

**And** it stores `judge.local=false`

**And** it does not write a new OpenClaw fallback order

## MOF-003: Cliproxy Provider Is Preferred Conservatively

**Given** multiple compatible OpenAI-style providers are available

**And** one provider id or base URL contains `cliproxyapi`

**When** provider discovery selects a base URL for the `gpt-5.4-mini` preset

**Then** it selects the `cliproxyapi` provider

**And** if compatibility is ambiguous it asks the user instead of guessing

## MOF-004: Judge Calls Stay No-Reasoning

**Given** Judge is configured with an OpenAI-compatible endpoint

**When** OctoClaw calls the Judge

**Then** the request payload includes `reasoning_effort="none"`

**And** the response parser still requires structured Judge output

## MOF-005: Missing Judge Is A Readiness Warning

**Given** a migrated install has no Judge config

**When** readiness is checked

**Then** the Judge check is `warn`

**And** the remediation mentions `octoclawctl init`

**And** the remediation mentions the `gpt-5.4-mini` remote preset

**And** install does not fail solely because Judge is missing

## MOF-006: Runtime Plugin Missing Is A Readiness Failure

**Given** OpenClaw is installed

**But** the OctoClaw runtime plugin main file cannot be loaded

**When** readiness is checked

**Then** the runtime plugin check is `fail`

**And** the remediation points to deploy/install

## MOF-007: Router Wizard Warns About Missing Judge Without Writing Judge Config

**Given** router onboarding starts in Slack

**And** Judge is missing

**When** the onboarding message is rendered

**Then** it includes a visible Judge warning

**And** it offers setup guidance

**And** pressing router wizard buttons only writes router wizard config

**And** it does not write `judge.enabled=true`

## MOF-008: Healthy Judge Suppresses Onboarding Warning

**Given** Judge config is present and readiness is healthy

**When** Slack router onboarding is rendered

**Then** no Judge-missing warning is shown

**And** existing router wizard steps behave unchanged

## MOF-009: Feishu Onboarding Renders A Card

**Given** the inbound session is a Feishu session

**When** router onboarding is sent

**Then** OctoClaw sends a Feishu card payload

**And** the card contains buttons for starting questions, using defaults, reminding later, and skipping

**And** the text fallback contains the same essential setup instruction

## MOF-010: Feishu Wizard Button Advances The Same State

**Given** a Feishu onboarding card was sent

**When** the user clicks the start-questions button

**Then** the callback decodes to the same semantic action as Slack start-questions

**And** the wizard state advances to the first question

**And** Feishu user ids retain original case

## MOF-011: Feishu Duplicate Click Is Idempotent

**Given** a Feishu wizard step has already been answered

**When** the same card button is clicked again

**Then** OctoClaw replies `这一步已经回答过`

**And** the stored wizard answers are not changed

## MOF-012: Feishu Unknown Action Is Safe

**Given** a Feishu card callback contains an unknown action id

**When** OctoClaw handles the callback

**Then** it sends a short error message

**And** it does not mutate router wizard state

## MOF-013: Feishu Card Failure Falls Back To Text

**Given** Feishu card delivery fails

**When** onboarding or status panel is delivered

**Then** OctoClaw sends a text fallback if the channel target is resolvable

**And** the fallback includes the manual CLI command

## MOF-014: Status Panel Renders For Feishu

**Given** a runtime status projection is available

**When** the status panel is requested from a Feishu session

**Then** OctoClaw renders a Feishu card

**And** the card shows state, route, model/worker when available, and native substrate summary

**And** it does not claim a child run is executing without native evidence

## MOF-015: Status Panel Keeps Text Fallback

**Given** rich rendering is unsupported or card delivery fails

**When** status panel output is delivered

**Then** OctoClaw sends text output

**And** the text output preserves existing status semantics

## MOF-016: Install Readiness Reports All Setup Surfaces

**Given** `octoclawctl install` or `deploy` finishes validation

**When** the command prints its closeout summary

**Then** it includes OpenClaw, runtime plugin, Judge, Slack, Feishu, router wizard, and status panel readiness

**And** no auth token or API key is printed

## MOF-017: Non-Interactive Install Does Not Prompt For Secrets

**Given** install/deploy runs in non-interactive mode

**When** Judge or IM tokens are missing

**Then** OctoClaw prints remediation commands

**And** it does not prompt for API keys

**And** it does not write placeholder credentials

## MOF-018: Legacy Judge Fast Migration Still Works

**Given** `~/.openclaw/judge-fast.json` exists with a valid model id and base URL

**And** unified OctoClaw Judge config is disabled

**When** config is synchronized to the OpenClaw plugin config

**Then** the legacy Judge config is imported

**And** readiness treats Judge as configured

## MOF-019: Feishu Status And Wizard Do Not Require Streaming

**Given** Feishu adapter has `canStreamNative=false`

**When** onboarding or status cards are delivered

**Then** OctoClaw uses card/text messages

**And** it does not attempt message streaming or in-place update

## MOF-020: Fallback Order Is Never Mutated Automatically

**Given** readiness or onboarding detects a better Judge or router model option

**When** it produces guidance

**Then** it may show commands or buttons requiring explicit user action

**And** it never runs `openclaw models fallbacks add`

**And** it never runs `openclaw models fallbacks remove`
