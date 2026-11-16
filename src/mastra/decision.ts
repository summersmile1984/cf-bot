/**
 * Workers AI 决策模型 provider（clef-decisions S2.1）：对标 `typeSafeAi.decisionModel('jev-latest')`
 * 的 provider 形态——`workersAi(E).decisionModel('@cf/cloudflare/clef-flash')`。
 * 传输层是 Workers AI 官方运行时 API（env.AI，即 Workers AI 本体；REST /ai/run 是同一 API）。
 * 为什么不走 Mastra 模型路由（provider-registry → createOpenAICompatible）：那条通路只造
 * `chatModel`（chat/completions 协议），表达不了决策模型的 state+questions 入参——已核实
 * 供给页与路由源码（2026-11-16），AI SDK 亦无 Cloudflare decisionModel() 工厂。
 * 结果形状对齐 AI SDK `DecisionModelV4`，供 Mastra `Classifier` / `ModelSelectionProcessor` 直接消费。
 */
import { Classifier } from '@mastra/core/classifier';
import { ModelSelectionProcessor } from '@mastra/core/processors';

export const CLEF_FLASH = '@cf/cloudflare/clef-flash';
export const CLEF = '@cf/cloudflare/clef';
export const CLEF_OMNI = '@cf/cloudflare/clef-omni';

const TO_CLEF: Record<string, string> = { boolean: 'noul', choice: 'choice', score: 'score' };

/** AI SDK state（含 parts 数组）→ Clef 可吃的 string/JSON；file parts v1 拒收 */
function toClefState(state: any): any {
  if (typeof state === 'string') return state;
  if (Array.isArray(state)) {
    const texts: string[] = [];
    const jsons: any[] = [];
    for (const p of state) {
      if (p && typeof p === 'object' && p.type === 'text') texts.push(String(p.text ?? ''));
      else if (p && typeof p === 'object' && p.type === 'json') jsons.push(p.value);
      else if (p && typeof p === 'object' && p.type === 'file') throw new Error('clef: file state 不支持（v1）');
      else jsons.push(p);
    }
    if (jsons.length && texts.length) return { text: texts.join('\n'), data: jsons.length === 1 ? jsons[0] : jsons };
    if (jsons.length) return jsons.length === 1 ? jsons[0] : jsons;
    return texts.join('\n');
  }
  return state ?? '';
}

/**
 * 造一个 DecisionModelV4（可直接喂 Mastra Classifier）。
 * modelId 默认快速档 clef-flash（9B，$0.038/M 输入、输出不计费）。
 */
export function createClefDecisionModel(E: any, modelId: string = CLEF_FLASH) {
  return {
    specificationVersion: 'v1',
    provider: 'cloudflare-workers-ai',
    modelId,
    supportedQuestionTypes: ['boolean', 'choice', 'score'] as const,
    async doDecide({ state, questions }: { state: any; questions: Record<string, any> }) {
      const sent: Record<string, any> = {};
      const kinds: Record<string, string> = {};
      for (const [id, q] of Object.entries(questions ?? {})) {
        const t = String((q as any)?.type ?? '');
        if (!TO_CLEF[t]) return { answers: { [id]: { type: 'refusal' } }, warnings: [] }; // box/未知：拒答
        kinds[id] = t;
        const one: any = { type: TO_CLEF[t] };
        if ((q as any)?.instructions != null) one.instructions = (q as any).instructions;
        if ((q as any)?.criteria != null) one.criteria = (q as any).criteria;
        sent[id] = one;
      }
      const input = { model: String(modelId).split('/').pop(), state: toClefState(state), questions: sent };
      const raw: any = await (E as any).AI.run(modelId, input);
      const answersRaw = raw?.answers ?? raw?.result?.answers ?? {};
      const answers: Record<string, any> = {};
      const confidence: Record<string, number> = {};
      for (const [id, t] of Object.entries(kinds)) {
        const a = answersRaw[id];
        if (!a) throw new Error(`clef: missing answer for ${id}`);
        if (a.confidence != null) confidence[id] = Number(a.confidence);
        if (t === 'boolean') {
          const p = Number(a.noul ?? a.probability ?? 0);
          answers[id] = { type: 'boolean', probability: Math.min(1, Math.max(0, p)) };
        } else if (t === 'choice') {
          const probs = a.probabilities ?? undefined;
          answers[id] = { type: 'choice', choice: String(a.choice ?? ''), ...(probs ? { probabilities: probs } : {}) };
        } else {
          const probs = a.probabilities ?? undefined;
          answers[id] = { type: 'score', score: Number(a.score ?? 0), ...(probs ? { probabilities: probs } : {}) };
        }
      }
      return {
        answers,
        rounding: { probabilityDecimals: 4, scoreDecimals: 4 },
        usage: {
          inputTokens: Number(raw?.usage?.input_tokens ?? 0) || undefined,
          outputTokens: Number(raw?.usage?.output_tokens ?? 0) || undefined,
        },
        warnings: [],
        providerMetadata: { clef: { model: modelId, confidence } },
        response: { modelId, timestamp: new Date() },
      };
    },
  };
}

