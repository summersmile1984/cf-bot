---
feature: mcp-library
status: delivered
updated: 2026-11-11
source: mcp-library
---

# MCP 库：应用商店式集成目录 + OAuth 连接 + 可调用

## Report

**What was built** — 应用商店式 **MCP 库**：内置精选目录（Gmail/日历/Drive/Docs/Sheets/Slides——Google Workspace 官方远端 MCP 真 URL+scopes、GitHub（官方 github-mcp-server）、本地文件/记忆库；`~/.config/mastra-l2/mcp-catalog.json` 可扩展）→ 面板卡片点「连接」→ **OAuth 2.1 授权码+PKCE**（系统浏览器 + 127.0.0.1 回环收码 + state 校验；Google `access_type=offline` 刷 token）或「填 Key」→ 凭证入 vault（`oauth_credential`/`api_key` 长期条目，明文只在密钥库，注册表只留 `secret:vault-*` 句柄）→ 自动生成注册表连接条目（remote 带 `Authorization: Bearer secret:vault-*`）→ **专家 `use:[id]` 即刻可调用**。`/l2-secret` 对 oauth 凭证**服务端自动刷新**（过期前 60s 用 refresh_token 换新并回写，refresh_token 永不出 vault）。断开＝删注册表条目+删凭证。

**Verification** — tsc（build+check）/ cargo check / cf:build（生产 3 版本：81ddec5d→1a713c13）/ tauri:build（204.93MB，l2-pkg 11 件含 catalog/oauth-flow）全绿；随仓单测 `scripts/mcp-library-tests.mts` PASS（目录/PKI 校验/令牌拦截/~/展开/毒条目/in-string refs/PKCE+回环）。**真链 E2E**（真 IdP Dex 经 cloudflared 隧道 + mcp-proxy + 官方 server-everything）：connect → `account:demo@example.com` + vaultId → 注册表 `Bearer secret:vault-*`（无明文）→ 真握手 16 工具/325ms → **REFRESH PASS**（过期凭证→/l2-secret→真 Dex RS256 JWT 换新）→ 专家 `use:["demo-idp"]` 真调用 echo → 房间回复含 `MCP-LIB-OK`。**授权面**生产实测：api_key 无 taskId 200 取到 key（修复后）/ generic 无 taskId 400 拒。面板截图（目录卡片/OAuth·Key 徽标/已连接行）+ 终端回放入 evidence/（8 件，JWT 已脱敏）。

**评审修复记录（先修后合）** — 首轮 2 major + 5 minor 全清：① api_key 条目不可消费 → `/l2-secret` 设备级凭证（oauth_credential|api_key）统一走设备令牌授权面，generic 维持任务 blob 校验（生产实测两类分流）；② 设备级授权面放宽已在 S2.2 正式签字（固有暴露面，与 L2 持令牌同界）；③ 包内无 expires_at 不再一律判过期；④ 明文令牌校验去引用后检测（`sk-x-secret:y` 绕过封死）；⑤ connect-key 改 stdin（不进 ps）；⑥ 证据 JWT 脱敏；⑦ 单测入库可复跑；⑧ spec 对准实装（条目清单/`secret:vault-*` 措辞/`~/` 展开/`createOAuthCredential` 接线/设备级凭证免 taskId）。

**已知边界（不阻合入）** — Gmail 真连需用户自带 Google OAuth client（Google Cloud → Auth Platform → Clients，勾选 AI-powered agent；连接指南随面板 hint）；本地 IdP 测试需隧道（生产 Google tokenUrl 为公网，Worker 直连无碍）；Worker 侧刷新在 refresh_token 轮换下有 stale-isolate 竞态（单用户单设备可容忍，后续可加版本戳）；L1 对话直呼 MCP 工具列下一切片。

## [S1] Problem

用户要的「MCP 连接管理」是**应用商店式 MCP 库**：在目录里看到 Gmail 这类集成 → 点「连接」走官方 OAuth 授权 → 之后秘书/专家就能调用（查邮件、管日程…）。现状只有底层配置管道（mcp-connections 切片：注册表/连接测试/专家 use 引用），没有目录、没有 OAuth、没有凭证生命周期——用户还得手写 command/URL，离产品形态很远。已核实的现实（2026-11）：Google Workspace 有官方远端 MCP（`serverUrl` + OAuth 2.0 client），MCP 授权规范为 OAuth 2.1（授权码 + PKCE + Bearer header），远端 MCP 都是这条路。

## [S2] Design

### S2.1 内置精选目录（应用商店式）

- `src/l2/mcp-catalog.json`（数据驱动，可配置可扩展）：条目 `{id, name, vendor, category, description, icon?, transport: {type:'remote'|'stdio', url?|command?+args?}, auth: {type:'oauth2'|'api_key'|'none', provider?, authorizationUrl?, tokenUrl?, scopes?, clientIdDefault?|clientIdEnv?, apiKeyName?, apiKeyHint?}, tags?}`。
- v1 精选（真条目，实装）：**Gmail / Google 日历 / Google Drive / Google Docs / Google Sheets / Google Slides**（Google Workspace 官方远端 MCP，各自 serverUrl，共用 Google OAuth client）、**GitHub**（官方 github-mcp-server，stdio + PAT/API Key）、**本地文件**（filesystem，stdio 免认证）、**记忆库**（memory，stdio 免认证）。Notion/Slack/Fetch 等列下一批（目录文件可配置可扩展，用户可经 `~/.config/mastra-l2/mcp-catalog.json` 自加）。
- 面板 **MCP 库**区：卡片流（图标/名称/厂商/分类徽标/认证徽标 OAuth|Key|免认证/状态 已连接·未连接），点卡片展开说明 + 「连接」按钮。用户新增的自定义条目（上一切片注册表）合并展示为「自定义」分组。

