/**
 * Web 端 MCP 连接（web-mcp S2.1）：连接记录（D1）+ OAuth state + 受管注册表条目生成。
 * 明文令牌只存 vault（vault_id 指向 oauth_credential/api_key）；本表无任何凭证值。
 */
import { createOAuthCredential, createVaultEntry, deleteVaultEntry, type OAuthCredential } from './vault';

export type McpConnection = {
  id: string;
  user_id: string;
  catalog_id: string;
  name: string;
  transport_json: string;
  vault_id: string | null;
  account: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};

export type OAuthStateRow = {
  state: string;
  user_id: string;
  catalog_id: string;
  client_id: string;
  client_secret: string | null;
  code_verifier: string;
  redirect_back: string | null;
  created_at: number;
};

export async function ensureMcpTables(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mcp_connections (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, catalog_id TEXT NOT NULL, name TEXT NOT NULL,
        transport_json TEXT NOT NULL, vault_id TEXT, account TEXT, status TEXT NOT NULL DEFAULT 'connected',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY, user_id TEXT NOT NULL, catalog_id TEXT NOT NULL,
        client_id TEXT NOT NULL, client_secret TEXT, code_verifier TEXT NOT NULL,
        redirect_back TEXT, created_at INTEGER NOT NULL)`,
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_conn_user ON mcp_connections(user_id)').run();
}

export function connOut(r: any) {
  return {
    id: r.id, catalogId: r.catalog_id, name: r.name, account: r.account ?? null,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    transport: (() => { try { return JSON.parse(r.transport_json); } catch { return null; } })(),
  };
}

/** userId=null → 全部（设备令牌场景，设备级根信任）。 */
export async function listConnections(db: any, userId: string | null): Promise<McpConnection[]> {
  const { results } = userId
    ? await db.prepare('SELECT * FROM mcp_connections WHERE user_id=? ORDER BY created_at DESC').bind(userId).all()
    : await db.prepare('SELECT * FROM mcp_connections ORDER BY created_at DESC').all();
  return (results ?? []) as McpConnection[];
}

export async function getConnection(db: any, id: string): Promise<McpConnection | null> {
  const row: any = await db.prepare('SELECT * FROM mcp_connections WHERE id=?').bind(id).first();
  return (row as McpConnection) ?? null;
}

export async function upsertConnection(db: any, userId: string, input: {
  catalogId: string; name: string; transport: unknown; vaultId?: string | null; account?: string | null;
}): Promise<McpConnection> {
  const id = `conn-${crypto.randomUUID()}`;
  const now = Date.now();
  await db
    .prepare('INSERT INTO mcp_connections (id,user_id,catalog_id,name,transport_json,vault_id,account,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, userId, String(input.catalogId).slice(0, 40), String(input.name).slice(0, 100), JSON.stringify(input.transport ?? {}), input.vaultId ?? null, input.account ?? null, 'connected', now, now)
    .run();
  return (await getConnection(db, id))!;
}

export async function deleteConnection(env: any, db: any, userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const row: any = await db.prepare('SELECT * FROM mcp_connections WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return { ok: false, error: 'not found' };
  if (row.vault_id) await deleteVaultEntry(env, db, userId, String(row.vault_id)).catch(() => {});
  await db.prepare('DELETE FROM mcp_connections WHERE id=?').bind(id).run();
  return { ok: true };
}

export async function saveOAuthState(db: any, row: OAuthStateRow): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO oauth_states (state,user_id,catalog_id,client_id,client_secret,code_verifier,redirect_back,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(row.state, row.user_id, row.catalog_id, row.client_id, row.client_secret, row.code_verifier, row.redirect_back, row.created_at)
    .run();
}

/** 取出即删（一次性 state，防重放）；过期（>10min）视为无效。 */
export async function takeOAuthState(db: any, state: string): Promise<OAuthStateRow | null> {
  const row: any = await db.prepare('SELECT * FROM oauth_states WHERE state=?').bind(state).first();
  if (!row) return null;
  await db.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
  if (Date.now() - Number(row.created_at) > 5 * 60_000) return null;
  return row as OAuthStateRow;
}

/** 清理过期 state（并入 schedules cron 或惰性调用）。 */
export async function purgeOAuthStates(db: any): Promise<void> {
  await db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(Date.now() - 5 * 60_000).run();
}

/** 从目录条目 transport + 凭证引用生成 L2 受管注册表条目（web-mcp S2.3）。 */
export function managedRegistryEntry(catalogEntry: any, vaultId: string, name: string, account?: string | null): Record<string, unknown> {
  const t = catalogEntry?.transport ?? {};
  const auth = catalogEntry?.auth ?? {};
  const note = `managed:${catalogEntry?.id}${account ? ` account:${account}` : ''}`;
  if (t.type === 'stdio') {
    const env: Record<string, string> = {};
    if (auth.type === 'api_key') env[String(auth.apiKeyName ?? 'API_KEY')] = `secret:${vaultId}`;
    return { name, command: t.command, args: t.args ?? [], env, note };
  }
  const out: Record<string, unknown> = { name, url: t.url, note };
  // 免认证 remote 不发空 Bearer（评审 MINOR：'Bearer secret:' 会被令牌校验拒掉）
  if (vaultId) out.headers = { Authorization: `Bearer secret:${vaultId}` };
  return out;
}

/** OAuth 凭证入库（走 vault 校验）。 */
export async function storeOAuthCredential(env: any, db: any, userId: string, cred: OAuthCredential, createdBy: string): Promise<{ id: string } | { error: string }> {
  const r = await createOAuthCredential(env, db, userId, cred, createdBy);
  return (r as any).error ? { error: (r as any).error } : { id: (r as any).id };
}

/** api_key 入库。 */
export async function storeApiKey(env: any, db: any, userId: string, key: string, name: string, createdBy: string): Promise<{ id: string } | { error: string }> {
  const r = await createVaultEntry(env, db, userId, { name, kind: 'api_key', value: key, ttl: 0 }, createdBy);
  return (r as any).error ? { error: (r as any).error } : { id: (r as any).id };
}

/** WebCrypto PKCE（Worker 侧无 node:crypto；S256）。 */
export async function genPkceWeb(): Promise<{ verifier: string; challenge: string; state: string }> {
  const b64url = (buf: ArrayBuffer | Uint8Array) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(rnd);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(digest);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

/** 授权 URL 拼装（目录 auth + PKCE）。 */
export function buildAuthUrlWeb(auth: any, clientId: string, redirectUri: string, pkce: { challenge: string; state: string }): string {
  const u = new URL(String(auth.authorizationUrl));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', pkce.state);
  if (Array.isArray(auth.scopes) && auth.scopes.length) u.searchParams.set('scope', auth.scopes.join(' '));
  for (const [k, v] of Object.entries(auth.extraAuthParams ?? {})) u.searchParams.set(k, String(v));
  return u.toString();
}

/** 回跳地址白名单（防开放重定向）：只许同源相对路径（评审 MAJOR：绝对 URL 的 pathname='/' 可绕过）。 */
export function safeRedirectBack(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s;
}