/**
 * Workers AI 决策模型 provider（对标 `typeSafeAi.decisionModel('jev-latest')` 的工厂形态）：
 * `workersAi(E).decisionModel('@cf/cloudflare/clef-flash')` → DecisionModelV4。
 */
export function workersAi(E: any) {
  return {
    decisionModel: (modelId: string = CLEF_FLASH) => createClefDecisionModel(E, modelId),
  };
}

// ---------- 模型选择（clef-decisions T3） ----------

let modelSel: any = null;

/**
 * 模型降级选择器（Mastra ModelSelectionProcessor 官方 API）：trivial 且高置信 → 便宜档；
 * 其余**弃权**走 persona 默认模型（只降不升，用户配置不被覆盖；Clef 自带分布，阈值 0.8 在 select 里判）。
 * 便宜档走 Mastra 的 cloudflare-workers-ai 供给（@cf/deepseek-ai/deepseek-v4-flash-0731），
 * 复用 CLOUDFLARE_API_KEY + 账号 ID 现成鉴权，比 deepseek 网关的 flash 档更便宜且自带 modelId。
 */
export function createModelSelection(E: any, cheapModel = 'cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731') {
  if (!modelSel) {
    const classifier = new Classifier({
      id: 'model-downgrade',
      model: workersAi(E).decisionModel() as any,
      questions: {
        trivial: {
          type: 'choice',
          instructions: '判断最新一条用户消息的复杂度，只看这条消息本身。',
          criteria: {
            trivial: '一两句话可答的常识、寒暄、简单事实查询，不需要推理、规划或调用工具',
            nontrivial: '需要多步推理、规划、写作、分析、工具调用或长上下文理解',
          },
        },
      },
    });
    modelSel = new ModelSelectionProcessor({
      id: 'model-downgrade',
      classifier,
      select: (answers: any) => {
        const a = answers?.trivial;
        if (a?.type !== 'choice' || a.choice !== 'trivial') return undefined;
        const p = Number(a.probabilities?.trivial ?? 0);
        return p >= 0.8 ? cheapModel : undefined;
      },
      onDecision: (d: any) => {
        console.log('[model-route]', JSON.stringify({ model: d?.model ?? null, abstained: d?.abstained ?? null }));
      },
    } as any);
  }
  return modelSel;
}

// ---------- 审批预判（clef-decisions S2.2） ----------

let permCls: any = null;

/** 权限审批条件放行分类器：单 boolean 题「低风险可自动放行吗」 */
export function permissionClassifier(E: any) {
  if (!permCls) {
    permCls = new Classifier({
      id: 'permission-approval',
      model: workersAi(E).decisionModel() as any,
      questions: {
        low_risk: {
          type: 'boolean',
          instructions: '这是一个工具调用审批请求。判断该操作是否低风险：只读、常规、无副作用（如读文件、列目录、查状态）。任何修改、删除、外发、凭据、支付类操作都不是低风险。',
          criteria: {
            true: '低风险只读或常规查询类操作',
            false: '有副作用或涉及修改/外发/凭据/支付',
          },
        },
      },
    });
  }
  return permCls as import('@mastra/core/classifier').Classifier<any>;
}
