# Official Capability Snapshot Publishing Design

## Goal

Publish OctoClaw-maintained router capability snapshots to GitHub Pages and let installed projects consume the official snapshot without requiring users to run benchmark collectors or provide benchmark API keys.

## Architecture

The package keeps shipping a bundled seed snapshot for offline and first-run behavior. A GitHub Actions workflow generates the official capability snapshot on a weekly or manual cadence, validates it with the capability smoke suite, and publishes static files under `capability/` on GitHub Pages. `octoclawctl router capability refresh` downloads the official manifest/snapshot by default, validates the payload, and writes the existing local cache files. Maintainers can still run local source recomputation through an explicit `--from-sources` mode.

## Data Flow

The published site contains `leaderboard-snapshot.json`, `leaderboard-summary.json`, and `leaderboard-manifest.json`. The manifest records schema version, generated time, model count, SHA-256 for the snapshot, and URL fields. The CLI first tries the official manifest URL, verifies the referenced snapshot, and writes `model-intel-snapshot.json` plus `capability-catalog-full.json` to the router-lite cache directory. If the official fetch fails, routing continues to use the existing packaged snapshot or the last local cache.

## Error Handling

Network failures, bad manifest JSON, SHA mismatch, or schema mismatch fail the refresh command with a clear error. They do not affect runtime routing because runtime selection already falls back to packaged/local snapshots. Benchmark-source recomputation remains a maintainer path, so normal users do not need Artificial Analysis, LM Arena, Hugging Face, or other benchmark credentials.

## Testing

Tests cover default official download, SHA validation, explicit `--from-sources` legacy recompute, and GitHub Pages workflow command shape. Existing capability smoke/watchlist tests continue to validate the scoring output.
