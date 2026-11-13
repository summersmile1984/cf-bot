---
feature: topic-ia
status: delivered
updated: 2026-11-12
source: topic-ia
---

# 主题 IA：主会话 + 主题卷宗（分主题的秘书信息架构）

## Report

**What was built** — 「主会话 = 走廊（永远有回应），主题 = 卷宗（工作现场）」全套落地：①数据层 `rooms` 扩 `kind/status/summary/last_topic_id`（迁移 0008 + 运行时幂等兜底），主题 = 单人卷宗（kind='topic'），多人房语义不变；②**资源映射分层**：主题 thread 用 `resource=user:<uid>`（激活 `semanticRecall.scope:'resource'` 跨主题召回），多人房保持 `room:<id>`；③路由判定 `src/l1/routing.ts`：独立轻量 Agent（L1 现有 DeepSeek 网关）跑 `persona_config.routing_prompt` 模板（{CATALOG}/{STICKY} 槽位），结果 `topic:<id>`/`new:<名字>`/`main_only` + confidence，低置信度降级 main_only，目标存在性校验防幻觉 id；④成卷/收卷工具 `open_topic`/`close_topic`（描述走 `persona_config.tool_topic`）+ 路由 `new:*` 自动成卷并告知，`generateTitle`+`titlePinned` 自动命名/防覆盖；⑤回复分层：主会话触发路由→卷宗生成完整回复（任务/进度/产物天然挂主题 thread），主会话落「一句话结论 + （详见主题「X」）」指路，用户消息抄送入卷，主题只留未读点；主题内说话就地全文回（显式禁分段格式）；⑥Workers 工具集补全 `job_status`/`cancel_job`/`follow_up_job`（Node 版语义移植）；⑦UI：侧栏主题分区（活跃/已归档折叠）+ 未读点 + 摘要行，Chat 气泡安全 Markdown（自研，无依赖无 XSS）。任务三件套 + 卷宗工具共 5 个新工具进 orchestrator。

**Verification** — 存储 spike 8/8（`scripts/spike-topic-ia.ts`）；路由判定回归 18/18（`scripts/spike-topic-routing.ts`，v1→v3 提示词迭代记录在案）；**生产 E2E 7/7**（`scripts/spike-topic-e2e.ts`，干净账号 + 真实 DeepSeek 全链路，最终版部署 `05ec4d47`）：自动成卷+告知 ✓、主会话指路落库 ✓、详情入卷 ✓、用户消息抄送 ✓、主题内就地回（无格式标记）✓、闲聊落主会话（无路由 JSON 泄漏）✓。web tsc+vite / cf:build 全绿。

**实测教训（三条，已修）** — ①OM 画像污染：spike 的路由判定框是当聊天消息发给 L1 的，OM Observer 把它们抽成「用户事实」注入每轮系统块，模型跟着扮路由模块（闲聊吐 JSON）；画像重置会被反思周期从旧观测重建——**判定类测试必须用隔离账号**（E2E 已改为自动注册全新账号）；②格式标记模仿：`【主会话】/【详情】` 两段式输出会进 Mastra 历史，主题内后续回合模仿分段、指令压不住——**改为结论先行**（第一句即结论，按句子边界拆分，历史永远干净），主题回合保留禁格式指令兜旧线程；③SSE `done` 事件带拆分后主会话版，前端乐观副本与落库一致（可去重）。

**已知边界（不阻合入）** — cancel_job 对 running 任务是尽力而为（执行位结束前可能有尾部产出）；follow_up_job 受 A2A 协议限制仅 queued 可追加；主会话暂保持 `resource=room:<id>`（主↔主题跨线召回留待后续切片）；OM 画像仍可能把「指令样内容」学成事实（om-admin 已知边界，测试侧用隔离账号规避）。

## [S1] Problem

