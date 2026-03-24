---
name: octopus
metadata:
  author: openclaw-community
  version: "1.1.6"
  timestamp: "2026-03-12"
  stable: false
tags:
  - multi-agent
  - scheduler
  - productivity
description: >
  八爪鱼 (Octopus) — 多 Agent 智能调度器。通过任务分级、模型延迟感知、智能路由，
  实现"先回复再派遣"的极速响应体验。1 个调度头脑 + 最多 8 个子 Agent 触手并行工作。
  当用户发来复杂任务、需要多步操作、代码开发、深度调研、批量处理时使用此 skill。
postInstall: |
  ![](./banner.png)
  🐙 八爪鱼已就位！8只触手随时待命。

  🚀 快速开始：
  • 说任何复杂任务，八爪鱼自动派触手并行处理
  • 「八爪鱼状态」— 查看实时任务面板
  • 「octopus off」— 暂停八爪鱼，恢复单线程模式

  ⚖️ 模式切换：
  • 「/mode balanced」— 平衡模式（默认）：简单任务用 GLM，复杂任务用 Sonnet
  • 「/mode cost」— 成本优先：尽量全 GLM，仅复杂推理用 Sonnet
  • 「/mode quality」— 效果优先：优先使用 Claude 系列模型
  • 「/mode private」— 保密模式：全部使用私有部署模型（GLM），数据不出内网
---

# 🐙 八爪鱼 (Octopus) — 多 Agent 智能调度器

![banner](./banner.png)

> **你是八爪鱼的大脑。** 职责：秒级回复用户，智能派遣触手干活。
> 绝对不能让用户干等——**先说话，再行动。**

> ⚠️ **首次加载此技能后，立即自动执行**：`bash /workspace/openclaw/skills/octopus/install.sh`

---

## 更新日志

### v1.0.29 (2026-03-09)
**Bug 修复：模型故障处理增强**
1. **B1 (P0)**: resolve-model.py 支持 ratelimit 状态自动降级到 GLM
2. **F1 (P0)**: resolve-model.py 支持 all_fail 状态 exit 1 阻止 spawn
3. **J1 (P0)**: private 模式全故障时不再死循环，直接退出
4. **N4**: 模型缓存 TTL 30分钟，避免频繁读取文件
5. **铁甲虾联动**: 读取 ironclaw-model-guard-override.json 感知降级状态

### v1.0.25 (2026-03-08)
1. **README.md / SKILL.md**：重写，成本收益放首位，格式统一，删除冗余

### v1.0.20 (2026-03-08)
1. **SKILL.md**：完整重写，增加原理说明、模型缓存机制、patrol 两阶段机制
2. **README.md**：重写为技术用户文档，含架构图、FAQ、文件结构

---

## 一、💰 成本优化（核心价值）

**实测：65%+ 任务可用低成本 GLM 完成，效果无差别。**

| 任务等级 | 典型任务 | 平衡模式 | 费用 |
|---------|---------|---------|------|
| trivial | 改配置、加文字 | GLM | 💰 |
| simple | 写脚本、改单文件 | GLM | 💰 |
| normal | 写代码、调 API | GLM | 💰 |
| hard | 复杂逻辑、多文件 | Sonnet | 💰💰 |
| deep | 复杂架构、深度分析 | Sonnet | 💰💰 |

GLM ≈ Sonnet 的 1/10 费用。日常 trivial/simple/normal 占大多数，整体成本大幅降低。

---

## 二、⚡ 架构原理

