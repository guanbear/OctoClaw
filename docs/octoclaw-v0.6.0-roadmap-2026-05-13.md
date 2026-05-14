# OctoClaw v0.6.0 路线图

Date: 2026-05-13
Branch: `v0.5.0` → 后续切 `v0.6.0` 或临时分支
Status: 落地计划（与 `octoclaw-improvement-plan-2026-05-12.md` 接续）

## 一句话

v0.5.x 把项目"做出来"了。v0.6.0 的目标是把它**做成开源人能用的样子**：
能装、能跑、能告诉用户哪儿坏了、Slack 之外的 IM 也能用、GitHub 主页看着像个项目。

## 范围

| 包 | 主题 | 优先级 | 预估 | OpenSpec 包名 |
|---|---|---|---|---|
| **S1** | npm 发包 + `npx octoclaw init` | P0 | 3-5 天 | `v0.6-npm-cli-distribution` |
| **S3** | 友好错误体系 + `octoclawctl doctor` | P1 | 3-4 天 | `v0.6-friendly-errors-doctor` |
| **A1** | GitHub 主页 / banner / badges / community 文件 | P1 | 2-3 天 | `v0.6-github-presence` |
| **A2** | 稳定性收尾（W-5 WP-F、W-6 Phase 2、judge cooldown、shadow 隔离 invariant） | P0 | 4-6 天 | `v0.6-stability-hardening` |
| **A3-飞书** | 飞书分段 / 图片 / attachment 完善 | P2 | 1-2 天 | `v0.6-im-feishu-deepen` |
| **A3-Discord** | Discord 适配（slash + thread + streaming） | P2 | 2-3 天 | `v0.6-im-discord-adapter` |
| **A3-Telegram** | Telegram 适配（webhook + Bot API） | P2 | 1-2 天 | `v0.6-im-telegram-adapter` |

总预估：**16-25 天**（单人），并行可压到 10-15 天。

显式跳过本版本：
- S2（5 分钟教程 + GIF）：等 S1 + A1 完成后录，做不做 v0.6.0 都不卡
- Docker 镜像：用户已经有 OpenClaw + Node 环境，不需要
- macOS / Linux 安装脚本：npx 一行就够，AI 也能装

## 依赖图

```
        ┌─ S1 (npm publish)
        │     ↑
        │     └── 依赖：什么都不依赖，可以最先开工
        │
        ├─ S3 (errors + doctor)
        │     ↑
        │     └── 弱依赖：S1 完成后 doctor 才有 npx 可执行入口去检测；
        │                  但实现可以先做，发布同步进 S1
        │
        ├─ A1 (GitHub presence)
        │     ↑
        │     └── 不依赖，纯静态资产 + community 文件
        │
        ├─ A2 (stability hardening)
        │     ↑
        │     └── 不依赖，但建议在 S1 上线前完成（避免一发布就有用户撞 bug）
        │
        └─ A3 (IM adapters)
              ↑
              └── 不依赖，三个适配器之间也独立，可以三个 AI 并行
```

**推荐顺序**：A2 → S3 → S1 → A1 + A3（并行）

A2 先做的原因：先保证稳定性，再扩用户面。

## 不再做（明确删除）

- 不做 Docker 镜像（已删）
- 不做 install.sh（已删）
- 不做 web UI（v0.7+ 再说）
- 不做 i18n 框架（中英双 README 够用）
- 不做端到端测试框架（v0.7 单独立项）

## 与 v0.6.0 不冲突的并行工作

- **Auto Router v3** 设计已完成，但实施推到 v0.7。如果 v0.6.0 提前结束有余力，可以开 router-v3 Phase A（包抽离）。
- **代码进一步清理**（`extension-entry.ts` 还有 3964 行）：作为持续维护任务，每次接触相关代码顺手抽，不立项。

## Acceptance（v0.6.0 整体）

- [ ] 用户可以 `npx @octoclaw/cli init` 在 5 步内完成首次配置
- [ ] 任何错误输出包含 `code` / 中文/英文消息 / actionable hint
- [ ] `octoclawctl doctor` 检测 Node / OpenClaw / Ollama / IM token / 配置 5 项
- [ ] GitHub README 顶部有 banner + badges + Discord/Discussions 链接
- [ ] Slack smoke 5 case 全过
- [ ] watchdog Phase 2（degraded / delivered / operator surface）落地
- [ ] judge 连续失败 30 分钟 cooldown 落地 + 测试
- [ ] shadow lane 失败 invariant 测试通过（至少 3 个回归点）
- [ ] 飞书分段策略 + 图片 attachment 测试通过
- [ ] Discord adapter 支持 slash + thread + streaming
- [ ] Telegram adapter 通过 webhook + 长消息分段

## 硬约束（每个 WP 都要遵守）

1. **不破坏现有 IM 适配器接口**（`IMAdapter` 接口是 contract）
2. **错误码必须中英双语**（`userMessageZh` + `userMessageEn` 都不能省）
3. **新加的 IM 适配器必须有 capabilityLevel 标注**（L0/L1/L2）
4. **doctor 命令不能 throw**（任何检测项失败也要继续跑完，输出汇总）
5. **npx 包不能依赖 monorepo 内部相对路径**（必须能独立解压到 `node_modules` 跑）
6. **Cooldown / 健康策略必须可关闭**（环境变量 `OCTOCLAW_DISABLE_HEALTH_GATES=1`，方便 e2e 测试）
7. **新文档必须中文友好**（错误消息、帮助文本、CLI 输出都要中文）

## 交接

每个包都有完整四件套：

```
openspec/changes/<pack-name>/
  proposal.md       # Why + Scope + Acceptance
  design.md         # 架构 + 决策 + 接口
  tasks.md          # 可勾任务（每个 < 4h）
  bdd.md            # 验收场景（每个 = 一个测试）
```

交接给其他 AI 的 prompt 模板见 `docs/octoclaw-v0.6.0-handoff.md`。

## References

- `docs/octoclaw-improvement-plan-2026-05-12.md` — 上一阶段（v0.5.x）改进计划
- `docs/octoclaw-auto-router-v3-design-2026-05-13.md` — v0.7 路线
- `docs/octoclaw-auto-router-v3-handoff.md` — 交接 AI 的格式参考
