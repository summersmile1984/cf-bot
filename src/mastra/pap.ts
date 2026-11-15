/**
 * PAP（Poppy 1.0）客户端 T1（pap-client S2.2）：发现 + agent 身份（CIMD/JWKS）+ Poppy-Session JWT 签发。
 * - agent 身份密钥：PAP_AGENT_KEY（Worker secret，PKCS8 base64url，ES256）；kid = RFC 7638 JWK 拇指印
 * - 委托链（§5.2 Delegated keys）：jwks_uri 密钥签 delegation（≤24h，只带 cnf.jwk 不带用户/公司），
 *   委托密钥签 Session JWT（typ poppy-session+jwt，按请求新鲜签发，htm/htu 绑请求，ath 绑 access token）
 * - 发现（§3）：/.well-known/poppy.json——HTTPS-only、终路径校验、organization.domain 绑定、防 SSRF
 * 口径对齐 AGENTS §5；Session JWT 只发给 poppy.json 声明的目的域（本模块只产头值，发送策略在调用方）。
 */

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** RFC 7638 JWK 拇指印：按 kty 取必填成员、键名字典序、无空白 JSON 的 SHA-256 */
export async function jwkThumbprint(jwk: { kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }): Promise<string> {
  let req: Record<string, string>;
  if (jwk.kty === 'EC') req = { crv: String(jwk.crv), kty: 'EC', x: String(jwk.x), y: String(jwk.y) };
  else if (jwk.kty === 'RSA') req = { e: String(jwk.e), kty: 'RSA', n: String(jwk.n) };
  else throw new Error(`unsupported kty ${jwk.kty}`);
  const canonical = JSON.stringify(Object.keys(req).sort().reduce<Record<string, string>>((o, k) => (o[k] = req[k], o), {}));
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

async function importAgentKey(E: any): Promise<{ key: CryptoKey; kid: string; pub: { kty: 'EC'; crv: 'P-256'; x: string; y: string } }> {
  const priv = String((E as any).PAP_AGENT_KEY ?? '');
  if (!priv) throw new Error('PAP_AGENT_KEY missing');
  const der = Uint8Array.from(atob(priv.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // 由私钥推导公钥：再生成不了，只能从 JWK 导——用同一 seed 无从反推；改为接受 PAP_AGENT_PUB 环境或由密钥对推导
  const pairPub = await derivePubFromPriv(der);
  const pub = { kty: 'EC' as const, crv: 'P-256' as const, x: pairPub.x, y: pairPub.y };
  return { key, kid: await jwkThumbprint(pub), pub };
}

/** 从 PKCS8 私钥导出对应公钥 JWK（EC P-256）：import 成可导出再导出 pub */
async function derivePubFromPriv(pkcs8: Uint8Array): Promise<{ x: string; y: string }> {
  const k = await crypto.subtle.importKey('pkcs8', pkcs8.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = (await crypto.subtle.exportKey('jwk', k)) as { x?: string; y?: string };
  return { x: String(jwk.x), y: String(jwk.y) };
}

/** CIMD 元文档（§4.1）：client_id 必须等于本文件 URL；jwks_uri/redirect 同域 */
export function agentMetadata(E: any, base: string): Record<string, unknown> {
  const b = String(base).replace(/\/$/, '');
  return {
    client_id: `${b}/agent/pap.json`,
    client_name: 'cf-bot',
    jwks_uri: `${b}/agent/jwks.json`,
    redirect_uris: [`${b}/oauth/pap-callback`],
    token_endpoint_auth_method: 'private_key_jwt',
  };
}

/** JWKS（§4.1）：只放公钥——签 client assertion 与 delegation */
export async function agentJwks(E: any): Promise<{ keys: Array<Record<string, unknown>> }> {
  const { kid, pub } = await importAgentKey(E);
  return { keys: [{ ...pub, kid, use: 'sig', alg: 'ES256' }] };
}

export type SessionSignArgs = {
  aud: string; // 公司标识（issuer 或 https://{organization.domain}）
  sid: string; // 随机会话 ID
  sub: string; // 该公司假名 User ID
  method: string;
  url: string; // 请求 URL（htu 去掉 query/fragment）
  accessToken?: string; // 有则算 ath（SHA-256 b64url）
  agentId?: string;
  delegationTtlSec?: number; // 默认 3600，≤24h
};

/**
 * 签发 Poppy-Session 头值（§5.2）：每请求新鲜（新委托密钥 + 新 jti）。
 * 返回的字符串直接放 `Poppy-Session` 头；调用方另附 `Poppy-Version: 1.0`。
 */
export async function signPoppySession(E: any, base: string, args: SessionSignArgs): Promise<string> {
  const { key: agentKey, kid: agentKid } = await importAgentKey(E);
  const clientId = `${String(base).replace(/\/$/, '')}/agent/pap.json`;
  const now = Math.floor(Date.now() / 1000);

  // 1) 委托密钥（一次性）+ delegation（§5.2：不带任何用户/公司信息，exp ≤ iat+24h）
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const dPubJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x?: string; y?: string };
  const dPub = { kty: 'EC' as const, crv: 'P-256' as const, x: String(dPubJwk.x), y: String(dPubJwk.y) };
  const dKid = await jwkThumbprint(dPub);
  const ttl = Math.min(Math.max(60, args.delegationTtlSec ?? 3600), 86400);
  const dlgClaims = { iss: clientId, cnf: { jwk: dPub }, iat: now, exp: now + ttl, jti: b64url(crypto.getRandomValues(new Uint8Array(16))) };
  const dlgHeader = { alg: 'ES256', typ: 'poppy-delegation+jwt', kid: agentKid };
  const dlgSig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, agentKey,
    new TextEncoder().encode(`${b64urlJson(dlgHeader)}.${b64urlJson(dlgClaims)}`));
  const delegation = `${b64urlJson(dlgHeader)}.${b64urlJson(dlgClaims)}.${b64url(dlgSig)}`;

  // 2) Session JWT（按请求绑定 htm/htu；ath 可选）
  const htu = String(args.url).split('#')[0].split('?')[0];
  const claims: Record<string, unknown> = {
    iss: clientId, aud: args.aud, sid: args.sid, sub: args.sub,
    htm: String(args.method).toUpperCase(), htu, iat: now,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  if (args.agentId) claims.agent_id = args.agentId;
  if (args.accessToken) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(args.accessToken));
    claims.ath = b64url(digest);
  }
  const header = { typ: 'poppy-session+jwt', alg: 'ES256', kid: dKid, poppy_dlg: delegation };
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(`${b64urlJson(header)}.${b64urlJson(claims)}`));
  return `${b64urlJson(header)}.${b64urlJson(claims)}.${b64url(sig)}`;
}

