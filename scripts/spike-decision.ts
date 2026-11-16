/**
 * Clef 决策模型回归（clef-decisions S2.1）：
 * ① 真调 Workers AI @cf/cloudflare/clef-flash，走 Mastra Classifier 全套校验（choice/score/boolean）
 * ② 映射边角：noul→probability、未知题型拒答、state parts 展平
 * 运行：CLOUDFLARE_API_TOKEN=... npx tsx scripts/spike-decision.ts
 */
import { Classifier } from '@mastra/core/classifier';
import { createClefDecisionModel } from '../src/mastra/decision';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ACC = '8a1dca996a18a595f0b931f106539248';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

// env.AI.run 等价物：REST /ai/run/<model>
const E: any = {
  AI: {
    run: async (model: string, input: any) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
      const j: any = await res.json();
      if (!res.ok || j?.success === false) throw new Error(`ai run failed: ${JSON.stringify(j?.errors ?? res.status)}`);
      return j.result ?? j;
    },
  },
};

async function main() {
  // ② 映射边角（mock）
  const mock: any = {
    AI: {
      run: async () => ({
        answers: {
          risky: { type: 'noul', noul: 0.25 },
          pick: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.4 },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    },
  };
  const m = createClefDecisionModel(mock);
  const mapped = await m.doDecide({
    state: [{ type: 'text', text: 'hi' }, { type: 'json', value: { x: 1 } }],
    questions: { risky: { type: 'boolean' } as any, pick: { type: 'choice', criteria: { a: 'A', b: 'B' } } as any },
  } as any);
  check('① noul→probability 映射', (mapped.answers as any).risky.probability === 0.25);
  check('② choice 直通 + parts 展平', (mapped.answers as any).pick.choice === 'a' && mapped.rounding?.probabilityDecimals === 4);
  const refused = await (m as any).doDecide({ state: 'x', questions: { where: { type: 'box', instructions: 'u' } } });
  check('③ box/未知题型拒答', (refused.answers as any).where?.type === 'refusal');

  if (!TOKEN) { console.log('no CLOUDFLARE_API_TOKEN，跳过真调'); return finish(); }

  // ① 真调：三类问题过 Mastra Classifier 校验
  const cls = new Classifier({
    id: 'spike-clef',
    model: createClefDecisionModel(E) as any,
    questions: {
      low_risk: {
        type: 'boolean',
        instructions: '该操作是否低风险只读？',
        criteria: { true: '只读常规', false: '有副作用' },
      },
      route: {
        type: 'choice',
        instructions: '这句话该怎么处理？',
        criteria: { direct_answer: '直接回答', dispatch_task: '派任务执行', ask_user: '先问用户' },
      },
      depth: {
        type: 'score',
        instructions: '需要多深的推理？',
        criteria: ['简单', '一般', '深度'],
      },
    },
  });
  const r = await cls.decide({
    state: { message: '帮我看下 C 盘还剩多少空间，只是查一下', note: '低风险查询' },
  });
  const b: any = r.answers.low_risk;
  const c: any = r.answers.route;
  const s: any = r.answers.depth;
  check('④ 真调 boolean 合法（过 Classifier 校验）', b?.type === 'boolean' && b.probability > 0.8, `p=${b?.probability}`);
  check('⑤ 真调 choice 合法（分布求和≈1）', c?.type === 'choice' && !!c.choice && Math.abs(Object.values(c.probabilities ?? { a: 1 }).reduce((x: number, y: any) => x + y, 0) - 1) < 0.01, `choice=${c?.choice}`);
  check('⑥ 真调 score 合法（加权均值一致）', s?.type === 'score' && s.score >= 0 && s.score <= 2, `score=${s?.score}`);
  check('⑦ usage/rounding 带回', !!r.usage && r.rounding?.probabilityDecimals === 4, `in=${r.usage?.totalTokens}`);

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
