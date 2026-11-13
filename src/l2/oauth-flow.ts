/**
 * OAuth 2.1 + PKCE 连接流（mcp-library S2.3）：授权码 + PKCE + 本地回环收码 + 换令牌。
 * 纯流程函数（零第三方依赖）；浏览器打开与回环等待供 CLI/面板编排。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

export type Pkce = { verifier: string; challenge: string; state: string };

export function genPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  return { verifier, challenge, state };
}

export function buildAuthUrl(
  auth: { authorizationUrl: string; scopes?: string[]; extraAuthParams?: Record<string, string> },
  clientId: string,
  redirectUri: string,
  pkce: Pkce,
): string {
  const u = new URL(auth.authorizationUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', pkce.state);
  if (auth.scopes?.length) u.searchParams.set('scope', auth.scopes.join(' '));
  for (const [k, v] of Object.entries(auth.extraAuthParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

export function openBrowser(url: string): void {
  const bin = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(bin, [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 用户可手动打开返回的 URL */ }
}

/** 127.0.0.1 回环收授权码：MCP_OAUTH_CALLBACK_PORT 固定端口（供需白名单的 IdP）或随机端口；校验 state 防 CSRF。 */
export function startCallbackServer(wantState: string, timeoutMs = 180_000): Promise<{
  port: number;
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}> {
  let settled = false;
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = createServer((req, res) => {
    try {
      const q = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams;
      if (q.get('state') !== wantState) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('state 不匹配，请回到应用重试');
        return;
      }
      const err = q.get('error');
      const c = q.get('code');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err ? `授权失败：${err}` : '授权完成，可以回到应用了。');
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      if (err) rejectCode(new Error(`授权失败：${err}`));
      else if (c) resolveCode(c);
      else rejectCode(new Error('回调缺少 code'));
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); rejectCode(e as Error); }
    }
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    rejectCode(new Error('授权超时（3 分钟）'));
  }, timeoutMs);
  return new Promise((resolve, reject) => {
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    const fixedPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT ?? 0) || 0;
    server.listen(fixedPort, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        code,
        close: () => { if (!settled) { settled = true; clearTimeout(timer); server.close(); rejectCode(new Error('已取消')); } },
      });
    });
  });
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  id_token?: string;
  scope?: string;
};

/** 授权码换令牌（PKCE；client_secret 可选）。 */
export async function exchangeCode(opts: {
  tokenUrl: string; code: string; redirectUri: string;
  clientId: string; clientSecret?: string; codeVerifier: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
  if (opts.clientSecret) params.set('client_secret', opts.clientSecret);
  const res = await fetch(opts.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.access_token) throw new Error(`换令牌失败：${res.status} ${String(j?.error_description ?? j?.error ?? '').slice(0, 120)}`);
  return j as TokenResponse;
}

/** 从 id_token（JWT，不验签仅展示）取 email/账号标识；拿不到返回 undefined。 */
export function accountFromIdToken(idToken?: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : (typeof payload.sub === 'string' ? payload.sub : undefined);
  } catch { return undefined; }
}
