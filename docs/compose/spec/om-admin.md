---
feature: om-admin
status: delivered
updated: 2026-11-11
source: om-admin
---

# OM 管理：记忆可检视 / 可修正 / 可导出（web UI）

## Report

**What was built** — web「记忆」页（Sidebar 入口，三 tab）：**主人画像**（称呼/时区/偏好/进行中/事实卡片 + 编辑表单，列表字段一行一条，诚实提示「聊天中学到的仍会并入」）、**观测日志**（按房间分组时间线 + 代数/状态徽标 + 详情抽屉全文（含 reflection）+ **修正**（乐观并发 409）+ **删除**（二次确认，连带向量尽力清理）+ 房间筛选）、**导出**（Markdown/JSON 一键下载）。L1 补齐管理面：`GET /om/overview`（画像摘要+各房间记录数）、`GET /om/observations?all=1`、`PUT /om/profile`（字段白名单+长度/条数上限）、`PUT/DELETE /om/observations/:id`（成员校验 403、CAS 409、向量尽力清理）、`GET /om/export?format=md`。桌面 iframe 复用同一 web 页。

**Verification** — tsc（desktop build+check）/ vite / cf:build 全绿；`mcp-library-tests.mts` 回归 PASS。**真数据 E2E**（生产 40+ 房间真实 OM）：overview 含真画像（小明/Asia/Shanghai）→ PUT profile 写入事实 → CAS 错值 409 / 对值落库（修正备注持久化 ✓）→ DELETE 成功 → **md 导出**含画像+观测全文（人可读存档）✓。页面截图 5 张（画像/编辑态/观测时间线/详情抽屉（可见 API 追加的修正备注）/导出）+ API 文本证据入 evidence/。

**评审修复记录（先修后合）** — 复审 1 major + 2 minor 全清：① 向量清理 id 空间错误（OM 向量按 chunk-hash 存、record_id 在 metadata）→ `deleteVectors({filter:{record_id}})`（生产删除实测无报错）；② 页面脏时间「Invalid Date」→ `Number/isFinite` 防御显示「时间未知」；③ 被替代记录默认折叠可展开 + 已生效/已被替代徽标补齐；顺手：并发删除返回 404、spec 重复标题清理。

**已知边界（不阻合入）** — 画像编辑为用户权威覆盖，Extractor 增量合并仍可能把删掉的条目学回来（页面已如实提示）；向量清理最终一致；旧数据 createdAt 为空的记录时间显示「时间未知」。

## [S1] Problem
## [S1] Problem

秘书的观察记忆（OM：Observer/Reflector 观测日志 + 主人画像）目前是黑盒——只有 `/om/profile`、`/om/observations`、`/om/export` 三个只读接口，没有任何管理界面。用户无法看到秘书「记住了什么」、改不了记错的画像、删不掉错误观测、也导不出存档。产品要求（对标并反超 Grok Bot 记忆黑盒）：**任何管理都要有 UI**——web 端「记忆」页做到可检视、可修正、可导出。

## [S2] Design

### S2.1 L1 记忆管理面（API）

- `GET /om/overview`（会话）：画像摘要 + 各房间观测记录数/最近更新时间（检视入口）。
- `GET /om/observations`（会话，已有）：单房间记录列表；补 `?all=1` 模式（本人所有房间一次拉齐，供页面时间线）。
- `PUT /om/profile`（会话）：整包替换 `om_profiles.payload`（字段：name/preferredName/timezone/preferences/ongoing/facts；列表字段按行拆分、去重、≤12 条与现 merge 上限一致）；服务端字段白名单+长度限制（单条 ≤200 字，防超长注入）。
- `PUT /om/observations/:id`（会话 + 成员校验）：修正记录 `activeObservations`/`bufferedReflection` 文本（用户权威覆盖；带 `expected` 做乐观并发，冲突回 409）。
- `DELETE /om/observations/:id`（会话 + 成员校验）：删记录行 + **尽力清理向量**（VECTORIZE_OBS 按 id deleteVectors，失败仅记日志——索引分钟级最终一致，不阻删除）。
- `GET /om/export`（会话，已有 JSON）：补 `?format=md`（人可读 Markdown 存档：画像 + 按房间分节的观测日志）。

### S2.2 Web「记忆」页（apps/web）

- Sidebar 新入口 **记忆** → `MemoryPage`（与 MCP 页同构）：
  - **Tab「主人画像」**：字段卡片（称呼/时区/偏好/进行中/事实）+ 「编辑」切换表单（列表字段多行文本，一行一条）+ 保存/取消；空态引导「多和秘书聊聊，它会慢慢认识你」。
  - **Tab「观测日志」**：按房间分组的记录列表（代数/时间/摘要首行/状态徽标 已生效·被替代）→ 点开抽屉看全文（activeObservations + reflection），行内 **修正**（textarea 保存，乐观并发）与 **删除**（二次确认）；顶部房间筛选。
  - **Tab「导出」**：`导出 JSON` / `导出 Markdown` 按钮（直接下载，文件名 `memory-<date>.<ext>`）。
- 所有文案经 esc/JSX 自动转义；秘钥类内容不涉及（记忆为文本）。

### S2.3 正确性边界

- 修正/删除仅限本人所在房间的记录（room_members 校验，与 /om/observations 同规则）。
- 删除记录级联语义：只删该行（mastra_observational_memory），不动 supersededBy 链上的其他代；被替代（supersededBy 非空）记录默认折叠、可展开。
- 向量清理尽力而为（Vectorize 最终一致），页面删除成功即删——DB 是权威。
- 画像编辑是**用户权威覆盖**：改完后 Extractor 的 mergePayload 仍会增量合并（用户显式删除的条目可能被再抽取回来——如实提示「随聊天可能被重新学到」，不做双向同步）。

## [S3] Out of Scope

- 语义搜索页（recall 能力已存在，检索界面后续做）
- 记忆的多设备冲突/版本管理
- 桌面独立面板（桌面 iframe 复用 web 页）
- 对话指令式记忆管理（「忘掉 xxx」）——本片只做 UI 面

## Tasks

- [x] T1: L1 API — acceptance: curl 逐条过 — ✅ 409/403/md 导出均实测（6 号证据）
- [x] T2: Web 记忆页 — acceptance: 页面截图 — ✅ 5 张（画像/编辑/时间线/抽屉/导出）
- [x] T3: 真数据 E2E — ✅ 真画像+真观测：检视→修正（持久化）→删除→md 导出
- [x] T4: 构建绿 + 回归 — ✅ tsc/vite/cf 绿 + mcp-library-tests PASS

## Journey log

- 2026-11-11 批准开工。E2E 抓出并修复：`MAX(updated_at)` 列名（表是 camelCase `updatedAt`）→ 500；md 导出 `new Date(NaN).toISOString()` 对空 createdAt 崩 → 时间未知防御；画像/观测 Promise.all 互相阻塞 → 解耦加载（观测 40+ 房间逐条查慢）。
- 截图取证三连坑：chrome-devtools MCP 无 filePath 权限（无 workspace roots）、多同名 Chrome 窗口在不同 Space（窗口级 screencapture 拿不到）、MCP 自带浏览器走调试管道（/json 不可见）——最终用系统 Chrome 无头 + 自写 CDP WebSocket 脚本（Node 内置 WebSocket，零依赖）全流程登录+五态落盘。此后网页类截图证据统一走这条确定性路径。
- 可迁移经验：`new Date(Number(x))` 对脏数据必防御；同名多浏览器实例定位用 `ps | grep user-data-dir` + 调试端口区分。

