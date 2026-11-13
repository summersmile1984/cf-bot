/**
 * 主题路由判定 — 提示词准确率验证（DeepSeek，走线上 L1 真实对话链路）
 *
 * 验证什么：L1 的路由判定是 LLM 判断（deepseek-chat）。本脚本把【路由提示词】
 * 作为判定框发给 L1，用带期望答案的用例集测准确率，输出混淆明细。
 *
 * 提示词版本：PROMPT_V3（v2 判断 18/18 但示例带偏格式；v3 修示例一致性）
 * 运行：npx tsx scripts/spike-topic-routing.ts
 */
import { writeFileSync, appendFileSync } from 'node:fs';

const BASE = 'http://localhost:4120';
const EMAIL = 'topic-ia-verify@example.com';
const PASSWORD = 'TopicIaVerify2026!';
const LOG = '/Users/summer/Documents/cf-bot/verify-shots/topic-routing-v3.log';

// ---------------- 路由提示词 v3 ----------------
// v1 → v2 变更：①route 必须原样用目录 id（修格式漂移）②省略式追问明确归当前主题（修 #13）
const PROMPT_V3 = `【主题路由判定】你是秘书的路由模块。根据用户消息决定它归属的会话位置。只做判定，不派发任务、不执行、不聊天。

主题目录（活跃）：
- topic-renovation「装修」：厨房翻新跟进
- topic-travel「旅行计划」：国庆出行
最近归档：报销（Q3 已结）
当前正在聊的主题：{STICKY}

判定规则（按优先级从高到低）：
1. 显式指名主题（如“装修那边”“回到旅行计划”）→ route=topic:<id>
2. 消息与「当前正在聊的主题」是同一件事的延续、追问或补充材料 → route=topic:<id>。省略式追问（“那…呢”“再…一下”“还是用…”）看语境承接，字面没有主题词也算当前主题
3. 消息内容明确属于某个主题的事项 → route=topic:<id>
4. 是一件需要持续跟进、有产出物或要派活的新事情，且与任何现有主题无关 → route=new:<简短名字>
5. 闲聊、简单问答、询问全局状态、要求跨主题汇总、对多个主题同时下指令 → route=main_only
铁律：
- route 中的 topic id 必须原样使用目录里的 id（如 topic-renovation），不得缩写或改写
- 一句话消息、含糊消息、拿不准的 → main_only，绝不硬造新主题
- 明确要求“不用单开/就在这儿说” → main_only
- 归档主题里的旧事若只是问一般性问题 → main_only
只输出一个 JSON 对象，例如：{"route":"topic:topic-renovation","confidence":"high"}`;

type Case = { n: number; sticky: string; text: string; expect: string; note: string };

const CASES: Case[] = [
  // A. 明确匹配现有主题
  { n: 1, sticky: '无', text: '装修的报价单到了吗', expect: 'topic:topic-renovation', note: 'A 匹配' },
  { n: 2, sticky: '无', text: '厨房的瓷砖帮我挑一下，预算别超两万', expect: 'topic:topic-renovation', note: 'A 匹配' },
  { n: 3, sticky: '无', text: '国庆酒店订了吗', expect: 'topic:topic-travel', note: 'A 匹配' },
  { n: 4, sticky: '无', text: '帮我看看去西安的高铁票', expect: 'topic:topic-travel', note: 'A 匹配' },
  { n: 5, sticky: '无', text: '水电改造那家工人的联系方式发我', expect: 'topic:topic-renovation', note: 'A 匹配' },
  // B. 新建主题
  { n: 6, sticky: '无', text: '帮我盯着 deepseek-api 库的 release notes，有大版本更新告诉我', expect: 'new:*', note: 'B 新建' },
  { n: 7, sticky: '无', text: '下个月要给客户出一版年度服务报价方案，帮我准备材料', expect: 'new:*', note: 'B 新建' },
  { n: 8, sticky: '无', text: '我驾照下个月到期，帮我记着去换证', expect: 'new:*', note: 'B 新建' },
  // C. 主会话
  { n: 9, sticky: '无', text: '今天心情不错', expect: 'main_only', note: 'C 闲聊' },
  { n: 10, sticky: '无', text: '你现在在忙什么', expect: 'main_only', note: 'C 状态' },
  { n: 11, sticky: '无', text: '装修和旅行现在都什么进展，汇总一下', expect: 'main_only', note: 'C 跨主题汇总' },
  { n: 12, sticky: '无', text: '好的谢谢', expect: 'main_only', note: 'C 闲聊' },
  // D. 粘性/延续
  { n: 13, sticky: '装修', text: '那预算再砍一砍呢', expect: 'topic:topic-renovation', note: 'D 粘性' },
  { n: 14, sticky: '装修', text: '阳台也想顺便弄一下', expect: 'topic:topic-renovation', note: 'D 粘性扩展' },
  // E. 边界/易错
  { n: 15, sticky: '无', text: '报销的事怎么弄？', expect: 'main_only', note: 'E 归档旧事' },
  { n: 16, sticky: '无', text: '就在这儿说吧，不用单开——订机票记得用公司邮箱', expect: 'main_only', note: 'E 显式主会话' },
  { n: 17, sticky: '无', text: '报价呢？', expect: 'main_only', note: 'E 含糊短句' },
  { n: 18, sticky: '无', text: '把装修和旅行的花费都列一下', expect: 'main_only', note: 'E 跨主题' },
];

