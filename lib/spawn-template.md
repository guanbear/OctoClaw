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
{"status":"success","summary":"2-5句结论，每句≤30字，禁列表/表格/代码块","files":["改动文件路径"],"report":"详情报告路径或null"}
```

**兼容文本格式（也被识别）：**
```
---RESULT---
状态: 成功
摘要: 2-5句结论，每句≤30字，禁列表/表格/代码块
详情: 详情报告路径或"无需"
```

规则：
1. status 只能是 `success` 或 `failure`（JSON）/ `成功` 或 `失败`（文本）
2. summary/摘要：≤5句，每句≤30字，禁止使用列表、表格、代码块
3. 详细内容写文件（`/workspace/tmp/octopus/results/{task-id}.md`），RESULT 只填路径

## 📂 大输出写共享文件区

**输出 > 500 字时，禁止直接塞进 RESULT summary**，必须写入共享文件区：

```bash
mkdir -p /workspace/tmp/octopus/shared
cat > /workspace/tmp/octopus/shared/{TASK_ID}.md << 'EOF'
...详细内容...
EOF
```

RESULT 的 `report` 字段填路径，`summary` 只写 2-5 句结论：

```
---RESULT---
{"status":"success","summary":"分析完成，发现3个关键问题，已写入报告","files":[],"report":"/workspace/tmp/octopus/shared/{TASK_ID}.md"}
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
