# OctoClaw x ClawTeam Integration Analysis (2026-03-25)

## 1. What We Confirmed Today

### 1.1 Why some OctoClaw replies looked too thin

The problem was not "subagent did no work".

The real chain was:

1. subagent produced a full report in `report_path`
2. subagent returned a short `---RESULT---`
3. runtime extension preferred `handoff.reply_text` / `handoff.summary`
4. main agent did not always re-read `report_path` and compose a final user-facing answer

So the user often saw a delivery receipt or a short summary, not a final polished answer.

### 1.2 Was long-form file handoff already supported in older versions?

Yes.

Long-form delivery through shared files was already part of the OctoClaw direction after the validated spawn wrapper work:

- short result for reliable A2A handoff
- long report written to shared file
- `report_path` returned to the parent

So the regression was not "file handoff disappeared".
The regression was "the parent did not consistently consume the file and finalize the answer".

### 1.3 What we changed today

- Research / analysis / writing tasks now allow more user-ready summaries instead of only ultra-short 2-5 sentence stubs.
- Skill rules now explicitly require the main agent to read `report_path` before finalizing research-style answers.
- Runtime extension now appends a compact report excerpt when `report_path` exists.

This preserves the old "artifact file" design while improving final user-visible answer quality.

## 2. OctoClaw vs ClawTeam

### 2.1 OctoClaw strengths

- explicit routing: `direct / runner / spawn_single / spawn_multi`
- cost-aware model selection
- runner fast path for low-latency observation work
- patrol and self-healing
- budget / plan-state awareness
- replay / eval direction

### 2.2 ClawTeam strengths

- explicit collaboration primitives
- task / inbox / board mental model
- better "collect deliverables" workflow
- dependency-oriented team execution
- strong interactive multi-agent ergonomics with tmux

### 2.3 Key conclusion

The best path is not replacing OctoClaw with ClawTeam.

The better path is:

- keep OctoClaw as the orchestration and runtime core
- absorb ClawTeam collaboration surfaces where OctoClaw is weaker

## 3. What tmux actually does in ClawTeam

tmux is not the task store and not the mailbox.

tmux is mainly the interactive process layer:

- one long-lived terminal per worker
- easy attach / inspect / monitor
- tiled swarm dashboard
- session survives SSH disconnect

ClawTeam task and inbox concepts are fundamentally file/CLI driven.

So:

- `task/inbox` does not strictly require tmux
- interactive swarm spawning usually does

## 4. Integration Paths

### Path A: Mirror only

OctoClaw keeps its own truth model and mirrors tasks into a ClawTeam-like layout:

- `tasks/`
- `inbox/`
- `events/`
- `board.json`

This is low-risk and works without installing `clawteam`.

### Path B: Use ClawTeam task/inbox CLI as an optional backend

OctoClaw still owns routing, runner, patrol, and model policy.
But bridge actions can optionally call `clawteam` CLI for:

- team init
- task sync
- inbox send

This should be optional and backend-driven:

- `mirror`
- `hybrid`
- `cli`

Why optional:

- current environments may not have `clawteam` installed
- exact CLI usage may vary across upstream/fork versions
- OctoClaw should keep working even when ClawTeam is absent

## 5. What We Implemented Today

### 5.1 Final-answer fixes

- `lib/octoclaw_spawn.py`
- `lib/spawn-template.md`
- `extensions/octoclaw-runtime/index.js`
- `lib/report_excerpt.py`
- `SKILL.md`

### 5.2 ClawTeam-style bridge validation

- `lib/clawteam_bridge.py`
- `lib/task-state-update.py`
- `lib/status.sh`
- `lib/octopus_config.py`

Current bridge modes:

- `mirror`: local mirrored task/inbox/events only
- `hybrid`: keep local mirror and also attempt CLI hooks
- `cli`: prefer CLI hooks, still retain mirror for observability

## 6. Why dynamic model selection belongs to OctoClaw

ClawTeam can support model/profile choice, but OctoClaw is better suited for runtime model policy because it already has:

- route awareness
- role awareness
- speed / pricing / benchmark inputs
- plan / quota / budget state
- runner vs subagent execution surfaces

So the likely long-term shape is:

- ClawTeam supplies collaboration primitives
- OctoClaw supplies routing + model policy

## 7. Future PR Direction

### 7.1 Good upstream contribution target for ClawTeam

Provide a generic resolver hook before spawn, for example:

- profile resolver command
- model resolver command
- spawn pre-hook

This would let any external system choose runtime/profile/model.

### 7.2 Good contribution target for ClawTeam-OpenClaw

Integrate OctoClaw-style role-aware and budget-aware model routing:

- role -> model/profile mapping
- cost / quality / private / auto modes
- subscription / quota / budget awareness
- maybe a runner-like fast path for observation tasks

## 8. What `clawteam launch` templates can express

The template loader accepts:

- `template.command`
- `template.backend`
- `template.leader`
- `template.agents`
- `template.tasks`

Each agent can also override the global command with its own `agent.command`.
That means templates can effectively choose an OpenClaw profile through the startup command, for example:

- `["openclaw", "--profile", "research", "tui"]`
- `["openclaw", "--profile", "coding", "tui"]`

So yes, a TOML team prototype can carry model-selection intent, but today it is expressed as command/profile selection rather than a first-class `model = "..."` field.
This matches the recommended OctoClaw integration:

- OctoClaw computes `label / tier / model / thinking`
- OctoClaw maps that decision to `--profile` where appropriate
- ClawTeam launch/spawn carries the final executable command

## 9. Recommended Next Step

Short term:

- keep `mirror` as safe default
- validate `hybrid` when `clawteam` is installed

Medium term:

- connect real `clawteam task/inbox` commands
- compare whether CLI-native collaboration materially improves result collection over the current mirrored inbox

Long term:

- contribute generic resolver hooks upstream
- contribute OpenClaw-specific dynamic model policy to `ClawTeam-OpenClaw`
