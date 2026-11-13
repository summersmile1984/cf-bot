/**
 * Pages 托管 E2E（pages-hosting T5）：真实链路走 L1 publish_page → CF Pages Direct Upload →
 * 独立 URL 验活 → 房间 [page:id] 卡片 → 下架。干净账号（自动注册）。
 * 运行：npx tsx scripts/spike-pages-e2e.ts
 */
import { writeFileSync, appendFileSync } from 'node:fs';

if (process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

const BASE = 'http://localhost:4120';
const EMAIL = `pages-e2e-${Date.now().toString(36)}@example.com`;
const PASSWORD = 'PagesVerify2026!';
const LOG = '/Users/summer/Documents/cf-bot/verify-shots/pages-e2e.log';

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

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  appendFileSync(LOG, `${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}\n`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail.slice(0, 140)}`);
};

async function main() {
  writeFileSync(LOG, `# pages e2e ${new Date().toISOString()}\n`);
  await api('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'pages-e2e', email: EMAIL, password: PASSWORD }) });
  const s = await api('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('sign-in 没拿到 Set-Cookie');

  const rooms = await (await api('/rooms', {}, cookie)).json() as any;
  const main = rooms.rooms.find((r: any) => r.is_main === 1);
  if (!main) throw new Error('没有主会话');

  // ① 聊天驱动发布（通道 B：L1 publish_page 工具）
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>cf-bot 页面测试</title><style>body{font-family:sans-serif;padding:40px;background:#0f172a;color:#e2e8f0}h1{color:#38bdf8}</style></head><body><h1>cf-bot Pages 托管验证</h1><p>这是由 L1 publish_page 发布的页面。时间戳：${Date.now()}</p></body></html>`;
  const r1 = await sseReply(cookie, main.id, `请调用 publish_page 工具发布一个页面：标题「Pages 托管验证」，HTML 如下（原样使用）：\n${html}`);
  const msgs = await (await api(`/rooms/${main.id}/messages`, {}, cookie)).json() as any;
  const pageMsg = [...(msgs.messages ?? [])].reverse().find((m: any) => /^\[page:page-/.test(String(m.content)));
  check('① 房间出 [page:id] 卡片消息', !!pageMsg, `msg=「${String(pageMsg?.content ?? r1).slice(0, 90)}」`);

  const m = pageMsg ? /^\[page:(page-[\w-]+)\]\s*([\s\S]*)$/.exec(String(pageMsg.content)) : null;
  const pageId = m?.[1] ?? '';
  const url = (m?.[2] ?? '').split('｜')[1]?.trim() ?? '';

  // ② 独立 URL 验活（免鉴权；Pages CDN 有秒级传播，轮询最多 ~60s）
  if (url) {
    let resp: Response | null = null;
    let body = '';
    for (let i = 0; i < 6; i++) {
      resp = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      body = resp ? await resp.text().catch(() => '') : '';
      if (resp && resp.status === 200 && body.includes('Pages 托管验证')) break;
      await new Promise((r) => setTimeout(r, 12_000));
    }
    check('② pages.dev URL 可访问且内容正确', !!resp && resp.status === 200 && body.includes('Pages 托管验证'), `HTTP ${resp?.status} url=${url}`);
  } else {
    check('② pages.dev URL 可访问且内容正确', false, '未拿到 URL');
  }

  // ③ GET /pages/:id 管理面
  const pj = await (await api(`/pages/${pageId}`, {}, cookie)).json() as any;
  check('③ /pages/:id 可查', pj?.page?.url === url && pj?.page?.status === 'live', `status=${pj?.page?.status}`);

  // ④ 下架
  const un = await (await api(`/pages/${pageId}/unpublish`, { method: 'POST' }, cookie)).json() as any;
  const pj2 = await (await api(`/pages/${pageId}`, {}, cookie)).json() as any;
  check('④ 下架生效', un?.ok === true && pj2?.page?.status === 'removed', `ok=${un?.ok} status=${pj2?.page?.status}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('e2e 崩了:', e);
  process.exitCode = 1;
});