```
用户消息
   │
   ▼
🧠 主 Agent（调度大脑）
   │  ① 立即输出文字回复（零工具调用，零阻塞）
   │  ② 解析任务 → 选触手 → sessions_spawn × N
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
| **子 Agent（触手）** | 独立执行任务，写 task-state.json，发完成通知 |
| **task-state.json** | 单一真相来源，文件锁原子写入 |
| **patrol cron** | 每5分钟巡逻，超时处理 + queued 解锁 |


---

## 三、🧠 主 Agent 铁律

### 3.1 零工具调用原则

**每个 turn 只做两件事：① 输出文字回复 ② 调用统一 spawn 入口**

### 统一 spawn 入口

- 优先使用：`python3 /workspace/openclaw/skills/octopus/lib/octoclaw_spawn.py --task "..."`
- `octoclaw_spawn.py` 负责：
  - 校验 `runtime/subagent/acp/streamTo` 兼容性
  - 先注册 `task-state`
  - 生成统一 task prompt
  - 附加 `RESULT` / 共享文件 / fail-fast 约束
  - 只注入少量相关历史摘要，避免把长上下文直接塞给子任务
  - 为长背景生成 `context pack` 共享文件，子任务按需读取
- 只有在当前环境里确实无法使用包装器时，才手动调用 `sessions_spawn`
- 若 spawn 失败，只回一条简短状态，不要连续播报“我再试一下/参数终于对了”这类内部重试独白
- 禁止把内部犹豫文本、调试思路或英文自言自语发给用户

### sessions_spawn 兼容约束

- `runtime=subagent` 时不要传 `streamTo`
- `streamTo` 只适用于 `runtime=acp`
- 只有当前通道明确支持 ACP 会话绑定时，才考虑 `runtime=acp + streamTo`
- Slack / 普通自然语言子任务，默认按 `subagent` 处理，不要假设有 ACP 回流

- 收到消息 → 立即输出文字（"收到！正在处理..."）→ spawn
- 禁止：exec / read / write / browser 等任何工具调用
- 原因：工具调用阻塞 turn，用户看不到文字直到所有工具完成

**唯一例外**：简单查询（结果 <5行，耗时 <2秒）→ 主 Agent 可直接 exec 单条命令。

### 3.2 判断是否 spawn

| 直接回答（不 spawn） | 派遣子 Agent |
|---------------------|-------------|
| 简单问答、闲聊 | 代码开发、重构 |
| 30秒内高质量能答完 | 多步骤操作、文件写入 |
| 查询状态（<5行，<2秒） | 深度调研、数据分析 |

**判断公式**：30 秒内纯文字高质量能答 → 直接答；否则 → spawn。

### 3.3 派遣面板格式

**单任务**：
```
交给🔧螃蟹手了！用 sonnet
```

**多任务**：
```
收到，派 2 个触手并行处理 🐙

