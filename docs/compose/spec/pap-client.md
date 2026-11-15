---
feature: pap-client
status: designed
updated: 2026-11-14
source: main
---

# PAP（Poppy）客户端接入：让秘书以标准身份跟企业打交道

## Report

**What was built** —（本片交付物 = 调研评估 + 设计，实施切片另开工）Personal Agent Protocol（Poppy 1.0，Sierra+Meta，2026-11-13 发布）兼容性评估与接入设计：以 **Personal Agent 侧（消费方）** 渐进实现四阶段（发现/身份 → 登录 → 对话通道 → 操作审批扩展），不动 L1/L2 内部架构。协议与本产品领域高度重合（假名归属、人机标注、HITL 拍板、审批 fail-closed 语义同源），接入后 L2 的 MCP/OAuth 管线可直连 PAP-enabled 企业，替代「冒充用户点网页」的脆弱路径。

## [S1] Problem

cf-bot 的 L2 今天替用户办事只有两条路：走企业 API/MCP（各家自定义鉴权）或 CUA 真人模拟点网页（脆弱、随时被反爬拦截、身份不可信）。PAP 正在成为「个人 agent ↔ 企业」的互信门面（Walmart/Shopify/Stripe/Genesys 联署）：agent 自报身份、用户分级授权（guest/read/write）、企业可识别可审计。不接 PAP = 被 PAP 化的企业按「来路不明的 bot」对待；接了 = 走正门。协议不管 agent 内部架构（L1/L2 分工是私事），因此兼容它**不需要动现有架构**，只是在 L2 对外侧加一个客户端层。

## [S2] Design

### S2.1 定位与映射（评估结论）

- **角色**：我们是 Personal Agent（消费方）；Company 侧（对外暴露 PAP）不做——cf-bot 是个人秘书不是企业服务（团队版/开放 API 时再议）。
- **层映射**（PAP → cf-bot 现状）：
  | PAP 层 | 机制 | 我们的对应物 |
  |---|---|---|
  | Discovery | `/.well-known/poppy.json` | 无（新增，接入点） |
  | Agent 身份 | CIMD（client_id = 元文档 URL）+ jwks_uri | 无（新增）；设备 token 是自家闭环 |
  | Sessions | `Poppy-Session` JWT（委托密钥签名）+ 每公司假名 User ID | `l2_tasks.owner_id`/decisions 归属（语义同源） |
  | Account access | 标准 OAuth + Direct/Device Sign-In | mcp-connections OAuth + vault（可复用） |
  | 通道 | MCP / OpenAPI / 浏览 / Company Agent 对话 | L2 的 MCP 管线、CUA、ask 拍板（同构） |
  | 任务/扩展 | excluded_tasks、skill_index、操作审批、UCP | 专家 skills_json、权限 ask 策略（fail-closed） |
- 语义同源三件套（实现时保持口径一致）：`author.type` human/agent ↔ 我们的消息角色标注（摘要/转述=agent）；Direct Conversation ↔ ask/待办中心（用户上场）；操作审批扩展 ↔ 权限 ask 策略。

### S2.2 分阶段实施

1. **T1 发现与身份**：poppy.json 拉取校验（organization.domain 绑定、HTTPS、SSRF 防护对齐 AGENTS §5）；agent 元文档（CIMD）+ JWKS 托管在 L1（`/agent/pap.json`、`/agent/jwks.json`）；`Poppy-Session` JWT 签发（ES256 委托密钥 + 委托凭证链，短 TTL 轮换）。
2. **T2 登录**：Direct Sign-In 接现有 OAuth 管线（callback 已有 PKCE/vault 模式）；Device Sign-In 给桌面端（配对码同款体验）；凭证入 vault（`oauth_credential`），撤销=sign-out 映射到 vault 删除 + 会话清理。
3. **T3 对话通道**：Poppy Conversations（JSON/HTTPS）映射到 L2 任务流：Company Agent 对话 → expert 通道；`author.type human` ↔ 房间回复原文转发；handoff/Direct Conversation ↔ 触发 ask 拍板 + 待办中心深链。
4. **T4 审批扩展**：操作审批（exact terms 前置确认）对接权限 `ask` 策略与 decisions 模型（fail-closed 口径不变）；`excluded_tasks`/`alternatives` 喂给路由判定（topic-ia 的 routing prompt 位）。

### S2.3 关键约束

- 安全基线不放松：poppy.json 取回与 Company 给的 URL 一律防 SSRF（禁私网/回环，对齐协议 §3）；Session JWT 只发给 poppy.json 声明的目的域；凭证永不出 vault（现有 secret 管线）。
- 协议早期：Poppy 1.0 =「0.4 + implementer fixes」，字段面还会动——解析器对未知字段宽容（协议自身要求 skip-unknown），跟进 GitHub changelog。
- 复杂度闸门：T1 spike 先跑通「发现 + 身份 + Session 签发」三家样例（官方 demos/reference implementation），再放 T2-T4。

## [S3] Out of Scope

- Company 侧实现（对外暴露 PAP 服务端）——非本产品形态。
- UCP 结账/支付扩展（等支付侧成熟后另评）。
- Web Bot Auth 运营商标名接入（T1 可留接口位）。
- 国内企业生态跟进（PAP 目前是欧美企业主导，收益出海侧优先）。

## Tasks

- [x] T1: 发现与身份 spike — acceptance: 拉取并校验 poppy.json；CIMD 元文档 + JWKS 可被官方校验器/样例公司接受；Poppy-Session JWT 签发通过验证（covers: S2.1/S2.2）— ✅ spike-pap 9/9（RFC7638 标准向量 + 委托链独立验签 + 发现负例）；`/agent/pap.json` `/agent/jwks.json` 已上线，线上无 PAP 发布者可对测（软探测 404）
- [ ] T2: Direct/Device Sign-In 接入 — acceptance: 对样例公司走通登录，凭证入 vault 可撤销；sign-out 语义正确 (covers: S2.2, depends: T1)
- [ ] T3: Conversations 通道映射 — acceptance: 与样例 Company Agent 完成一轮任务对话；human/agent 标注正确；handoff 触发 ask 拍板 (covers: S2.2, depends: T2)
- [ ] T4: 审批扩展对接权限策略 — acceptance: exact-terms 审批走 decisions/ask 流，拒绝即 fail-closed 不执行 (covers: S2.2/S2.3, depends: T3)

## Journey log

- 2026-11-14：评估结论「可兼容、顺水推舟」——协议只管对外门面不动内部架构；我们的 HITL/decisions/审批 fail-closed 模型与 PAP 语义同源，T3/T4 是映射而非重建。定角色为 Personal Agent 侧，Company 侧不做。
- 2026-11-14：1.0（2026-11-13）定位为「0.4 + implementer fixes」，接入按 skip-unknown 解析原则写，字段变更风险可控；风险在生态侧（欧美主导）而非技术侧。
- 2026-11-14：T1 落地——`src/mastra/pap.ts`（RFC7638 拇指印、委托链签发、poppy.json 发现校验含 SSRF/终路径/域绑定）+ 公开路由 `/agent/pap.json`（CIMD，client_id=自身 URL）、`/agent/jwks.json`；`spike-pap.ts` 用「公司侧独立验签器」跑通委托链（不复用签发路径）。委托密钥按请求一次性生成（比 spec 的 per-user 短 TTL 更严）。线上暂无 PAP 发布者可互操作对测——官方 demos 出现后补一轮。
