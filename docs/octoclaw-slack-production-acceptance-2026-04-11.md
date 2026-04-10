# OctoClaw Slack Production Acceptance And Security Checklist

日期：2026-04-11  
状态：active operator checklist

---

## 1. 目的

这份清单只做两件事：

- 把真实 Slack/macmini 验收变成固定步骤，不再靠临时回忆。
- 把当前仍保留的安全风险单独列出，避免和功能问题混在一起。

这不是新的架构设计文档。  
架构主线仍以以下文档为准：

- [octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)
- [octoclaw-router-policy-refactor-plan-2026-04-10.md](./octoclaw-router-policy-refactor-plan-2026-04-10.md)

---

## 2. 当前结论

到 2026-04-11 这轮为止：

- router/runtime 主链已经完成到可用状态
- macmini 部署已恢复
- gateway / Slack channel / deep health probe 正常
- 旧 `patrol-loop` / `runner-daemon` / `runner_loop` 不再作为默认运行面

当前剩余项主要是：

- 真实 Slack 对话体验验收
- Slack 安全策略收紧
- 长时间稳定性观察

---

## 3. 真实 Slack 验收矩阵

### 3.1 快回复

测试句：

- `在吗`
- `你再看下 OpenClaw 有啥更新，尤其是 Memory 方向`
- `查下 openclaw 有没有新的发版`

通过标准：

- 1 秒内出现 ACK 或直接回答
- ACK 只能表达“我去查一下 / 我看下”，不能伪称已经查完
- 如果后续需要 runner / task，ACK 后必须继续有 progress 或 final

失败信号：

- 首条消息长时间静默
- ACK 直接声称“已经交给 runner”但实际没有 materialize
- ACK 卡在 Slack 投递链路导致首响超时

### 3.2 live lookup

测试句：

- `你再看下 OpenClaw 有啥更新，尤其是 Memory 方向`
- `查下 OpenClaw 最近 release`
- `Control UI 地址是啥`
- `现在版本是啥`

通过标准：

- 本机 surface 问题走本机事实
- 上游 release / Memory 更新走 live lookup
- 回答里不混淆“本机版本”和“上游最新发版”
- 如果 execution facts 没记录 direct tool，不得声称用了某个工具

失败信号：

- 把本机版本回答成上游版本
- 把上游问题误答成本地状态
- “怎么查的”与实际 facts 对不上

### 3.3 execution follow-up

测试句：

- `刚才那个任务判定是啥`
- `single 成功了吗`
- `怎么查的`
- `还在跑吗`

通过标准：

- follow-up 绑定最近 execution ledger
- 只基于 `task_bound / runner_started / delivery_sent / delivery_failed / tool_used` 等事实回答
- 不靠旧记忆自由发挥

失败信号：

- 同一 follow-up 每次说法不同
- 用“我记得”式答案覆盖 execution facts
- 把 direct 路径和 delegated 路径混说

### 3.4 delegated work

测试句：

- `帮我查一下最近 release，给我 5 句话总结`
- `帮我看这个 task 失败原因`
- `跑一下这个检查`

通过标准：

- 如需 delegated work，先 ACK
- task materialize 后，完成时能主动通知
- 用户没追问时也不应静默吞掉完成结果

失败信号：

- task 创建了但没有 completion notify
- 用户必须再追问一次才知道任务结果
- materialization failed 仍伪装成已执行

---

## 4. 建议验收顺序

每次大改动后，最少跑下面 6 条：

1. `在吗`
2. `你再看下 OpenClaw 有啥更新，尤其是 Memory 方向`
3. `怎么查的`
4. `Control UI 地址是啥`
5. `刚才那个任务判定是啥`
6. 一条明确 delegated work 请求

配套机器侧检查：

1. `python3 lib/harness_gate.py --preset quick --format json`
2. `openclaw status --deep`
3. `nc -vz github.com 443`
4. 查看最近 gateway log 是否存在持续性 socket/ping 异常

如果要做黑盒 Slack smoke，可直接运行：

```bash
python3 lib/slack_e2e_acceptance.py --preset smoke
```

说明：

- 脚本会优先从 `~/.openclaw/agents/main/sessions/sessions.json` 选择最近可用的 Slack session
- 再通过 gateway `agent` 调用注入 prompt
- 然后直接用 Slack Web API 拉回 thread/history，统计 ACK 与 final
- 如果报告里出现 `delivery_mode=embedded_fallback`，则 `ack_verifiable=false` 是预期行为
- 这说明当前是 CLI fallback 黑盒验收，只稳定验证 Slack 最终回流与 follow-up/provenance；真实“快 ACK”仍要靠用户入站或 gateway 直连链路验收

---

## 5. 当前安全风险与处理建议

### 5.1 已收掉

- `~/.openclaw/openclaw.json` 权限已收为 `600`
- macmini 旧 video-site/video-site-scan 干扰项已保持关闭
- 端口池扩容已持久化，避免临时端口耗尽导致 Slack/gateway 假故障

### 5.2 仍保留的风险

#### Slack `groupPolicy=open`

现状：

- 任意可达 channel 仍可能触发 gateway

风险：

- 和 elevated/runtime/filesystem tools 组合时风险过高

建议：

- 改成 `allowlist`
- 明确只开放固定 channel / DM
- 在切换前先盘点实际使用 channel，避免误伤当前工作流

#### tool exposure 偏宽

现状：

- 默认 agent/tool policy 仍较宽

建议：

- 对 exposed Slack surface 优先使用更保守的 tools profile
- runtime/fs/web 只对白名单 agent 暴露

#### multi-user 风险

现状：

- 现在的 gateway 更像个人运行时，但 surface 暴露方式接近共享入口

建议：

- 如果继续多人可达，应该拆 trust boundary
- 至少把 personal/private runtime 与公共入口隔离

---

## 6. 后续建议

### 6.1 近期必须做

- 跑一轮真实 Slack 验收并记录样例
- 收 Slack allowlist 策略
- 观察 24-48 小时，确认端口池不会再次被打满

### 6.2 可以随后做

- 把 Slack bad cases 持续沉淀进 golden fixtures
- 把安全策略检查也并入验收脚本
- 继续删除不再使用的 compat/legacy 运维壳

---

## 7. 一句话结论

OctoClaw 项目主链现在已经不是“缺核心功能”，而是“进入生产验收和安全收口阶段”。  
后续工作的重点不该再是补随机 case，而应是：

- 用固定验收矩阵证明真实 Slack 体验稳定
- 用明确 allowlist 和更窄 tool exposure 收掉上线风险
