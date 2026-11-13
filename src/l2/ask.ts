/**
 * judgment call 追问（ask-artifacts S2.1）：ask_user 工具 → /l2-ask → 阻塞轮询答案。
 * 语义：只在真正需要主人判断时问（Grok "only pull you in for judgment calls"）。
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { withProxy } from './proxy-fetch.js';

export type AskCfg = { l1Url: string; token: string };
const POLL_MS = 5_000;
const TIMEOUT_MS = 3 * 60_000; // 串行执行位防饿死（评审 MAJOR）

/** 抛出问题并阻塞等待主人房间回复（超时给兜底语，任务不挂死）。 */
export function l2Asker(cfg: AskCfg, taskId: string): (question: string) => Promise<string> {
  return async (question: string) => {
    const post = await fetch(`${cfg.l1Url}/l2-ask`, withProxy({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
      body: JSON.stringify({ taskId, question: String(question).slice(0, 300) }),
      signal: AbortSignal.timeout(15_000),
    })).catch(() => null);
    if (!post?.ok) {
      const j: any = await post?.json?.().catch(() => null);
      return `（提问失败：${j?.error ?? '通道不可用'}）请自行稳妥决定并继续。`;
    }
    const end = Date.now() + TIMEOUT_MS;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const r = await fetch(`${cfg.l1Url}/l2-ask-answer?taskId=${encodeURIComponent(taskId)}`, withProxy({
          headers: { authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
          signal: AbortSignal.timeout(15_000),
        }));
        const j: any = await r.json().catch(() => null);
        if (r.ok && typeof j?.answer === 'string' && j.answer.trim()) return j.answer.trim();
      } catch { /* 继续轮询 */ }
    }
    // 超时撤销提问：清掉 pending，防后续无关发言被吞成“答案”
    try {
      await fetch(`${cfg.l1Url}/l2-ask-cancel`, withProxy({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
        body: JSON.stringify({ taskId }),
        signal: AbortSignal.timeout(15_000),
      }));
    } catch { /* 忽略 */ }
    return '（主人暂未回复）请自行稳妥决定并继续，事后在总结里注明。';
  };
}

/** ask_user 工具：sink 由 runExpertAgent 按任务注入（缓存 agent + 全局槽，同 report_progress）。 */
export function makeAskTool(sink: () => ((q: string) => Promise<string>) | null, description?: string) {
  return createTool({
    id: 'ask_user',
    description: description || '向主人提一个需要判断的问题（分叉/口径/取舍），会暂停等主人在聊天里回复（约 3 分钟内）。只在真正需要主人拍板时用；能自己稳妥决定的不要问。每任务最多 3 次。',
    inputSchema: z.object({
      question: z.string().describe('一句话问题，≤100 字'),
      context: z.string().optional().describe('可选：为什么需要判断（一两句）'),
    }),
    execute: async ({ question, context }: { question: string; context?: string }) => {
      const fn = sink();
      if (!fn) return { answer: '（提问通道不可用）请自行稳妥决定并继续。' };
      const q = context ? `${question}（${context.slice(0, 80)}）` : question;
      const answer = await fn(String(q).slice(0, 300));
      return { answer };
    },
  });
}
