#!/usr/bin/env python3
"""
slowlog-check.py - 主 Agent 慢响应检测
每天运行一次，扫描前一天的主 session 日志
检测主 Agent 违规调用 exec/read/write 等工具导致的卡顿
"""

import json, os, glob, sys, subprocess
from datetime import datetime, timezone, timedelta

from octopus_config import WORKSPACE

SESSION_DIR = "/root/.openclaw/agents/main/sessions/"
ERRORS_MD = f"{WORKSPACE}/.learnings/ERRORS.md"
SLOWLOG_STATE = "/tmp/octopus-slowlog-lastrun"
THRESHOLD_SEC = 180  # 3分钟

VIOLATION_TOOLS = {'exec', 'read', 'write', 'edit', 'web_fetch', 'browser', 'web_search', 'memory_search', 'memory_get'}

# 飞书通知已移除，改为系统 cron 执行

def append_error(violation):
    now = datetime.now()
    err_id = f"ERR-{now.strftime('%Y%m%d')}-SLOWLOG"
    line = (f"\n| {err_id} | medium | open | 重现1次 | "
            f"主Agent卡顿{violation['duration_sec']}s 工具:{violation['tool']} "
            f"时间:{violation['start_ts'][:16]} |")
    try:
        # 检查是否今天已记录过
        if os.path.exists(ERRORS_MD):
            with open(ERRORS_MD) as f:
                content = f.read()
            if now.strftime('%Y%m%d') in content and 'SLOWLOG' in content:
                return  # 今天已记录，跳过
        with open(ERRORS_MD, 'a') as f:
            f.write(line + '\n')
    except Exception:
        pass

def main():
    # 检查今天是否已运行
    now_ts = datetime.now(timezone.utc).timestamp()
    if os.path.exists(SLOWLOG_STATE):
        try:
            last_run = float(open(SLOWLOG_STATE).read().strip())
            if now_ts - last_run < 82800:  # 23小时内不重复跑
                sys.exit(0)
        except Exception:
            pass
    
    # 找最近24小时最大的 session 文件
    cutoff = now_ts - 86400
    sessions = [f for f in glob.glob(f"{SESSION_DIR}*.jsonl") 
                if os.path.getmtime(f) > cutoff and os.path.getsize(f) > 10000]
    if not sessions:
        sys.exit(0)
    main_session = max(sessions, key=os.path.getsize)
    
    # 解析消息时间戳
    messages = []
    with open(main_session) as f:
        for line in f:
            try:
                d = json.loads(line)
                ts_str = d.get('timestamp') or d.get('ts') or d.get('createdAt')
                if ts_str:
                    ts = datetime.fromisoformat(ts_str.replace('Z','+00:00')).timestamp()
                    if ts > cutoff:  # 只看最近24h
                        messages.append({'ts': ts, 'data': d})
            except Exception:
                pass
    
    messages.sort(key=lambda x: x['ts'])
    if len(messages) < 2:
        sys.exit(0)
    
    # 找卡顿片段
    violations = []
    for i in range(1, len(messages)):
        gap = messages[i]['ts'] - messages[i-1]['ts']
        if gap > THRESHOLD_SEC:
            context = messages[max(0,i-5):i+5]
            tool_used = None
            for m in context:
                d = m['data']
                tool = d.get('toolName') or d.get('name','')
                if not tool and d.get('type') == 'tool_use':
                    tool = d.get('tool','')
                if tool and tool.lower() in VIOLATION_TOOLS:
                    tool_used = tool
                    break
            violations.append({
                'start_ts': datetime.fromtimestamp(messages[i-1]['ts'], tz=timezone.utc).astimezone().isoformat(),
                'end_ts': datetime.fromtimestamp(messages[i]['ts'], tz=timezone.utc).astimezone().isoformat(),
                'duration_sec': int(gap),
                'tool': tool_used or 'unknown',
                'severity': 'high' if gap > 300 else 'medium'
            })
    
    # 记录运行时间
    with open(SLOWLOG_STATE, 'w') as f:
        f.write(str(now_ts))
    
    if not violations:
        sys.exit(0)
    
    # 取最严重的一个报告
    worst = max(violations, key=lambda x: x['duration_sec'])
    append_error(worst)
    
    # 飞书通知
    total = len(violations)
    max_gap = worst['duration_sec']
    msg = f"""⚠️ 八爪鱼慢响应日报
━━━━━━━━━━━━━━━━
发现 {total} 次卡顿（>{THRESHOLD_SEC}s）
最长卡顿：{max_gap}s（工具：{worst['tool']}）
时间：{worst['start_ts'][:16]}

⚡ 原因：主 Agent 直接调用了 {worst['tool']} 工具
✅ 应对：下次遇到此类任务，先回复用户再 spawn 子 Agent
━━━━━━━━━━━━━━━━
每日自动检测"""
    send_feishu(msg)

if __name__ == '__main__':
    main()
