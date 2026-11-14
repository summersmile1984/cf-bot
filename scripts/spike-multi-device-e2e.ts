/**
 * 多设备生产 E2E（multi-device T4）：线上真实链路验证设备身份与任务路由。
 * ① 配对 A/B 两台设备 ② 默认设备 ③ 定向任务只被目标设备领（A 领不到 B 的单）④
 * 抢单任务任一设备可领 ⑤ /a2a-callback 认设备 token ⑥ 吊销后 401 ⑦ 配对码一次性。
 * 任务行由 wrangler d1（UUID）直插，claim 路径为真实 /l2-claim。
 * 运行：HTTPS_PROXY=http://127.0.0.1:7897 npx tsx scripts/spike-multi-device-e2e.ts
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
const EMAIL = `md-e2e-${Date.now().toString(36)}@example.com`;
const PASSWORD = 'MultiDevice2026!';
const LOG = '/Users/summer/Documents/cf-bot/verify-shots/multi-device-e2e.log';

writeFileSync(LOG, `# multi-device E2E ${new Date().toISOString()}\n`);
const log = (s: string) => { console.log(s); appendFileSync(LOG, s + '\n'); };

async function api(path: string, init: RequestInit = {}, cookie?: string, bearer?: string) {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      referer: BASE + '/',
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
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
    // 代理瞬断单次有界重试（夜间网络抖动），不循环轰炸
    if (attempt === 1) { log(`d1 retry: ${msg.slice(0, 120)}`); return d1(sql, 2); }
    throw new Error(msg);
  }
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // ---------- 会话 ----------
  await api('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'md-e2e', email: EMAIL, password: PASSWORD }) });
  const s = await api('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('sign-in 没拿到 Set-Cookie');
  log(`session ok (${EMAIL})`);

  // ---------- 配对 A/B ----------
  const codeA = await (await api('/devices/pairing-code', { method: 'POST', body: '{}' }, cookie)).json();
  const codeB = await (await api('/devices/pairing-code', { method: 'POST', body: '{}' }, cookie)).json();
  check('配对码下发', !!codeA?.code && !!codeB?.code, `${codeA?.code} / ${codeB?.code}`);
  const pairA = await (await api('/devices/pair', { method: 'POST', body: JSON.stringify({ code: codeA.code, name: '公司电脑' }) })).json();
  const pairB = await (await api('/devices/pair', { method: 'POST', body: JSON.stringify({ code: codeB.code, name: '家里电脑' }) })).json();
  check('配对 A/B 成功', !!pairA?.token && !!pairB?.token, `${pairA?.deviceId} / ${pairB?.deviceId}`);
  const tokA = String(pairA.token), tokB = String(pairB.token);
  const devA = String(pairA.deviceId), devB = String(pairB.deviceId);
  const ownerA = String(pairA.userId ?? ''); // 多租户归属：任务行必须挂 owner，设备只领本用户的单

  const reuse = await api('/devices/pair', { method: 'POST', body: JSON.stringify({ code: codeA.code, name: '再来' }) });
  check('配对码一次性', reuse.status === 400);

  // ---------- 列表 / 默认设备 ----------
  const devList = await (await api('/devices', {}, cookie)).json();
  check('设备列表 2 台', devList.devices?.length === 2, JSON.stringify((devList.devices ?? []).map((d: any) => d.name)));
  const defRes = await (await api('/devices/default', { method: 'POST', body: JSON.stringify({ deviceId: devA }) }, cookie)).json();
  check('设默认设备 A', !!defRes.ok, defRes.ok ? '' : JSON.stringify(defRes).slice(0, 160));

  // ---------- 任务路由（直插三行：定向B / 定向A / 抢单NULL；created_at 回拨让测试单排最前） ----------
  // 先清历史残留（半途失败的旧测试行会撞主键），task_id 带 RUN 后缀防撞
  d1("UPDATE l2_tasks SET state='canceled' WHERE task_id LIKE 'md-e2e-%' AND state IN ('queued','working')");
  const RUN = Date.now().toString(36);
  const tB = `md-e2e-${RUN}-tB`, tA = `md-e2e-${RUN}-tA`, tN = `md-e2e-${RUN}-tN`;
  const base = 1_000; // epoch+1s：任何残留积压单都比测试单新，claim 必先取测试行
  const gen = (id: string, dev: string | null, t: number) =>
    `INSERT INTO l2_tasks (task_id,thread_id,resource_id,runtime,state,prompt,created_at,updated_at,device_id,owner_id) VALUES ('${id}','md-e2e-room',NULL,'local','queued','多设备路由测试 ${id}',${t},${t},${dev ? `'${dev}'` : 'NULL'},'${ownerA}')`;
  d1(gen(tB, devB, base + 1));
  d1(gen(tA, devA, base + 2));
  d1(gen(tN, null, base + 3));
  log(`tasks injected: ${tB}→B ${tA}→A ${tN}→NULL (created_at -1d)`);

  // claim：定向行按 created_at 排最前，断言精确 taskId
  const claimB1 = await (await api('/l2-claim', { method: 'POST', body: '{}' }, undefined, tokB)).json();
  const bGot = String(claimB1.task?.taskId ?? '');
  check('B 领到定向 B 的任务', bGot === tB, `got=${bGot || 'none'}`);
  check('B 不会领到定向 A 的任务', bGot !== tA, `got=${bGot}`);

  const claimA1 = await (await api('/l2-claim', { method: 'POST', body: '{}' }, undefined, tokA)).json();
  const aGot = String(claimA1.task?.taskId ?? '');
  check('A 领到定向 A 的任务', aGot === tA, `got=${aGot || 'none'}`);
  check('A 不会领到定向 B 的任务', aGot !== tB, `got=${aGot}`);

  // 抢单行 tN：下一位设备可领（无定向）
  const claimA2 = await (await api('/l2-claim', { method: 'POST', body: '{}' }, undefined, tokA)).json();
  const nGot = String(claimA2.task?.taskId ?? '');
  check('抢单行可被设备领取', nGot === tN, `got=${nGot || 'none'}`);

  // ---------- 多租户归属（授权绕过修复）：另一用户的设备领不到本用户的任何单 ----------
  const EMAIL2 = `md-e2e-b-${Date.now().toString(36)}@example.com`;
  await api('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'md-e2e-b', email: EMAIL2, password: PASSWORD }) });
  const s2 = await api('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL2, password: PASSWORD }) });
  const cookie2 = (s2.headers.get('set-cookie') ?? '').split(';')[0];
  const codeC = await (await api('/devices/pairing-code', { method: 'POST', body: '{}' }, cookie2)).json();
  const pairC = await (await api('/devices/pair', { method: 'POST', body: JSON.stringify({ code: codeC.code, name: '路人电脑' }) })).json();
  const tokC = String(pairC.token ?? '');
  const claimC = await (await api('/l2-claim', { method: 'POST', body: '{}' }, undefined, tokC)).json();
  const cGot = String(claimC.task?.taskId ?? '');
  check('跨用户设备领不到他人任务', !!tokC && !cGot.startsWith('md-e2e-'), `got=${cGot || 'none'}`);

  // ---------- 回调认设备 token ----------
  const cb = await api('/a2a-callback', {
    method: 'POST',
    body: JSON.stringify({ id: bGot, kind: 'task', status: { state: 'completed' }, artifacts: [{ artifactId: 'x', parts: [{ kind: 'text', text: '多设备回调冒烟' }] }] }),
  }, undefined, tokB);
  check('回调认设备 token', cb.status === 200, `HTTP ${cb.status}`);

  // ---------- 吊销后 401 ----------
  const rev = await (await api(`/devices/${devB}`, { method: 'DELETE' }, cookie)).json();
  check('吊销 B', !!rev.ok);
  const claimB3 = await api('/l2-claim', { method: 'POST', body: '{}' }, undefined, tokB);
  check('吊销后 claim 401', claimB3.status === 401, `HTTP ${claimB3.status}`);
  const cb2 = await api('/a2a-callback', {
    method: 'POST',
    body: JSON.stringify({ id: tA, kind: 'task', status: { state: 'completed' }, artifacts: [{ artifactId: 'x', parts: [{ kind: 'text', text: 'x' }] }] }),
  }, undefined, tokB);
  check('吊销后回调 401', cb2.status === 401, `HTTP ${cb2.status}`);

  // 改名（A 仍在线）
  const ren = await (await api(`/devices/${devA}`, { method: 'PUT', body: JSON.stringify({ name: '公司电脑-改名' }) }, cookie)).json();
  check('设备改名', !!ren.ok);

  // 清理：任务行置终态，避免污染队列
  d1("UPDATE l2_tasks SET state='canceled' WHERE task_id LIKE 'md-e2e-%'");
  log('cleanup: md-e2e tasks canceled');

  const fail = results.filter((r) => !r.ok).length;
  log(`\n${results.length - fail}/${results.length} passed${fail ? `，${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { log(`FATAL ${e}`); process.exit(1); });
