# PRD — OctoClaw P2 Unified Feedback Loop

## Goal
把 OctoClaw 已经落地的 replay / review / curate / validation / promotion / learning 基线，收成一条统一、可解释、可持续演进的反馈闭环，而不是一组零散脚本。

## Baseline Already Landed
- replay logging: `lib/replay_summary.py`, runtime-policy replay JSONL
- replay review: `lib/replay_review.py`
- replay curate: `lib/replay_curate.py`
- nightly automation: `lib/replay_automation.py`
- reply/delegation packet: `lib/reply_review_packet.py`
- replay validation: `lib/replay_validation.py`
- eval fixture export: `lib/eval_fixture_export.py`
- learning/error promotion: `lib/learning_log.py`, `lib/nightly_error_review.py`
- rollout promotion hints: `lib/runtime_policy_rollout.py`

## Problem
当前反馈链路已经很多，但角色边界不清：
- 哪个是“观察层”
- 哪个是“人审层”
- 哪个是“可回归验证层”
- 哪个输出能进入策略晋升
- 哪个只是 operator 参考

结果是：工具都在，但没有单一闭环心智。

## Target Loop
observe -> summarize -> review -> curate -> validate -> promote -> learn

## Product Requirements
1. 每个阶段有明确输入/输出/schema
2. 每个阶段都能指向下一阶段，而不是只写 report 停住
3. “策略晋升”和“学习沉淀”要明确区分
4. nightly 作业分核心链路与辅助链路
5. 文档、CLI、产物命名统一

## Non-goals
- 不重写 IM/display
- 不重写 observer/taskflow substrate
- 不做新的 UI cockpit
- 不马上做 fully automatic policy rewrite

## Chosen Direction
选“统一 feedback kernel + 保留现有工具为薄适配层”：
- 保留现有脚本
- 增加统一 feedback domain model / manifest / phase contract
- 逐步让现有工具挂到统一闭环上
