---
feature: web-mcp
status: delivered
updated: 2026-11-11
source: web-mcp
---

# Web 端 MCP 管理：MCP 市场 + 我的 MCP + 在线认证授权

## Report

**What was built** — web 端 MCP 管理三件套：**MCP 市场**页（应用商店卡片流：Gmail/日历/Drive/Docs/Sheets/Slides——Google Workspace 官方远端 MCP、GitHub（官方 github-mcp-server）、本地文件/记忆库；分类筛选+搜索+🔐OAuth·🔑Key·免认证徽标+去授权/填 Key/连接按钮）、**我的 MCP**页（已连接列表：账号/状态/断开二次确认）、**在线认证授权**（L1 `/mcp-oauth/start` 生成 PKCE+state → 系统浏览器跳官方授权 → `/oauth/callback` 收码换令牌 → 凭证入密钥库 → `mcp_connections` 入 D1 → 302 回 `/` toast 报喜；BYO OAuth client 填一次记住 `user_settings.oauth_clients`）。L1 新增 7 路由（catalog/connections CRUD/key/none/oauth start/callback）+ `mcp_connections`/`oauth_states` D1 表；L2 claim loop ≥60s 节流拉 `/mcp-connections` → `mcp-managed.json`（loadRegistry 同名覆盖本地，web 权威）→ 专家 `use:[id]` 即刻可调用，桌面面板状态互通。

**Verification** — tsc（desktop build+check）/ vite build / cf:build 全绿；随仓单测 `scripts/mcp-library-tests.mts` PASS（含 managed 覆盖本地）。**真链 E2E**（真 IdP Dex + mcp-proxy + server-everything）：`/mcp-oauth/start` → Dex 真登录 → **L1 `/oauth/callback` 成功换令牌**（302 → `/?mcp=connected&account=demo@example.com`）→ 连接记录含 `Bearer secret:vault-*` → claim loop `mcp-managed synced: 1` → 专家 `use:["demo-web"]` 真调用 echo → **MCP-WEB-OK 回流**（has_token=1）。页面截图（市场卡片流 / 我的 MCP 已连接行）+ 文本证据入 evidence/（5 件）。

**评审修复记录（先修后合）** — 复审 2 major + 3 minor 全清：① `safeRedirectBack` 开放重定向绕过（绝对 URL pathname='/'）→ 只收同源相对路径；② BYO client_secret 明文进 D1 → 只入 vault（user_settings 记 secretRef，换令牌时服务端解引用）；③ oauth_states TTL 与 spec 对齐 5min + `purgeOAuthStates` 挂入 schedules tick；④ 免认证 remote 不再发空 `Bearer secret:`；⑤ spec 合并顺序措辞对准实装、tsbuildinfo 噪音复位。

**已知边界（不阻合入）** — web 端连接测试留桌面面板；用户自定义目录条目仅桌面可见（web 展示内置精选）；`/app` 旧路由与 SPA 根路径的差异是既有 backlog（本片回跳已改用 `/`）；本地 IdP 测试经隧道（生产 Google tokenUrl 公网直连无碍）。

## [S1] Problem
## [S1] Problem

用户在 web 聊天端（apps/web `/app`）看不到任何 MCP 管理界面：没有 **MCP 市场**（浏览/选择集成）、没有**我的 MCP**（已连接管理）、没有**认证授权页**——连接流程只存在于桌面 app 卡片里。产品期望：用户在 web（手机也可以）点开市场 → 选 Gmail → 网页完成 OAuth 授权 → 「我的 MCP」出现已连接 → 秘书/专家即刻能调用。已定架构：web 授权走 **L1 的 OAuth 回调**（redirect_uri 指向我们域名，Claude connector 同款模式），token 入密钥库，连接记录入 D1，PC 端自动同步消费。

## [S2] Design

### S2.1 L1 连接面（API + D1）

- `mcp_connections` D1 表：`{id(conn-uuid), user_id, catalog_id, name, transport_json, vault_id, account, status, created_at, updated_at}`（无任何明文令牌；vault_id 指向 `oauth_credential`/`api_key` 凭证）。
- `oauth_states` D1 表（5 分钟 TTL，过期清扫并入 schedules tick）：`{state, user_id, catalog_id, client_id, client_secret(vault 引用)?, code_verifier, redirect_back}`；BYO client_secret 只入 vault（`user_settings.oauth_clients` 记 `{clientId, secretRef}`，评审后加固）。
- 路由：
  - `GET /mcp-catalog`（公开）：内置精选目录（静态导入 `src/l2/mcp-catalog.json`，单一数据源）。
  - `GET /mcp-connections`（会话或设备令牌）：连接列表（catalog_id/账号/状态/时间，绝不带凭证值）。
  - `DELETE /mcp-connections/:id`（会话）：删连接 + 连带删 vault 凭证。
  - `POST /mcp-oauth/start`（会话）：`{catalogId, clientId, clientSecret?}` → PKCE+state 入库 → 返回授权 URL（页面跳转）。
  - `GET /oauth/callback?code&state`（公开）：校验 state → token 端点换令牌 → `createOAuthCredential` 入 vault → 建 `mcp_connections` → 302 回 `/app?mcp=connected&name=…`（或 `mcp=error`）。
  - `POST /mcp-connections/key`（会话）：`{catalogId, key}` → key 入 vault（api_key）→ 建连接。
  - `POST /mcp-connections/none`（会话）：免认证条目直接建连接。
