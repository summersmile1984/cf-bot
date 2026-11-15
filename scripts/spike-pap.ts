/**
 * PAP T1 回归（pap-client S2.2）：RFC 7638 拇指印标准向量、委托链「公司侧」独立验签、
 * 发现层负例（http/私网/路径）。运行：npx tsx scripts/spike-pap.ts
 */
import { jwkThumbprint, agentMetadata, agentJwks, signPoppySession, discoverPoppy } from '../src/mastra/pap';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const b64urlDecode = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const decodePart = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function verifyJwt(jwt: string, pubJwk: JsonWebKey, header: any, claims: any): Promise<boolean> {
  const [h, p, sig] = jwt.split('.');
  const key = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
  Object.assign(header, decodePart(h));
  Object.assign(claims, decodePart(p));
  return ok;
}

async function main() {
  // ① RFC 7638 §3.1 标准向量（RSA）
  const rsa = { kty: 'RSA', n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw', e: 'AQAB' };
  const tp = await jwkThumbprint(rsa as any);
  check('① RFC7638 标准向量', tp === 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs', tp);

  // ② CIMD/JWKS 形状
  const E = { PAP_AGENT_KEY: process.env.PAP_TEST_KEY ?? '' };
  if (!E.PAP_AGENT_KEY) {
    // 现场生成测试密钥（不依赖部署 secret）
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    E.PAP_AGENT_KEY = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64url');
  }
  const base = 'https://agent.example';
  const meta = agentMetadata(E, base);
  const jwks = await agentJwks(E);
  const pub = jwks.keys[0] as any;
  check('② CIMD 形状（client_id=自身 URL / 同域 jwks）',
    meta.client_id === `${base}/agent/pap.json`
    && String(meta.jwks_uri).startsWith(base) && String(meta.token_endpoint_auth_method) === 'private_key_jwt');
  check('② JWKS 只含公钥 + kid=拇指印',
    !!pub && !('d' in pub) && pub.kid === (await jwkThumbprint(pub)) && pub.alg === 'ES256');

  // ③ 委托链「公司侧」验签（自实现验证器，不复用签发代码路径）
  const jwt = await signPoppySession(E, base, {
    aud: 'https://example.com', sid: 'Yx2b7Qd_Kp8mR3vT1nWc4A', sub: 'usr_Q7c1vK',
    method: 'POST', url: 'https://api.example.com/orders/ord_1?x=1#frag', accessToken: 'tok-abc',
    delegationTtlSec: 3600,
  });
  const dHead: any = {}, dClaims: any = {};
  // 先解 Session 头取 delegation
  const sHead = decodePart(jwt.split('.')[0]);
  const sClaims = decodePart(jwt.split('.')[1]);
  check('③ Session 头 typ/alg/kid 正确', sHead.typ === 'poppy-session+jwt' && sHead.alg === 'ES256' && !!sHead.poppy_dlg);
  const dlg = String(sHead.poppy_dlg);
  const dlgOk = await verifyJwt(dlg, pub, dHead, dClaims);
  const now = Math.floor(Date.now() / 1000);
  check('③ delegation 签名 + 声明规则', dlgOk && dHead.typ === 'poppy-delegation+jwt'
    && dHead.kid === pub.kid && dClaims.iss === meta.client_id
    && dClaims.exp <= dClaims.iat + 86400 && dClaims.exp > now
    && !!dClaims.cnf?.jwk && !('d' in dClaims.cnf.jwk)
    && JSON.stringify(dClaims).indexOf('usr_') < 0, `exp-iat=${dClaims.exp - dClaims.iat}s`);
  const dPubJwk = dClaims.cnf.jwk;
  const sHead2: any = {}, sClaims2: any = {};
  const sessOk = await verifyJwt(jwt, dPubJwk, sHead2, sClaims2);
  const athOk = sClaims2.ath === Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tok-abc'))).toString('base64url');
  check('③ Session 签名 + 请求绑定', sessOk
    && (await jwkThumbprint(dPubJwk)) === sHead2.kid
    && sClaims2.htm === 'POST' && sClaims2.htu === 'https://api.example.com/orders/ord_1'
    && sClaims2.aud === 'https://example.com' && sClaims2.sub === 'usr_Q7c1vK'
    && athOk && !!sClaims2.jti && !!sClaims2.iat, `htu=${sClaims2.htu}`);
  const jwt2 = await signPoppySession(E, base, { aud: 'https://example.com', sid: 's2', sub: 'u2', method: 'GET', url: 'https://api.example.com/x' });
  const c2 = decodePart(jwt2.split('.')[1]);
  check('③ 无 token 时 ath 缺席', !('ath' in c2));

  // ④ 发现层负例（fetch 前拒绝）
  const r1 = await discoverPoppy('http://example.com/.well-known/poppy.json');
  const r2 = await discoverPoppy('https://localhost/.well-known/poppy.json');
  const r3 = await discoverPoppy('https://127.0.0.1/.well-known/poppy.json');
  const r4 = await discoverPoppy('https://192.168.1.10/.well-known/poppy.json');
  check('④ 发现负例（http/localhost/回环/私网）全拒',
    !r1.ok && !r2.ok && !r3.ok && !r4.ok, [r1, r2, r3, r4].map((r: any) => r.error).join(' | ').slice(0, 120));

  // ⑤ 线上发现（软探测：有 PAP 发布者的域名才命中，失败不算红）
  let live = 'skipped';
  for (const u of ['https://sierra.ai/.well-known/poppy.json', 'https://personalagentprotocol.org/.well-known/poppy.json']) {
    const r = await discoverPoppy(u);
    if (r.ok) { live = `ok ${u}`; break; }
    live = `none (${String((r as any).error).slice(0, 40)})`;
  }
  check('⑤ 线上 poppy.json 探测（软）', true, live);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
