/**
 * mcp-library 单测（T1 验收，评审 MINOR：单测随仓可复跑）。
 * 用法: HOME=$(mktemp -d) tsx scripts/mcp-library-tests.mts
 * 覆盖：注册表校验/原子写/毒条目、目录合并、headers、in-string secret 解析、PKCE/回环、令牌明文拦截。
 */
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { upsertServer, removeServer, loadRegistry, resolveMcpConfig, validateServerDef, toClientServerEntry, registryPath } from '../src/l2/mcp-registry.js';
import { loadCatalog } from '../src/l2/mcp-catalog.js';
import { resolveSecretRefsIn } from '../src/l2/secret-resolver.js';

// 目录：9 条真条目（Google 官方 URL + 真 npm 包）
const cat = loadCatalog();
assert.ok(cat.length >= 9, 'catalog entries');
assert.equal(cat.find((e: any) => e.id === 'google-gmail')!.transport.url, 'https://gmailmcp.googleapis.com/mcp/v1');
assert.equal((cat.find((e: any) => e.id === 'google-gmail')!.auth as any).extraAuthParams['access_type'], 'offline');

// 校验：headers、令牌拦截（含绕过形态）、secret: 引用放行
assert.equal(validateServerDef({ url: 'http://x', headers: { Authorization: 'secret:vault-abc' } }), null);
assert.equal(validateServerDef({ url: 'http://x', headers: { Authorization: 'Bearer secret:vault-abc' } }), null, 'Bearer+ref 放行');
assert.ok(validateServerDef({ url: 'http://x', headers: { Authorization: 'Bearer sk-live-1' } }), '明文 Bearer 拒');
assert.ok(validateServerDef({ env: { K: 'sk-abc-secret:zz' } as any }), '绕过形态拒');

// toClientServerEntry：headers 透传 + ~/ 展开
const e1 = toClientServerEntry({ url: 'https://a.example/mcp' }, {}, { Authorization: 'Bearer tok' });
assert.equal(e1.requestInit.headers.Authorization, 'Bearer tok');
const e2 = toClientServerEntry({ command: 'npx', args: ['x', '~/dir'] }, {}, {});
assert.ok(!e2.args[1].startsWith('~'), '~/ 展开');

// use 合并 + 持久化 + 毒条目可删 + 原子写
upsertServer('g', { url: 'https://a.example/mcp', headers: { Authorization: 'secret:vault-1' } });
assert.equal(resolveMcpConfig({ use: ['g'] }).servers.g.headers!.Authorization, 'secret:vault-1');
writeFileSync(registryPath(), JSON.stringify({ servers: { g: { command: 'x' }, bad: { command: 'y', env: { A: 'sk-z' }, z: 1 } } }, null, 2));
assert.equal(loadRegistry().servers.bad, undefined, '毒条目隐藏');
assert.equal(removeServer('bad'), true, '毒条目可删');
removeServer('g');

// web-managed 合并（web-mcp S2.3）：managed 同名覆盖本地
import { managedRegistryPath } from '../src/l2/mcp-registry.js';
upsertServer('google-gmail', { url: 'http://local-override.example/mcp' });
writeFileSync(managedRegistryPath(), JSON.stringify({ servers: { 'google-gmail': { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer secret:vault-abc' }, note: 'managed:google-gmail' } } }, null, 2));
assert.equal(loadRegistry().servers['google-gmail']!.url, 'https://gmailmcp.googleapis.com/mcp/v1', 'managed 覆盖本地');
removeServer('google-gmail');

// in-string secret 解析
const resolver = async (ref: string) => ({ value: `<${ref}>` });
assert.equal(await resolveSecretRefsIn('Bearer secret:vault-x', resolver), 'Bearer <secret:vault-x>');
assert.equal(await resolveSecretRefsIn('plain', resolver), 'plain');

// PKCE + 回环（真收码）
const flow: any = await import('../src/l2/oauth-flow.js');
const pkce = flow.genPkce();
assert.equal(Buffer.from(pkce.challenge, 'base64url').length, 32);
const cb = await flow.startCallbackServer(pkce.state, 10000);
const got = await (async () => {
  await fetch(`${cb.redirectUri}?code=C1&state=${pkce.state}`);
  return cb.code;
})();
assert.equal(got, 'C1');

console.log('MCP-LIBRARY TESTS PASS');