// ---------------- 线上 L1 客户端 ----------------
async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      // better-auth 的 POST 需要同源 origin/referer，否则 403
      origin: BASE,
      referer: BASE + '/',
      // better-auth 会话走 cookie（Set-Cookie 原值，含签名），不走 Bearer
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  return r;
}

async function sseReply(cookie: string, roomId: string, text: string): Promise<string> {
  const r = await api(
    `/rooms/${roomId}/messages`,
    { method: 'POST', body: JSON.stringify({ text }), headers: { accept: 'text/event-stream' } },
    cookie,
  );
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

function extractRoute(reply: string): { route: string; confidence: string } | null {
  const m = reply.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.route === 'string') return { route: j.route, confidence: String(j.confidence ?? '') };
  } catch {}
  return null;
}

function score(expect: string, got: string): boolean {
  if (expect.endsWith('*')) return got.startsWith(expect.slice(0, -1));
  return got === expect;
}

// ---------------- 主流程 ----------------
async function main() {
  writeFileSync(LOG, `# topic routing spike v1 ${new Date().toISOString()}\n`);
  const s = await fetch(BASE + '/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, referer: BASE + '/' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!s.ok) throw new Error(`sign-in HTTP ${s.status}`);
  // better-auth 会话 cookie 是 token.签名 形态，必须从 Set-Cookie 原样取
  const setCookie = s.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('sign-in 没拿到 Set-Cookie');

  const rows: { n: number; ok: boolean; expect: string; got: string; conf: string; note: string }[] = [];
  for (const c of CASES) {
    const frame = PROMPT_V3.replace('{STICKY}', c.sticky) + `\n\n用户消息：「${c.text}」`;
    // 每用例独立房间，避免历史污染判定
    const roomRes = await api('/rooms', { method: 'POST', body: JSON.stringify({ name: `rt-${c.n}` }) }, cookie);
    const { room } = (await roomRes.json()) as { room: { id: string } };
    let got = 'PARSE_FAIL';
    let conf = '';
    let raw = '';
    for (let attempt = 0; attempt < 2 && got === 'PARSE_FAIL'; attempt++) {
      try {
        raw = await sseReply(cookie, room.id, frame);
        const parsed = extractRoute(raw);
        if (parsed) {
          got = parsed.route;
          conf = parsed.confidence;
        }
      } catch (e) {
        raw = `ERR ${String(e)}`;
      }
    }
    const ok = score(c.expect, got);
    rows.push({ n: c.n, ok, expect: c.expect, got, conf, note: c.note });
    appendFileSync(LOG, `## case ${c.n} [${c.note}] sticky=${c.sticky}\nmsg: ${c.text}\nexpect: ${c.expect} got: ${got} conf: ${conf} ${ok ? 'OK' : 'MISS'}\nraw: ${raw.slice(0, 600)}\n\n`);
    console.log(`${ok ? 'PASS' : 'MISS'}  #${String(c.n).padStart(2)} [${c.note}] expect=${c.expect} got=${got} (${conf})`);
  }

  const total = rows.length;
  const passed = rows.filter((r) => r.ok).length;
  console.log(`\n准确率：${passed}/${total} = ${(passed / total * 100).toFixed(1)}%`);
  for (const group of ['A 匹配', 'B 新建', 'C 闲聊', 'D 粘性', 'E 显式主会话', 'E 归档旧事', 'E 含糊短句', 'E 跨主题', 'C 跨主题汇总', 'C 状态', 'D 粘性扩展']) {
    const g = rows.filter((r) => r.note === group);
    if (g.length) console.log(`  ${group}: ${g.filter((r) => r.ok).length}/${g.length}`);
  }
  const misses = rows.filter((r) => !r.ok);
  if (misses.length) {
    console.log('\n错例：');
    for (const m of misses) console.log(`  #${m.n} [${m.note}] expect=${m.expect} got=${m.got}`);
  }
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
