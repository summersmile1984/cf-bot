---
feature: pages-hosting
status: delivered
updated: 2026-11-13
source: pages-hosting
---

# Pages：bot 产出 HTML 的云端托管与分享（对齐 Grok Bot page 功能）

## Report

**What was built** — Pages 托管全链路：Cloudflare Pages Direct Upload（项目 `cf-bot-pages`，每页独立 `https://<short_id>.cf-bot-pages.pages.dev`）+ D1 `pages` 表 + 双通道发布（L2 `save_artifact kind:'page'` / L1 `publish_page` 工具）+ 房间 `[page:id]` 卡片（打开/复制/下架）+ `GET /pages/:id` / `POST /pages/:id/unpublish` 管理面。鉴权复用 `CF_PAGES_TOKEN` secret。

**Verification** — 生产 E2E 4/4（`scripts/spike-pages-e2e.ts`，聊天驱动真发布→URL 200→管理→下架）；截图 2 张 + 日志入 `pages-hosting-evidence/`。API 硬坑记录：资产 key 必须 MD5（SHA-256 会 500）、manifest 路径必须 `/index.html` 带斜杠、CDN 秒级传播——详见 evidence/REPORT.md。

## [S1] Problem

Grok Bot 有 page 功能：bot 写的 HTML 有地方托管、有 URL 可看、可分享到外面。我们的 L2（PC/云电脑）产出 HTML 后目前只能塞进 `save_artifact`（文本 ≤8KB），没有托管层、没有可分享链接。需要打通「L2 产出 → 上传 CF 云上 → 每页独立 URL → 房间卡片 → 外部可访问」的完整链路。

## [S2] Design

### S2.1 托管载体：Cloudflare Pages Direct Upload（用户已选定）

- 一个 Pages 项目（`cf-bot-pages`）承载所有产出页；每页 = 一个 deployment，拿到永久独立 URL `https://<short_id>.cf-bot-pages.pages.dev`。
- 上传四步（官方 API）：`GET .../upload-token`（JWT）→ `POST /pages/assets/check-missing`（SHA-256 哈希）→ `POST /pages/assets/upload`（KV bulk-write 形状，base64）→ `POST .../deployments`（multipart，`manifest={"index.html":"<hash>"}`）→ 返回 `url`。
- 鉴权复用 Worker 已有 secret `CLOUDFLARE_API_KEY` + var `CLOUDFLARE_ACCOUNT_ID`。
- **安全**：pages.dev 与应用不同源，bot 生成的 HTML 天然拿不到应用会话 cookie——XSS 隔离问题由托管域解决，无需 CSP sandbox。
- 「取消分享」= DELETE deployment（尽力而为；失败则标记 removed 并从房间撤卡）。

### S2.2 数据与发布通道（D1 pages 表）

- `pages` 表：`id(page-xxx)/task_id/room_id/created_by/title/deployment_id/short_id/url/status(live|removed)/created_at`（运行时 CREATE IF NOT EXISTS，符合 D1 唯一存储中心）。
- **通道 A（主）**：L2 `save_artifact` 扩 `kind:'page'`（HTML ≤2MB）→ `/l2-artifact` 识别 page → `publishPage()` 走 Direct Upload → 落 pages 行 → 房间消息 `[page:<id>]`。
- **通道 B**：L1 工具 `publish_page(title, html)`（聊天里让秘书直接发布；描述走 `persona_config.tool_page`）——同一 `publishPage()` 核心。
- 房间消息格式：`[page:<id>] <title>`（与 `[artifact:id]` 同构）。

### S2.3 管理面与 UI

- `GET /pages/:id`（会话 + 房间成员）：title/url/status；`POST /pages/:id/unpublish`（会话 + 创建者）：下架。
- Chat 卡片：`[page:id]` → 标题 + 「打开页面」（新窗口，target=_blank）+「复制链接」+「下架」（创建者可见）。Markdown 渲染不动（页面是独立文档，不在气泡里内嵌 iframe——保留清晰的内外边界）。

## [S3] Out of Scope

- 自定义域名 / Cloudflare Access 门禁（pages.dev 公开链接 + 随机 short_id 即分享模型）
- 页面编辑/版本管理（每次发布一个新 deployment，旧 URL 不变）
- 访问统计
- 白牌页脚注入（页面内容归 bot/用户所有）

## Tasks

- [x] T1: spec 落档 — acceptance: 本文件模板对齐
- [x] T2: pages.ts 上传模块 + pages 表 + 发布/下架 — acceptance: 本地直调 CF API 真发布一页拿到 live URL
- [x] T3: 通道 A/B 接入（/l2-artifact kind=page + L1 publish_page 工具）— acceptance: 聊天里让秘书发页 → 房间出卡片
- [x] T4: Web 卡片（打开/复制/下架）— acceptance: tsc 绿，卡片渲染正确
- [x] T5: 部署 + E2E + 截图报告 — acceptance: 生产链路真发布/真打开/真下架，证据入 evidence/
