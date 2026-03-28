# 八爪鱼子 Agent 工作规范 v1.1.0
# 路径: /workspace/openclaw/skills/octopus/lib/spawn-template.md
# 子 Agent 第一步必须读取此文件（head -n 80 即可）

## 🚦 执行第一步：状态写入

**立即执行**（在任何读文件/工具调用之前）：

```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  upsert --id {TASK_ID} --label {LABEL} --model {MODEL} \
  --status running --expected-done "+{N}min"
```

字段说明：
- `id`：格式 `{label}-{YYYYMMDD}-{序号}`，例：`octopus-fix-20260309-001`
- `expected-done`：trivial=+3min | simple=+5min | normal=+8min | hard=+15min | deep=+20min
- `source`：必须是 `octopus`（不写则 patrol 不会处理）

## 📋 文件读取规范（防 token 超限）

```bash
# ✅ 正确用法
head -n 100 /path/to/file          # 读前100行
tail -n 50 /path/to/file           # 读最后50行
grep "keyword" file | head -20     # 搜索结果截断
cat file | head -n 60              # 替代 cat

# ❌ 禁止
cat /path/to/large/file            # 禁止读完整大文件
find / -name "*.log"               # 禁止全盘扫描
```

每次 exec 加 timeout=30（秒）。每 turn ≤500 字，内容写文件不要攒在最后。

## ⚡ Fail Fast 原则（节省 token 的关键）

遇到以下情况，**立即停止，写 failed 状态，不要继续消耗 token 硬撑**：

- 找不到目标文件/接口，且无法合理推断位置
- 权限不足，操作被拒
- 发现任务描述有歧义，无法确定正确方向
- 前置条件不满足（依赖的上游结果不存在）

```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  failed --id {TASK_ID} --summary "阻塞原因（1句）：xxx，建议：xxx"
```

然后输出：
```
---RESULT---
{"schema_version":"octoclaw.worker_result/v1","status":"failed","summary":"遇到阻塞：xxx。建议主 Agent 补充 xxx 后重派。","artifacts":[],"files":[],"report":"","risks":[],"next_step":"补充 xxx 后重派"}
```

**为什么**：被动等 patrol 超时重派会浪费整个超时窗口（normal 任务最多 8 分钟）的 token；
主动 fail fast 让主 Agent 立刻拿到原因，重派时能补充正确上下文，一次成功。

## 📝 经验沉淀（可选）

任务完成后，若发现可复用的经验（技巧/踩坑/最佳实践），追加到对应触手的笔记文件：

```bash
mkdir -p /workspace/tmp/octopus/agent-notes
echo "- $(date +%Y-%m-%d): 经验一句话（≤50字）" >> /workspace/tmp/octopus/agent-notes/{LABEL}.md
# 例：echo "- 2026-03-12: grep搜索前先确认路径，避免全盘扫描" >> /workspace/tmp/octopus/agent-notes/octopus-fix.md
```

格式：`- YYYY-MM-DD: 一句话经验（≤50字）`

**只在发现真正有价值的新经验时才写，不强制每次都写。**

## ✅ 完成时：状态更新

```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  done --id {TASK_ID} --summary "2句内摘要，不超过60字"
```

失败时：
```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py \
  failed --id {TASK_ID} --summary "失败原因，不超过60字"
```

## 📤 RESULT 格式（最终回复必须遵守，否则视为未完成被重派）

最后输出必须以 `---RESULT---` 开头：

**优选 JSON 格式（推荐）：**
```
---RESULT---
{"schema_version":"octoclaw.worker_result/v1","status":"done","summary":"默认 2-5句结论；调研/分析/写作任务可放宽到 4-8句可直接转述给用户的中文结论；禁表格/代码块","artifacts":["path-or-id"],"files":["改动文件路径"],"report":"详情报告路径或空字符串","risks":[],"next_step":"若无需后续动作写 none"}
```

**兼容文本格式（也被识别）：**
```
---RESULT---
状态: 成功
摘要: 默认 2-5句结论；调研/分析/写作任务可放宽到 4-8句可直接转述给用户的中文结论
详情: 详情报告路径或"无需"
```

规则：
1. status 建议使用 `done` / `blocked` / `failed`；兼容老格式 `success` / `failure`
2. summary/摘要：默认 ≤5句；调研/分析/写作任务可放宽到 4-8句，但仍需简洁、可直接转述给用户，禁止表格、代码块
3. `artifacts` 填路径或 artifact id；长报告同时写入 `report`
4. `next_step` 必填；若无后续动作写 `none`
5. 详细内容写文件（`/workspace/tmp/octopus/results/{task-id}.md`），RESULT 只填路径

## 📂 大输出写共享文件区

**输出 > 500 字时，禁止直接塞进 RESULT summary**，必须写入共享文件区：

```bash
mkdir -p /workspace/tmp/octopus/shared
cat > /workspace/tmp/octopus/shared/{TASK_ID}.md << 'EOF'
...详细内容...
EOF
```

RESULT 的 `report` 字段填路径，`summary` 仍要写可直接转述的结论，不能只写“已写入报告”：

```
---RESULT---
{"schema_version":"octoclaw.worker_result/v1","status":"done","summary":"分析完成，发现3个关键问题，已写入报告","artifacts":["/workspace/tmp/octopus/shared/{TASK_ID}.md"],"files":[],"report":"/workspace/tmp/octopus/shared/{TASK_ID}.md","risks":[],"next_step":"none"}
```

**为什么**：A2A announce 有 30 秒硬超时，超时后消息丢失；共享文件持久可靠，主 Agent 或用户按需读取。

## 📦 task-state.json 完整字段说明

写入路径：`/workspace/tmp/octopus/task-state.json`

```json
{
  "id": "octopus-fix-20260309-001",
  "source": "octopus",
  "label": "octopus-fix",
  "model": "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6",
  "tier": "normal",
  "status": "running",
  "summary": "",
  "files_changed": [],
  "artifacts": {},
  "deps": [],
  "spawned_at": "2026-03-09T12:00:00Z",
  "started_at": "2026-03-09T12:00:05Z",
  "expected_done_at": "2026-03-09T12:08:00Z",
  "completed_at": ""
}
```

完成后：
- `status` → `done` 或 `failed`
- `summary` → 2句内摘要
- `files_changed` → 改动的文件路径列表
- `completed_at` → ISO 时间戳
- 顺带清理 7 天前的 done/failed 记录

## 🔗 子 Agent 嵌套 spawn

若需要再 spawn 子任务，**必须先调用 task-state-update.py upsert 注册任务**（否则面板无法显示）。

## 🧠 thinking 参数（可选）

| tier | thinking | 适用场景 |
|------|----------|---------|
| trivial / simple | `off` | 配置修改、单行改动 |
| normal | `minimal` | 写代码、调 API |
| hard | `low` | 复杂逻辑、多文件 |
| deep | `medium` | 架构分析、深度调研 |
