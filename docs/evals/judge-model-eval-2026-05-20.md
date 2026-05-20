# OpenClaw Judge Model Evaluation - 2026-05-20

Purpose: compare low-latency remote Flash-style models against the current OpenClaw/OctoClaw local judge task.

Current production baseline remains:

```text
model: qwen3-judge:0.6b-q4km
runtime: local Ollama
previous result: route 9/10, strict 7/10, average about 0.9 s
```

## Harness

The OpenAI-compatible judge harness lives outside the repo at:

```text
/Users/guanbear/models/judge-evals/scripts/eval-openclaw-judge-openai-compatible.mjs
```

It uses the current real OpenClaw prompt builders:

```text
buildLocalJudgeSystemPrompt()
buildLocalJudgeUserPrompt()
```

The current judge prompt asks only for:

```json
{
  "route": "reply|delegate",
  "confidence": 0.0,
  "complexity": "simple|normal|complex|deep"
}
```

The 10-case suite covers conceptual replies, ambiguous scope, code/test delegation, local model investigation, fresh research, config review, status/provenance follow-ups, and current-config reads.

## OpenRouter

Endpoint:

```text
https://openrouter.ai/api/v1
```

Account state during this run:

```text
credits before paid run: total_credits=5, total_usage=0
credits after paid run: total_credits=5, total_usage=0.016914279
```

Free Flash probe:

```text
deepseek/deepseek-v4-flash:free
result: 10/10 calls failed
error: HTTP 429 upstream temporarily rate-limited
provider: Crucible
```

Paid Flash results:

| Model | Completed | Valid JSON | Route | Avg Latency | Min | Max | >2 s | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `xiaomi/mimo-v2-flash` | 10/10 | 10/10 | 8/10 | 1759 ms | 839 ms | 3147 ms | 5/10 | Best OpenRouter speed/quality balance in this run |
| `qwen/qwen3.6-flash` | 10/10 | 10/10 | 9/10 | 8441 ms | 1531 ms | 23035 ms | 8/10 | Accurate, but long tail |
| `qwen/qwen3.5-flash-02-23` | 9/10 | 9/10 | 9/10 | 10706 ms | 6651 ms | 16593 ms | 9/9 | One timeout; accurate when completed |
| `deepseek/deepseek-v4-flash` | 10/10 | 9/10 | 8/10 | 5087 ms | 2618 ms | 13671 ms | 10/10 | One truncated/invalid JSON |
| `stepfun/step-3.5-flash` | 10/10 | 0/10 | 0/10 | 2518 ms | 1342 ms | 3129 ms | 7/10 | JSON mode unsupported; plain mode did not return parseable JSON |
| `google/gemini-2.5-flash-lite` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | HTTP 403 |
| `google/gemini-3-flash-preview` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | HTTP 403 |
| `google/gemini-3.5-flash` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | HTTP 403 |

Per-case misses:

| Model | Misses |
| --- | --- |
| `xiaomi/mimo-v2-flash` | `clarify_scope` expected reply but got delegate; `delegate_status_no_support` expected delegate but got reply |
| `qwen/qwen3.6-flash` | `clarify_scope` expected reply but got delegate |
| `qwen/qwen3.5-flash-02-23` | One case timed out; completed cases all matched route |
| `deepseek/deepseek-v4-flash` | `clarify_scope` expected reply but got delegate; `delegate_code_fix` returned truncated JSON |
| `stepfun/step-3.5-flash` | All cases failed schema/JSON parsing |

Interpretation:

- `xiaomi/mimo-v2-flash` is the only OpenRouter candidate close to the 2 s judge budget, but half the cases still exceeded 2 s.
- Qwen Flash models are accurate but too slow for hot-path judge.
- DeepSeek V4 Flash is slower than MiMo and had one truncated JSON result.
- Step 3.5 Flash should not be used for this JSON-only judge shape.
- Gemini Flash models were blocked by the provider path through OpenRouter for this account/environment.

## GLM-4.5-Air

Endpoint:

```text
https://open.bigmodel.cn/api/coding/paas/v4
model: glm-4.5-air
required option: {"thinking":{"type":"disabled"}}
```

Results:

```text
first run: 8/10 completed, 8/10 valid JSON, 6/10 route, average 1253 ms among completed cases
two timeout cases retried: both completed under 2 s and matched route
with one retry: 10/10 valid JSON, 8/10 route, average about 1359 ms
```

Interpretation:

- Much better than GLM-4.7 for this judge task.
- Fast when it returns.
- First-pass 30 s stalls remain an operational risk.
- Suitable only behind a short timeout and fallback if used as remote judge.

## Recommendation

Keep `qwen3-judge:0.6b-q4km` as the hot-path local judge.

Potential remote/shadow candidates:

```text
1. glm-4.5-air with thinking disabled
2. xiaomi/mimo-v2-flash through OpenRouter
3. qwen/qwen3.6-flash through OpenRouter, only if latency is acceptable
4. gpt-5.4-mini as accurate but slower remote adjudicator
```

Do not currently use:

```text
google/gemini-*flash* via OpenRouter
stepfun/step-3.5-flash
deepseek/deepseek-v4-flash:free
gpt-5.4-nano through Codex/OAuth/OmniRoute
```
