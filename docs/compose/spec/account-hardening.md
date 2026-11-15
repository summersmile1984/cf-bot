---
feature: account-hardening
status: in-progress
updated: 2026-11-14
source: main
---

# 账号体系补齐：邮箱验证 / 找回密码 / 会话管理

## Report

**What was built** —（本片交付物 = 设计，实施切片另开工）事务性邮件底座（provider 可插拔，notifications 片复用）+ better-auth 能力开启：邮箱验证、找回密码、会话管理面。这是 SaaS 开放注册前的账号安全门槛——现状是「能注册、丢了密码没救、邮箱不验证」。

## [S1] Problem

better-auth 只开了 emailAndPassword + 进程内限频。开放注册后三个实打实的风险：①假邮箱注册薅赠点（注册赠点 200 分是真金白银的模型额度）；②用户丢密码账户即死，客诉无解；③撞库/会话被盗无法自清（无会话管理）。另有一个基建缺口：找回密码与邮箱验证都要发信，而系统目前**没有邮件发送通道**——这条通道 notifications 片的邮件渠道也要用。

## [S2] Design

### S2.1 邮件发送底座（T1，本片公共件）

- `src/mastra/mail.ts`：`sendMail({ to, subject, html, text, tag })`，provider 可插拔。v1 选一个可用通道（CF Email Service / Resend / MailChannels，以账号可用性定），配置 `MAIL_PROVIDER` + `MAIL_FROM` + secret；**未配置 = 降级不炸**：流程可走、状态标记「未送达」，开发/自部署无邮件也能跑。
- 模板：极简 HTML 事务性邮件（标题/正文/按钮），品牌名取 `persona_config.product_name`（白牌一致，不写死产品名）。
- 频控：同一收件人 ≤1 封/分钟（复用 Rate Limiting binding 或轻量计数），防邮件轰炸。

### S2.2 邮箱验证

- better-auth `emailVerification`：注册即发验证信；未验证可登录使用（不锁免费体验），但账号页挂「待验证」横幅与重发按钮。
- **付费墙前置验证**：进入 checkout 前必须已验证邮箱——付费是找回与合规关键，自然要求真实邮箱；免费体验保持零摩擦（对齐 S2.6 注册闸门的获客语义）。

### S2.3 找回密码

- better-auth `resetPassword`：忘记密码 → 邮件限时链接 → 重置。token 30 分钟 TTL、一次性；错/过期 token 明确报错不泄账号存在性。
- 重置成功后会话策略：其余会话全部下线（防盗号残留）。

### S2.4 会话与登录设备管理

- 「设置 → 安全」：活跃会话列表（IP 摘要 / User-Agent 摘要 / 最后活跃 / 当前标记）+ 单条下线 + 全部下线（除当前）。
- 与 multi-device 的「执行设备」是两层概念，UI 明确区分：**登录会话**（看得到聊天的入口）vs **执行设备**（跑任务的电脑），避免用户混淆撤销对象。
- 2FA/WebAuthn：P2，不做。

## [S3] Out of Scope

- 2FA/WebAuthn、企业 SSO/SCIM、手机号登录、邀请制注册（注册开关已有）。
- 邮件营销/订阅信（事务性邮件 only）。

## Tasks

- [x] T1: mail adapter + 模板 + 频控 — acceptance: 未配置 provider 时降级可见不报错；配置后真实收发一封测试邮件 (covers: S2.1) — ✅ 真发信闭环验证（见 Journey 末条）
- [x] T2: 邮箱验证流 — acceptance: 注册收验证信；未验证横幅 + 重发；checkout 前强制已验证 (covers: S2.2, depends: T1) — ✅ sendOnSignUp 注册即发；验证/重发/付费墙拦截生产烟测通
- [x] T3: 找回密码流 — acceptance: 30 分钟内一次性重置；错/过期 token 拒绝；重置后旧会话全失效 (covers: S2.3, depends: T1) — ✅ 含 onPasswordReset 全量下线旧会话
- [x] T4: 会话管理面 — acceptance: 列表/下线/当前标记正确；下线后 cookie 立即失效 (covers: S2.4) — ✅ 生产烟测 list-sessions/revoke

## Journey log

- 2026-11-14：邮箱验证采用「不锁体验、付费前置」而非注册即锁——免费体验零摩擦与获客优先（SaaS 语义），真实邮箱要求随付费自然产生；赠点滥用先由 Turnstile + 限频兜住。
- 2026-11-14：邮件底座归属本片而非 notifications——验证/重置是账号事务，通知是产品事件；单收口给 notifications T3 复用。
- 2026-11-14：T1 落地（`src/mastra/mail.ts`：log/resend/mailchannels 三 provider + `MAIL_RATE_LIMITER` 软限频 + 白牌模板）；log 降级 spike 验证，真实发信待 `MAIL_PROVIDER`/`RESEND_API_KEY` 配置后补验。
- 2026-11-14：T2-T4 落地：验证/重置链接走 SPA 自绘（`?verify_token` / `?reset_token` 入站），绕开 better-auth 重定向页拿回 UI 控制权；找回端点实名为 `/auth/request-password-reset`，`reset-password` body 字段是 `newPassword` 不是 password。缺口：**重置后旧会话失效**未覆盖（better-auth 默认不撤销，需服务端挂钩）——小切片待补。付费墙前置验证已接 `/billing/checkout`。
- 2026-11-14：T3 补口——`emailAndPassword.onPasswordReset` 钩子里 `DELETE FROM session WHERE user_id=?`，重置即全量下线旧会话；`newPassword` 字段坑同步修正（原实现会 400）。
- 2026-11-14：provider 选型落到 **Cloudflare Email Service（send_email binding）**：`env.EMAIL.send()` 结构化发送，代码链全通（注册→模板→binding），实测错误码推进 `E_VALIDATION_ERROR`（MAIL_FROM 空）→ `E_SENDER_DOMAIN_NOT_CONFIGURED`（**唯一余留：发信域名入网 Email Service**，账号当前无域名）。MAIL_RATE_LIMITER（5/60s 每收件人）随绑定下发。
- 2026-11-14：`cf-bot.app` 域名到位后走 **REST API 入网**（`POST /zones/:id/email/sending/subdomains`，name=cf-bot.app，自动配 cf-bounce MX/SPF/DKIM/DMARC + preview 开）——DNS 就绪约 2 分钟；`MAIL_FROM=noreply@cf-bot.app`。**真实发信验证通过**：REST 直发 message_id 落袋 + Worker 全链（注册→验证邮件）`[mail:cf-email] ok`。账号级 provider 从此默认 cf-email。
- 2026-11-14（深夜）：**真发信闭环验证**——用 Email Sending 的 Activity/Preview 当「测试收件箱」提取真实链接：①验证流（发信→预览取 `/auth/verify-email?token=…`→点击→302 回 `/`→`emailVerified` 翻真）；②重置流（发信→预览取 `?reset_token=…` SPA 链接→`reset-password` status:true→**旧会话全失效**→新密码 200/旧密码 401）。白牌模板渲染正确。两个实测注意：验证 token TTL 约 13 分钟（`emailVerification.expiresIn` 默认值待核）；活动日志有 30–60s 传播延迟；曾见一次 request-password-reset 静默未发（无 [mail] 日志、无消息），重试即好——疑 better-auth 全局限频吞掉，待复现再查。
