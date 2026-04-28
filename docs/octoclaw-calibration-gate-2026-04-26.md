# OctoClaw Calibration Gate

## Purpose

The calibration gate compares a **baseline** evaluation report against a **candidate** evaluation report and produces a gate result (`pass` / `fail` / `unknown`) with a recommendation. It is a pure offline tool — no live policy mutation, no API calls, no self-tuning.

## CLI

```bash
octoclawctl calibration-gate \
  --baseline baseline-report.json \
  --candidate candidate-report.json \
  --output-dir ./reports/ \
  [--format markdown|json]
```

### Required arguments

| Flag | Description |
|------|-------------|
| `--baseline` | Path to a JSON file containing the baseline report |
| `--candidate` | Path to a JSON file containing the candidate report |
| `--output-dir` | Directory for output artifacts |
| `--format` | Output format: `markdown` (default) or `json` |

### Input file format

The `--baseline` and `--candidate` files are JSON objects containing optional D3 nightly, D4 slack acceptance, and explicit cost/latency metrics:

```json
{
  "nightly": { ... NightlyReport ... },
  "slackAcceptance": { ... SlackAcceptanceReport ... },
  "metrics": {
    "latencyMs": 1000,
    "costUsd": 0.12
  },
  "rollbackTarget": "baseline-model-profile-map-v1"
}
```

The CLI accepts this aggregate wrapper, a raw D3 `NightlyReport`, or a raw D4 `SlackAcceptanceReport`. Missing reports or metrics cause their corresponding dimensions to be `unknown`. `unknown` is never treated as `pass`.

### Output

Two files are written to `--output-dir`:

- `calibration-YYYY-MM-DDTHH-MM-SS.json` — structured JSON report
- `calibration-YYYY-MM-DDTHH-MM-SS.md` — human-readable markdown report

## Calibration Dimensions

| Dimension | Source | Pass condition |
|-----------|--------|----------------|
| Latency | `metrics.latencyMs`, else D3 `RouteCommitAckLane.ackMsP95` (or P50) | Candidate <= baseline |
| Cost | `metrics.costUsd` | Candidate <= baseline |
| Acceptance | D4 `SlackAcceptanceReport` overall gate + per-case status | No regression |
| No-Lie | D4 `no_lie_materialized_no_spawn` case + D3 `ExecutionTransitionLane.materializedNoSpawn` count | No regression |
| Context Pollution | D3 `DelegationHealthLane` parent context tokens + pollution count | Candidate <= baseline |
| Fallback/Timeout | D3 `ExecutionTransitionLane` timedOut + stale counts | Candidate <= baseline |

## Gate Logic

- Overall gate is `fail` if any dimension is `fail`
- Overall gate is `unknown` if any dimension is `unknown` (and none is `fail`)
- Overall gate is `pass` only if all dimensions are `pass`
- `unknown` is never treated as `pass`

## Recommendation

| Overall Gate | Status | Meaning |
|-------------|--------|---------|
| `pass` | `recommend_only` | Candidate is not worse; keep rollout recommend-only |
| `fail` | `blocked` | Candidate regressed; block promotion |
| `unknown` | `unknown` | Insufficient evidence; do not promote |

## Rollback Target

When the gate passes, `rollbackTarget` is set to the baseline's explicit `rollbackTarget`, nightly report ID, or slack report ID. This identifies the known-good configuration state to revert to if the candidate's promotion causes issues.

When the gate fails or is unknown, `rollbackTarget` is `null` — no promotion is recommended.

## Known Limitations

- **Cost comparison**: Cost requires explicit `metrics.costUsd` in both baseline and candidate, or reviewer-supplied metrics derived from the D3 cost/speed baseline. Missing cost data makes the gate `unknown`, not `pass`.
- **Statistical comparison**: Latency comparison uses aggregate percentiles (P50/P95). Different sample sizes between baseline and candidate may affect comparison accuracy.

## Safety Guarantees

- The gate function is pure: no I/O, no API calls, no state mutation
- No code path changes live model/rule policy automatically
- All outputs are reports/recommendations only
- `unknown` never equals `pass`