- `transport_json` 由目录条目 transport + `headers:{Authorization: Bearer secret:vault-*}`（remote）或 `env:{<apiKeyName>: secret:vault-*}`（key 类）生成。

### S2.2 Web 页面（apps/web）

- Sidebar 新入口 **MCP** → `McpPage`（组件，view 切换同 SettingsPanel 模式）：
  - **Tab「MCP 市场」**：应用商店式卡片流（名称/厂商/分类/描述/🔐OAuth·🔑Key·免认证徽标），分类筛选 + 名称搜索；卡片按钮：OAuth→「去授权」跳 `/mcp-oauth/start` 的 URL；Key→内联表单（提交走 `/mcp-connections/key`，key 只进 vault）；免认证→一键连接。
  - **Tab「我的 MCP」**：已连接列表（集成名/账号/状态/连接时间/「断开」二次确认）；空态引导去市场。
- 授权跳转前浮层「即将前往 {vendor} 授权，完成后自动回到这里」；回跳 `/app?mcp=…` 顶部 toast 显示连接结果并自动切「我的 MCP」刷新。

### S2.3 L2 消费同步（web 连接 → 专家即刻可用）

- claim loop（`apps/l2-desktop/src/main.ts` 与 `src/l2-pull-worker.ts`）每轮顺带（≥60s 节流）`GET /mcp-connections`（设备令牌）→ 生成 `~/.config/mastra-l2/mcp-managed.json`（`{servers: {catalog_id: {name,url|command,args,env,headers,note:'managed:'+catalog_id}}}`，引用形式 `secret:vault-*` 不变）。
- `loadRegistry()`（`src/l2/mcp-registry.ts`）合并：用户本地 `mcp.json` + `mcp-managed.json`（web 同步面），同 id 时 **managed 覆盖本地**（「我的 MCP」以 web 为准）。
- 专家 `use:["google-gmail"]` 等即通（既有解析链，零改动）；桌面 MCP 库卡片因 loadRegistry 合并自动显示已连接状态（互通零成本）。

## [S3] Out of Scope

- web 端连接测试（面板测试已在桌面；web 只做连接/断开/状态）
- 公共 MCP registry 搜索（沿用内置精选；用户自定义目录条目仅桌面可见）
- 多账号同 provider 并存、连接健康巡检
- L1 对话直呼 MCP 工具（下一切片）

## Tasks

- [x] T1: D1 表 + /mcp-catalog + /mcp-connections（GET/DELETE/key/none）+ /mcp-oauth/start + /oauth/callback — acceptance: 真 AS 走 web 回调建连接成功 — ✅ 302 connected + 连接记录（3 号证据）
- [x] T2: Web MCP 市场页 + 我的 MCP 页 + 授权跳转/toast — acceptance: 页面截图 — ✅ 1-web-market.png / 2-web-my-mcp.png
- [x] T3: L2 同步（mcp-managed.json + loadRegistry 覆盖策略）— acceptance: web 连接后专家 use 真调用 — ✅ synced:1 + MCP-WEB-OK（4 号证据）
- [x] T4: 全链 E2E + 证据 + 构建绿 — ✅ 5 件证据 + tsc/vite/cf 全绿


- 2026-11-11 批准开工。E2E 抓出并修复：`storeOAuthCredential` 漏 import（wrangler tail 定位）、设备令牌查连接的 user 范围错位（改为设备级取全部）、回调回跳 `/app` 而 SPA 在 `/`（toast 丢失）。
- 重大教训（耗时最久）：bash 每次调用 cwd 会重置回会话目录（主仓）——中段多轮构建/部署/检查实际跑在主仓上，导致「生产缺路由」的假象与反复误判。排查用 `build_marker` 内嵌版本标记 + 本地 wrangler dev 对照才定位。此后凡 worktree 操作必须显式 workdir/绝对路径。
- 可迁移经验：部署验证先打一个「构建标记」探针再排路由问题；多 worktree 并行开发时构建/部署命令必须钉死目录。

## Journey log
