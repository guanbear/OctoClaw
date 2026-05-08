# Test Spec — OctoClaw P2 Unified Feedback Loop

## Acceptance Criteria
1. 文档能清楚映射现有工具到 7 段闭环：observe/summarize/review/curate/validate/promote/learn
2. 统一 manifest / schema 后，nightly 产物能被串起来追踪
3. replay review / curate / validation / learning promotion 的输入输出不再靠隐含约定
4. rollout promotion 只消费明确允许的验证结果，不直接消费原始 report 噪音
5. 至少一条“从 replay 到 learning”的黄金路径可复现实证

## Verification Plan
- unit: replay summary / review / curate / automation / validation / fixture export / learning log tests
- integration: nightly replay automation outputs + reply review packet + validation report + rollout recommendation
- observability: manifest links every output artifact to source phase and upstream inputs
- regression: current replay tooling behavior remains backward compatible while unified contracts are added
