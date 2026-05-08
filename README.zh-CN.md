# OctoClaw / 八爪鱼 v0.5.0

[English](./README.md) | 简体中文

![OctoClaw 横幅](./banner.png)

> 面向 OpenClaw 的 TypeScript-first 执行策略层、委派 harness、反馈闭环和 IM/operator 控制面。

OctoClaw 现在的主线已经不是旧的 Python 脚本集合，也不依赖常驻 runner 才能工作。它把 live path 收在 OpenClaw gateway / runtime extension 内，用 `reply | delegate` 两条 live route 驱动 WorkContract、managed TaskFlow、ACK/progress/final delivery、状态投影和 nightly feedback loop。

## 当前设计入口

- [TS 重构设计 v2](./docs/octoclaw-ts-rebuild-design-v2.md)：当前总设计入口、已完成状态和下一步 N0-N4。
- [角色术语规范](./docs/octoclaw-role-terminology.md)：Observer / Patrol / Runner / Ctl 的边界。
- [架构图谱](./docs/octoclaw-architecture-map-2026-05-09.md)：更细的模块图、数据流和控制流。
- [仓库债务清理计划](./docs/octoclaw-repo-debt-cleanup-plan-2026-05-09.md)：归档边界、当前入口和版本/术语口径。
- [状态收敛设计](./docs/octoclaw-state-convergence-4-4-design.md)：TaskFlow、WorkContract、`task-state.json`、`policyState` 的真相层级。
- [WorkContract 委派设计](./docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md)：委派、handoff、continuity 合同。
- [Judge / ACK 策略规范](./docs/octoclaw-judge-ack-policy-spec-2026-04-21.md)：judge、ACK、policy labels。
- [反馈链路合同](./docs/octoclaw-feedback-loop-contracts.md)：observe -> summarize -> review -> curate -> validate -> promote -> learn。
- [Auto Router Phase 5 设计](./docs/octoclaw-phase5-auto-router-design-2026-04-30.md)：shadow-first 的 execution contract 推荐器设计。

历史路线图和原始 v1 设计已归档到 [docs/archive/](./docs/archive/)。

## 核心能力

- **Policy-first route**：live route 固定为 `reply | delegate`，`direct / runner / spawn_single / spawn_multi` 只作为 execution contract / lane。
- **WorkContract-centered delegation**：每次委派都有 route seal、scope、role、allowed tools、model profile 和 continuity 记录。
- **Managed TaskFlow substrate**：OpenClaw native TaskFlow 是生命周期事实源，OctoClaw 负责 durable projection 和 operator surface。
- **ACK / progress / final 分离**：ACK 只确认收到，progress 来自 execution transition，final 来自 completion/result fact。
- **Native final delivery**：OpenClaw native announce/channel delivery 负责 final relay；OctoClaw 记录 delivery metadata 和状态投影。
- **IM adapter registry**：Slack L2、Feishu L1、WeChat L0 已有 baseline；不支持 thread/action 的渠道会降级到文本。
- **Feedback loop**：`octoclawctl nightly/review/curate/nightly-eval/promote` 支持回放、复盘、fixture 和 baseline promotion。
- **统一操作入口**：安装、部署、开关、状态、评估和巡检都通过 `octoclawctl`。

## 项目结构

```text
packages/octoclaw-contracts      稳定合同：WorkContract、events、results、delivery、status projection
packages/octoclaw-policy         policy：intent、judge schema、route、role、model、gate
extensions/octoclaw-runtime      OpenClaw runtime extension：hooks、dispatch、ACK、IM、delivery、replay
extensions/octoclaw-status-surface
                                 status/details/queue/timeline 的 read model 和 renderer
tools/octoclawctl                安装、配置、状态、nightly、review、curate、calibration gate
schemas                          runtime / route / budget / outcome JSON schema
eval                             最小 eval fixtures
docs                             当前设计文档
docs/archive                     历史规划、工程日志和验收证据
```

## 快速开始

源码管理安装和更新优先走 `octoclawctl`：

```bash
pnpm install
pnpm build
node tools/octoclawctl/dist/cli.js install
```

部署到已有 OpenClaw 环境：

```bash
node tools/octoclawctl/dist/cli.js deploy
node tools/octoclawctl/dist/cli.js enable
node tools/octoclawctl/dist/cli.js status
```

常用配置：

```bash
node tools/octoclawctl/dist/cli.js config get enabled
node tools/octoclawctl/dist/cli.js config set enabled true
node tools/octoclawctl/dist/cli.js config set features.delegation true
```

如果已经通过包管理器安装了 `octoclawctl`，可以直接把上面的 `node tools/octoclawctl/dist/cli.js` 替换成 `octoclawctl`。

## Operator 常用命令

```bash
octoclawctl status
octoclawctl details --task-id <task-id>
octoclawctl queue
octoclawctl timeline --task-id <task-id>
octoclawctl patrol
octoclawctl repair
```

反馈闭环：

```bash
octoclawctl nightly --format markdown
octoclawctl review
octoclawctl curate --task-id <turn-id>
octoclawctl nightly-eval run --config ~/.openclaw/nightly-eval-config.json --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval
octoclawctl nightly-eval promote --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval
```

## 当前路线

N0 已收口：当前入口是 `octoclaw-ts-rebuild-design-v2.md`，旧 v1、Phase1/Phase2 施工设计和 2026-04-30 roadmap 作为 archive snapshot 保留。

接下来按 v2 的 N1-N4 推进：

1. 状态真相和 native completion relay 加固。
2. IM capability matrix 产品化。
3. Auto Router shadow-first：先推荐 execution contract，不改 live path。
4. 发布和开源产品面收口。

## 开发校验

```bash
pnpm check
pnpm test
git diff --check
```

只改文档时至少运行：

```bash
git diff --check
```
