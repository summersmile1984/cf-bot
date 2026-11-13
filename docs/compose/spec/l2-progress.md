---
feature: l2-progress
status: delivered
updated: 2026-11-07
source: l2-progress
---

# Grok 式简短进度播报（L2 一句话进度流）

## Report

**What was built** — L2 任务中途「一句话短句」进度流（Grok Bot 体验基准）：专家内置 `report_progress` 工具（描述经 `persona_config.tool_progress` → def 快照下发，零写死）→ `POST /l2-progress`（设备令牌 + 任务 `working` 状态门）→ 15s 去重、非心跳播报 ≤10 条入房、`l2_tasks.progress` 存档（cap 20）→ **房间 transcript 直接播报**（assistant 短句，复用 message 事件保证 RoomDO 实时广播）+ `/l2-results` 携带。静默 3 分钟心跳兜底（expert/acp/cua 三路）；compose 终稿注入「已播报 N 条进度」防重复；出口脱敏抽共享 `src/l1/sanitize.ts`；桌面端 `status.json.lastProgress` 面板一行同步。

**Verification** — `npm run cf:build` PASS（部署 fdfc8c04）。真 E2E **11/11 PASS**（生产 L1+真 L2+macOS VM）：五步节奏化任务（sleep 16 隔开）→ D1 progress 3 条（「开工：开始盘点三份材料｜过半：两份材料已核对完｜收尾：正在汇总结论」，11/11/9 字）→ 房间 transcript 3 条播报可见 → **终稿完整汇总**（≥60 字+完成标记断言）→ `/l2-results` 携带 3 条 progress。独立评审 1 CRITICAL+3 MAJOR 修复后复审 7/7 PASS（CRITICAL：RoomDO 只认 message|busy，progress 事件被静默丢弃——已复用 message 事件）。**截图证据**：聊天流全貌（派发→三句进度→完整终稿）已随交付展示。收尾前另修一例「空终稿」（generate 默认步数预算掐断收尾）——`maxSteps:20` + 工具轨迹兜底汇总，复验通过。

## [S1] Problem

体验基准 = Grok Bot（用户定调）：不弹窗审批、直接干到底、**中途只给一句话简短进度**（如「14 receipts in. Still missing your Uber from Tuesday.」），只在 judgment call 时才回来。现状 L2 任务从派发到完成全程静默（`/l2-results` 只有终态），主人只能干等——对标差距最大的一块。本片补「任务中途一句话进度播报」。

## [S2] Design

### S2.1 进度契约（L2 → L1）

- 新端点 `POST /l2-progress`（设备令牌，同 /l2-claim 口径）：`{ taskId, line, kind? }`。授权：task 须存在且非终态。`line` ≤120 字，过长截断；同一 task 相邻两条 <15s 去重/合并（防刷屏）。
- 落库：`l2_tasks` 加 `progress TEXT`（JSON 数组，cap 20 条，`[{line, at}]`）；`/l2-results` 响应附带 `progress`（前端可取）。
- 每条进度即时 `notifyRoom(threadId, {kind:'progress'})`（RoomDO 推送复用现有通知面）。

### S2.2 房间播报（Grok 语感）

- 进度行以 **assistant 消息**写入房间 transcript（主人在聊天里直接看到，像同事顺口汇报）；前缀极轻（不加【进度】重标签，行文自然由专家保证，执行层只做 `sanitizeUserFacing` 脱敏）。
- 节流：每 task 最多 10 条播报；任务终态汇报照旧走 compose（不变）。进度消息与终态汇报不重复（compose prompt 注入最近进度条数）。
- 判断点（judgment call）不在本片：专家提问/挂起另片。

### S2.3 进度源（L2 专家侧）

- JIT 工厂给每位专家挂 `report_progress` 工具（`{line: string}`）：调用即 `POST /l2-progress`（复用 l2SecretResolver 同款设备令牌通道），工具回执「ok」，对模型透明。工具描述入 `persona_config.tool_progress`（零写死），基座提示词加一句「长任务中途用 report_progress 播一两句话进度」。
- 兜底心跳：任务运行超 3 分钟且零进度 → runner 自动补一条「还在处理：<任务摘要前 20 字>」（kind='heartbeat'，不计入 10 条上限外也播报，最多每 3 分钟一条）。ACP/CUA 无模型路径只有心跳。
- 桌面端轻同步：`status.json` 增 `lastProgress` 字段（runner 写），面板显示（一行）。

## [S3] Out of Scope

- judgment call 挂起/追问交互（专家中途问主人 → 另片）
- 进度的多模态（截图缩略图进房间）
- 弹窗/通知中心形态（Grok 语感 = 聊天流短句，不做弹窗——对标结论已定）
- 进度持久化出 D1 后的检索（先落 `l2_tasks.progress` 足够）

## Tasks

- [x] T1: `/l2-progress` 通道 + `l2_tasks.progress` 落库 + 房间播报 + RoomDO — acceptance: 进度行 15s 去重、cap 20、随 `/l2-results` 可读（covers: S2.1, S2.2）
- [x] T2: `report_progress` 工具 + 心跳兜底（expert/acp/cua 三路） — acceptance: 专家真调用工具后房间 transcript 出现该句；静默 3 分钟自动心跳（代码级，E2E 以主动播报为主证）(covers: S2.3)
- [x] T3: 配置面（persona_config.tool_progress + 基座护栏句）+ 工坊 builder prompt 引导 — acceptance: 文案全部可配置（描述经 def 快照下发），代码零写死（covers: S2.3）
- [x] T4: 真 E2E — acceptance: 派发长任务 → 房间里出现 ≥2 条一句话进度（Grok 语感）→ 终态汇报正常 → /l2-results 携带；桌面端 lastProgress 代码级同步（pull-worker 为主证）；证据入 Report（covers: S2.2, S2.3, depends: T1–T3）

## Journey log

- **RoomDO `notify()` 静默丢弃未知 `evt.kind`**——只认 `message|busy`。新增事件类型必须同步 room-do.js 分支，否则「消息已入库但 WS 永远不播」；最稳的姿势是复用 `message` 事件（带 messageId），广播/前端合并全链路免费。
- `activeProgress` 全局槽依赖**执行串行**（pull/desktop 的 for(;;) 单任务循环）；若将来并发执行，要换成 per-task context 传递。
- 10 条播报上限按 20 条滑窗计数而非累计计数——极端「心跳挤窗」序列可重开上限（deferred nit，可换累计计数器闭合）。
- 进度短句的语感来自专家（工具入参 line），执行层只做脱敏与节流——保持「像同事顺口汇报」的关键是别在管道里改写文案。
- **`agent.generate` 不带 `maxSteps` 时步数预算会掐断多步任务**：症状是结果只剩开头意图句（「I'll execute…**Step 1:**」），工具明明都执行了。修法：显式 `maxSteps` 给足 + 结果过短时从 `res.steps` 工具轨迹拼兜底汇总。任何「多工具调用 + 收尾总结」的 agent 调用都要带足步数预算。
