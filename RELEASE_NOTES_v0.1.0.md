# OctoClaw v0.1.0

First public release of OctoClaw, a cost-sensitive multi-agent orchestration layer for OpenClaw.

## Highlights

- Role-aware model routing instead of generic proxy-only switching
- Persistent runner fast-path for lightweight shell / API / status tasks
- Session-aware patrol with steer-before-redispatch
- Generic text status rendering for non-card environments
- Optional notification backend and open-source friendly minimal path

## Recommended First Use

1. Install the skill
2. Keep notification backend as `auto` or `none`
3. Let `runner-daemon` run in the background
4. Use `dispatch_task.py` as the unified dispatch entry
5. Run `eval_suite.py` once to capture a baseline report

## Notes

- Internal implementation milestone remains `v1.5.0`
- Public release tag recommendation: `v0.1.0`
- Feishu remains supported, but text-mode status and runner flow are the recommended open-source default path