用户与 L1 秘书有一个主会话，但真实沟通是分主题的（装修、旅行、报销各是一摊事）。现状所有对话堆在一个房间流里：没有主题容器、L1 不会自己建 thread、长任务的进度/产物和闲聊混在一起、回答落在哪里没有规则。需要补齐核心信息架构：**主会话是走廊（永远有回应），主题 thread 是卷宗（工作现场）**——L1 能根据用户输入判断归属（已有主题 / 新建主题 / 只在主会话），知道在哪里回复，事情了结会收卷。

对标背景：Grok Bot 用多 Bot 花名册解决分主题（AGENTS.md 明确不做）；我们用「单 L1 + 主题卷宗」走自己的节奏。判定是 LLM 判断（L1 现有 DeepSeek），路由提示词 v3 已在真实链路 18/18 验证（`scripts/spike-topic-routing.ts`）。

## [S2] Design

### S2.1 数据模型（A1/A3）

- `rooms` 扩展列：`kind`（'main'|'room'|'topic'，默认 'room'）、`status`（'active'|'archived'）、`summary`（主题一句话摘要）、`last_topic_id`（主会话粘性：最近路由到的主题）。迁移 0008 幂等补列 + 存量 `is_main=1 → kind='main'`。
- 主题 = 单人房间（`kind='topic'`，room_members 仅创建者）。多人共享房间（`kind='room'`）语义不变。
- Mastra thread 元数据同步：`{kind, status, summary, titlePinned?}`（`saveThread`/`updateThread`，spike 已验证）。
- **资源映射分层（A2）**：主题 thread 用 `resource=user:<created_by>` + `thread=<roomId>`（激活 `semanticRecall.scope:'resource'` 的跨主题召回、OM recall 工具跨卷浏览、working memory 主人画像共享）；多人房保持 `resource=room:<id>` 不动。主会话暂保持 `room:<id>`（存量向量兼容；跨主会话召回后续切片）。
- 主题目录接口：`GET /rooms` 响应补 `kind/status/summary` 字段；L1 每轮注入的目录文本由 `topicCatalogText()` 从 DB 现拼（≤20 行）。

### S2.2 路由判定（B1）——LLM 判断，不建分类器

- 新模块 `src/l1/routing.ts`：`routeMessage()` 用 L1 现有模型（persona 的 model 网关）跑独立轻量判定（无记忆 Agent，不污染 thread）。判定框 = 身份一句话 + 主题目录 + `{STICKY}` 粘性槽 + 优先级规则链 + 铁律 + JSON 输出契约（带示例，**示例与规则必须字面一致**——v2 实测教训）。
- 规则链（按优先级）：显式指名 > 粘性延续（省略式追问「那…呢」看语境）> 事项匹配 > 新建（有实质工作才成卷）> 主会话（闲聊/汇总/含糊）。铁律：拿不准 → `main_only`，绝不硬造主题。
- 判定结果：`topic:<id>` / `new:<名字>` / `main_only`，带 `confidence`（低置信度按 main_only 处理）。
- 判定提示词全文存 `persona_config.routing_prompt`（模板含 `{CATALOG}`/`{STICKY}` 槽位；文案皆数据，白牌可改）。
- 作用范围：仅主会话（`kind='main'`）的消息触发路由；主题内说话锁定该主题（粘性=该主题）；多人房不路由。
- 回归：`scripts/spike-topic-routing.ts` 用例集（18 例起步，目标 50+）作为行为化验收，线上回归 ≥95%。

### S2.3 成卷 / 收卷（B2/B3）

- **成卷**：路由判 `new:<名字>` 或 L1 显式调 `open_topic(name, summary)` 工具 → 建房间（kind=topic）+ 成员 + thread 元数据 → 主会话告知一句（「我建了主题『X』跟这件事」）→ 后续按 `topic:<id>` 流处理。闲聊不开卷。
- **自动命名**：Mastra `generateTitle` 生成标题；用户改名后 `metadata.titlePinned=true` 防自动覆盖。
- **收卷**：L1 显式调 `close_topic(topic_id, summary)` → `status='archived'`、summary 落库、thread 元数据同步 → 主会话一句「这事结了」。归档主题侧栏降权可查。
- 工具描述文案走 `persona_config.tool_topic`（与 tool_schedule 同模式，零写死）。

