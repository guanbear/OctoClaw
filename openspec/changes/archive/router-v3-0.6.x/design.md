# Design Notes: Auto Router v3

Short-form design rationale. Full design: `docs/octoclaw-auto-router-v3-design-2026-05-13.md`

## Why a new package instead of extending existing?

`@octoclaw/policy/judge` and `@octoclaw/policy/router-lite` are conceptually one pipeline (semantic → decision), but they live in separate paths and have different call signatures. The new `@octoclaw/router`:

1. **Clean abstraction**: one public API surface (`Router`), plugin-friendly via provider injection
2. **Future-proof for independent open-source**: can be lifted out to a standalone npm package without refactoring
3. **Simpler migration**: both old packages keep backward-compat shims while consumers gradually move to new API
4. **Better testing**: integration tests span semantic + decision in one place

## Why reduce judge to 3 fields?

Original plan (4-5 fields) optimized for information richness. Small model reality:

| Output size | JSON parse success rate (Qwen3 0.6B) |
|---|---|
| 3 fields | ~98-99% |
| 5 fields | ~94-96% |
| 7+ fields | < 90% |

Stability > richness in V1. `scenario` and `complexity_confidence` were both judged removable:
- `scenario`: V1 has no data to validate scenario dispatch anyway; better to add it in V2 with real data
- `complexity_confidence`: small models are unreliable on meta-judgments; just gives false confidence

## Why external data (leaderboards) as primary source?

OctoClaw will be open-sourced and used by people without local test infrastructure. We can't assume users will run a benchmarking harness. Therefore:

- **V1**: pack leaderboard data with the project, ship useful defaults
- **V2**: opt-in community data sharing for better defaults
- **V3**: self-calibrating based on community data

Local replay remains optional (always welcomed if available) but never required.

## Why reject tier 0/1/2 layered judge?

Historical pattern: layered systems degrade into keyword patches. When the Tier 0 "fast path" misses an edge case, the fix is adding another keyword to the bypass list, which becomes a maintenance nightmare.

Single-layer judge with strict fallback is simpler, more predictable, and the performance gain (~250ms) is not worth the complexity cost.

## Why automatic sub-agent switching but not main-agent?

User experience and trust:

- **Sub-agent**: user already delegated it; system decides execution details
- **Main agent**: user is directly talking to this entity; silent model swap feels deceptive

Showing sub-agent model choice in the footer gives transparency without friction.

## Why data-driven auto-promotion?

User explicitly rejected:
- Fixed thresholds ("5 days / 100 samples") — too rigid
- Manual promotion — defeats the purpose
- Deep LLM review in V1 — too expensive and slow

Chosen: strict automatic rules + full decision audit trail. User reviews decisions via CLI.

## Why local-only data in V1?

Privacy and open-source trust. Users have to trust the package they install. V1 stores everything locally (cost SQLite, shadow JSONL, decision log). V2+ will add opt-in community aggregation, but only when user explicitly enables it.

## Why plugin architecture from day one?

Scaling out beyond OctoClaw. Main open-source play: eventually make `agent-router` or `policy-router` a general-purpose LLM router usable by Continue / Aider / Cursor / AutoGen. Building for extensibility now avoids rewriting later.

## Trade-offs accepted

| Trade-off | Choice |
|---|---|
| Judge richness vs parse stability | Stability wins (3 fields) |
| Cost of auto-refresh vs data freshness | Refresh on config change + 12h background |
| Scenario specificity vs V1 simplicity | Drop scenario in V1 (V2 will add with real data) |
| Multi-mode flexibility vs V1 complexity | Single balanced mode in V1 |
| Community data value vs privacy | Local-only V1, opt-in V2+ |

## Hard constraints encoded in API design

- `RouterOptions.capabilityProvider` is mandatory but has a default (packaged snapshot). Can't instantiate without one.
- `CostProvider` writes to local SQLite only; no network option in V1 API.
- `LeaderboardLoader` always returns a valid snapshot (can be empty), never null.
- `ShadowStorage` append-only; no delete API.
- Score override doesn't go through the config file; it's a separate call so it's revocable.
