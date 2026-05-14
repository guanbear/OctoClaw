# Tasks: GitHub 主页优化（A1）

## Phase A — README badges（< 0.5 天）

### A1. 加 badges
- [ ] 在 `README.md` 顶部（banner 下方）加：
  - CI badge：`[![CI](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml/badge.svg)](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml)`
  - npm badge：`[![npm](https://img.shields.io/npm/v/@octoclaw/cli)](https://www.npmjs.com/package/@octoclaw/cli)`（S1 发包后才有意义，先加占位）
  - license badge：`[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)`
- [ ] `README.zh-CN.md` 同步加相同 badges

---

## Phase B — 社区文件（< 1 天）

### B1. CODE_OF_CONDUCT.md
- [ ] 新建 `CODE_OF_CONDUCT.md`，使用 Contributor Covenant 2.1（标准模板，中英双语）
- [ ] 联系邮箱填 `[项目维护者邮箱]`（占位，用户替换）

### B2. SECURITY.md
- [ ] 新建 `SECURITY.md`
- [ ] 内容：支持的版本 / 如何报告安全漏洞（邮件，不要公开 issue）/ 响应时间承诺

### B3. Issue Templates
- [ ] 新建 `.github/ISSUE_TEMPLATE/bug_report.md`
  - 字段：描述 / 复现步骤 / 期望行为 / 实际行为 / 环境（OS / Node / OpenClaw 版本）/ 日志
- [ ] 新建 `.github/ISSUE_TEMPLATE/feature_request.md`
  - 字段：问题描述 / 期望的解决方案 / 替代方案 / 额外上下文
- [ ] 新建 `.github/ISSUE_TEMPLATE/config.yml`（关闭空白 issue，引导到模板）

### B4. PR Template
- [ ] 新建 `.github/PULL_REQUEST_TEMPLATE.md`
  - 字段：改动描述 / 关联 issue / 测试方式 / checklist（pnpm check / pnpm test / 文档更新）

---

## Phase C — CONTRIBUTING.md 补充（< 0.5 天）

### C1. 补充内容
- [ ] 加"开发环境搭建"节：Node 22 / pnpm 10 / `pnpm install` / `pnpm build`
- [ ] 加"运行测试"节：`pnpm test` / `pnpm --filter <pkg> test`
- [ ] 加"提 PR"节：分支命名规范 / commit message 格式 / PR 大小建议（< 400 行）
- [ ] 加"代码风格"节：TypeScript strict / ESM / `.js` 后缀 / 中英双语错误消息

---

## Acceptance

- [ ] README 顶部有 CI / npm / license 三个 badge
- [ ] `CODE_OF_CONDUCT.md` 存在，包含联系方式占位
- [ ] `SECURITY.md` 存在
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md` 存在
- [ ] `.github/ISSUE_TEMPLATE/feature_request.md` 存在
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` 存在
- [ ] `CONTRIBUTING.md` 包含"运行测试"和"提 PR"两节