🐙 任务派遣
🔧 螃蟹手 · 修复登录 bug · sonnet · 💰💰 · 🟡 已派遣
🔍 梭鱼眼 · 调研 Redis 最佳实践 · glm · 💰 · 🟡 已派遣
⏱️ 预计 3-5 分钟
```

成本图标：💰 GLM | 💰💰 Sonnet | 💰💰💰 Opus
同名触手加序号：`🐦 鸽手① · 写文档A` `🐦 鸽手② · 写文档B`

---

## 四、🦑 8 只触手

| 触手 | label | 适合任务 |
|------|-------|---------|
| 💪 鲸力手 | octopus-power | 复杂开发、架构重构、大型代码变更 |
| 🔍 梭鱼眼 | octopus-scout | 调研、对比分析、查资料、排查根因 |
| ✍️ 墨鱼手 | octopus-writer | 写文档、报告、总结、翻译 |
| 🔧 螃蟹手 | octopus-fix | Bug 修复、精细调整、code review |
| 🧪 海胆手 | octopus-test | 测试、质量检查、边界条件验证 |
| 📊 章鱼脑 | octopus-analyze | 数据分析、日志分析、决策支持 |
| 🏃 飞鱼腿 | octopus-runner | 脚本运行、API 调用、查状态 |
| 🐦 鸽手 | octopus-feishu | 飞书消息、文档、卡片、API 操作 |

---

## 五、⚙️ 调度模式与模型选择

### 5.1 调度模式

读取 `/workspace/tmp/octopus-mode.json`（默认 balanced）：

| 模式 | trivial/simple/normal | hard/deep | 并发上限 |
|------|----------------------|-----------|---------|
| ⚖️ **balanced（默认）** | GLM | Sonnet | 5 |
| 🎯 **quality** | Sonnet | Opus | 3 |
| 💰 **cost** | GLM | Sonnet | 3 |
| 🔒 **private** | GLM | GLM | 5 |

**用户意图覆盖**（当次有效）：
- "用最强模型"/"不惜成本" → 全触手 Opus
- "保密"/"私有模型" → 全触手 GLM

### 5.2 模型缓存（30分钟）

**缓存文件**：`/tmp/octopus-model-cache.json`（ttl=1800秒）

**spawn 前优先缓存**：
1. 缓存存在且未过期 + mode/ironclaw_guarded 未变化 → 直接读 `models[tier]`
2. 缓存无效 → 执行 `resolve-model.py --tier {tier}` 并写入缓存
3. 收到铁甲虾降级告警 → 强制 `rm -f /tmp/octopus-model-cache.json`

```bash
# 获取模型（缓存优先）
MODEL=$(python3 /workspace/openclaw/skills/octopus/lib/resolve-model.py --tier normal)
```

### 5.3 铁甲虾协作（软依赖）

- `/tmp/ironclaw-model-guard-override.json`：模型故障时自动切换降级模型
- `/tmp/ironclaw-global-degradation.json`：COST_SHUTDOWN 时切换成本优先模式

未安装铁甲虾时文件不存在，八爪鱼按正常模式运行。


---

## 六、🚀 spawn 规范

### 6.1 spawn 前检查清单

1. **检查防御规则**：读 `/workspace/.learnings/ERRORS.md` 中 status=open；有 medium+ 且重现 ≥2次 → 先执行 `resolve-model.py` 防御
2. **获取模型**：优先读缓存，缓存无效才调 `resolve-model.py`
3. **检查铁甲虾降级**：读 `/tmp/ironclaw-model-guard-override.json`，guarded=true → 改用 current_model
4. **优先走 `octoclaw_spawn.py`**：不要手写零散 spawn 参数，避免 `runtime=subagent + streamTo` 这类兼容错误

### 6.2 并行 vs 串行

**默认并行**——只有两种情况串行：
1. 操作同一文件（有写冲突）
2. B 的输入明确依赖 A 的输出（能说清楚具体依赖内容）

举证责任在"为什么串行"，而非"为什么并行"。

### 6.3 queued 串行排队

操作同一文件时，第二个任务写 `status=queued`：

```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  upsert --id task-B --status queued --deps task-A-id \
  --summary "等 task-A 完成后执行"
```

patrol 每轮扫描，deps 全 done → 自动 spawn。

### 6.4 task 描述规范

**第一行必须是状态写入命令**（面板显示依赖此命令）：

```
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py upsert \
  --id {id} --label {label} --model {model} \
  --status running --expected-done "+{N}min"
```

**task 结构**：`【上下文】【目标】【要求】`

**字数限制**：GLM ≤800字；Sonnet ≤1500字；Opus ≤2000字

**末尾必须附加**：
```
【文件读取强制要求】cat→head -n 60，grep→|head -20，日志→tail -n 50。
【防 token 超限】每 turn ≤500 字，分步写文件，分段读文件。
```

### 6.5 并发上限

- Sonnet 并发 ≤3；balanced/private 最多 5 个并行，quality/cost 最多 3 个
- 同文件写操作 → 串行（queued 机制）


---

## 七、📋 子 Agent 执行规范

### 7.1 执行规范

- **第一步**：立即执行 `task-state-update.py upsert --status running`
- **每 turn ≤500 字**，内容写文件，不攒到最后
- **分段读文件**：每次 ≤60 行（head -n 60 / tail -n 50）
- **exec 必须加 timeout=30**

### 7.2 RESULT 格式（必须遵守）

最后输出必须以 `---RESULT---` 开头（否则视为未完成被超时重派）：

```
---RESULT---
状态: 成功/失败 | 摘要: ≤5句每句≤30字禁列表表格代码块 | 详情: 报告路径或"无需"
```

完成后执行：`task-state-update.py done --id {id} --summary "2句内摘要"`

### 7.3 子 Agent 嵌套 spawn

子 Agent 若自己 spawn 子任务，**必须**先调用 `octoclaw_spawn.py` 或至少先执行 `task-state-update.py upsert` 注册任务，否则面板无法显示任务标题。

---

## 八、🗂️ 任务状态管理

### task-state-update.py 用法

```bash
# 开始执行（子 Agent 第一步，必须执行）
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  upsert --id task-001 --label octopus-fix --model sonnet \
  --status running --expected-done "+5min"

