---
feature: notifications
status: in-progress
updated: 2026-11-14
source: main
---

# 通知触达：让秘书「叫得到」主人

## Report

**What was built** —（本片交付物 = 设计，实施切片另开工）统一通知模型与渠道分层：事件总线（决策/任务/额度/订阅）→ 站内通知中心 + 桌面系统通知 + 邮件 + Web Push 四渠道，按「事件类型 × 用户偏好」路由。与 approvals-hub（决策请求出线）、account-hardening（邮件适配器）两片互相咬合，不重复造轮子。

## [S1] Problem

任务完成、「想请你定一下」审批、额度预警、订阅欠费全部只写房间消息——用户不在网页前就错过，HITL 会静默挂死（ask 问满 3 次放弃）。长任务 + 审批是产品主叙事（订阅制秘书的核心闭环），「叫不到主人」让闭环断裂：用户感受是「派了任务没下文 / 等我拍板的事没人告诉我」。现状没有任何站外触达通道。

## [S2] Design

### S2.1 事件模型（统一出线）

- 事件类型（v1）：`decision.requested` / `decision.answered` / `decision.expired`、`task.completed` / `task.failed`、`quota.low`（80–90% 预警）/ `quota.empty`、`subscription.past_due`。
- 事件载荷：`{ id, userId, kind, title, body, link, refType, refId, createdAt }`；`link` 是站内深链（房间消息锚点 / 待办行 / 设置页）。
- 出线点：`finalizeTask`（任务终态）、decisions 落库与过期扫描（approvals-hub）、`chargeQuota` 阈值穿越、订阅状态迁移（billing webhook 处理后）。事件先落 `notifications` 表再分发渠道——渠道失败不丢事件。

### S2.2 渠道分层（先叫到，再叫好）

| 渠道 | 载体 | 定位 | 切片 |
|---|---|---|---|
| 站内通知中心 | `notifications` 表 + 顶栏铃铛 | 回访兜底、未读聚合 | T1 |
| 桌面系统通知 | SPA（Tauri 内）→ 原生通知 | **在线主力**（桌面 App 本就是执行位） | T2 |
| 邮件 | 复用 account-hardening 的 mail adapter | 离开场景的关键通知（审批/欠费） | T3 |
| Web Push | VAPID + `push_subscriptions` | 浏览器常开用户 | T4（可后置） |

### S2.3 偏好与频控

- `user_settings.notification_prefs`（JSON）：事件类型 × 渠道开关矩阵。默认：决策类全渠道开、任务类站内 + 桌面、额度/订阅类站内 + 邮件。
- 同一 `refId` 同类事件 5 分钟去重（铃铛合并计数）；邮件另守「同一收件人 ≤1 封/分钟」。
- 通知中心保留最近 200 条，支持一键已读/全部已读。

## [S3] Out of Scope

- IM/机器人渠道（Telegram/微信/钉钉）、短信、语音外呼。
- quiet hours、每日摘要聚合（P2）。
- 通知模板可视化编辑（模板即代码）。

## Tasks

- [x] T1: 事件总线 + `notifications` 表 + 铃铛/通知中心 — acceptance: ask/任务/额度事件落库可见；未读数、深链、已读操作正确 (covers: S2.1/S2.3) — ✅ spike-notifications 14/14，生产烟测通
- [x] T2: 桌面系统通知 — acceptance: 桌面 App 在线时，审批请求与任务完成弹原生通知；点击聚焦聊天窗 (covers: S2.2) — ✅ SPA Web Notification API（浏览器/Tauri WebView 双形态），设置里授权；点击聚焦+深链。真机 Tauri 弹窗待桌面构建验证
- [ ] T3: 邮件渠道（决策/欠费类）— acceptance: 邮件送达审批提醒与欠费提醒；偏好开关生效；降级（未配 provider）不报错 (covers: S2.2/S2.3, depends: account-hardening T1)
- [x] T4: Web Push — acceptance: 浏览器授权后离站可收审批通知；取消授权后不再推送 (covers: S2.2) — ✅ VAPID（ES256）+ 空载荷推送 + SW 拉取展示；订阅/退订/清理失效订阅全链（真机送达待浏览器授权验证）

## Journey log

- 2026-11-14：渠道优先级「站内 → 桌面 → 邮件 → Web Push」——桌面 App 是执行位天然在线，先叫到正在干活的人；Web Push 工程量最大、受众待验证，放 T4 不阻塞 P0。
- 2026-11-14：邮件适配器归 account-hardening（事务性邮件属账号基建：验证/重置都要发信），本片只做渠道消费——单收口避免两处造轮子。
- 2026-11-14：T1 落地；`decision.answered` 不发通知——操作者即本人（房间回复已有轻 ack），铃铛保留记录即可，出线事件为 requested/expired。
- 2026-11-14：T2 用 Web Notification API（SPA 内实现）——同一套代码在浏览器弹浏览器通知、在 Tauri WebView 弹系统通知；授权入口放「设置→账号与安全」，不强弹授权框。
- 2026-11-14：T4 Web Push 选**空载荷**（RFC 8030 + VAPID）——push 到达后 SW 拉最新通知展示，免 aes128gcm 载荷加密的复杂度；代价是展示依赖一次同源请求。404/410 自动清订阅。quota 事件只进通知中心不推 Web Push（chargeQuota 无 env 视角），桌面轮询补位。
