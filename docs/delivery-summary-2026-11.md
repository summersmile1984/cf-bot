# cf-bot 交付总结（2026-11）

> 本文是阶段性总结：产品定位、交付清单、验证证据、运行方式与遗留事项。
> 细节设计见 `docs/compose/spec/*.md`（每份含 Problem / Design / 验收与 Report）。

## 产品与架构

cf-bot 是一个订阅制的 AI 管家：一个主会话秘书（L1，跑在 Cloudflare Workers）负责听需求、派任务、汇报结果；执行位（L2）是用户自己的电脑或云电脑，跑真实工具（ACP harness / CUA / 专家模型）。刻意把执行放在用户 PC 上——文件、终端、桌面都在本地，云端只做协调与记忆。

```
用户 ── web SPA（cf-bot·房间）──► L1 Worker（主会话 + 调度 + 记忆 + 计量）
                                    │  /l2-claim 抢单（设备 token 认证）
                                    ▼
                          L2 执行位：桌面 App（Tauri）或云沙箱
                          expert LLM | ACP(dsh) | CUA(cua) → /a2a-callback 回报
```

关键约束（AGENTS.md）：部署唯一目标账号（Alexwong，`8a1dca99…`）；产品名可白牌（默认 cf-bot）；文案皆数据（persona_config）；对用户隐藏内部词（harness/ACP/jobId）。

## 本批交付（16 提交，origin/main 之上）

**主题 IA + Pages + 白牌**（`742c890`）——聊天自动成卷/收卷、回复分层（主会话指路、详情入卷）、Cloudflare Pages 发布与分享、product_name 可配置。回归 `spike-topic-{ia,routing,e2e}`、`spike-pages-e2e`。

**SaaS 化**（`1d666b8` 设计、`443ada3` 实施）——额度账本（注册赠点/周池/credit 溢出/幂等退补）、订阅与 Paddle 收款（webhook/结账）、付费墙三岔路 UX、HITL 审批闭环（ask 策略 → 主会话确认 → 放行）。回归 `spike-quota` 9/9、`spike-billing` 5/5。

**双仓拆分 + 一键部署 + onboarding**（`deddc44`–`0e3d511`）——开源仓（FSL-1.1-ALv2 公平源许可）由 `scripts/export-open-source.mjs` 单向导出（剔商业层/内部文档，quota/billing 换 stub）；README 带 Deploy to Cloudflare 按钮，部署链自举 D1/Vectorize/Queues（`cf-ensure-resources`）；首跑引导（setup 向导、注册闸门、配置检查）。登录/注册两处根因修复：better-auth baseURL 从请求来源推导；未配置默认开放注册（SaaS 语义）。

**L2 控制台**（`4f6d44e`）——Sidebar「管理」四标签：专家 CRUD、权限 allow/ask/deny + AutoReview、例程启停/立即运行/记录、执行引擎目录与账号默认。生产浏览器实测 + 截图 `verify-shots/l2-console-*.png`。

**多设备**（`5d3c884`，spec `docs/compose/spec/multi-device.md`）——一个用户多台电脑的完整语义：

- 设备身份：web「管理→设备」生成一次性配对码（10 分钟）→ 桌面换 `deviceId + device token`（可单独吊销/改名/设默认）。
- 任务路由（派发时解析）：显式指定设备 > 用户默认设备 > 在线设备抢单，落 `l2_tasks.device_id`；claim 只领自己的定向单和无主单；云端任务不绑定设备。
- 认证面一次换齐：`/l2-claim` 与全部 L2 端点认设备 token（共享 PUSH_TOKEN 老路径兼容）。
- 验证：`spike-multi-device` 22/22、生产双设备 E2E 15/15（定向互不串台、吊销后 claim/回调双 401）、真模型 dispatch 3/3（默认绑定/无效设备名报错/显式绑定，D1 核对 device_id）。途中抓出并修复 `setDefaultDevice` 坏 SQL（占位符错配 + 缺 user 作用域）。


## 验证证据索引

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/spike-quota.ts` | 额度账本 | 9/9 |
| `scripts/spike-billing.ts` | 订阅/Paddle | 5/5 |
| `scripts/spike-topic-{ia,routing,e2e}.ts` | 主题 IA | 绿 |
| `scripts/spike-pages-e2e.ts` | Pages 发布 | 绿 |
| `scripts/spike-multi-device.ts` | 设备身份/路由（真 SQL） | 22/22 |
| `scripts/spike-multi-device-e2e.ts` | 生产双设备 claim 路由 | 15/15 |
| `scripts/spike-multi-device-dispatch.ts` | 真模型 dispatch 解析链 | 3/3 |

截图与日志归档在 `verify-shots/`（l2-console-*、multi-device-*）。生产部署：`http://localhost:4120`（部署命令 `npm run cf:build && wrangler deploy -c .mastra/output/wrangler.json`，账号/凭据见 AGENTS.md §8）。

## 本机运行（桌面 App）

```bash
cd apps/l2-desktop
npm install
npm run tauri:dev        # 窗口；claim 循环在 UI 里 Start
# 或无头：ACP_DRY_RUN=1 npm run claim:dev
```

配对：web「管理 → 设备」生成配对码 → App Settings 填码点「配对这台电脑」→ 凭据写 `~/.config/mastra-l2/device.json`（0600）。前置：Rust（rustup）、cua CLI（CUA 任务；Tauri 构建要求 sidecar 在位）、可选 `dsh`（ACP 真执行）。`npm run tauri:build` 出 `.app` 安装包。

## 遗留事项

- cf-bot-verify 测试部署/资源可清理或留作 demo。
- 聊天自动派发的「真引擎」整合验证待本机装 `dsh`（或 CUA 授权）后补一条真执行录像级证据（当前 dry-run 已证路由与回调）。
- 设备级并发配额、离线积压补跑、能力标签精细路由为 P3（spec 已圈出不做）。