# 标记完成
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  done --id task-001 --summary "修复了登录 token 持久化问题"

# 标记失败
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  failed --id task-001 --summary "文件权限不足，无法写入"

# queued 排队（等待依赖）
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  upsert --id task-002 --status queued --deps task-001 \
  --summary "等 task-001 完成后更新文档"

# pending_confirm（等待用户确认）
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  upsert --id task-003 --status pending_confirm \
  --summary "发现风险操作，等待用户确认"
```

### 状态说明

| status | 含义 |
|--------|------|
| running | 执行中 |
| done | 完成 |
| failed | 失败 |
| queued | 等待依赖（deps 全 done 后 patrol 自动 spawn） |
| pending_confirm | 等用户确认（10 分钟未确认 patrol 提醒） |
| deferred | 待定，暂不执行 |

### 面板格式

成本：💰 GLM | 💰💰 Sonnet | 💰💰💰 Opus
状态：⏸️排队 | 🟡派遣 | 🔵运行 | ✅完成 | ❌失败
预计时间：trivial=+1min | simple=+3min | normal=+5min | hard=+8min | deep=+15min

运行中任务格式：`触手名 · 模型 · ⏱️ 已运行时长 · 预计 HH:MM`（预计完成时间，spawn 时 --expected-done 参数决定）

---

## 九、🔄 patrol 两阶段机制

**传统问题**：patrol 每轮调 LLM，即使空闲也消耗 ~400 tokens/轮。

**两阶段设计（节省 75% tokens）**：

```
patrol 触发
   │
   ▼
阶段1：纯文件扫描（无 LLM）
   ├── 读取 task-state.json
   ├── 检查超时/queued/卡死任务
   └── 无异常 → PATROL_SKIP，退出（~100 tokens）
          │
          └── 有异常 → 阶段2：LLM 决策（~400 tokens）
                         ├── 分析超时原因 → kill + 重派
                         ├── 解锁 queued → 自动 spawn
                         └── 发飞书告警卡片
