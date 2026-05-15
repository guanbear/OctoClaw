# Tasks (PARKED)

> Parked 2026-05-15. None of these run until the parking trigger is met
> (see `proposal.md`). Inherited from `archive/router-v3-0.6.x/tasks.md`
> Phases D and E.

## D1. Full interactive 7-step wizard

- [ ] `octoclawctl router wizard` — full 7-step flow (UI / prompts).
- [ ] `octoclawctl router wizard --incremental` — only asks for new models.
- [ ] Auto-trigger on `~/.openclaw/openclaw.json` change (detect new
      providers/models).

## D2. Plan type detection heuristics

- [ ] Model name pattern → plan type suggestion.
- [ ] User confirms/overrides in wizard.

## D6. Plan quota protection

- [ ] Poll provider usage API on interval (where supported).
- [ ] < 10% remaining → switch to non-plan models + light notification.
- [ ] Test with mocked provider.

## E1. End-to-end smoke

- [ ] Fresh install → wizard → first task → check cost report shows 1 entry.
- [ ] 10 delegate turns → cost report shows breakdown, shadow has data.
- [ ] 30+ turns → verify auto-promotion triggers.
- [ ] Wizard + override + decisions all work as documented.

## E2. Documentation refresh

- [ ] Update `README.md` Auto Router section once wizard ships.
- [ ] Update `SKILL.md` with new CLI commands.

## E4. Release polish

- [ ] Coverage report on `@octoclaw/router` > 80%.
- [ ] Integration tests for full pipeline.
