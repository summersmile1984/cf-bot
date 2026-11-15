---
feature: approvals-hub
status: in-progress
updated: 2026-11-14
source: main
---

# 待办/审批中心：把「拍板」从聊天流里提出来

## Report

**What was built** —（本片交付物 = 设计，实施切片另开工）统一决策请求模型 `decisions`（任务 ask / 权限 ask / secret 确认三类）+ Sidebar 待办中心（徽标 / 列表 / 深链）+ 超时 fail-closed 语义。与 notifications（事件出线）、多租户归属（user 过滤）对齐。

## [S1] Problem

「想请你定一下：…」（专家 ask）、权限 `ask` 策略触发的放行确认、`request_secret` 密钥确认——三种「等主人拍板」混在房间消息流里：①错过即挂死（ask 问满 3 次放弃、审批无超时语义）；②无全局可见性（多房间并行时根本不知道有几件事等我）；③无统一的「拒绝/过期」出口。HITL 是产品安全与信任的核心（AGENTS.md §7 审批路由 fail-closed 基线），必须有独立的待办面，否则审批闭环只完成了一半。

## [S2] Design

### S2.1 统一决策模型

- `decisions` 表：`id, user_id, kind(task_ask|permission_ask|secret_confirm), ref_id, room_id, question, status(pending|answered|declined|expired|canceled), answer, created_at, expires_at, decided_at`。
- 写入点：`/l2-ask` 落库、权限 `ask` 策略触发放行确认、`request_secret` 派发前确认。`l2_tasks.ask_*` 字段**保留**为任务快照（继续随任务下发 L2 协议），`decisions` 是主人视角的聚合面——不改 A2A 快照契约。
- 多租户归属：`user_id` 置顶过滤，所有查询/写回同界（与任务链归属硬约束同款）。

### S2.2 超时与 fail-closed

- 默认 TTL：`secret_confirm` 10 分钟（与 vault TTL 同步）、`permission_ask` 当次任务生命周期、`task_ask` 24 小时。
- 超时 → `expired` → **语义按 fail-closed 走（拒绝/不放行）**，对齐审批路由闭环基线：宁可任务失败重来，不默认放权。并发 `decision.expired` 事件。
- 现有 ask_count<3（同任务追问上限）保留；过期的 ask 再来追问 → 新建 decision 行，不复活旧行。

### S2.3 UI：待办中心

- Sidebar「待办」入口 + 徽标（pending 数）；列表行：问题、来源（任务/专家/权限/密钥）、房间名、剩余时间。
- 操作：直接回答（回写 `ask_answer` / 放行 secret / 记录权限放行）、拒绝、跳房间深链；操作后行内即时消失。
- 房间内 ask 消息与待办行双向深链（点消息 → 待办行；点待办 → 滚到消息锚点）。

## [S3] Out of Scope

- 审批规则引擎（批量授权/白名单时效）——权限面板的 allow/ask/deny 已覆盖规则面。
- 多级审批、代理审批人、审批委托。
- 移动端专属 UI（响应式兜底即可）。

## Tasks

- [x] T1: `decisions` 表 + 三处写入 + 归属过滤 — acceptance: 三类决策落库正确；跨用户查询/回答 404 (covers: S2.1) — ✅ task_ask/permission_ask 写入点就位（/l2-ask 带 kind）；secret_confirm 待收密流
- [x] T2: 超时扫描（schedules tick 顺带）+ fail-closed 落语义 — acceptance: 过期自动 expired；secret 不放行、ask 再答报「已过期」 (covers: S2.2) — ✅ 过期清挂起提问防劫持
- [x] T3: 待办中心 UI + 房间双向深链 — acceptance: 徽标数正确；回答/拒绝即时生效并回写原流程 (covers: S2.3) — ✅ 回答/拒绝回写 ask_answer（拒绝=「主人拒绝」fail-closed）
- [ ] T4: 事件出线接 notifications — acceptance: pending/expired/answered 三事件进通知中心（桌面通知同步生效） (covers: S2.1/S2.3, depends: notifications T1)

## Journey log

- 2026-11-14：超时语义选「fail-closed：过期 = 拒绝」而非自动放行——与 §7 审批路由闭环的 fail-closed 基线一致；安全语义不因产品体验让步。
- 2026-11-14：decisions 与 `l2_tasks.ask_*` 并存而非改列——任务快照服务 L2 协议（下发/回调），聚合面服务主人视角，两层各有消费者，合并会把 A2A 契约拖进 UI 需求。
- 2026-11-14：TTL 由初稿 24h 收到 **10 分钟**——L2 asker 询问窗口实为 3 分钟（超时兜底退场并 ask-cancel），长挂起只会劫持后续聊天消息；ask-cancel / 任务终态 / 过期三条路径都清挂起提问。拒绝回写统一「主人拒绝：请停止该动作」——权限钩子按「拒绝」放弃（fail-closed）。
