# 🐙 八爪鱼 Octopus v1.0.25

![八爪鱼 Octopus](https://gitlab.chehejia.com/sre/openclaw-octopus/-/raw/master/banner.png)

> 多 Agent 智能调度器 — 省钱、极速、自愈。1 个大脑 + 最多 8 只触手并行。

---

## 💰 成本优化（核心价值）

**实测：65%+ 的任务可用低成本模型完成，效果无差别。**

| 任务等级 | 典型任务 | 平衡模式用模型 | 费用 |
|---------|---------|--------------|------|
| trivial | 改配置、加文字 | GLM | 💰 |
| simple | 写脚本、改单文件 | GLM | 💰 |
| normal | 写代码、调 API | GLM | 💰 |
| hard | 复杂逻辑、多文件 | Sonnet | 💰💰 |
| deep | 复杂架构、深度分析 | Sonnet | 💰💰 |

GLM 费用约为 Sonnet 的 **1/10**。日常使用中 trivial/simple/normal 占大多数，整体成本大幅降低。

### 5 种调度模式

| 模式 | 适用场景 | trivial~normal | hard~deep |
|------|---------|---------------|-----------|
| ⚖️ **balanced**（默认） | 日常使用 | GLM | Sonnet |
| 🎯 **quality** | 重要任务 | Sonnet | Opus |
| 💰 **cost** | 批量任务 | GLM | Sonnet |
| 🔒 **private** | 敏感数据 | GLM | GLM |

切换方式：告诉 Agent "切换到成本优先模式" 或 `/mode cost`。

---

## ⚡ 执行效率

**主 Agent 零等待**：收到消息立即输出文字回复，任务异步派发给触手。用户不需要等任何工具调用完成。

**最多 8 触手并行**：独立任务同时执行，没有串行等待。

**patrol 自愈**：每 5 分钟巡逻。空闲时仅 ~100 tokens；超时任务自动 kill + 重派；queued 依赖完成后自动解锁。

---

## 🏗️ 架构原理

```
用户消息
   │
   ▼
🧠 主 Agent（调度大脑）
   │  ① 立即输出文字回复（零阻塞）
   │  ② sessions_spawn × N（非阻塞）
   │
   ├──► 💪 鲸力手 ──► task-state.json ──► ✅ done
   ├──► 🔍 梭鱼眼 ──► task-state.json ──► ✅ done
   └──► ✍️ 墨鱼手 ──► task-state.json ──► ✅ done
                             │
                             ▼
                  🦅 patrol cron（每5分钟）
                     ├── 超时 → kill + 重派
                     ├── queued deps 全 done → 自动 spawn
                     └── 空闲 → PATROL_SKIP（~100 tokens）
```

### 四大组件

| 组件 | 职责 |
|------|------|
| **主 Agent（大脑）** | 秒级回复 + spawn，永不阻塞用户 |
| **子 Agent（触手）** | 独立执行任务，写入 task-state.json，发完成通知 |
| **task-state.json** | 所有任务状态的单一真相来源，文件锁原子写入 |
| **patrol cron** | 每5分钟巡逻，超时处理 + queued 解锁 + 两阶段优化 |

---

## 🦑 8 只触手

| 触手 | label | 适合任务 |
|------|-------|---------|
| 💪 **鲸力手** | octopus-power | 复杂开发、架构重构、大型代码变更 |
| 🔍 **梭鱼眼** | octopus-scout | 调研、对比分析、查资料、排查根因 |
| ✍️ **墨鱼手** | octopus-writer | 写文档、报告、总结、翻译 |
| 🔧 **螃蟹手** | octopus-fix | Bug 修复、精细调整、code review |
| 🧪 **海胆手** | octopus-test | 测试、质量检查、边界条件验证 |
| 📊 **章鱼脑** | octopus-analyze | 数据分析、日志分析、决策支持 |
| 🏃 **飞鱼腿** | octopus-runner | 脚本运行、API 调用、查状态 |
| 🐦 **鸽手** | octopus-feishu | 飞书消息、文档、卡片、API 操作 |

---

## 🚀 快速开始

### 安装

技能加载后自动执行，或手动运行：
```bash
bash /workspace/openclaw/skills/octopus/install.sh
```

### 使用示例

直接说出任务，八爪鱼自动派触手：

```
"帮我重构用户认证模块，同时调研 JWT 最佳实践"
→ 鲸力手 重构代码（Sonnet）
→ 梭鱼眼 调研 JWT（GLM）
两个触手并行，同时开始

"查一下 Redis 配置"
→ 主 Agent 直接答（无需 spawn）

"八爪鱼状态"
→ 显示当前任务面板
```

---

## ⚙️ 模式切换

```
切换到成本优先模式    →  全 GLM，仅复杂推理用 Sonnet
切换到效果优先模式    →  优先 Sonnet/Opus，追求最佳结果
切换到保密模式        →  全部使用私有部署 GLM，数据不出内网
切换到平衡模式        →  默认，成本与质量均衡
```

---

## 🛠️ 管理命令

```bash
# 禁用（保留配置，停止 cron）
touch /workspace/tmp/octopus-disabled

# 重新启用
rm -f /workspace/tmp/octopus-disabled

# 强制刷新任务面板
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force

# 卸载
bash /workspace/openclaw/skills/octopus/install.sh uninstall
```

---

## 📂 文件结构

```
/workspace/openclaw/skills/octopus/
├── SKILL.md                   # 技能规则（加载到 Agent 上下文）
├── README.md                  # 本文档
├── install.sh                 # 安装/卸载脚本
└── lib/
    ├── patrol.py              # 巡逻（两阶段，空闲~100 tokens）
    ├── task-state-update.py   # 任务状态原子写入（文件锁）
    ├── resolve-model.py       # 模型路径解析（含30分钟缓存）
    ├── feishu-card.py         # 飞书卡片发送/更新
    └── status.sh              # 轻量状态查询

/workspace/tmp/octopus/
├── task-state.json            # 全局任务状态（运行时）
└── octopus-mode.json          # 当前调度模式

/tmp/
├── octopus-model-cache.json   # 模型缓存（30分钟有效）
└── ironclaw-model-latency.json # 铁甲虾延迟数据（软依赖）
```

---

## ❓ 常见问题

**Q：任务卡死了怎么办？**
patrol 每5分钟自动检查并 kill + 重派。也可手动运行 `patrol.py --force` 立即触发。

**Q：怎么省钱？**
切换到 cost 或 private 模式："切换到成本优先模式"。

**Q：八爪鱼和铁甲虾能同时用吗？**
可以，且推荐。铁甲虾提供实时模型延迟数据，让八爪鱼选模型更准确，并在模型故障时自动降级。

**Q：怎么知道当前有哪些任务？**
问 Agent "八爪鱼状态" 或运行 `patrol.py --force`。
