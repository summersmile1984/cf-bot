// 密钥保管（schedules-secrets spec S2.3，secret-pipeline 更新存储面）：密钥本体托管 **Cloudflare Workers Secrets**
// （动态 env 键，加密存储；CF Secrets Store 明文只进不回、绑定是部署期静态的，动态条目读不回——已弃用为值存储）。
// D1 vault_meta 只存元数据——不落任何明文/密文。写/删经 Workers REST API（CLOUDFLARE_API_KEY），读回经运行时 env[name]。
// TTL 语义：expires_at 过期即视为不存在（HITL 短时 vault 的地基）。
const CF_API = 'https://api.cloudflare.com/client/v4';
const WORKER_SCRIPT = 'mastra-l1';

export type VaultMeta = {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  secret_id: string;
  secret_name: string;
  created_at: number;
  expires_at: number | null;
  created_by: string | null;
};

const LIMITS = { name: 100, kind: 40, value: 8000 };

export async function ensureVaultTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS vault_meta (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        secret_id TEXT NOT NULL, secret_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER, created_by TEXT)`,
    )
    .run();
}

function api(env: any, path: string, init?: RequestInit) {
  return fetch(`${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_KEY}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

export function vaultOut(r: any) {
  return {
    id: r.id, name: r.name, kind: r.kind, secret_name: r.secret_name,
    created_at: r.created_at, expires_at: r.expires_at ?? null,
    expired: r.expires_at ? Number(r.expires_at) < Date.now() : false,
  };
}