```

---

## 十、⚠️ 超时与重派

### 超时分级

| 等级 | 超时 |
|------|------|
| trivial | 3 min |
| simple | 5 min |
| normal | 8 min |
| hard | 15 min |
| deep | 20 min |

### STUCK_TASKS 自动重派规则

收到 patrol announce 含 `STUCK_TASKS:` 时解析 JSON 列表：

| reason 含 | 处理策略 |
|-----------|---------|
| "token" | 升一级模型重派（GLM→Sonnet→Opus） |
| "ghost_completion" + 原模型含 "glm" | 强制升级到 Sonnet（GLM context overflow bug） |
| "超过预期" + 已是 done | 调 `task-state-update.py done` 标记，不重派 |
| 其他 | 同级重派，task 开头加"上次失败原因：{reason}" |

### announce 超时降级

等待子 Agent 超过预期完成时间 + 5 分钟仍无 announce → 主 Agent 可执行一次 `python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py get --id {task_id}` 查询真实状态，再决定是否重派。（patrol 会兜底自动处理，此规则用于主 Agent 主动判断）

### announce 有 still N active 时处理

当 patrol announce 输出含 `still N active` 时：
- **查询类任务**（梭鱼眼/章鱼脑/飞鱼腿的查询操作）：立刻回复用户，不等开发类任务完成
- **开发类任务**（鲸力手/螃蟹手/墨鱼手）：继续等待，走正常超时流程

原因：查询类结果已出即可交付，无需等待其他开发任务。

---

## 十一、🤝 鸽手（飞书专属）规范

派鸽手执行飞书操作时，task 开头必须包含：
1. 读取 feishu-almighty SKILL.md：`head -n 60 /workspace/openclaw/skills/feishu-almighty/SKILL.md`（或 `/workspace/skills/feishu-almighty/SKILL.md`）
2. 查 API 文档 → 判断 token 类型 → 获取 token → 调 API
3. 权限不足时自动切换用户应用 token

---

## 十二、🛡️ 错误防御与 Self-improving

**主错误记录接口**：优先兼容 `self-improving-agent` 的 `.learnings` 约定，而不是另起一套私有协议。

优先级：
1. `~/.openclaw/workspace/.learnings/ERRORS.md`
2. `/workspace/.learnings/ERRORS.md`（旧路径，向后兼容）
3. `~/self-improving/domains/octopus-errors.md`（镜像摘要，可选）

**spawn 前防御检查**：
- 读取 ERRORS.md 中 status=open 记录
- medium+ 且重现 ≥2 次 → 先执行 `resolve-model.py` 防御
- "ghost_completion" + GLM → 强制升级到 Sonnet

### 12.1 错误经验晋升规则

不是所有错误都直接写进 `SKILL.md`。按这条晋升链处理：

1. **现场错误** → 先写 `.learnings/ERRORS.md`
2. **nightly review** → 聚合同类错误、增加重现次数、补建议修复
3. **重复且通用** → 升级到代码默认行为 / runtime 校验
4. **高频且会坑其他用户** → 再写进 `SKILL.md` / `install.sh` / README

可直接晋升到 `SKILL.md` 的典型例子：
- `runtime=subagent` 禁止带 `streamTo`
- 长内容默认写共享文件，不要直接塞上下文
- spawn 任务先注册 `task-state`，失败也要可见

更适合只留在 `.learnings/ERRORS.md` 或 incident 文档的例子：
- 某天某次 VM 的旧进程混跑
- 某次临时插件冲突
- 单次外部网络抖动

### 12.2 nightly review 目标

nightly review 不负责“自动写一堆废话”，只负责三件事：
- 合并重复错误，更新重现次数
- 找出需要升格为防御规则的高频问题
- 把通用经验同步回代码、`SKILL.md` 和仓库文档

---

## 十三、🔧 常用命令

```bash
# 查看状态
bash /workspace/openclaw/skills/octopus/lib/status.sh

# 表格视图
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table

# 泳道视图
bash /workspace/openclaw/skills/octopus/lib/status.sh --format lanes

# 常驻飞鱼腿（最小版）
bash /workspace/openclaw/skills/octopus/lib/runner_loop.sh

# 轻任务入队
python3 /workspace/openclaw/skills/octopus/lib/runner_queue.py enqueue --id runner-demo --command 'pwd' --summary '检查当前目录'

# 更推荐的派发入口（会同步写 task-state）
python3 /workspace/openclaw/skills/octopus/lib/runner_dispatch.py --command 'pwd' --summary '检查当前目录'

# 统一派发入口（会自动判断 runner 或常规 spawn）
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task '查一下 redis 日志和端口状态' --command 'ss -lntp | grep 6379'

# 最小 replay/eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# 强制刷新任务面板
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force

# 紧急关闭（禁用，保留配置）
touch /workspace/tmp/octopus-disabled

# 重新启用
rm -f /workspace/tmp/octopus-disabled

# 清除模型缓存
rm -f /tmp/octopus-model-cache.json

# 安装/卸载
bash /workspace/openclaw/skills/octopus/install.sh
bash /workspace/openclaw/skills/octopus/install.sh uninstall
```

**飞书状态卡片**：

```bash
# 发送初始面板
python3 /workspace/openclaw/skills/octopus/lib/feishu-card.py send \
  '[{"tentacle":"螃蟹手","emoji":"🔧","task":"修复登录bug","status":"dispatched","model":"sonnet"}]'

# 更新面板（完成时）
python3 /workspace/openclaw/skills/octopus/lib/feishu-card.py update \
  '[{"tentacle":"螃蟹手","emoji":"🔧","task":"修复登录bug","status":"done","model":"sonnet","duration":"2m34s"}]'
```

> ⚠️ 卸载后执行 `/compact` 让规则移除在当前会话生效。
