/**
 * Web Push（notifications T4）：VAPID JWT（ES256）+ 空载荷推送（RFC 8030）。
 * 空载荷设计：push 到达后 Service Worker 拉取最新通知展示——免去 aes128gcm 载荷加密；
 * 代价是展示依赖一次同源请求（会话 cookie），服务端 404/410 订阅即清理。
 * 密钥：VAPID_PUBLIC_KEY（vars，给 PushManager 订阅）+ VAPID_PRIVATE_KEY（secret，签名）。
 */

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function ensurePushTables(db: any): Promise<void> {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
}

export async function savePushSubscription(db: any, userId: string, sub: { endpoint: string; keys?: { p256dh?: string; auth?: string } }): Promise<{ ok: boolean; reason?: string }> {
  await ensurePushTables(db);
  const endpoint = String(sub?.endpoint ?? '').slice(0, 2000);
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (!endpoint || !p256dh || !auth) return { ok: false, reason: 'bad subscription' };
  await db
    .prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .bind(`ps-${crypto.randomUUID()}`, userId, endpoint, p256dh, auth, Date.now())
    .run();
  return { ok: true };
}

export async function removePushSubscription(db: any, userId: string, endpoint: string): Promise<void> {
  await ensurePushTables(db);
  await db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').bind(userId, String(endpoint ?? '').slice(0, 2000)).run().catch(() => null);
}

/** VAPID JWT（ES256）：header/payload base64url + WebCrypto 签名（raw R||S 即 JOSE 格式） */
async function vapidJwt(E: any, aud: string): Promise<string> {
  const priv = String((E as any).VAPID_PRIVATE_KEY ?? '');
  const pub = String((E as any).VAPID_PUBLIC_KEY ?? '');
  if (!priv || !pub) throw new Error('VAPID keys missing');
  const der = Uint8Array.from(atob(priv.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:postmaster@${new URL(aud).hostname}` })));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return `${header}.${payload}.${b64url(sig)}`;
}

/** 给单个订阅推一条（空载荷）：2xx 成功；404/410 视为订阅失效返回 'gone' */
async function pushOne(E: any, row: any): Promise<'ok' | 'gone' | 'err'> {
  try {
    const aud = new URL(String(row.endpoint)).origin;
    const jwt = await vapidJwt(E, aud);
    const res = await fetch(String(row.endpoint), {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${String((E as any).VAPID_PUBLIC_KEY)}`,
        ttl: '86400',
        urgency: 'normal',
        'content-length': '0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'err';
  } catch {
    return 'err';
  }
}

/** 给用户的所有订阅推送；顺手清理失效订阅。无订阅/未配 VAPID = 静默跳过。 */
export async function pushToUser(db: any, E: any, userId: string): Promise<void> {
  try {
    if (!(E as any)?.VAPID_PRIVATE_KEY || !(E as any)?.VAPID_PUBLIC_KEY) return;
    await ensurePushTables(db);
    const { results } = await db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=? LIMIT 20').bind(userId).all();
    for (const row of results ?? []) {
      const r = await pushOne(E, row);
      if (r === 'gone') await db.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(row.id).run().catch(() => null);
    }
  } catch (e: any) {
    console.log('[push] dispatch failed', String(e?.message ?? e).slice(0, 120));
  }
}