export async function createVaultEntry(env: any, db: any, userId: string, input: any, createdBy: string): Promise<VaultMeta | { error: string }> {
  const name = String(input?.name ?? '').trim().slice(0, LIMITS.name);
  const value = String(input?.value ?? '');
  const kind = String(input?.kind ?? 'generic').trim().slice(0, LIMITS.kind) || 'generic';
  const ttl = Number(input?.ttl ?? 0);
  if (!name) return { error: 'name required' };
  if (!value) return { error: 'value required' };
  if (value.length > LIMITS.value) return { error: 'value too long' };
  const id = `vault-${crypto.randomUUID()}`;
  const secretName = `vault__${userId}__${id}`;
  let created: any;
  try {
    const res = await api(env, `/workers/scripts/${WORKER_SCRIPT}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name: secretName, text: value, type: 'secret_text' }),
    });
    const body: any = await res.json().catch(() => ({}));
    created = body?.result;
    if (!body?.success || !created?.name) return { error: `worker-secret create failed: ${JSON.stringify(body?.errors ?? []).slice(0, 160)}` };
  } catch (e: any) {
    return { error: `worker-secret unreachable: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  const row: VaultMeta = {
    id, user_id: userId, name, kind,
    secret_id: String(created.name), secret_name: secretName,
    created_at: Date.now(), expires_at: ttl > 0 ? Date.now() + ttl * 1000 : null,
    created_by: createdBy,
  };
  try {
    await db
      .prepare('INSERT INTO vault_meta (id,user_id,name,kind,secret_id,secret_name,created_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(row.id, row.user_id, row.name, row.kind, row.secret_id, row.secret_name, row.created_at, row.expires_at, row.created_by)
      .run();
  } catch (e: any) {
    // D1 写失败则回滚 Worker secret，避免孤儿密钥
    try { await api(env, `/workers/scripts/${WORKER_SCRIPT}/secrets/${encodeURIComponent(secretName)}?url_encoded=true`, { method: 'DELETE' }); } catch {}
    return { error: `vault_meta write failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  return row;
}

export async function listVaultEntries(db: any, userId: string): Promise<VaultMeta[]> {
  const { results } = await db.prepare('SELECT * FROM vault_meta WHERE user_id=? ORDER BY created_at DESC').bind(userId).all();
  const now = Date.now();
  return ((results ?? []) as VaultMeta[]).filter((r) => !r.expires_at || Number(r.expires_at) >= now);
}

export async function deleteVaultEntry(env: any, db: any, userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return { ok: false, error: 'not found' };
  try {
    // fetch 不会因 HTTP 错误抛错——必须校验响应，否则 CF 删失败仍删行会留下孤儿密钥
    const res = await api(env, `/workers/scripts/${WORKER_SCRIPT}/secrets/${encodeURIComponent(String(row.secret_name))}?url_encoded=true`, { method: 'DELETE' });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) {
      return { ok: false, error: `worker-secret delete failed: ${JSON.stringify(body?.errors ?? body?.errors ?? []).slice(0, 140)}` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
  await db.prepare('DELETE FROM vault_meta WHERE id=?').bind(id).run();
  return { ok: true };
}

/** 读回明文（secret-pipeline）：Worker Secrets 是运行时 env 键——不经 API、不走日志。过期即视为不存在。 */
export async function getVaultValue(env: any, db: any, id: string): Promise<{ value: string; secret_name: string } | null> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=?').bind(id).first();
  if (!row) return null;
  if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
  const value = (env as any)[String(row.secret_name)];
  if (typeof value !== 'string' || !value) return null;
  return { value, secret_name: String(row.secret_name) };
}

/** 单条读取（S2.3）：过期即视为不存在。 */
export async function getVaultEntry(db: any, userId: string, id: string): Promise<VaultMeta | null> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return null;
  if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
  return row as VaultMeta;
}

/** 过期清扫（并入 schedules cron tick）：过期条目连密钥一起删。 */
export async function purgeExpiredVault(env: any, db: any): Promise<number> {
  const { results } = await db.prepare('SELECT * FROM vault_meta WHERE expires_at IS NOT NULL AND expires_at < ?').bind(Date.now()).all();
  let n = 0;
  for (const r of (results ?? []) as VaultMeta[]) {
    if ((await deleteVaultEntry(env, db, r.user_id, r.id)).ok) n++;
  }
  return n;
}

// ---------- OAuth 长期凭证（mcp-library S2.2） ----------
// kind='oauth_credential' 的 vault 值是 JSON 包：{access_token, refresh_token, expires_at, client_id,
// client_secret?, token_url, scopes?}。凭证条目本身 vault_meta.expires_at=null 持久（purge 不扫）；
// 包内 expires_at 是 access_token 的过期时间。取用时服务端自动刷新，refresh_token 永不出 vault，
// 只有短命 access_token 下发给 L2。

export type OAuthCredential = {
  access_token: string;
  refresh_token?: string;
  /** access_token 过期时间（epoch ms） */
  expires_at?: number;
  client_id: string;
  client_secret?: string;
  token_url: string;
  scopes?: string[];
  /** 账号标识（email/登录名），面板展示用，非秘钥 */
  account?: string;
};

/** 写回 Worker secret 值（token 刷新后的新包）。 */
async function putSecretValue(env: any, secretName: string, value: string): Promise<void> {
  const res = await api(env, `/workers/scripts/${WORKER_SCRIPT}/secrets`, {
    method: 'PUT',
    body: JSON.stringify({ name: secretName, text: value, type: 'secret_text' }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!body?.success) throw new Error(`worker-secret update failed: ${JSON.stringify(body?.errors ?? []).slice(0, 140)}`);
}

/** OAuth 凭证取用：过期前 60s 视为过期，用 refresh_token 换新（服务端自动刷新）。 */
export async function getOAuthAccessToken(env: any, db: any, id: string): Promise<{ value: string; secret_name: string; account?: string } | { error: string }> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=?').bind(id).first();
  if (!row) return { error: 'not found' };
  const raw = (env as any)[String(row.secret_name)];
  if (typeof raw !== 'string' || !raw) return { error: 'credential missing' };
  let cred: OAuthCredential;
  try { cred = JSON.parse(raw); } catch { return { error: 'credential corrupt' }; }
  const now = Date.now();
  // 包内无 expires_at：有 refresh_token 就保守刷新；没有则只能当长期 token 用（评审 MINOR：不能一律判过期）
  const expiring = cred.expires_at ? Number(cred.expires_at) < now + 60_000 : Boolean(cred.refresh_token);
  if (!expiring) return { value: cred.access_token, secret_name: String(row.secret_name), account: cred.account };
  if (!cred.refresh_token || !cred.token_url) return { error: 'token expired and no refresh_token' };
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
      client_id: String(cred.client_id ?? ''),
    });
    if (cred.client_secret) params.set('client_secret', cred.client_secret);
    const res = await fetch(cred.token_url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const tok: any = await res.json().catch(() => ({}));
    if (!res.ok || !tok?.access_token) return { error: `refresh failed: ${res.status} ${String(tok?.error ?? '').slice(0, 80)}` };
    const next: OAuthCredential = {
      ...cred,
      access_token: String(tok.access_token),
      refresh_token: tok.refresh_token ? String(tok.refresh_token) : cred.refresh_token,
      expires_at: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : undefined,
    };
    await putSecretValue(env, String(row.secret_name), JSON.stringify(next));
    return { value: next.access_token, secret_name: String(row.secret_name), account: next.account };
  } catch (e: any) {
    return { error: `refresh error: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** OAuth 凭证入库（value 是 JSON 包；kind 固定 oauth_credential；ttl=0 持久）。 */
export async function createOAuthCredential(env: any, db: any, userId: string, cred: OAuthCredential, createdBy: string): Promise<VaultMeta | { error: string }> {
  if (!cred?.access_token || !cred.client_id || !cred.token_url) return { error: 'access_token/client_id/token_url required' };
  return createVaultEntry(env, db, userId, {
    name: String(cred.account ?? cred.token_url).slice(0, 100),
    kind: 'oauth_credential',
    value: JSON.stringify(cred),
    ttl: 0,
  }, createdBy);
}
