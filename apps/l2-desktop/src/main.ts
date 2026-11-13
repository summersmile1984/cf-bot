/**
 * L2 desktop claim loop entry (Node sidecar for Tauri; also `npm run claim:dev`).
 * Aligns with repo root `src/l2-pull-worker.ts` + L1 `POST /l2-claim`.
 */
import { loadConfig, readDeviceHarness } from './config.js';
import { syncManagedConnections } from '../../../src/l2/mcp-sync.js';
import { claimOnce, completeTask } from './claim.js';
import { resolveKind } from './dispatch.js';
import { runAcp } from './acp/runner.js';
import { runCua } from './cua/runner.js';
import { runExpert } from './expert/runner.js';
import { writeStatus } from './status.js';
import { bootstrap } from './bootstrap.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  writeStatus({
    running: true,
    online: true,
    pid: process.pid,
    error: null,
    queueHint: 'polling',
    lastSummary: `claim loop → ${cfg.l1Url}/l2-claim`,
  });
  console.log('[l2-desktop] claim loop', `${cfg.l1Url}/l2-claim`, 'every', cfg.intervalMs, 'ms', 'pid', process.pid);
  // 默认 harness 报 L1 存档（harness-registry S2.3）；UI 改默认后按 device.json 变化重报，失败仅记日志
  let reportedHarness: string | undefined;
  // web 连接同步（web-mcp S2.3）：≥60s 节流拉 /mcp-connections → mcp-managed.json
  let lastSync = 0;
  const syncManaged = () => {
    if (Date.now() - lastSync < 60_000) return;
    lastSync = Date.now();
    void syncManagedConnections(cfg.l1Url, cfg.token)
      .then((n) => { if (n >= 0) console.log('[l2-desktop] mcp-managed synced:', n); })
      .catch(() => undefined);
  };
  syncManaged();
  const reportDefaultHarness = () => {
    const h = readDeviceHarness();
    if (h === reportedHarness) return;
    reportedHarness = h;
    void fetch(`${cfg.l1Url}/harness-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
      body: JSON.stringify({ harness: h ?? null }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => { if (r.ok) console.log('[l2-desktop] default harness reported', h ?? '(none)'); }).catch(() => undefined);
  };
  reportDefaultHarness();

  const shutdown = () => {
    writeStatus({ running: false, online: false, queueHint: 'stopped', lastSummary: 'claim loop stopped' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (;;) {
    try {
      reportDefaultHarness();
      syncManaged();
      writeStatus({ online: true, queueHint: 'polling', error: null });
      const task = await claimOnce(cfg);
      if (!task) {
        writeStatus({ queueHint: 'idle (no queued L2 task)' });
        await sleep(cfg.intervalMs);
        continue;
      }
      const kind = resolveKind(task);
      const claimAt = new Date().toISOString();
      console.log('[l2-desktop] claimed', task.taskId, kind);
      writeStatus({
        lastClaimAt: claimAt,
        lastTaskId: task.taskId,
        lastKind: kind,
        lastState: 'working',
        lastSummary: (task.prompt || '').slice(0, 160),
        queueHint: 'running task',
      });
      let state: 'completed' | 'failed' = 'completed';
      let text: string;
      // 沙箱秘钥物化（secret-pipeline）：句柄 → env + 一次性 0600 文件，任务结束销毁
      const { collectVaultRefs, materializeSecrets, rewriteRefs, secretsHint } = await import('../../../src/l2/secrets-inject.js');
      const { l2SecretResolver } = await import('../../../src/l2/expert-agent.js');
      const { l2ProgressReporter, startHeartbeat } = await import('../../../src/l2/progress.js');
      const { l2Asker } = await import('../../../src/l2/ask.js');
      const { uploadArtifact, uploadScreenshot } = await import('../../../src/l2/artifacts.js');
      // Grok 式一句话进度（l2-progress S2.3）：上报 + 面板 lastProgress + 静默心跳
      const report = (line: string, kind?: string) => {
        writeStatus({ lastProgress: line.slice(0, 120), lastSummary: line.slice(0, 240) });
        return l2ProgressReporter(cfg, task.taskId)(line, kind);
      };
      const stopHeartbeat = startHeartbeat(task.taskId, report, String(task.prompt || '').replace(/\s+/g, ' '));
      const refs = collectVaultRefs(task.prompt, JSON.stringify(task.def ?? null));
      let sec: Awaited<ReturnType<typeof materializeSecrets>> | null = null;
      try {
        if (refs.length) {
          sec = await materializeSecrets({ refs, resolveSecret: l2SecretResolver(cfg, task.taskId), taskId: task.taskId });
          console.log('[l2-desktop] secrets bound', JSON.stringify(Object.keys(sec.env)));
        }
        const prompt = sec ? rewriteRefs(String(task.prompt || ''), sec.byRef) : String(task.prompt || '');
        const t2 = { ...task, prompt, reportProgress: report,
          askQuestion: l2Asker(cfg, task.taskId),
          uploadArtifact: (p: { kind: 'image' | 'text'; caption?: string; data: string }) => uploadArtifact(cfg, task.taskId, p),
        };
        const out = kind === 'expert' ? await runExpert(t2, cfg, sec?.env)
          : kind === 'cua' ? await runCua(t2, sec?.env, sec ? secretsHint(sec) : '')
          : await runAcp(t2, sec?.env);
        text = out.text;
        if (kind === 'cua' && (t2 as any).__screenshotPath && ((t2 as any).__screenshotBytes ?? 0) > 0) {
          await uploadScreenshot(cfg, task.taskId, (t2 as any).__screenshotPath);
        }
      } catch (e: any) {
        state = 'failed';
        text = String(e?.message ?? e).slice(0, 2000);
      } finally {
        sec?.cleanup();
        stopHeartbeat();
      }
      let r: unknown;
      try {
        r = await completeTask(cfg, task.taskId, state, text);
      } catch (e: any) {
        console.log('[l2-desktop] callback error', String(e?.message ?? e).slice(0, 160));
        await sleep(2000);
        r = await completeTask(cfg, task.taskId, state, text);
      }
      console.log('[l2-desktop] done', task.taskId, state, JSON.stringify(r)?.slice(0, 120));
      writeStatus({
        lastState: state,
        lastSummary: text.slice(0, 240).replace(/\n/g, ' '),
        queueHint: 'polling',
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      console.log('[l2-desktop] poll error', msg);
      writeStatus({ error: msg, queueHint: 'backoff' });
      await sleep(cfg.intervalMs * 2);
    }
  }
}

if (!bootstrap()) main().catch((e) => {
  writeStatus({ running: false, online: false, error: String(e?.message ?? e).slice(0, 300) });
  console.error(e);
  process.exit(1);
});
