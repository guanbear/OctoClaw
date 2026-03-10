#!/bin/bash
# 八爪鱼轻量模型延迟探测
# 如果铁甲虾在，使用铁甲虾的探测；否则自己探测

LATENCY_FILE="/tmp/ironclaw-model-latency.json"
MAX_AGE=1200  # 20分钟
IRONCLAW_BIN="/workspace/openclaw/skills/ironclaw/bin/ironclaw"

# ── 公共函数：从延迟文件生成模型别名 ────────────────────────────────
generate_model_aliases() {
python3 << 'PYEOF'
import json, time, os

LATENCY_FILE = "/tmp/ironclaw-model-latency.json"
ALIAS_FILE   = "/workspace/tmp/octopus-model-aliases.json"

DEFAULTS = {
    "trivial": "lixiang-glm-5/kivy-glm-5",            # 用户偏好：trivial 用 GLM，不用 Kimi
    "simple":  "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6",
    "normal":  "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6",
    "deep":    "vendor-claude-opus-4-6/aws-claude-opus-4-6",
    "speed":   "lixiang-glm-5/kivy-glm-5",            # 用户偏好：speed 用 GLM，不用 Kimi
}

def best_model(keyword, models_dict):
    """从可用模型中找含 keyword 的、延迟最低的那个，失败返回 None"""
    candidates = [
        (k, v) for k, v in models_dict.items()
        if keyword.lower() in k.lower() and v.get("available", False)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda x: x[1].get("latency_ms", 99999))[0]

def select_model_with_aws_preference(keyword, models_dict, threshold=0.5):
    """
    优先选 AWS 供应商的模型。
    只有当非AWS模型的延迟比所有AWS模型最低延迟还要快超过 threshold(50%) 时，才选非AWS。
    threshold=0.5 意味着：非AWS延迟 < AWS最低延迟 * (1 - 0.5) = AWS最低延迟 * 0.5

    Returns:
        (model_id, is_non_aws_switch, aws_lat, non_aws_lat)
        - model_id: 选出的模型 ID
        - is_non_aws_switch: True 表示选出了非AWS模型且超过阈值（需要用户确认）
        - aws_lat: 最优 AWS 模型延迟（ms），无 AWS 模型时为 None
        - non_aws_lat: 最优非AWS模型延迟（ms），无非AWS模型时为 None
    """
    candidates = [
        (v.get("latency_ms", 99999), k)
        for k, v in models_dict.items()
        if keyword.lower() in k.lower() and v.get("available", False)
    ]
    if not candidates:
        return None, False, None, None

    aws_models     = [(lat, mid) for lat, mid in candidates if "aws" in mid.lower()]
    non_aws_models = [(lat, mid) for lat, mid in candidates if "aws" not in mid.lower()]

    aws_models.sort()
    non_aws_models.sort()

    if not aws_models:
        # 没有 AWS 模型，选最快的，无需确认
        result = non_aws_models[0][1] if non_aws_models else None
        non_lat = non_aws_models[0][0] if non_aws_models else None
        return result, False, None, non_lat

    best_aws_lat, best_aws = aws_models[0]
    best_non_aws_lat = non_aws_models[0][0] if non_aws_models else None
    best_non_aws     = non_aws_models[0][1] if non_aws_models else None

    if non_aws_models:
        # 只有非AWS比AWS快超过50%才切换
        if best_non_aws_lat < best_aws_lat * (1 - threshold):
            return best_non_aws, True, best_aws_lat, best_non_aws_lat

    return best_aws, False, best_aws_lat, best_non_aws_lat


def check_pending_confirm(tier, proposed_model):
    """检查 task-state.json 是否已有针对该 tier+proposed_model 的 pending_confirm 记录"""
    state_file = "/workspace/tmp/octopus/task-state.json"
    try:
        with open(state_file) as f:
            state = json.load(f)
        for task in state.get("tasks", []):
            if (task.get("label") == "pending_confirm"
                    and task.get("status") == "pending_confirm"):
                arts = task.get("artifacts", {})
                if arts.get("tier") == tier and arts.get("proposed_model") == proposed_model:
                    return True
    except Exception:
        pass
    return False


def write_pending_confirm(tier, current_model, proposed_model, speedup_pct):
    """向 task-state.json 写入 pending_confirm 记录"""
    import datetime
    state_file = "/workspace/tmp/octopus/task-state.json"
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    try:
        with open(state_file) as f:
            state = json.load(f)
    except Exception:
        state = {"tasks": [], "updated_at": ""}

    now_iso = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    date_str = datetime.datetime.utcnow().strftime("%Y%m%d")
    record = {
        "id":         f"confirm-{date_str}-model-switch-{tier}",
        "label":      "pending_confirm",
        "status":     "pending_confirm",
        "summary":    f"等待确认：{proposed_model} 替换 {current_model}（{tier} 级别）",
        "spawned_at": now_iso,
        "completed_at": "",
        "artifacts": {
            "tier":           tier,
            "current_model":  current_model,
            "proposed_model": proposed_model,
            "speedup_pct":    speedup_pct,
        }
    }
    state["tasks"].append(record)
    state["updated_at"] = now_iso
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    return record["id"]


def _get_feishu_token_and_openid():
    """公共辅助：读取配置，返回 (token, open_id)，失败返回 (None, None)"""
    import urllib.request as urlreq
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
    except Exception as e:
        print(f"⚠️  无法读取 openclaw 配置，跳过飞书通知：{e}")
        return None, None

    # 获取 open_id（先读 sessions.json，找不到则用硬编码兜底）
    open_id = None
    sessions_path = os.path.expanduser("~/.openclaw/sessions.json")
    try:
        with open(sessions_path) as f:
            sessions = json.load(f)
        for key in sessions:
            if key.startswith("feishu:dm:ou_"):
                open_id = key.split("feishu:dm:")[1]
                break
    except Exception:
        pass
    if not open_id:
        open_id = "ou_373285ded0f664b08b43820c32f3d1b7"

    # 获取 app_id / app_secret
    feishu_cfg = config.get("channels", {}).get("feishu", {})
    app_id     = feishu_cfg.get("appId") or feishu_cfg.get("app_id") or "cli_a90f871e65f8dcc0"
    app_secret = feishu_cfg.get("appSecret") or feishu_cfg.get("app_secret")
    if not app_secret:
        print("⚠️  未找到飞书 appSecret，跳过通知")
        return None, None

    api_base = "https://open.feishu.cn/open-apis"
    try:
        token_req = urlreq.Request(
            f"{api_base}/auth/v3/tenant_access_token/internal",
            data=json.dumps({"app_id": app_id, "app_secret": app_secret}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urlreq.urlopen(token_req, timeout=10) as resp:
            token_data = json.loads(resp.read())
        if token_data.get("code") != 0:
            print(f"⚠️  获取飞书 token 失败：{token_data.get('msg')}")
            return None, None
        return token_data["tenant_access_token"], open_id
    except Exception as e:
        print(f"⚠️  飞书 token 请求失败：{e}")
        return None, None


def _feishu_post(token, open_id, msg_type, content_dict):
    """公共辅助：POST 到飞书消息接口，返回 True/False"""
    import urllib.request as urlreq
    api_base = "https://open.feishu.cn/open-apis"
    try:
        payload = json.dumps({
            "receive_id": open_id,
            "msg_type":   msg_type,
            "content":    json.dumps(content_dict, ensure_ascii=False)
        }).encode("utf-8")
        req = urlreq.Request(
            f"{api_base}/im/v1/messages?receive_id_type=open_id",
            data=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type":  "application/json; charset=utf-8"
            },
            method="POST"
        )
        with urlreq.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
        if result.get("code") != 0:
            print(f"⚠️  飞书消息发送失败 (code={result.get('code')}): {result.get('msg')}")
            return False
        print(f"✅ 飞书通知已发送（open_id={open_id}）")
        return True
    except Exception as e:
        print(f"⚠️  飞书消息发送异常：{e}")
        return False


def send_feishu_text(text):
    """发送飞书文本消息给用户"""
    token, open_id = _get_feishu_token_and_openid()
    if not token:
        return False
    return _feishu_post(token, open_id, "text", {"text": text})


def send_model_switch_card(tier, current_model, proposed_model, current_lat, proposed_lat,
                           speedup_pct, count, elapsed_minutes):
    """
    发送飞书普通文字消息通知模型切换建议（text 类型，无按钮）。
    用户通过回复「确认切换」或「拒绝切换」完成操作。
    """
    def friendly(mid):
        if "google" in mid.lower():
            return "Google Sonnet 4.6" if "sonnet" in mid.lower() else "Google Opus 4.6"
        if "aws" in mid.lower():
            return "AWS Sonnet 4.6" if "sonnet" in mid.lower() else "AWS Opus 4.6"
        if "glm"  in mid.lower(): return "GLM-5"
        if "kimi" in mid.lower(): return "Kimi K2.5"
        return mid

    current_name  = friendly(current_model)
    proposed_name = friendly(proposed_model)

    # 根据 tier 显示对应级别名称
    tier_label = {
        "normal": "normal/simple",
        "simple": "normal/simple",
        "deep":   "deep",
        "trivial": "trivial",
    }.get(tier, tier)

    msg = (
        f"🔄 模型切换建议\n\n"
        f"检测到更快的模型（已连续{count}次确认）：\n\n"
        f"📊 {tier_label} 级别\n"
        f"  当前：{current_name}（{current_lat}ms）\n"
        f"  建议：{proposed_name}（{proposed_lat}ms）\n"
        f"  提升：快 {speedup_pct}%\n\n"
        f"回复「确认切换」立即生效\n"
        f"回复「拒绝切换」保持当前模型"
    )

    print(f"📤 发送飞书文字通知（{tier}: {current_name} → {proposed_name}）...")
    return send_feishu_text(msg)


CANDIDATES_FILE = "/workspace/tmp/octopus/.model-switch-candidates.json"
DEBOUNCE_COUNT  = 3       # 至少连续检测到 N 次
DEBOUNCE_MINS   = 30      # 且首次检测距今至少 N 分钟


def _load_candidates():
    """读取候选切换文件，返回 dict（tier -> record）"""
    try:
        with open(CANDIDATES_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_candidates(data):
    os.makedirs(os.path.dirname(CANDIDATES_FILE), exist_ok=True)
    with open(CANDIDATES_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _verify_non_aws_faster(tier_keyword, proposed_model, aws_lat_orig, non_aws_lat_orig, threshold=0.5):
    """
    二次验证：重新读取延迟文件，判断非AWS模型是否仍比AWS快超过 threshold(50%)。
    返回 (still_faster, new_aws_lat, new_non_aws_lat)
      - still_faster=True  → 二次验证确认超过阈值
      - still_faster=False → 二次验证未超（偶发抖动，应忽略）
    如果延迟文件 mtime 没有变化（探测数据未更新），则视为确认（保守处理 → 返回True）。
    """
    try:
        prev_mtime = os.path.getmtime(LATENCY_FILE) if os.path.exists(LATENCY_FILE) else 0
        with open(LATENCY_FILE) as f:
            data = json.load(f)
        new_mtime = os.path.getmtime(LATENCY_FILE)

        if abs(new_mtime - prev_mtime) < 1:
            # 文件未更新（mtime 相同），视为确认
            print(f"⚠️  延迟文件未更新（mtime 无变化），二次验证保守确认")
            return True, aws_lat_orig, non_aws_lat_orig

        models_dict = data.get("models", {})
        _, is_non_aws, new_aws_lat, new_non_aws_lat = select_model_with_aws_preference(
            tier_keyword, models_dict, threshold
        )
        return is_non_aws, new_aws_lat, new_non_aws_lat
    except Exception as e:
        print(f"⚠️  二次验证读取延迟文件失败：{e}，保守确认")
        return True, aws_lat_orig, non_aws_lat_orig


def update_candidate(tier, proposed_model, current_model, speedup_pct,
                     tier_keyword=None, aws_lat=None, non_aws_lat=None):
    """
    记录一次「超50%」检测。
    返回 (should_notify, count, elapsed_minutes)：
      - should_notify=True  → 达到防抖阈值，可发通知
      - should_notify=False → 尚未达到，仅更新计数
      - (False, 0, 0)       → 二次验证未通过，本次忽略

    二次验证逻辑（仅首次检测 count 0→1 时触发）：
      sleep 30s → 重读延迟文件 → 仍超50% 才计入 count=1
    """
    import datetime
    candidates = _load_candidates()
    now_ts = time.time()
    now_iso = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    entry = candidates.get(tier)
    # 如果候选模型变了（上次记的是另一个非AWS模型），重置
    if entry and entry.get("proposed") != proposed_model:
        entry = None

    if entry is None:
        # ── 首次检测：执行即时二次验证 ────────────────────────────────
        print(f"⏳ 首次检测到 [{tier}] 级别非AWS模型延迟优势，30秒后二次验证...")
        time.sleep(30)

        kw = tier_keyword or ("sonnet" if "sonnet" in proposed_model.lower()
                              else "opus" if "opus" in proposed_model.lower()
                              else "sonnet")
        still_faster, v_aws_lat, v_non_aws_lat = _verify_non_aws_faster(
            kw, proposed_model, aws_lat or 9999, non_aws_lat or 0
        )
        if not still_faster:
            # 二次验证未超50%，忽略本次（偶发抖动）
            print(f"✅ 二次验证：[{tier}] 非AWS延迟优势已消失，忽略本次检测（偶发抖动）")
            return False, 0, 0.0

        v_speedup = int((v_aws_lat - v_non_aws_lat) / v_non_aws_lat * 100) if v_non_aws_lat else speedup_pct
        print(f"✅ 二次验证确认：[{tier}] 非AWS仍快 {v_speedup}%（{v_non_aws_lat}ms vs {v_aws_lat}ms），计入 count=1")

        entry = {
            "proposed":       proposed_model,
            "current":        current_model,
            "first_detected": now_iso,
            "first_ts":       now_ts,
            "count":          1,
            "notify_count":   0,
            "speedup_pct":    v_speedup,
            "last_updated":   now_iso,
        }
    else:
        # 后续累积：不需要二次验证，直接计数
        entry["count"]        += 1
        entry["speedup_pct"]  = speedup_pct   # 更新为最新值
        entry["last_updated"] = now_iso
        # 确保旧记录有 notify_count 字段
        if "notify_count" not in entry:
            entry["notify_count"] = 0

    candidates[tier] = entry
    _save_candidates(candidates)

    # 计算距首次检测的时间：优先用 first_ts（float），回退到解析 first_detected（ISO）
    if "first_ts" in entry:
        elapsed_minutes = (now_ts - entry["first_ts"]) / 60.0
    else:
        try:
            fd_dt = datetime.datetime.strptime(entry["first_detected"], "%Y-%m-%dT%H:%M:%SZ")
            fd_ts = (fd_dt - datetime.datetime(1970, 1, 1)).total_seconds()
            elapsed_minutes = (now_ts - fd_ts) / 60.0
        except Exception:
            elapsed_minutes = 0.0
    should_notify = (entry["count"] >= DEBOUNCE_COUNT
                     and elapsed_minutes >= DEBOUNCE_MINS)

    print(f"📊 候选记录更新 [{tier}] count={entry['count']} "
          f"elapsed={elapsed_minutes:.1f}min speedup={speedup_pct}% "
          f"→ {'✅ 触发通知' if should_notify else '⏳ 尚未达到阈值'}")
    return should_notify, entry["count"], elapsed_minutes


def clear_candidate(tier):
    """清除某级别的候选记录（恢复正常 / 用户已确认后调用）"""
    candidates = _load_candidates()
    if tier in candidates:
        del candidates[tier]
        _save_candidates(candidates)
        print(f"🗑️  候选记录已清除 [{tier}]")


def handle_non_aws_switch(tier, current_model, proposed_model, aws_lat, non_aws_lat):
    """
    即时二次验证 + 防抖 + 用户确认 三层保护：
      0. 首次检测时：sleep 30s 做即时二次验证，两次都超50%才计入 count=1
      1. 先更新候选计数；未达阈值则直接返回（只保持 AWS 版本，不通知）
      2. 达到阈值后，检查是否已有 pending_confirm（避免重复发消息）
      3. 符合条件才发飞书通知 + 写 pending_confirm
    返回 True 表示本次探测保持 AWS 版本。
    """
    speedup_pct = int((aws_lat - non_aws_lat) / non_aws_lat * 100) if non_aws_lat else 0

    # 推断 tier_keyword（用于二次验证重读延迟文件时选正确模型类型）
    if "sonnet" in proposed_model.lower():
        tier_keyword = "sonnet"
    elif "opus" in proposed_model.lower():
        tier_keyword = "opus"
    else:
        tier_keyword = proposed_model.split("/")[-1].split("-")[0]

    # ── 即时二次验证 + 防抖层 ────────────────────────────────────────────
    should_notify, count, elapsed = update_candidate(
        tier, proposed_model, current_model, speedup_pct,
        tier_keyword=tier_keyword, aws_lat=aws_lat, non_aws_lat=non_aws_lat
    )
    if not should_notify:
        # 未达阈值（含二次验证未通过）：只记录或忽略，保持 AWS 版本
        return True

    # ── notify_count 限制：最多通知3次 ────────────────────────────────────
    candidates = _load_candidates()
    entry_check = candidates.get(tier, {})
    notify_count = entry_check.get("notify_count", 0)
    if notify_count >= 3:
        print(f"🔕 [{tier}] 已通知 {notify_count} 次（>= 3），静默跳过（等待自然恢复）")
        return True

    # ── pending_confirm 查重 ─────────────────────────────────────────────────
    if check_pending_confirm(tier, proposed_model):
        print(f"⏸️  已有待确认记录（{tier}: {proposed_model}），跳过重复通知")
        return True

    # ── 发送飞书交互卡片通知 ────────────────────────────────────────────────
    print(f"📢 发送飞书卡片通知：{tier} 级别模型切换建议（count={count}, elapsed={elapsed:.0f}min）")
    send_model_switch_card(
        tier=tier,
        current_model=current_model,
        proposed_model=proposed_model,
        current_lat=aws_lat,
        proposed_lat=non_aws_lat,
        speedup_pct=speedup_pct,
        count=count,
        elapsed_minutes=elapsed,
    )

    # notify_count +1
    candidates = _load_candidates()
    if tier in candidates:
        candidates[tier]["notify_count"] = candidates[tier].get("notify_count", 0) + 1
        _save_candidates(candidates)
        print(f"📊 [{tier}] notify_count 更新为 {candidates[tier]['notify_count']}")

    record_id = write_pending_confirm(tier, current_model, proposed_model, speedup_pct)
    print(f"📝 pending_confirm 已写入：{record_id}")
    return True


def handle_aws_recovered(tier):
    """
    当延迟差距回到 50% 以内（AWS 恢复正常）时调用：
    清除候选记录，视为恢复正常。
    """
    candidates = _load_candidates()
    if tier in candidates:
        clear_candidate(tier)
        print(f"♻️  [{tier}] 延迟差距已恢复到阈值内，清除候选记录")


def _verify_trivial_switch(glm_lat_orig, kimi_lat_orig, threshold=1.5):
    """
    二次验证 trivial 级别：重新读取延迟文件，判断 GLM↔Kimi 的选择是否仍然一致。
    返回 (still_switches, new_glm_lat, new_kimi_lat, new_proposed)
    """
    try:
        with open(LATENCY_FILE) as f:
            data = json.load(f)
        models_dict = data.get("models", {})
        new_glm  = sorted([(v["latency_ms"], k) for k, v in models_dict.items()
                           if "glm"  in k.lower() and v.get("available", False)])
        new_kimi = sorted([(v["latency_ms"], k) for k, v in models_dict.items()
                           if "kimi" in k.lower() and v.get("available", False)])
        if new_glm and new_kimi:
            ng_lat, ng_id   = new_glm[0]
            nk_lat, nk_id   = new_kimi[0]
            new_proposed = ng_id if ng_lat <= nk_lat * threshold else nk_id
            # 与原来的判断结果是否一致（都选 GLM 或都选 Kimi）
            orig_proposed = None
            if glm_lat_orig <= kimi_lat_orig * threshold:
                orig_proposed = "glm"
            else:
                orig_proposed = "kimi"
            new_is_glm = "glm" in new_proposed.lower()
            still_switches = (orig_proposed == "glm") == new_is_glm
            return still_switches, ng_lat, nk_lat, new_proposed
        return True, glm_lat_orig, kimi_lat_orig, None
    except Exception as e:
        print(f"⚠️  trivial 二次验证失败：{e}，保守确认")
        return True, glm_lat_orig, kimi_lat_orig, None


def handle_trivial_switch(current_model, proposed_model, glm_lat, kimi_lat):
    """
    trivial 级别 GLM↔Kimi 切换的防抖 + 用户确认流程：
      0. 首次检测时 sleep 30s 做即时二次验证
      1. 更新候选计数，未达阈值则保持当前模型
      2. 达到阈值后检查是否已有 pending_confirm
      3. 符合条件才发飞书通知 + 写 pending_confirm
    返回 True 表示本次保持 current_model（等待用户确认）。
    """
    tier = "trivial"

    # 计算速度差（仅用于提示，可为负数表示 GLM 更慢）
    if kimi_lat and kimi_lat > 0:
        speedup_pct = int((kimi_lat - glm_lat) / kimi_lat * 100)
    else:
        speedup_pct = 0

    candidates = _load_candidates()
    now_ts = time.time()
    import datetime
    now_iso = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    entry = candidates.get(tier)
    # 候选模型变了则重置
    if entry and entry.get("proposed") != proposed_model:
        entry = None

    if entry is None:
        # ── 首次检测：30秒二次验证 ─────────────────────────────────────
        print(f"⏳ 首次检测到 [trivial] 级别模型应切换至 {proposed_model}，30秒后二次验证...")
        time.sleep(30)

        still_ok, v_glm_lat, v_kimi_lat, v_proposed = _verify_trivial_switch(
            glm_lat, kimi_lat
        )
        if not still_ok or v_proposed is None:
            print(f"✅ 二次验证：[trivial] 切换信号消失，忽略本次（偶发抖动）")
            return True

        print(f"✅ 二次验证确认：[trivial] 应切换至 {v_proposed}，计入 count=1")
        entry = {
            "proposed":       proposed_model,
            "current":        current_model,
            "first_detected": now_iso,
            "first_ts":       now_ts,
            "count":          1,
            "notify_count":   0,
            "speedup_pct":    speedup_pct,
            "last_updated":   now_iso,
        }
    else:
        entry["count"]       += 1
        entry["speedup_pct"]  = speedup_pct
        entry["last_updated"] = now_iso
        # 确保旧记录有 notify_count 字段
        if "notify_count" not in entry:
            entry["notify_count"] = 0

    candidates[tier] = entry
    _save_candidates(candidates)

    # 计算距首次检测的时间
    if "first_ts" in entry:
        elapsed_minutes = (now_ts - entry["first_ts"]) / 60.0
    else:
        elapsed_minutes = 0.0

    should_notify = (entry["count"] >= DEBOUNCE_COUNT
                     and elapsed_minutes >= DEBOUNCE_MINS)

    count = entry["count"]
    print(f"📊 候选记录更新 [trivial] count={count} "
          f"elapsed={elapsed_minutes:.1f}min speedup={speedup_pct}% "
          f"→ {'✅ 触发通知' if should_notify else '⏳ 尚未达到阈值'}")

    if not should_notify:
        return True

    # ── notify_count 限制：最多通知3次 ────────────────────────────────────
    notify_count = entry.get("notify_count", 0)
    if notify_count >= 3:
        print(f"🔕 [trivial] 已通知 {notify_count} 次（>= 3），静默跳过（等待自然恢复）")
        return True

    # ── pending_confirm 查重 ─────────────────────────────────────────────────
    if check_pending_confirm(tier, proposed_model):
        print(f"⏸️  已有待确认记录（trivial: {proposed_model}），跳过重复通知")
        return True

    # ── 发送飞书交互卡片通知 ─────────────────────────────────────────────────
    print(f"📢 发送飞书卡片通知：trivial 级别模型切换建议（count={count}, elapsed={elapsed_minutes:.0f}min）")
    send_model_switch_card(
        tier=tier,
        current_model=current_model,
        proposed_model=proposed_model,
        current_lat=glm_lat if "glm" in current_model.lower() else kimi_lat,
        proposed_lat=glm_lat if "glm" in proposed_model.lower() else kimi_lat,
        speedup_pct=abs(speedup_pct),
        count=count,
        elapsed_minutes=elapsed_minutes,
    )

    # notify_count +1
    candidates = _load_candidates()
    if tier in candidates:
        candidates[tier]["notify_count"] = candidates[tier].get("notify_count", 0) + 1
        _save_candidates(candidates)
        print(f"📊 [trivial] notify_count 更新为 {candidates[tier]['notify_count']}")

    record_id = write_pending_confirm(tier, current_model, proposed_model, speedup_pct)
    print(f"📝 pending_confirm 已写入：{record_id}")
    return True


try:
    with open(LATENCY_FILE) as f:
        results = json.load(f)
except Exception as e:
    print(f"❌ 无法读取延迟文件：{e}")
    raise SystemExit(1)

avail_models = results.get("models", {})

aliases = {
    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}

# ── trivial 级别：GLM 效果优先 ────────────────────────────────────────────
# GLM 延迟 <= Kimi 延迟 * 1.5（不超过50%慢）→ 选 GLM
# GLM 延迟 > Kimi 延迟 * 1.5 → GLM 太慢，选 Kimi
glm_models  = sorted([(v["latency_ms"], k) for k, v in avail_models.items()
                       if "glm"  in k.lower() and v.get("available", False)])
kimi_models = sorted([(v["latency_ms"], k) for k, v in avail_models.items()
                       if "kimi" in k.lower() and v.get("available", False)])

trivial_model = None
if glm_models and kimi_models:
    best_glm_lat,  best_glm  = glm_models[0]
    best_kimi_lat, best_kimi = kimi_models[0]
    if best_glm_lat <= best_kimi_lat * 1.5:
        trivial_model = best_glm   # GLM 够快，效果优先
    else:
        trivial_model = best_kimi  # GLM 太慢，选 Kimi
elif glm_models:
    trivial_model = glm_models[0][1]
elif kimi_models:
    trivial_model = kimi_models[0][1]

trivial_model = trivial_model or DEFAULTS["trivial"]

# ── trivial 切换确认流程 ──────────────────────────────────────────────────
# 读取当前已写入的别名文件里的 trivial 模型，判断是否发生了跨厂商切换
_trivial_current = None
try:
    ALIAS_FILE = "/workspace/tmp/octopus-model-aliases.json"
    if os.path.exists(ALIAS_FILE):
        with open(ALIAS_FILE) as _f:
            _existing = json.load(_f)
        _trivial_current = _existing.get("trivial")
except Exception:
    pass

_trivial_current = _trivial_current or DEFAULTS["trivial"]

# 仅当新旧 trivial 模型跨越了 GLM↔Kimi 边界时才走确认流程
_cur_is_glm  = "glm"  in _trivial_current.lower()
_new_is_glm  = "glm"  in trivial_model.lower()
_cur_is_kimi = "kimi" in _trivial_current.lower()
_new_is_kimi = "kimi" in trivial_model.lower()

_trivial_switch_needed = (_cur_is_glm and _new_is_kimi) or (_cur_is_kimi and _new_is_glm)

if _trivial_switch_needed and glm_models and kimi_models:
    _glm_lat  = glm_models[0][0]
    _kimi_lat = kimi_models[0][0]
    _held = handle_trivial_switch(
        current_model=_trivial_current,
        proposed_model=trivial_model,
        glm_lat=_glm_lat,
        kimi_lat=_kimi_lat,
    )
    if _held:
        trivial_model = _trivial_current  # 保持原模型，等待用户确认
        print(f"⏸️  trivial 保持原模型（等待用户确认切换到 {_trivial_current}）")
    else:
        # 清除候选记录（切换完成）
        clear_candidate("trivial")
else:
    # 未发生跨厂商切换，清除旧候选记录
    if not _trivial_switch_needed:
        clear_candidate("trivial")

aliases["trivial"] = trivial_model

# ── sonnet（simple/normal 级别） ──────────────────────────────────────────
sonnet_result, sonnet_is_non_aws, sonnet_aws_lat, sonnet_non_aws_lat = \
    select_model_with_aws_preference("sonnet", avail_models)
sonnet_best = sonnet_result or DEFAULTS["simple"]

if sonnet_is_non_aws and sonnet_aws_lat is not None:
    # 非AWS比AWS快超过50%，走防抖+确认流程
    aws_default = DEFAULTS["simple"]
    handle_non_aws_switch(
        tier="normal",
        current_model=aws_default,
        proposed_model=sonnet_best,
        aws_lat=sonnet_aws_lat,
        non_aws_lat=sonnet_non_aws_lat,
    )
    # 本次探测保持 AWS 版本
    sonnet_best = aws_default
    print(f"⏸️  sonnet 保持 AWS 版本（等待用户确认切换到 {sonnet_result}）")
else:
    # AWS 已恢复正常（差距回到50%以内），清除候选记录
    handle_aws_recovered("normal")

aliases["simple"] = sonnet_best
aliases["normal"] = sonnet_best

# ── opus（deep 级别） ──────────────────────────────────────────────────────
opus_result, opus_is_non_aws, opus_aws_lat, opus_non_aws_lat = \
    select_model_with_aws_preference("opus", avail_models)
opus_best = opus_result or DEFAULTS["deep"]

if opus_is_non_aws and opus_aws_lat is not None:
    aws_default = DEFAULTS["deep"]
    handle_non_aws_switch(
        tier="deep",
        current_model=aws_default,
        proposed_model=opus_best,
        aws_lat=opus_aws_lat,
        non_aws_lat=opus_non_aws_lat,
    )
    opus_best = aws_default
    print(f"⏸️  opus 保持 AWS 版本（等待用户确认切换到 {opus_result}）")
else:
    handle_aws_recovered("deep")

aliases["deep"] = opus_best

# speed 级：所有可用模型中延迟最低的
speed_candidates = [(k, v) for k, v in avail_models.items() if v.get("available", False)]
if speed_candidates:
    aliases["speed"] = min(speed_candidates, key=lambda x: x[1].get("latency_ms", 99999))[0]
else:
    aliases["speed"] = DEFAULTS["speed"]

with open(ALIAS_FILE, "w") as f:
    json.dump(aliases, f, indent=2, ensure_ascii=False)

print(f"🏷️  模型别名已写入：{ALIAS_FILE}")
print(f"   trivial → {aliases['trivial']}")
print(f"   simple  → {aliases['simple']}")
print(f"   normal  → {aliases['normal']}")
print(f"   deep    → {aliases['deep']}")
print(f"   speed   → {aliases['speed']}")
PYEOF
}

# 时间戳复用：如果延迟文件在 20 分钟内已更新，直接跳过探测
if [ -f "$LATENCY_FILE" ]; then
    FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$LATENCY_FILE" 2>/dev/null || echo 0) ))
    if [ "$FILE_AGE" -lt "$MAX_AGE" ]; then
        echo "ℹ️  延迟数据仍然新鲜（${FILE_AGE}s 前更新），跳过探测"
        exit 0
    fi
fi

# 优先使用铁甲虾
if [ -f "$IRONCLAW_BIN" ]; then
    echo "✅ 使用铁甲虾探测模型延迟..."
    "$IRONCLAW_BIN" model probe 2>/dev/null
    PROBE_EXIT=$?
    # 无论铁甲虾探测结果如何，尝试生成别名文件
    if [ -f "$LATENCY_FILE" ]; then
        generate_model_aliases
    fi
    exit $PROBE_EXIT
fi

# 铁甲虾不在，自己做轻量探测
echo "🔍 八爪鱼自主探测模型延迟..."

# 读取 openclaw 配置，获取可用模型列表
CONFIG="$HOME/.openclaw/openclaw.json"
if [ ! -f "$CONFIG" ]; then
    echo "❌ 未找到 openclaw 配置文件"
    exit 1
fi

# 用 Python 做探测（最简实现）
python3 << 'PYEOF'
import json, time, urllib.request, os, sys

config_path = os.path.expanduser("~/.openclaw/openclaw.json")
with open(config_path) as f:
    config = json.load(f)

# 尝试从配置中获取 API base URL 和 token
port = config.get("port", 3000)
api_base = config.get("apiBase") or config.get("api_base") or f"http://localhost:{port}"
api_key  = config.get("apiKey")  or config.get("api_key")  or config.get("token", "")

# 常见模型列表（与铁甲虾保持兼容）
MODELS = {
    "lixiang-kimi-2-5/kivy-kimi-k2_5":              {"tier": "kimi"},
    "lixiang-glm-5/kivy-glm-5":                     {"tier": "glm"},
    "vendor-claude-google/google-claude-sonnet-4-6": {"tier": "sonnet"},
    "vendor-claude-google/google-claude-opus-4-6":   {"tier": "opus"},
    "vendor-gemini-3-pro/gemini-3-pro-preview":      {"tier": "gemini"},
}

results = {
    "models": {},
    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "probe_method": "octopus-lite"
}

url = f"{api_base}/v1/chat/completions"
headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {api_key}"
}

for model_key, info in MODELS.items():
    start = time.time()
    try:
        req_payload = json.dumps({
            "model": model_key,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 1,
            "stream": False
        }).encode()
        req = urllib.request.Request(url, data=req_payload, headers={
            **headers,
            "X-Model": model_key
        }, method="POST")
        with urllib.request.urlopen(req, timeout=8) as resp:
            _ = resp.read()
        latency = int((time.time() - start) * 1000)
        results["models"][model_key] = {
            "latency_ms": latency,
            "available": True,
            "tier": info["tier"]
        }
        print(f"  ✅ {info['tier']:8s} {latency:5d}ms  {model_key}")
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        results["models"][model_key] = {
            "latency_ms": 9999,
            "available": False,
            "tier": info["tier"],
            "error": str(e)[:120]
        }
        print(f"  ❌ {info['tier']:8s}  N/A     {model_key}  ({e})")

with open("/tmp/ironclaw-model-latency.json", "w") as f:
    json.dump(results, f, indent=2)

available = sum(1 for m in results["models"].values() if m["available"])
print(f"\n✅ 探测完成：{available}/{len(results['models'])} 个模型可用")
print(f"📄 结果写入：/tmp/ironclaw-model-latency.json")
PYEOF

# 自己探测完成后，生成别名文件
if [ -f "$LATENCY_FILE" ]; then
    generate_model_aliases
fi
