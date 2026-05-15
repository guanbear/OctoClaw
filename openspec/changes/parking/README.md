# Parking Lot

Designs and proposals deferred from the current release scope. They are not
forgotten — each one records the trigger that should bring it back into active
work.

## Inventory

| Change id | Why parked | Trigger to revisit |
|-----------|-----------|---------------------|
| `router-v3-wizard-and-release` | Interactive 7-step wizard, plan quota auto-poll, full release polish need real install traffic to validate | After Auto Router V3 ships shadow data from ≥ 5 active installs |

If you decide to reactivate a parked change:

1. Move the directory back up to `openspec/changes/<id>/`.
2. Update `proposal.md` with the new release target.
3. Re-validate the design against current code (the codebase has likely moved).
4. Re-scope `tasks.md` if the parked plan is now obsolete.
