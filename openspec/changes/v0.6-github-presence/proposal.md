# Change: GitHub 主页优化（A1）

Date: 2026-05-13
Target release: v0.6.0

## Purpose

GitHub 主页是开源项目的门面。现在缺 badges、社区文件、讨论区，第一眼看不出这是个活跃项目。

## Scope

1. **README badges**：CI / npm version / license / Discord 邀请链接
2. **Banner 优化**：`banner.png` 确认可用，`icon.png` 在 README 顶部展示
3. **GitHub 社区文件**：`CODE_OF_CONDUCT.md` / `SECURITY.md` / `.github/ISSUE_TEMPLATE/` / `.github/PULL_REQUEST_TEMPLATE.md`
4. **GitHub Discussions**：在 repo Settings 开启（用户手动操作，文档说明）
5. **`CONTRIBUTING.md` 补充**：加"如何运行测试"/ "如何提 PR"/ "代码风格"
6. **Social preview 图**：说明如何设置（用户手动操作）

## Non-Goals

- 不做 GitHub Pages 文档站（V2）
- 不做 Discord 服务器（用户自建，文档给模板）

## Acceptance Gate

- [ ] README 顶部有 CI / npm / license 三个 badge
- [ ] `CODE_OF_CONDUCT.md` 存在
- [ ] `SECURITY.md` 存在（说明如何报告安全漏洞）
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md` 存在
- [ ] `.github/ISSUE_TEMPLATE/feature_request.md` 存在
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` 存在
- [ ] `CONTRIBUTING.md` 包含"运行测试"和"提 PR"两节
