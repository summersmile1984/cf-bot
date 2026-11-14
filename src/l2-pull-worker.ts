/**
 * L2 出站 PULL 客户端：轮询 L1 Worker /l2-claim → expert LLM | ACP | CUA → POST /a2a-callback。
 * P1: experts 与 sandbox 同一 claim 队列（无 Worker waitUntil 专家路径）。
 * Env: L1_PULL_URL, PUSH_TOKEN, L2_PULL_INTERVAL_MS(2000), ACP_DRY_RUN(可选), DEEPSEEK_API_KEY(专家优先)
 */
import { runAcpPrompt } from './l2/a2a-l2.js';
import { runExpertAgent, l2SecretResolver } from './l2/expert-agent.js';
import { l2ProgressReporter, startHeartbeat } from './l2/progress.js';
import { l2Asker } from './l2/ask.js';
import { uploadArtifact, uploadScreenshot } from './l2/artifacts.js';
import { collectVaultRefs, materializeSecrets, rewriteRefs, secretsHint, type MaterializedSecrets } from './l2/secrets-inject.js';
import { runCuaTask } from './l2/cua-cli.js';
import { withProxy, resolveProxyUrl } from './l2/proxy-fetch.js';
import { syncManagedConnections } from './l2/mcp-sync.js';

const BASE = String(process.env.L1_PULL_URL || 'http://localhost:4120').replace(/\/$/, '');
const TOKEN = process.env.L2_DEVICE_TOKEN || process.env.PUSH_TOKEN || '';
const INTERVAL = Number(process.env.L2_PULL_INTERVAL_MS || 2000);
let lastManagedSync = 0;
if (!TOKEN) { console.error('[L2-pull] L2_DEVICE_TOKEN / PUSH_TOKEN missing'); process.exit(1); }
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Claimed = {
  taskId: string; prompt?: string; runtime?: string; kind?: string;
  expertId?: string | null; instructions?: string | null; threadId?: string;
  resourceId?: string | null; model?: string | null;
  def?: import('./l2/expert-agent.js').ExpertDefSnapshot | null;
  harness?: string | null;
  reportProgress?: (line: string) => Promise<unknown>;
};

function resolveKind(t: Claimed): 'expert' | 'cua' | 'acp' {
  const k = String(t.kind || '').toLowerCase();
  if (k === 'expert' || t.expertId) return 'expert';
  if (k === 'cua') return 'cua';
  const r = String(t.runtime || '').toLowerCase();
  if (r === 'expert') return 'expert';
  if (r.includes('cua') || r.includes('computer')) return 'cua';
  return 'acp';
}

async function runExpert(t: Claimed, cfg: { l1Url: string; token: string }, secretEnv?: Record<string, string>): Promise<string> {
  // L2 专家 = Mastra Agent + thread 对齐本地记忆（l2-experts S2.5）；secret: 引用经 /l2-secret 解析（secret-pipeline）
  return runExpertAgent({
    prompt: String(t.prompt || ''),
    expertId: t.expertId, instructions: t.instructions, model: t.model,
    threadId: t.threadId, resourceId: t.resourceId, def: t.def ?? null,
    resolveSecret: l2SecretResolver(cfg, t.taskId), secretEnv, reportProgress: t.reportProgress,
    askQuestion: (t as any).askQuestion, uploadArtifact: (t as any).uploadArtifact,
  });
}

async function post(path: string, body: any) {
  const r = await fetch(`${BASE}${path}`, withProxy({ method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }));
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return j;
}

async function complete(taskId: string, state: 'completed' | 'failed', text: string) {
  for (let i = 0; i < 5; i++) {
    try {
      return await post('/a2a-callback', { id: taskId, kind: 'task', status: { state, timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, parts: [{ kind: 'text', text }] }] });
    } catch (e: any) { console.log('[L2-pull] callback retry', i, String(e?.message ?? e).slice(0, 160)); await sleep(2000 * (i + 1)); }
  }
}

