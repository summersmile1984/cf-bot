/**
 * 主题 IA 端到端验收（topic-ia T6）：走线上 L1 真实链路（DeepSeek + 回复分层 + 路由）。
 * 场景：①主会话派事→自动成卷并告知 ②主会话追问→一句话+指路，详情入卷 ③主题内说话→就地全文 ④闲聊→主会话全文
 * 运行：npx tsx scripts/spike-topic-e2e.ts
 */
import { writeFileSync, appendFileSync } from 'node:fs';

// 网络直连不稳时走代理（HTTPS_PROXY=http://127.0.0.1:7897）
if (process.env.HTTPS_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
}

const BASE = 'http://localhost:4120';
// 专用干净账号：spike 判定框会被 OM 抽成事实且反思周期会从旧观测重建画像——
// 画像重置压不住，必须换新账号隔离（om-admin 已知边界）
const EMAIL = `topic-ia-e2e-${Date.now().toString(36)}@example.com`;
const PASSWORD = 'TopicIaVerify2026!';
const LOG = '/Users/summer/Documents/cf-bot/verify-shots/topic-e2e.log';

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
    signal: AbortSignal.timeout(120_000),
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

async function listRooms(cookie: string): Promise<any[]> {
  const r = await api('/rooms', {}, cookie);
  const j = (await r.json()) as { rooms: any[] };
  return j.rooms ?? [];
}

async function listMsgs(cookie: string, roomId: string): Promise<any[]> {
  const r = await api(`/rooms/${roomId}/messages`, {}, cookie);
  const j = (await r.json()) as { messages: any[] };
  return j.messages ?? [];
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  appendFileSync(LOG, `${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}\n`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail.slice(0, 120)}`);
};

async function main() {
  writeFileSync(LOG, `# topic-ia e2e ${new Date().toISOString()}\n`);
  // 注册（新账号）→ 登录；画像天然干净
  await api('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'topic-ia-e2e', email: EMAIL, password: PASSWORD }) });
  const s = await api('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('sign-in 没拿到 Set-Cookie');

  // 双保险：画像重置（spike 测试的判定框会被 OM 抽成「事实」污染系统块）
  await api('/om/profile', { method: 'PUT', body: JSON.stringify({ preferences: [], ongoing: [], facts: [] }) }, cookie);

  let rooms = await listRooms(cookie);
  const main = rooms.find((r) => r.is_main === 1);
  if (!main) throw new Error('没有主会话');
  const topicsBefore = new Set(rooms.filter((r) => r.kind === 'topic').map((r) => r.id));

  // ① 主会话派一件独一无二的新事 → 自动成卷 + 告知（唯一主题名保证必是新建）
  const uniq = `release-watch-${Date.now().toString(36)}`;
  const r1 = await sseReply(cookie, main.id, `帮我盯着 ${uniq} 库的发布动态，有大版本变化告诉我。`);
  rooms = await listRooms(cookie);
  const newTopic = rooms.find((r) => r.kind === 'topic' && !topicsBefore.has(r.id) && r.status === 'active' && r.name.includes(uniq.slice(0, 8)));
  check('① 自动成卷', !!newTopic, `reply=「${r1.slice(0, 60)}…」 topic=${newTopic ? `${newTopic.id}「${newTopic.name}」` : '无'}`);
  check('① 主会话有回应', r1.trim().length > 0, r1.slice(0, 80));
  if (!newTopic) return finish();

  // ② 主会话追问（粘性延续）→ 一句话+指路入主会话（查落库），详情入卷
  const r2 = await sseReply(cookie, main.id, '那先帮我确认下它现在是什么版本。');
  const topicMsgs = await listMsgs(cookie, newTopic.id);
  const mainMsgs = await listMsgs(cookie, main.id);
  const detailMsg = topicMsgs.find((m) => m.role === 'assistant' && m.content && !String(m.content).includes('详见主题'));
  const userCopy = topicMsgs.find((m) => m.role === 'user' && String(m.content).includes('版本'));
  const mainPointer = [...mainMsgs].reverse().find((m) => m.role === 'assistant');
  check('② 详情入卷', !!detailMsg, `卷内 assistant 消息 ${topicMsgs.filter((m) => m.role === 'assistant').length} 条`);
  check('② 用户消息抄送入卷', !!userCopy, userCopy ? '有' : '无');
  check('② 主会话指路（落库）', !!(mainPointer && /详见主题|主题「/.test(String(mainPointer.content))), `main=「${String(mainPointer?.content ?? '').slice(0, 80)}…」`);

  // ③ 主题内说话 → 就地全文回复（不得带分段格式）
  const r3 = await sseReply(cookie, newTopic.id, '顺便把它的更新日志也整理给我。');
  check('③ 主题内就地回', r3.trim().length > 0 && !/【主会话】|【详情】|详见主题/.test(r3), `topic-reply=「${r3.slice(0, 80)}…」`);

  // ④ 闲聊 → 主会话全文（不得吐路由 JSON）
  const r4 = await sseReply(cookie, main.id, '今天心情不错');
  check('④ 闲聊落主会话', r4.trim().length > 0 && !/详见主题|route|【主会话】/.test(r4), `main=「${r4.slice(0, 80)}…」`);

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('e2e 崩了:', e);
  process.exitCode = 1;
});
