/**
 * L2 进度上报（l2-progress S2.3，Grok 式一句话进度）：
 * report_progress 工具 → POST /l2-progress；静默超时心跳兜底（ACP/CUA 无模型路径也报）。
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { withProxy } from './proxy-fetch.js';

export type ProgressCfg = { l1Url: string; token: string };

/** 每任务最近一次进度时间（心跳判「零进度」用） */
const lastAt = new Map<string, number>();

/** 任务级进度上报器（设备令牌 + 任务授权在 L1 侧）。 */
export function l2ProgressReporter(cfg: ProgressCfg, taskId: string): (line: string, kind?: string) => Promise<void> {
  return async (line: string, kind = 'note') => {
    try {
      const r = await fetch(`${cfg.l1Url}/l2-progress`, withProxy({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
        body: JSON.stringify({ taskId, line, kind }),
        signal: AbortSignal.timeout(15_000),
      }));
      if (r.ok) lastAt.set(taskId, Date.now());
      else console.log('[l2-progress] post failed', r.status);
    } catch (e: any) {
      console.log('[l2-progress] post error', String(e?.message ?? e).slice(0, 120));
    }
  };
}

/** 专家用的 report_progress 工具：sink 由 runExpertAgent 按任务注入（agent 实例是缓存的，工具用全局槽）。 */
export function makeProgressTool(sink: () => ((line: string) => Promise<unknown>) | null, description?: string) {
  return createTool({
    id: 'report_progress',
    description: description || '任务中途播报一句话进度（像对同事顺口汇报）。长任务建议报 1-3 次，不要刷屏。',
    inputSchema: z.object({ line: z.string().describe('≤60 字的一句话进度') }),
    execute: async ({ line }: { line: string }) => {
      const fn = sink();
      if (!fn) return { ok: false, reason: 'no progress channel' };
      await fn(String(line).slice(0, 120));
      return { ok: true };
    },
  });
}

/**
 * 心跳兜底：任务静默超过 everyMs 且期间零进度 → 自动补一条短心跳（kind=heartbeat）。
 * 返回 stop()，调用方在任务结束时务必调用。
 */
export function startHeartbeat(
  taskId: string,
  report: (line: string, kind?: string) => Promise<void>,
  summary: string,
  everyMs = 180_000,
): () => void {
  lastAt.set(taskId, Date.now()); // 起点即「刚有动静」：真正静默 everyMs 后才补心跳（评审 MAJOR）
  const t = setInterval(() => {
    const last = lastAt.get(taskId) ?? 0;
    if (Date.now() - last < everyMs) return; // 已有进度，不打扰
    lastAt.set(taskId, Date.now());
    void report(`还在处理：${summary.slice(0, 20)}`, 'heartbeat');
  }, Math.min(everyMs, 60_000));
  t.unref?.();
  return () => clearInterval(t);
}