### S2.2 凭证库与生命周期（OAuth token 可刷新）

- L1 vault 扩展**长期凭证**条目：`kind:'oauth_credential'` 值为 JSON 包 `{access_token, refresh_token, expires_at, client_id, client_secret?, token_url, scopes, account?}`（`kind:'api_key'` 为纯 key）；明文只在 vault，模型/日志只见 `secret:vault-<id>` 句柄。
- `/l2-secret` 解析 `secret:vault-<id>` 时按 kind 分流：`oauth_credential` **服务端自动刷新**（包内 expires_at 过期前 60s 用 refresh_token 换新 access_token 并回写；refresh_token 永不出 vault）；`api_key` 原样下发。
- **授权面（评审后签字）**：`oauth_credential`/`api_key` 是「已连接集成」的**设备级凭证**——连接写入与取用同界（设备令牌），不走任务 blob 校验（ref 在本机注册表而非任务文本）。签字：设备令牌泄露即可取已连集成的短命令牌，与「L2 本就要拿这些令牌调 MCP」同界，属固有暴露面；任务级秘钥（`generic`，HITL request_secret）维持任务 blob 校验不变。

### S2.3 OAuth 2.1 + PKCE 连接流（桌面）

- 面板点「连接」→ `oauth-connect.ts`（Node，mcp-cli 同款机制）：① 按目录条目生成授权 URL（authorization code + PKCE + state；`client_id` 用条目内置值或用户自带——设置里按 provider 配置 client_id/client_secret）② 系统浏览器打开 + `127.0.0.1` 回环端口收 code ③ token 端点换令牌（含 client_secret 时带）④ 写入 vault 长期凭证 ⑤ 自动写注册表连接条目（remote：`url` + `headers:{Authorization: Bearer secret:cred:<id>}`；stdio：env 注入对应变量）。
- `api_key` 条目：面板表单填 key → 入 vault → 同样自动生成注册表条目。
- `mcp-registry` 扩展 `headers` 字段（值可 `secret:` 引用；remote MCP 的 Bearer 头靠它）；`toClientServerEntry` 透传 headers（requestInit）。
- 断开：删注册表条目 + 删 vault 凭证；面板显示已连接状态与账号标识（token 能拿到的 email/登录名，不存明文令牌）。

### S2.4 连接后可调用

- 专家链路即刻可用：`mcp_json {"use":["gmail"]}`（既有 use 引用 + secret: 解析 + 自动刷新）。
- 面板「测试」复用 mcp-cli test（remote 条目带 Bearer 头真握手列工具）。
- 专家派发 E2E：连接 Gmail 类条目 → 专家经 use 引用真调用工具（如列邮件）。

## [S3] Out of Scope

- L1 对话直呼 MCP 工具（架构已通：remote+headers；工具面接入列下一切片）
- 公共 MCP registry 搜索接入（本期只做内置精选）
- 多账号同 provider 并存、组织级 OAuth 代理
- stdio 条目的 OAuth 弹窗自动打开（v1 以 remote OAuth 为主，stdio 凭证走 api_key/环境注入）

## Tasks

- [x] T1: mcp-catalog.json 目录 + mcp-registry headers 扩展 + toClientServerEntry 透传 — acceptance: 单测真跑（headers secret: 解析、remote 条目拼装）— ✅ scripts/mcp-library-tests.mts PASS（含 ~/ 展开、令牌拦截）
- [x] T2: L1 vault 长期凭证 + /l2-secret 自动刷新（secret:vault-*）— acceptance: 真 OAuth AS 换令牌→入库→过期后取用自动刷新 — ✅ REFRESH PASS（真 Dex RS256 JWT 换新）+ api_key/generic 分流生产实测
- [x] T3: oauth-connect 连接流（PKCE+回环+换令牌+写 vault/注册表）+ 面板 MCP 库卡片 — acceptance: 面板走完一次真 OAuth 连接，注册表出现连接条目并测试出工具 — ✅ connect→✓已连接→16 工具；面板截图 3 张
- [x] T4: 专家 use 引用真调用 + 截图/终端证据 + 构建绿 — acceptance: 连接后专家任务真调用集成工具 — ✅ echo→MCP-LIB-OK 回流；evidence 8 件；tsc/cargo/cf/tauri 绿

## Journey log

- 2026-11-11 范围澄清（用户纠正）：「MCP 连接管理」=应用商店式库+OAuth，不是配置面板——定位已入项目 MEMORY。调研定锚 Google Workspace 官方远端 MCP（gmailmcp.googleapis.com/mcp/v1 等真 URL，`access_type=offline` 刷 token）。
- E2E 踩坑（全是对面真系统的实弹）：新版 Dex 登录表单 action 是 `/auth/local/login?state=`（无 req 域）、bcrypt cost 门槛 10、云 Worker 打不到 loopback tokenUrl（quick tunnel 解）、zsh 对 UUID 变量展开的 math 坑（改 python）、CF 盾拦 python 默认 UA。评审抓出 api_key 授权面缺口与令牌校验绕过——已修并生产实测分流。
- 可迁移经验：用户级凭证（连接集成）与任务级秘钥（HITL）必须分开授权面；「明文令牌」检测要去掉 secret: 引用后再判；秘钥类参数走 stdin 不走 argv；新建 Worker secret 有传播延迟，E2E 要重试。