// ---------- 发现（§3） ----------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|\[?fe80:|\[?fc|\[?fd)/i;

export type DiscoveryResult = { ok: true; doc: any; finalUrl: string } | { ok: false; error: string };

/** 拉取并校验 poppy.json：HTTPS-only、终路径必须是 /.well-known/poppy.json、organization.domain 绑定 */
export async function discoverPoppy(inputUrl: string): Promise<DiscoveryResult> {
  try {
    const u = new URL(String(inputUrl));
    if (u.protocol !== 'https:') return { ok: false, error: 'https required' };
    if (PRIVATE_HOST.test(u.hostname)) return { ok: false, error: 'private/loopback host refused' };
    const res = await fetch(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const finalUrl = res.url || u.toString();
    const f = new URL(finalUrl);
    if (f.protocol !== 'https:' || f.pathname !== '/.well-known/poppy.json' || f.search) {
      return { ok: false, error: 'final URL must be https /.well-known/poppy.json without query' };
    }
    if (PRIVATE_HOST.test(f.hostname)) return { ok: false, error: 'redirected to private host' };
    const doc: any = await res.json().catch(() => null);
    if (!doc || typeof doc !== 'object') return { ok: false, error: 'bad json' };
    const ver = String(doc.protocol_version ?? '');
    if (!/^\d+\.\d+$/.test(ver) || ver.split('.')[0] !== '1') return { ok: false, error: `unsupported protocol_version ${ver}` };
    const org = String(doc.organization?.domain ?? '').toLowerCase();
    if (!org || org !== f.hostname.toLowerCase()) return { ok: false, error: `organization.domain mismatch (${org} != ${f.hostname})` };
    return { ok: true, doc, finalUrl };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}
