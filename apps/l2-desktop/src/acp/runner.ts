import type { ClaimTask } from '@mastra-preflight/shared';

/**
 * Real ACP runner: reuse repo `runAcpPrompt` (AcpAgent + dsh --profile acp).
 * Same path as `npm run start:l2-pull` / src/l2-pull-worker.ts. Not a stub.
 */
export async function runAcp(task: ClaimTask, secretEnv?: Record<string, string>): Promise<{ ok: true; text: string }> {
  const mod: any = await import('../../../../src/l2/a2a-l2.js');
  const runtime = task.runtime === 'local' ? 'local' : 'cloud';
  console.log('[acp] real run', task.taskId, runtime, (task.prompt || '').slice(0, 80));
  if (process.env.ACP_DRY_RUN === '1') {
    console.warn('[acp] ACP_DRY_RUN=1 — not real harness');
  }
  const text = await mod.runAcpPrompt(String(task.prompt || ''), runtime, secretEnv, { harness: task.harness ?? undefined, policies: (task as any).def?.policies });
  return { ok: true, text };
}
