---
feature: ask-artifacts
status: delivered
updated: 2026-11-07
source: ask-artifacts
---

# Grok 体验收口：judgment call 中途追问 + 产物预览

## Report

**What was built** — Grok 体验最后两块：①**judgment call 追问**：专家 `ask_user` 提问 → `/l2-ask`（CAS 防并发、≤3 次）→ 房间问句 → 主人回复即答案（FIFO 最老 pending + ack 引用问题）→ 专家拿到答案续跑（阻塞轮询 3 分钟，超时 `ask_cancel` 撤销防吞发言 + 兜底语）；②**产物预览**：`save_artifact` 工具 + CUA 截图自动入档（任务完成前 await，防竞态）→ `task_artifacts` + `GET /artifacts/:id` → 房间 `[artifact:id]` 附件消息，SPA 渲染 `<img>`（文本产物内嵌前 300 字）。描述零写死（tool_ask/tool_artifact 经 persona→def 下发）；图片 ≤1.2MB（超限拒绝不截断）。

**Verification** — `npm run cf:build` PASS（部署 eb5f9106+）。真 E2E **10/10 PASS**（生产 L1+真 L2+macOS VM）：追问流（房间出现 judgment call 提问→「用A口径」→ask_answer 已路由→终稿含口径）；产物流（save_artifact 落库→GET 200→房间附件→**CUA 截图自动入档 kind=image（800KB）**）。**截图证据两张已交付**：聊天内 Q&A 全链路、聊天内图片渲染。独立评审 0 CRITICAL + 3 MAJOR（base64 截断/ask 错投/队列饿死）+ 回归竞态 1 例，全部修复并复审 APPROVE。

## [S1] Problem

对标 Grok Bot 的最后两块体验缺口：①「只在需要判断时回来」——专家执行中遇到分叉现在无法找主人，只有终态汇报（l2-progress 明确递延的 judgment call）；② 产物只以文本回流，任务产出的截图/报告主人看不到实物。本片补齐：**ask_user 问答流**（提问→房间→主人回复→任务续跑）与 **产物预览**（图片/文本产物进房间可看）。

## [S2] Design

### S2.1 Judgment call 追问（ask_user 问答通道）

- **L2 `ask_user{question, context?}` 工具**（JIT 挂给每位专家，描述入 `persona_config.tool_ask` 零写死）：`POST /l2-ask`（设备令牌 + `working` 门，同 /l2-progress 口径）→ 房间 assistant 问句（脱敏）→ 工具**阻塞轮询** `GET /l2-ask-answer?taskId`（5s 间隔）直到拿到答案或超时 10 分钟——超时返回 `{answer:'（主人未回复）请自行稳妥决定并继续'}` 让模型兜底。任务全程保持 `working`（无需真挂起/恢复；L2 进程活着，工具挂起语义即够）。
- **数据**：`l2_tasks` 加 `ask_question TEXT`、`ask_answer TEXT`、`ask_count INTEGER`（节流：每任务 ≤3 次，超出工具直接拒绝）。
- **L1 房间回复路由**：thread 存在未答 `ask_question` 时，主人的房间消息**优先作为答案**落 `ask_answer`（并给一句轻 ack「收到，已转给任务继续」），不再走 orchestrator 全量回复；无 pending 时行为不变。
- **语义**：工具描述强调「只在真正需要主人判断（分叉/口径/取舍）时使用；能自己稳妥决定的不要问」——Grok 的 "only pull you in for judgment calls"。

### S2.2 产物预览（artifacts）

- **通道** `POST /l2-artifact`（设备令牌 + `working` 门）：`{taskId, kind:'image'|'text', caption, data}`；`data` 图片 base64 ≤1.2MB（超限拒收；实测桌面截图约 1MB，256KB 太紧）、文本 ≤8KB。落 `task_artifacts` 表（id/task_id/kind/caption/data/created_at）。
- **房间呈现**：附件消息入 transcript（assistant，content=`[产物] caption` + 附件 id），`GET /artifacts/:id`（登录会话）回内容（图片按 `image/png` 流出）；SPA 聊天渲染 `<img>`/文本块（Chat.tsx 附件分支），桌面端 status 面板同步 `lastArtifact` 链接（轻）。产物 id 列表随 `/l2-results` 附带。
- **产物源**：
  a. L2 `save_artifact{caption, kind, data}` 工具（专家主动上报，描述入 `persona_config.tool_artifact`）；
  b. **CUA 截图自动入档**：runCuaTask / CuaSandbox.computer.screenshot 产出的 PNG 自动 `POST /l2-artifact`（带 caption「屏幕截图」）。
- 脱敏照旧（caption/文本过 `sanitizeUserFacing`）；秘钥不入产物（data 只收图片/文本明面内容）。

## [S3] Out of Scope

- Mastra 真挂起/恢复（suspend/resume 跨进程恢复）——阻塞轮询已达同等体验，真正的 resume 留待 HITL 大片
- 大文件/R2 存储（>1.2MB 图片不收；后续接 R2 再放开）
- 产物批注/编辑、语音产物
- 通知中心/弹窗形态（守 Grok 语感：聊天流）

## Tasks

- [x] T1: ask 通道 — `/l2-ask` + `/l2-ask-answer` + `ask_question/ask_answer/ask_count` 落库 + 房间回复路由 + 轻 ack — acceptance: 主人房间回复被路由为答案且不再触发全量 L1 回复（covers: S2.1）
- [x] T2: `ask_user` 工具（阻塞轮询、10min 超时兜底、≤3 次节流、tool_ask 配置下发） — acceptance: 专家中途提问→房间可见→主人回复→专家拿到答案并写进终稿（covers: S2.1）
- [x] T3: artifacts 通道 — `/l2-artifact` + `task_artifacts` + `GET /artifacts/:id` + 房间附件消息 + SPA/桌面渲染 — acceptance: 图片产物在房间聊天里可见（covers: S2.2）
- [x] T4: `save_artifact` 工具 + CUA 截图自动入档 — acceptance: 专家主动上报与截图自动上报各一条真产物（covers: S2.2）
- [x] T5: 真 E2E + 截图证据 — acceptance: 追问流、产物流各一条端到端（真 L2+真房间），聊天画面截图入 Report（covers: S2.1, S2.2, depends: T1–T4）

## Journey log

- **base64 永远不要 `.slice()` 截断**——静默损坏图片（atob 炸/裂图）；超限就拒绝。D1 行硬上限 2,000,000 字节，图片 base64 宜 ≤1.5M 字符。
- **阻塞式问答放在串行执行位里会饿死队列**：ask 轮询超时必须收短（3min）+ 超时撤销 pending（否则后续发言被吞成假答案）。
- **多任务同房间的答案路由用 FIFO（最老 pending）+ ack 引用问题**；所有 L2 任务状态写入统一 CAS（`UPDATE … WHERE 状态守卫` + `meta.changes`）。
- **火后不理（void async）在任务收尾处必丢**：产物落档必须 await 在 complete 之前。
- 已知余项：ask_cancel 失败仅 best-effort（极小窗口残留 pending）；桌面端 lastArtifact 面板链接未接；`/artifacts/:id` 仅登录会话级（UUID 防猜，房间级鉴权后续加固）。
