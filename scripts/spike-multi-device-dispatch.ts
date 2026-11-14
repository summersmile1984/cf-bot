/**
 * 多设备 dispatch 链路 E2E（multi-device S2.1）：真模型派发 → l2_tasks.device_id 落库断言。
 * ① 未指定设备 → 绑默认设备 ② 指定不存在的设备 → 明确报错不落库 ③ 显式指定 → 绑该设备。
 * 运行：HTTPS_PROXY=http://127.0.0.1:7897 npx tsx scripts/spike-multi-device-dispatch.ts
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

if (process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

const BASE = 'http://localhost:4120';
const ACCOUNT = '8a1dca996a18a595f0b931f106539248';
const DB_UUID = '067cc9a0-be08-4b16-a527-a29ed4bf31b6';
const EMAIL = `md-disp-${Date.now().toString(36)}@example.com`;
const PASSWORD = 'MultiDevice2026!';
const LOG = '/Users/summer/Documents/cf-bot/verify-shots/multi-device-dispatch.log';

writeFileSync(LOG, `# multi-device dispatch E2E ${new Date().toISOString()}\n`);
const log = (s: string) => { console.log(s); appendFileSync(LOG, s + '\n'); };

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      referer: BASE + '/',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(180_000),
  });
}

async function sseReply(cookie: string, roomId: string, text: string): Promise<string> {
  const r = await api(`/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ text }), headers: { accept: 'text/event-stream' } }, cookie);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '[DONE]') continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'delta') full += ev.text ?? '';
        else if (ev.type === 'done') full = ev.text ?? full;
        else if (ev.type === 'error') throw new Error(ev.message ?? 'sse error');
      } catch (e) {
        if (String(e).includes('sse error')) throw e;
      }
    }
  }
  return full;
}

function d1(sql: string, attempt = 1): any {
  try {
    const out = execFileSync('/Users/summer/Documents/cf-bot/node_modules/.bin/wrangler', [
      'd1', 'execute', DB_UUID, '--remote', '--json', '--command', sql,
    ], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e: any) {
    const msg = `d1 failed: out=${String(e?.stdout ?? '').slice(0, 500)} err=${String(e?.stderr ?? e?.message ?? e).slice(0, 300)}`;
    if (attempt === 1) { log(`d1 retry: ${msg.slice(0, 120)}`); return d1(sql, 2); }
    throw new Error(msg);
  }
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const latestTask = (thread: string) => {
  const j = d1(`SELECT task_id, runtime, device_id, state, substr(prompt,1,30) AS p FROM l2_tasks WHERE thread_id='${thread}' ORDER BY created_at DESC, rowid DESC LIMIT 3`);
  return j?.[0]?.results ?? [];
};

async function main() {
  await api('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'md-disp', email: EMAIL, password: PASSWORD }) });
  const s = await api('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('sign-in 没拿到 Set-Cookie');
  const rooms = await (await api('/rooms', {}, cookie)).json();
  const main = (rooms.rooms ?? []).find((r: any) => r.is_main === 1);
  if (!main) throw new Error('没有主会话');
  log(`session ok (${EMAIL}) main=${main.id}`);

  // 设备：测试机（默认）
  const code = await (await api('/devices/pairing-code', { method: 'POST', body: '{}' }, cookie)).json();
  const pair = await (await api('/devices/pair', { method: 'POST', body: JSON.stringify({ code: code.code, name: '测试机' }) })).json();
  const devId = String(pair.deviceId);
  await api('/devices/default', { method: 'POST', body: JSON.stringify({ deviceId: devId }) }, cookie);
  log(`device ready: ${devId}`);

  // ① 未指定设备 → 默认设备
  const r1 = await sseReply(cookie, main.id, '帮我后台跑一个本地任务：在终端输出当前时间就好。不用指定用哪台电脑。');
  const t1 = latestTask(main.id);
  const row1 = t1.find((r: any) => r.runtime === 'local');
  check('① 未指定 → 默认设备', !!row1 && row1.device_id === devId, `rows=${JSON.stringify(t1).slice(0, 200)} reply=「${r1.slice(0, 60)}…」`);

  // ② 指定不存在的设备 → 明确报错，不落新库
  const before2 = t1.length ? t1[0].task_id : '';
  const r2 = await sseReply(cookie, main.id, '再跑一个本地任务：输出 hello，指定设备 不存在的机器XYZ。');
  const t2 = latestTask(main.id);
  const newRows2 = t2.filter((r: any) => r.task_id !== before2 && r.state === 'queued');
  check('② 无效设备名报错', !newRows2.length && /找不到|设备|无法/.test(r2), `new=${JSON.stringify(newRows2).slice(0, 120)} reply=「${r2.slice(0, 100)}…」`);

  // ③ 显式指定 → 绑该设备
  const r3 = await sseReply(cookie, main.id, '再跑一个本地任务：输出 hello2，指定设备 测试机。');
  const t3 = latestTask(main.id);
  const row3 = t3.find((r: any) => r.runtime === 'local' && String(r.p).includes('hello2'));
  check('③ 显式指定绑定', !!row3 && row3.device_id === devId, `rows=${JSON.stringify(t3).slice(0, 200)} reply=「${r3.slice(0, 60)}…」`);

  // 清理
  d1(`UPDATE l2_tasks SET state='canceled' WHERE thread_id='${main.id}' AND state IN ('queued','working')`);
  log('cleanup done');

  const fail = results.filter((r) => !r.ok).length;
  log(`\n${results.length - fail}/${results.length} passed${fail ? `，${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { log(`FATAL ${e}`); process.exit(1); });