console.log('[L2-pull] polling', `${BASE}/l2-claim`, 'every', INTERVAL, 'ms', process.env.ACP_DRY_RUN === '1' ? '(DRY-RUN)' : '', resolveProxyUrl() ? `proxy=${resolveProxyUrl()}` : 'proxy=off');
for (;;) {
  try {
    // web 连接同步（web-mcp S2.3）：≥60s 节流拉 /mcp-connections → mcp-managed.json
    if (Date.now() - lastManagedSync > 60_000) {
      lastManagedSync = Date.now();
      void syncManagedConnections(BASE, TOKEN).catch(() => undefined);
    }
    const j = await post('/l2-claim', {});
    const t: Claimed | null = j?.task;
    if (!t) { await sleep(INTERVAL); continue; }
    const kind = resolveKind(t);
    console.log('[L2-pull] claimed', t.taskId, t.runtime, 'kind=' + kind, t.expertId ? `expert=${t.expertId}` : '');
    let state: 'completed' | 'failed' = 'completed', text: string;
    // 沙箱秘钥物化（secret-pipeline）：句柄 → 子进程 env + 一次性 0600 文件，任务结束销毁
    const cfg = { l1Url: BASE, token: TOKEN };
    const resolveSecret = l2SecretResolver(cfg, t.taskId);
    // Grok 式一句话进度（l2-progress S2.3）：上报器 + 静默心跳
    const report = l2ProgressReporter(cfg, t.taskId);
    const stopHeartbeat = startHeartbeat(t.taskId, report, String(t.prompt || '').replace(/\s+/g, ' '));
    const refs = collectVaultRefs(t.prompt, JSON.stringify(t.def ?? null));
    let sec: MaterializedSecrets | null = null;
    try {
      const explicitEnv: Record<string, string> = {};
      for (const s of Object.values((t.def as any)?.mcp_json ? JSON.parse(String((t.def as any).mcp_json) || '{}')?.servers ?? {} : {})) {
        for (const [k, v] of Object.entries((s as any)?.env ?? {})) explicitEnv[k] = String(v);
      }
      if (refs.length || Object.values(explicitEnv).some((v) => v.startsWith('secret:'))) {
        sec = await materializeSecrets({ refs, explicitEnv, resolveSecret, taskId: t.taskId });
        console.log('[L2-pull] secrets bound', JSON.stringify(Object.keys(sec.env)), 'files@', sec.fileDir);
      }
      const prompt = sec ? rewriteRefs(String(t.prompt || ''), sec.byRef) : String(t.prompt || '');
      const ask = l2Asker(cfg, t.taskId);
      const upload = (p: { kind: 'image' | 'text'; caption?: string; data: string }) => uploadArtifact(cfg, t.taskId, p);
      if (kind === 'expert') text = await runExpert({ ...t, prompt, reportProgress: report, askQuestion: ask, uploadArtifact: upload }, cfg, sec?.env);
      else if (kind === 'cua') {
        // cua 目标 shell 不继承 CLI env → 靠 0600 文件 + 提示行
        const out = await runCuaTask({ taskId: String(t.taskId), prompt: sec ? prompt + secretsHint(sec) : prompt, runtime: t.runtime, kind }, undefined, sec?.env);
        text = out.text;
        // 截图自动入档（ask-artifacts S2.2）
        if (out.screenshotPath && (out.screenshotBytes ?? 0) > 0) await uploadScreenshot(cfg, t.taskId, out.screenshotPath); // 任务完成前落档（防火后不理竞态）
      } else {
        text = await runAcpPrompt(prompt, t.runtime === 'local' ? 'local' : 'cloud', sec?.env, { harness: t.harness ?? undefined, policies: (t.def as any)?.policies ?? undefined, ask });
      }
    } catch (e: any) { state = 'failed'; text = String(e?.message ?? e).slice(0, 2000); }
    finally { sec?.cleanup(); stopHeartbeat(); }
    const r = await complete(t.taskId, state, text);
    console.log('[L2-pull] done', t.taskId, state, JSON.stringify(r));
  } catch (e: any) { console.log('[L2-pull] poll error', String(e?.message ?? e).slice(0, 200)); await sleep(INTERVAL * 2); }
}