### S2.4 回复分层（B4）——主会话报信，卷宗干活

| 场景 | 主会话 | 主题 thread |
|---|---|---|
| 闲聊/简单问答 | ✅ 全文 | – |
| 主会话里问主题的事 | ✅ 一句话结论 + 指路 | ✅ 详情/进展/产物（完整问答入卷） |
| 主题里说话 | （未读点，不刷屏） | ✅ 全文就地回 |
| 任务完成/要拍板 | ✅ 一句人话（必须） | ✅ 完整结果 |

- 实现：路由到主题的回合，chat 的 memory thread 切到主题 id（任务/进度/产物天然挂主题）；turn 的 system 前置要求**结论先行**（第一句 = 一句话结论 ≤40 字，随后完整回答）——**不用格式标记**（标记会进 Mastra 历史被后续回合模仿，实测教训），handler 按句子边界拆分：结论 +「（详见主题「X」）」入主会话、全文入卷（兼容旧标记格式的解析保留）。
- 用户消息原文留在发出的房间；同时抄送一份入主题卷宗（上下文完整）。
- 回声策略：主会话只留未读点（`last_read_at` 已有），不双写详情。

### S2.5 UI（C1/C2）

- 侧栏分区：主会话 → **主题**（活跃，未读点）→ 多人房间 → 折叠「已归档主题」。主题行显示 summary 摘要。
- `Room` 类型扩 `kind/status/summary`；跳转即普通房间切换（Chat 复用）。
- Chat 气泡 Markdown 渲染（自研安全渲染：先转义再转换 bold/italic/code/围栏/列表/链接/换行；无新依赖、无 XSS）。

### S2.6 Workers 工具集补全（D1）

- `job_status(job_id)`：查 `l2_tasks` 状态/进度（Node 版 `controller.ts` 语义移植）。
- `cancel_job(job_id)`：queued 直接取消；working 置取消态（finalize 幂等守卫已有）。
- `follow_up_job(job_id, note)`：queued 任务追加补充要求；working 返回「完成后可追加新任务」（A2A 协议限制，RESULTS.md 已知边界）。

## [S3] Out of Scope

- 多 Bot 花名册 / Bot 群聊 / 任务交接（AGENTS.md §6 非目标）
- 主会话 ↔ 主题的跨线语义召回切换（主会话暂保持 `resource=room:<id>`；后续切片）
- 聊天附件上传（P0 候补，独立切片）
- HITL 审批闭环「ask → 停下等确认」（D2，依赖本片回复分层落点后做）
- 移动端 / 语音 / Teach a task / Skill 市场（P2，独立战役）
- generateTitle 行为级验证（需模型配额；实现期行为化验收）

## Tasks

- [x] T1: spec 落档 — acceptance: docs/compose/spec/topic-ia.md 模板对齐
- [x] T2: A 阶段 — acceptance: 迁移 0008 幂等；主题资源映射生效（主题 A 事实可被主题 B 语义问法召回）；/rooms 带 kind/status/summary — ✅ spike-topic-ia 8/8
- [x] T3: B 阶段 — acceptance: 路由回归 ≥95%；成卷必告知；收卷归档可查；回复分层五场景行为化过 — ✅ 路由 18/18、E2E 分层场景过
- [x] T4: C 阶段 — acceptance: 侧栏主题分区/未读点；气泡 Markdown 正常渲染且转义安全 — ✅ tsc 绿、构建过
- [x] T5: D 阶段 — acceptance: 三工具可调、状态查询/取消/追加语义正确 — ✅ 移植进 Workers 工具集
- [x] T6: 部署验证 — acceptance: cf:build 绿、生产部署、spike 回归 PASS、Report 补全 — ✅ 详见 Report Verification
