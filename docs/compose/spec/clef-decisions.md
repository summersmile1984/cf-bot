---
feature: clef-decisions
status: designed
updated: 2026-11-15
source: main
---

# Clef 决策模型接入与审批预判

---
feature: clef-decisions
status: delivered
updated: 2026-11-15
source: main
---

# Clef 决策模型接入与审批预判

## Report

**What was built** — `src/mastra/decision.ts`：Workers AI Clef（`@cf/cloudflare/clef-flash`）→ AI SDK `DecisionModelV4` 适配（boolean↔noul/choice/score 映射、parts 展平、rounding 4 位、confidence 入 providerMetadata）→ Mastra Classifier 直接消费。首个改造点落地：`/l2-ask` 权限审批**条件放行**——Clef 判低风险且 p≥0.9 自动放行（ask_answer 预置 + decisions 留痕 + 通知），不确定/异常回落真审批。

**Verification** — `spike-decision` 7/7（mock 映射边角 + **真调 Clef 过 Mastra Classifier 全套校验**）；生产 E2E 双例：「读目录」autoApproved 留痕、「删文件外发」走真审批（fail-closed 不变）。

## [S1] Problem

Mastra Classifier 需要 decision model，官方供给（TypeSafe/OpenAI/Anthropic/Google）都要新 API key；而 **Workers AI 自带 Clef 系列**（clef 27B / clef-omni 30B-MoE / clef-flash 9B）——入参就是 state + 类型化 questions，与 DecisionModelV4 只差命名（noul↔boolean）。我们的权限审批（`ask` 策略）每次都真打断用户，低风险常规动作（如「读文件」「列目录」）也要求拍板——打扰成本高，正是文档里 "conditional approval" 的靶子。

## [S2] Design

### S2.1 适配层（`src/mastra/decision.ts`）

- `createClefDecisionModel(E, modelId?)` 返回实现 `DecisionModelV4` 的对象：`supportedQuestionTypes = ['boolean','choice','score']`，`doDecide()` 调 `E.AI.run(modelId, { model, state, questions })`。
- 类型映射：AI SDK `boolean` ↔ Clef `noul`（值即 P(true)）；`choice`/`score` 同名直通。`box` 与未知类型按拒答（`{type:'refusal'}`）处理。
- 结果归一：`noul→probability`；choice 保 `choice`+`probabilities`；score 保加权 `score`+分布；声明 `rounding: {probabilityDecimals: 4, scoreDecimals: 4}`（Clef 四舍五入到 4 位，满足校验容差）；usage 映射 `input_tokens/output_tokens`；confidence 收进 `providerMetadata.clef`。
- state 归一：对象/数组直通；AI SDK parts 数组（text/json）展平；file parts v1 拒收（Clef 支持 images 但走 `images` 入参，后续接）。

### S2.2 首个改造点：权限审批条件放行

- `/l2-ask` 收到 `permission_ask` 时先问 Clef（state = 提问 + 任务摘要）：`low_risk` boolean——「此操作是否低风险、只读、常规动作」。
- **p ≥ 0.9 → 自动放行**：`ask_answer='允许（自动放行：Clef 判定低风险）'`，decision 记 answered 留痕，发 `decision.answered` 通知（可见可审计）；< 0.9 或任何异常 → 走原有真审批（fail-closed 不变）。
- 只对 `permission_ask` 生效；`task_ask`（用户判断题）与 secret 类不碰。

## [S3] Out of Scope

- ~~模型选择~~（已交付，见 T3）；主题路由判定、输入输出护栏（ClassifierProcessor）——下一波。
- box/多模态 state、TypeSafe 的 confidence/legend 扩展面。

## Tasks

- [x] T1: Clef 适配器 + spike — acceptance: 真调 `@cf/cloudflare/clef-flash` 三类问题出合法 DecisionModelV4 结果，过 Mastra Classifier 校验 (covers: S2.1) — ✅ spike-decision 7/7
- [x] T2: 条件放行接线 — acceptance: permission_ask 高置信低风险自动放行且留痕通知；不确定/异常走真审批 (covers: S2.2) — ✅ 生产 E2E 正负双例
- [x] T3: 模型选择（ModelSelectionProcessor）— acceptance: 平凡消息降级便宜档、复杂弃权走 persona 默认；消息行可见模型 (covers: S2.3 新增) — ✅ 生产双问题实测 + 截图（verify-shots/model-select-*.png）

## Journey log

- 2026-11-15：实测 Workers AI 模型目录找到 Clef（jev 是 TypeSafe 的牌子；Cloudflare 托管的决策模型叫 Clef，协议同源）——REST 直调确认输出形状（noul/choice/score + 4 位分布 + 加权分），与 DecisionModelV4 严丝合缝。
- 2026-11-15：条件放行定「高置信（p≥0.9）才自动 + 全留痕」——放宽 fail-closed 的唯一口子，异常一律回落真审批。
- 2026-11-15：T1/T2 落地。实测要点：Clef 输出 4 位小数分布（声明 rounding 容差过校验）；score 是分布加权均值（与 AI SDK 校验一致）；E2E 里低风险问句 p≈0.95 自动放行、高风险问句不触发。零新增密钥/供应商的目标达成——整条链只用现有 `env.AI`。
- 2026-11-16：**决策模型通道定案**（用户方向「决策模型用 worker ai」）：Workers AI 的决策模型（Clef）传输层就是 `env.AI`（Workers AI 官方运行时 API）；Mastra 模型路由（provider-registry→createOpenAICompatible）与 AI SDK 社区包 `workers-ai-provider` 均只造 `chatModel`，表达不了 state+questions（已核对路由源码与两处供给文档）。故按 provider 形态封装 `workersAi(E).decisionModel(id)`（对标 `typeSafeAi.decisionModel('jev-latest')`），消费侧全部走该工厂。
- 2026-11-16：T3 模型选择落地——Mastra `ModelSelectionProcessor`（classifier+select：trivial 且 p≥0.8 → 降级 `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`；其余弃权走 persona 默认，只降不升）。生产实测：3+5/12+7/9+9 → v4-flash-0731；三日亲子游两问 → 默认模型（该部署 persona 值 v4.1-flash-1017）。**验证含截图** verify-shots/model-select-{1-trivial,2-complex}.png。
- 2026-11-16：模型章显示坑两个：①`response.modelId` 网关会回填（实测拿到 `@cf/deepseek-ai/...`），但流式乐观副本无 model 字段、分层回复与服务端结论行内容不等致去重失败残留无章副本——合并改前缀近似去重 + 流式收尾即拉真身；②ego-browser `screenshot()` 返回的是**临时文件路径字符串**不是字节，落盘要 copyFile。
