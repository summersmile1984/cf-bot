/**
 * Pages 托管（pages-hosting S2.1/S2.2）：bot 产出的 HTML 经 Cloudflare Pages Direct Upload
 * 发布为独立可分享 URL（https://<short_id>.cf-bot-pages.pages.dev）。
 * 四步上传：upload-token(JWT) → check-missing(sha256) → assets/upload(KV bulk 形状) → deployments(manifest)。
 * 鉴权复用 vault 同款：Bearer E.CLOUDFLARE_API_KEY + E.CLOUDFLARE_ACCOUNT_ID。
 * pages.dev 与应用不同源——bot 生成 HTML 的 XSS 隔离由托管域天然解决。
 */

export const PAGES_PROJECT = 'cf-bot-pages';

export type PageRow = {
  id: string;
  task_id: string | null;
  room_id: string | null;
  created_by: string | null;
  title: string | null;
  deployment_id: string | null;
  short_id: string | null;
  url: string | null;
  status: string;
  created_at: number;
};

export type PagesEnv = {
  CF_PAGES_TOKEN?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  DB: any;
};

import { chargeQuota, refundQuota, PUBLISH_POINTS } from '../mastra/quota';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(env: PagesEnv, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_PAGES_TOKEN || env.CLOUDFLARE_API_KEY}`,
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  return r.json().catch(() => ({}));
}

/** MD5（Pages 资产 key 必须是内容 MD5——SHA-256 会部署成功但 500，实测）。
 * Workers crypto.subtle 无 MD5，用紧凑纯实现（RFC 1321）。 */
function md5Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  const ml = bytes.length;
  const withPad = new Uint8Array(((ml + 8) >> 6 << 6) + 64);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, ml * 8, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = [a0, b0, c0, d0];
  return out.map((w) => [0, 1, 2, 3].map((k) => ((w >>> (k * 8)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

export async function ensurePagesTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY, task_id TEXT, room_id TEXT, created_by TEXT, title TEXT,
        deployment_id TEXT, short_id TEXT, url TEXT, status TEXT NOT NULL DEFAULT 'live', created_at INTEGER NOT NULL)`,
    )
    .run()
    .catch(() => null);
}

/** Direct Upload 一个 HTML 页面到 Pages 项目，返回 deployment 的独立 URL。 */
export async function uploadPageToPages(env: PagesEnv, html: string, title: string): Promise<{ deploymentId: string; shortId: string; url: string } | null> {
  try {
    // 1) upload-token（JWT，仅用于 assets 上传）
    const tok = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/upload-token`, { method: 'GET' });
    const jwt = tok?.result?.jwt ?? tok?.result;
    if (!jwt || typeof jwt !== 'string') {
      console.log('[pages] upload-token failed', JSON.stringify(tok?.errors ?? tok).slice(0, 160));
      return null;
    }
    // 2) 哈希去重（MD5，key=hash）
    const hash = md5Hex(html);
    await fetch(`${CF_API}/pages/assets/check-missing`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: [hash] }),
    }).catch(() => null);
    // 3) 上传（KV bulk-write 形状）
    const up = await fetch(`${CF_API}/pages/assets/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ base64: true, key: hash, metadata: { contentType: 'text/html;charset=utf-8' }, value: btoa(String.fromCharCode(...new TextEncoder().encode(html))) }]),
    });
    const upJ: any = await up.json().catch(() => ({}));
    if (!upJ?.success) {
      console.log('[pages] asset upload failed', up.status, JSON.stringify(upJ?.errors ?? '').slice(0, 160));
      return null;
    }
    // 4) 建 deployment（manifest: path → hash）
    const form = new FormData();
    form.set('manifest', JSON.stringify({ '/index.html': hash }));
    const dep = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/deployments`, { method: 'POST', body: form });
    const res = dep?.result;
    if (!dep?.success || !res?.url) {
      console.log('[pages] deployment failed', JSON.stringify(dep?.errors ?? dep).slice(0, 200));
      return null;
    }
    return { deploymentId: String(res.id), shortId: String(res.short_id ?? ''), url: String(res.url) };
  } catch (e: any) {
    console.log('[pages] upload error', String(e?.message ?? e).slice(0, 160));
    return null;
  }
}

/** 发布一页：额度扣减（硬门）→ Direct Upload → 落 pages 行；上传失败退补。返回行（含 url）。 */
export async function publishPage(
  env: PagesEnv,
  opts: { html: string; title: string; taskId?: string | null; roomId?: string | null; userId?: string | null },
): Promise<PageRow | null> {
  await ensurePagesTable(env.DB);
  const id = `page-${crypto.randomUUID().slice(0, 8)}`;
  if (opts.userId) {
    const ch = await chargeQuota(env.DB, opts.userId, { kind: 'pool', units: PUBLISH_POINTS, idempotencyKey: `page:${id}`, detail: '页面发布' });
    if (!ch.ok) {
      console.log('[pages] quota rejected', ch.reason);
      return null;
    }
  }
  const uploaded = await uploadPageToPages(env, opts.html, opts.title);
  if (!uploaded) {
    if (opts.userId) await refundQuota(env.DB, opts.userId, `page:${id}`, PUBLISH_POINTS);
    return null;
  }
  await env.DB
    .prepare('INSERT INTO pages (id,task_id,room_id,created_by,title,deployment_id,short_id,url,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, opts.taskId ?? null, opts.roomId ?? null, opts.userId ?? null, opts.title.slice(0, 120), uploaded.deploymentId, uploaded.shortId, uploaded.url, 'live', Date.now())
    .run();
  return {
    id, task_id: opts.taskId ?? null, room_id: opts.roomId ?? null, created_by: opts.userId ?? null,
    title: opts.title.slice(0, 120), deployment_id: uploaded.deploymentId, short_id: uploaded.shortId,
    url: uploaded.url, status: 'live', created_at: Date.now(),
  };
}

export async function getPage(db: any, id: string): Promise<PageRow | null> {
  await ensurePagesTable(db);
  const row: any = await db.prepare('SELECT * FROM pages WHERE id=?').bind(id).first();
  return (row as PageRow) ?? null;
}

/** 下架：DELETE deployment（尽力而为）+ 标记 removed。 */
export async function unpublishPage(env: PagesEnv, id: string): Promise<boolean> {
  const row = await getPage(env.DB, id);
  if (!row || row.status !== 'live') return false;
  if (row.deployment_id) {
    const del = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/deployments/${row.deployment_id}`, { method: 'DELETE' }).catch(() => null);
    // 部分 API 版本无 delete-deployment：失败不阻标记（卡片撤下 + 状态记录为准）
    if (del && !del.success) console.log('[pages] deployment delete unsupported/failed', JSON.stringify(del.errors ?? '').slice(0, 120));
  }
  await env.DB.prepare("UPDATE pages SET status='removed' WHERE id=?").bind(id).run();
  return true;
}
