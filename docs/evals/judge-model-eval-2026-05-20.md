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

## 2026-05-21 Prompt Alignment Retest

Change under test:

```text
packages/octoclaw-policy/src/spec/prompt-builder.ts
```

The local judge prompt was aligned with the current SR-P1 runtime semantics:

```text
lightweight read-only lookup/status check -> route=reply
runtime may execute it on main_fast_path or budgeted_main_then_delegate
delegate only for explicit delegation, write/mutation, tests/builds, review/validation, multi-step probing, long commands, or clearly long-running work
```

The bilingual harness lives outside the repo at:

```text
/Users/guanbear/models/judge-evals/scripts/eval-octoclaw-simplified-bilingual.mjs
```

It uses 18 Chinese cases plus direct English translations. The gold labels follow the aligned rule: local status, one-step version/weather lookup, simple script generation, Q&A, thanks, and clarify-like health checks are `reply`; log investigation, refactor/edit work, and run-tests-then-fix are `delegate`.

Retest results after prompt alignment:

| Model | Completed | Valid JSON | Route | Overall | ZH | EN | Avg Latency | Min | Max | >2 s | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `gpt-5.5` | 35/36 | 35/36 | 35/36 | 97.2% | 94.4% | 100% | 5130 ms | 1716 ms | 12136 ms | 31 | Best reference accuracy, too slow for hot path; one aborted call |
| `gpt-5.4-mini` | 35/36 | 35/36 | 35/36 | 97.2% | 94.4% | 100% | 4496 ms | 2069 ms | 11066 ms | 35 | Accurate reference/shadow candidate, too slow for hot path |
| `glm-4.5-air` | 36/36 | 36/36 | 34/36 | 94.4% | 94.4% | 94.4% | 1225 ms | 717 ms | 2834 ms | 2 | Best speed/accuracy remote balance in this retest |
| `xiaomi/mimo-v2-flash` | 36/36 | 36/36 | 34/36 | 94.4% | 94.4% | 94.4% | 3063 ms | 624 ms | 10274 ms | 23 | Accurate, but OpenRouter tail latency remains high |
| `qwen3-judge:0.6b-q4km` | 36/36 | 36/36 | 30/36 | 83.3% | 83.3% | 83.3% | 361 ms | 264 ms | 1680 ms | 0 | Fastest stable local candidate; misses hard-delegate edit/test/log cases |
| `qwen35-judge:0.8b-q4km` | 36/36 | 36/36 | 30/36 | 83.3% | 83.3% | 83.3% | 1268 ms | 1067 ms | 2605 ms | 4 | Same accuracy as Qwen3 0.6B, slower |
| `google/gemma-4-26b-a4b-it` | 36/36 | 36/36 | 30/36 | 83.3% | 83.3% | 83.3% | 1209 ms | 510 ms | 6232 ms | 2 | Paid route only; free route was rate-limited |
| `google/gemma-4-31b-it` | 36/36 | 35/36 | 31/36 | 86.1% | 88.9% | 83.3% | 4014 ms | 912 ms | 24672 ms | 18 | Slightly more accurate than 26B, much worse tail latency |
| `qwen/qwen3.6-flash` | 34/36 | 34/36 | 30/36 | 83.3% | 83.3% | 83.3% | 4124 ms | 1546 ms | 16226 ms | 28 | Accurate enough, but slow and had two incomplete calls |
| `deepseek/deepseek-v4-flash` | 36/36 | 25/36 | 23/36 | 63.9% | 72.2% | 55.6% | 2463 ms | 564 ms | 6354 ms | 25 | JSON instability makes it unsuitable |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 18/36 | 18/36 | 10/36 | 27.8% | 50.0% | 5.6% | 940 ms | 590 ms | 1623 ms | 0 | Fast, but free route reliability/accuracy is poor |
| `google/gemma-4-26b-a4b-it:free` | 0/36 | 0/36 | 0/36 | 0.0% | 0.0% | 0.0% | n/a | n/a | n/a | 0 | All calls hit OpenRouter free/upstream rate limits |

Notable misses:

| Model | Miss pattern |
| --- | --- |
| `qwen3-judge:0.6b-q4km` | Misclassifies log inspection, refactor/edit work, and run-tests-then-fix as `reply` in both Chinese and English |
| `glm-4.5-air` | Misclassifies simple script generation as `delegate` in both Chinese and English |
| `xiaomi/mimo-v2-flash` | Same simple-script over-delegation as GLM |
| `google/gemma-4-26b-a4b-it` | Over-delegates simple script generation, one-step React 19 lookup, and v2/v3 API comparison |
| `gpt-5.5` / `gpt-5.4-mini` | One Chinese Redis-port case aborted through cli-proxy; completed calls all matched |

Interpretation:

- The prompt alignment materially improved `qwen3-judge:0.6b-q4km`: it is now fast and usable again under the lightweight-read-only rule.
- `glm-4.5-air` is the best remote speed/accuracy tradeoff in this retest, but it remains an external dependency.
- `gpt-5.5` and `gpt-5.4-mini` are good reference adjudicators, not hot-path judges.
- Paid `google/gemma-4-26b-a4b-it` is usable but no better than local Qwen3 0.6B on this suite.
- Free OpenRouter models remain unsuitable for dependable judge routing; `gemma-4-26b-a4b-it:free` was fully rate-limited in this run.

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

Free text-model probe:

| Model | Completed | Valid JSON | Route | Avg Latency | Min | Max | >2 s | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 10/10 | 10/10 | 6/10 | 961 ms | 708 ms | 1415 ms | 0/10 | Fastest free candidate, but judge accuracy is below baseline |
| `openai/gpt-oss-20b:free` | 3/10 | 2/10 | 2/10 | 5780 ms | 5646 ms | 5985 ms | 3/3 | Too many failed calls for hot-path use |
| `z-ai/glm-4.5-air:free` | 9/10 | 0/10 | 0/10 | 8390 ms | 4205 ms | 22307 ms | 9/9 | Free OpenRouter route did not produce parseable judge JSON |
| `nvidia/nemotron-nano-9b-v2:free` | 10/10 | 0/10 | 0/10 | 9463 ms | 4079 ms | 17164 ms | 10/10 | Not compatible with the JSON judge shape in this run |
| `openrouter/free` | 2/10 | 1/10 | 0/10 | 8307 ms | 7099 ms | 9515 ms | 2/2 | Router choice is unstable and inaccurate for judge use |
| `baidu/cobuddy:free` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Free quota limit reached during this run |
| `google/gemma-4-26b-a4b-it:free` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Free quota limit reached during this run |
| `google/gemma-4-31b-it:free` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Free quota limit reached during this run |

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

Paid Gemma/Baidu results:

| Model | Completed | Valid JSON | Route | Avg Latency | Min | Max | >2 s | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `google/gemma-4-26b-a4b-it` | 10/10 | 10/10 | 9/10 | 2934 ms | 849 ms | 7601 ms | 6/10 | Accurate, but exceeds the 2 s judge budget on most cases |
| `google/gemma-4-31b-it` | 10/10 | 10/10 | 9/10 | 4302 ms | 1573 ms | 8708 ms | 6/10 | Similar accuracy, slower than 26B A4B |
| `baidu/ernie-4.5-21b-a3b` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Structured outputs unsupported through this route |
| `baidu/ernie-4.5-21b-a3b-thinking` | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Structured outputs unsupported through this route |
| `baidu/ernie-4.5-21b-a3b` without JSON mode | 1/10 | 0/10 | 0/10 | 10730 ms | 10730 ms | 10730 ms | 1/1 | Upstream rate limits/errors and no parseable judge JSON |
| `baidu/ernie-4.5-21b-a3b-thinking` without JSON mode | 0/10 | 0/10 | 0/10 | n/a | n/a | n/a | n/a | Upstream rate limits/errors |

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
- `nvidia/nemotron-3-nano-30b-a3b:free` is the only tested free OpenRouter route that was both fast and JSON-stable, but its 6/10 route accuracy makes it suitable only for free shadow comparison, not for the primary judge.
- `google/gemma-4-26b-a4b-it` and `google/gemma-4-31b-it` are accurate enough to remain shadow candidates, but they are not fast enough for a 2 s hot-path judge.
- OpenRouter's Baidu/ERNIE route is not compatible with the current structured-output judge path in this run.
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
1. glm-4.5-air with thinking disabled, best remote speed/accuracy balance in the 2026-05-21 retest
2. xiaomi/mimo-v2-flash through OpenRouter, accurate but with high tail latency
3. gpt-5.4-mini / gpt-5.5 as accurate but slower reference adjudicators
4. google/gemma-4-26b-a4b-it through OpenRouter, paid route only and no better than local Qwen3 on the aligned suite
5. qwen/qwen3.6-flash through OpenRouter, only if latency is acceptable
```

Do not currently use:

```text
google/gemini-*flash* via OpenRouter
stepfun/step-3.5-flash
deepseek/deepseek-v4-flash:free
deepseek/deepseek-v4-flash for active judge due JSON instability in the aligned bilingual retest
nvidia/nemotron-3-nano-30b-a3b:free for active judge despite good latency
google/gemma-4-26b-a4b-it:free under current free quota/rate-limit state
baidu/cobuddy:free under current free quota state
baidu/ernie-4.5-21b-a3b through OpenRouter for structured JSON judge
gpt-5.4-nano through Codex/OAuth/OmniRoute
```
