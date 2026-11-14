---
feature: l2-console
status: delivered
updated: 2026-11-13
source: main
---

# L2 控制台：专家 / 权限 / 例程 / 执行引擎的 web 管理面

## Report

**What was built** — web「管理」页（Sidebar 入口，四标签）：**专家**（列表/新建/精修 instructions+JSON 字段/删除，与对话工坊互补）、**权限**（allow/ask/deny 规则增删改 + Auto Review 开关）、**例程**（列表/新建/启停/立即运行/运行记录/删除）、**执行引擎**（目录展示 + 账号默认下拉，安装指引桌面端）。后端补三口：`DELETE /permissions/:tool`、`POST /schedules/:id/run`（next_run_at=0 复用 tick）、`/harness-settings` GET 附 catalog。

**Verification** — tsc 绿；生产（29b53fbe）浏览器实测：四标签渲染 ✓、UI 建专家 ✓、UI 加权限规则 ✓、UI 建例程 ✓（API 201 双证）、引擎目录可见 ✓；截图 4 张入 verify-shots/l2-console-*.png。测试专家/例程已清理。

## [S1] Problem

L2 agent 的配置数据面齐全（agent_defs、user_permission_rules、schedules、harness 三级默认链），但 web 端没有管理入口：专家只能对话工坊改、权限只在 API、例程只能对话查、引擎只能桌面端设。用户无法总览和管理自己的 L2 agent——专家一多就失控，权限规则看不见，例程没有开关面板。

## [S2] Design

### S2.1 入口与结构

- Sidebar 新增「管理」按钮 → `L2Page`（与 McpPage/MemoryPage 同构的独立页），四标签页：**专家 / 权限 / 例程 / 执行引擎**。
- 复用现有 CRUD API，仅补三个小口子（S2.5）。所有写操作走既有鉴权（会话 + 属主校验）。

### S2.2 专家 tab

- 列表：name / description / model / 更新时间；行内展开编辑。
- 编辑字段：name、description、instructions（textarea）、tools_json / mcp_json / skills_json / memory_json（JSON textarea，校验可解析）。
- 新建 / 删除。与对话工坊（draft→save）互补：工坊适合起草，控制台适合精修与治理。

### S2.3 权限 tab

- 规则表：`category_or_tool` × `policy`（allow / ask / deny）；增/改/删。
- 「自动审查（auto_review）」开关（user_settings）。
- 提示语：ask = 执行前在主会话征求确认（HITL 已闭环）；deny = 直接拒绝；allow = 审计放行。

### S2.4 例程 tab

- 列表：name / cron / 时区 / 启用状态 / 下次运行 / 上次运行；**启用开关**（PUT enabled）；删除；**立即运行**；展开查看最近运行记录（`/schedules/:id/runs`）。
- 新建表单：name / prompt / cron / timezone / 目标房间。

### S2.5 后端补口（三处小改）

1. `DELETE /permissions/:tool`：删单条权限规则。
2. `POST /schedules/:id/run`：立即运行——置 `next_run_at=0`，下个 cron tick（≤1 分钟）执行（复用现有 tick 执行路径，不新增执行代码）。
3. `/harness-settings` GET 响应附 `catalog`（harnesses.json 目录摘要）：web 只读展示 + 设默认；安装/检测仍指引桌面端。

### S2.6 执行引擎 tab

- 展示：账号默认 / 设备默认 / 目录（id、名称、说明）；「设为账号默认」下拉（PUT /harness-settings）。
- 安装与检测属桌面端能力，页面明确指引（不重复造）。

## [S3] Out of Scope

- 专家版本管理 / 导入导出 / 市场（下一片）
- 权限的批量策略模板
- 例程的可视化 cron 编辑器（文本输入 + 常用预设即可）
- 桌面端 harness 安装流程的 web 化

## Tasks

- [x] T1: 后端补口（权限删除 / 例程立即运行 / 引擎目录）— acceptance: 三接口 curl 可用且鉴权正确 (covers: S2.5)
- [x] T2: L2Page 四标签前端 + Sidebar 入口 — acceptance: tsc 绿；四块均可增删改查 (covers: S2.2–S2.4/S2.6)
- [x] T3: 构建部署 + 浏览器验证 + 交付 — acceptance: 生产可用，截图证据 (covers: S2.1)

## Journey log

- 2026-11-13：浏览器自动化填表两次踩「快照字段角色/时序」坑（textarea 归为 textbox、表单挂载竞态）导致假阴性——**UI 验证要先看结构再填、失败先查 API 侧**（API 201 证明后端无恙，重试 UI 即过）。
- 2026-11-13：API 盘点先行——发现 schedules 已有 PUT(enabled)（暂停免新码），例程「立即运行」用 next_run_at=0 复用 tick 路径（零新执行代码），刻意避开再写一套执行器。
