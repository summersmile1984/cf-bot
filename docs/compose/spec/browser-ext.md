---
feature: browser-ext
status: designed
updated: 2026-11-15
source: main
---

# 浏览器扩展：把当前网页交给秘书

---
feature: browser-ext
status: delivered
updated: 2026-11-15
source: main
---

# 浏览器扩展：把当前网页交给秘书

## Report

**What was built** — Chrome MV3 扩展（`apps/browser-ext/`）：工具栏按钮 + 右键「把这页发给秘书 / 把选中内容发给秘书」→ 组装草稿（标题/URL/选中文本）→ 打开 L1 站点 `?task=` 预填；options 页可改 L1 地址（自部署）。SPA 侧 `?task=` 入站 → 切主会话 → 预填聊天输入框（不自动发送）；消息框升级 textarea（多行草稿/粘贴保真，Enter 发送、Shift+Enter 换行）。

**Verification** — 扩展 JS 语法校验过；SPA 预填生产实测（URL 参数清除、多行换行保真、不自动发送）。

## [S1] Problem

浏览网页是任务的高发场景（「这页帮我总结」「这个 PR 你看看」「照这个格式写」），今天要手动复制粘贴链接和上下文。扩展把「我在看什么」一键递到秘书面前。关键取舍：**不为扩展单独做鉴权/POST 通道**（会引出 token 管理、CORS、滥用面）——打开已登录站点预填草稿，用户回车即发，安全面零新增。

## [S2] Design

### S2.1 扩展（MV3，apps/browser-ext/）

- `manifest.json`（manifest_version 3）+ `background.js`（service worker）+ 图标。
- 入口两处：工具栏按钮（捕获当前页）；右键菜单「发给秘书」（页面/选区）。
- 组装草稿文本：`【网页交办】<title>\n<url>\n\n<选中文本或页面描述>`；`chrome.tabs.create({ url: <L1>/?task=<encodeURIComponent(draft)> })`。
- 设置（options 页）：L1 地址（默认 `http://localhost:4120`，自部署可改）。
- 权限最小化：`activeTab`、`contextMenus`、`storage`。

### S2.2 SPA 侧

- App 启动读 `?task=`：有值即清参、切主会话、把草稿塞进聊天输入框（不自动发送——用户可编辑确认，符合 HITL 精神）。

## [S3] Out of Scope

- 网页正文抓取（readability 全文）、截图整页递交、Firefox/Safari 适配、扩展内直接发送（需鉴权通道，v2 评估）。

## Tasks

- [x] T1: 扩展本体 — acceptance: 按钮/右键两入口组装草稿并开新标签预填；options 改 L1 地址生效 (covers: S2.1) — ✅ MV3 最小权限（activeTab/contextMenus/storage）
- [x] T2: SPA 预填 — acceptance: `?task=` 进入主会话且输入框预填、URL 参数被清除、不自动发送 (covers: S2.2) — ✅ 生产实测；顺手修了输入框单行压平多行的老毛病（换 textarea）

## Journey log

- 2026-11-15：定「打开已登录站点预填」而非「扩展内 POST」——免鉴权基建与信任面扩张；代价是多一次回车，v2 若要一键直发再评 token 通道。
- 2026-11-15：预填用 sessionStorage 一次性消费（房间切换重挂 Chat 不重复填）；实测暴露消息输入是单行 `<input>` 会压平多行草稿——升级 textarea（Enter 发送/Shift+Enter 换行），粘贴多行的老毛病一并修掉。
