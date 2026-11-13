/**
 * MCP 注册表本机操作（mcp-connections S2.2，单一实现复用 src/l2/mcp-registry + mcp-test）。
 * 用法: tsx scripts/mcp-cli.ts list | show <id> | set <id> <json> | remove <id> | test <id>
 * 结果一律 JSON 落 stdout（含 ok:false），便于面板解析；仅用法错误 exit 1。
 * 导入路径双候选：dev 树（apps/l2-desktop/scripts → 仓库根 src/l2）与打包资源（与本脚本同目录）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 管道提前关闭（如 | head）时静默退出，避免 EPIPE 噪声
process.stdout.on('error', (e: any) => { if (e?.code === 'EPIPE') process.exit(0); });

type RegMod = any;
async function loadMod(name: string): Promise<RegMod> {
  try {
    return await import(new URL(`../../../src/l2/${name}.js`, import.meta.url).href);
  } catch (e1: any) {
    try {
      return await import(new URL(`./${name}.js`, import.meta.url).href);
    } catch (e2: any) {
      // 保留两级错误：打包缺依赖（如 @mastra/mcp）与文件缺失都要能分辨
      throw new Error(`${name} 加载失败：[${String(e1?.message ?? e1).slice(0, 120)}] / [${String(e2?.message ?? e2).slice(0, 120)}]`);
    }
  }
}

const reg = await loadMod('mcp-registry');
const { loadRegistry, upsertServer, removeServer, validateServerDef }: RegMod = reg;

const [cmd, id, jsonArg] = process.argv.slice(2);

function deviceCfg(): { l1Url: string; token: string } {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.config', 'mastra-l2', 'device.json'), 'utf8'));
    return {
      l1Url: String(process.env.L1_PULL_URL || j.l1Url || ''),
      token: String(process.env.PUSH_TOKEN || process.env.L2_DEVICE_TOKEN || j.token || ''),
    };
  } catch {
    return { l1Url: String(process.env.L1_PULL_URL || ''), token: String(process.env.PUSH_TOKEN || process.env.L2_DEVICE_TOKEN || '') };
  }
}

function fail(error: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ok: false, error: String(error).slice(0, 300), ...extra }));
  process.exit(0); // 结果性失败也 exit 0：Rust 把 stdout 原样交面板解析
}

if (cmd === 'list') {
  // 不回显 env 值（安全硬约束）：只给变量名
  const list = Object.entries(loadRegistry().servers).map(([id2, def]: any) => ({
    id: id2, name: def.name, command: def.command, url: def.url, args: def.args,
    requireToolApproval: def.requireToolApproval, enabled: def.enabled, note: def.note,
    endpoint: def.command ? `${def.command} ${(def.args ?? []).join(' ')}`.trim() : def.url,
    envVars: Object.keys(def.env ?? {}),
  }));
  console.log(JSON.stringify({ ok: true, servers: list }));
} else if (cmd === 'show' && id) {
  const def = loadRegistry().servers[id];
  if (!def) fail('not in registry', { id });
  else console.log(JSON.stringify({ ok: true, id, def }));
} else if (cmd === 'set' && id && jsonArg) {
  try {
    const def = JSON.parse(jsonArg);
    const err = validateServerDef(def);
    if (err) throw new Error(err);
    upsertServer(id, def);
    console.log(JSON.stringify({ ok: true, id }));
  } catch (e: any) {
    fail(String(e?.message ?? e), { id });
  }
} else if (cmd === 'remove' && id) {
  const gone = removeServer(id);
  if (!gone) fail('not found', { id });
  else console.log(JSON.stringify({ ok: true, id }));
} else if (cmd === 'catalog') {
  // MCP 库目录 + 连接状态（mcp-library S2.1）：内置精选合并注册表已连条目
  const { loadCatalog }: RegMod = await loadMod('mcp-catalog');
  const reg2 = loadRegistry().servers;
  const entries = loadCatalog().map((e: any) => ({
    ...e,
    connected: Boolean(reg2[e.id]),
    connection: reg2[e.id] ? { endpoint: reg2[e.id].command ? `${reg2[e.id].command} ${(reg2[e.id].args ?? []).join(' ')}`.trim() : reg2[e.id].url, enabled: reg2[e.id].enabled !== false, envVars: Object.keys(reg2[e.id].env ?? {}), hasAuthHeader: Boolean(reg2[e.id].headers?.Authorization) } : null,
  }));
  const custom = Object.entries(reg2)
    .filter(([id]) => !entries.some((e: any) => e.id === id))
    .map(([id, def]: any) => ({ id, name: def.name || id, vendor: '自定义', category: '自定义', description: def.note ?? '', transport: def.command ? { type: 'stdio', command: def.command, args: def.args } : { type: 'remote', url: def.url }, auth: { type: 'custom' }, connected: true, connection: { endpoint: def.command ? `${def.command} ${(def.args ?? []).join(' ')}`.trim() : def.url, enabled: def.enabled !== false, envVars: Object.keys(def.env ?? {}), hasAuthHeader: Boolean(def.headers?.Authorization) } }));
  console.log(JSON.stringify({ ok: true, entries, custom }));
} else if (cmd === 'test' && id) {
  const def = loadRegistry().servers[id];
  if (!def) fail('not in registry', { id });
  else if (def.enabled === false) fail('已停用（enabled=false），先启用再测试', { id });
  else {
    const { testMcpServer } = await loadMod('mcp-test');
    // secret: 引用（含 in-string 的 Bearer secret:vault-x）经 L1 /l2-secret 解析（明文只进 MCP 子进程；输出不回显值）
    try {
      const cfg = deviceCfg();
      const { l2SecretResolver, resolveSecretRefsIn }: RegMod = await loadMod('secret-resolver');
      const resolve = cfg.token && cfg.l1Url ? l2SecretResolver(cfg, 'mcp-panel-test') : null;
      const resolveMap = async (map: Record<string, string>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries<string>(map ?? {})) {
          if (v.includes('secret:')) {
            if (!resolve) throw new Error(`env/headers ${k} 用 secret: 引用但 device.json 缺 l1Url/token`);
            out[k] = await resolveSecretRefsIn(v, resolve);
          } else out[k] = v;
        }
        return out;
      };
      const env = await resolveMap(def.env ?? {});
      const headers = await resolveMap(def.headers ?? {});
      const result = await testMcpServer(id, def, env, headers);
      console.log(JSON.stringify(result));
    } catch (e: any) {
      fail(String(e?.message ?? e), { id });
    }
  }
} else if (cmd === 'connect' && id) {
  try {
    const { loadCatalog }: RegMod = await loadMod('mcp-catalog');
    const entry = (loadCatalog() as any[]).find((e) => e.id === id);
    if (!entry) fail('not in catalog', { id });
    else if (entry.auth?.type === 'api_key') fail('该集成为 API-Key 认证：用 echo KEY ｜ connect-key <id>（key 走 stdin）', { id });
    else if (entry.auth?.type === 'none') {
      // 免认证：直接生成注册表条目
      const def = entry.transport.type === 'stdio'
        ? { name: entry.name, command: entry.transport.command, args: entry.transport.args ?? [], note: `via catalog:${id}` }
        : { name: entry.name, url: entry.transport.url, note: `via catalog:${id}` };
      upsertServer(id, def);
      console.log(JSON.stringify({ ok: true, id, connected: true, account: null }));
    } else {
      // OAuth 2.1 + PKCE（mcp-library S2.3）
      let clients: any = {};
      try { clients = JSON.parse(readFileSync(join(homedir(), '.config', 'mastra-l2', 'oauth-clients.json'), 'utf8'))?.[String(entry.auth.provider)] ?? {}; } catch { clients = {}; }
      if (!clients.clientId) {
        fail(`缺少 ${entry.auth.provider} 的 OAuth client：在 ~/.config/mastra-l2/oauth-clients.json 配置 {"${entry.auth.provider}":{"clientId":"…","clientSecret":"…"}}（Google：Google Auth Platform → Clients 创建，勾选 AI-powered agent）`, { id });
      } else {
        const flow = await loadMod('oauth-flow');
        const pkce = flow.genPkce();
        const cb = await flow.startCallbackServer(pkce.state);
        const authUrl = flow.buildAuthUrl(entry.auth, String(clients.clientId), cb.redirectUri, pkce);
        if (process.env.MCP_OAUTH_NO_BROWSER !== '1') flow.openBrowser(authUrl);
        console.error(`[mcp-connect] 授权页：${authUrl}`);
        const code = await cb.code;
        const tok = await flow.exchangeCode({
          tokenUrl: entry.auth.tokenUrl, code, redirectUri: cb.redirectUri,
          clientId: String(clients.clientId), clientSecret: clients.clientSecret ? String(clients.clientSecret) : undefined,
          codeVerifier: pkce.verifier,
        });
        const account = flow.accountFromIdToken(tok.id_token);
        const cred = {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : undefined,
          client_id: String(clients.clientId),
          client_secret: clients.clientSecret ? String(clients.clientSecret) : undefined,
          token_url: entry.auth.tokenUrl,
          scopes: entry.auth.scopes,
          account,
        };
        const cfg = deviceCfg();
        if (!cfg.token || !cfg.l1Url) throw new Error('device.json 缺 l1Url/token，无法存凭证');
        const vr = await fetch(`${cfg.l1Url}/vault`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
          body: JSON.stringify({ name: `${entry.name}${account ? `:${account}` : ''}`, kind: 'oauth_credential', value: JSON.stringify(cred), ttl: 0 }),
          signal: AbortSignal.timeout(20000),
        });
        const vj: any = await vr.json().catch(() => ({}));
        if (!vr.ok || !vj?.entry?.id) throw new Error(`凭证入库失败：${vr.status} ${String(vj?.error ?? '').slice(0, 100)}`);
        const vaultId = String(vj.entry.id);
        const def = entry.transport.type === 'stdio'
          ? { name: entry.name, command: entry.transport.command, args: entry.transport.args ?? [], note: `via catalog:${id}${account ? ` account:${account}` : ''}` }
          : { name: entry.name, url: entry.transport.url, headers: { Authorization: `Bearer secret:${vaultId}` }, note: `via catalog:${id}${account ? ` account:${account}` : ''}` };
        try {
          upsertServer(id, def);
        } catch (e) {
          // 注册表写失败回滚凭证，不留孤儿（E2E 实弹教训）
          await fetch(`${cfg.l1Url}/vault/${vaultId}`, { method: 'DELETE', headers: { authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token }, signal: AbortSignal.timeout(15000) }).catch(() => {});
          throw e;
        }
        console.log(JSON.stringify({ ok: true, id, connected: true, account: account ?? null, vaultId }));
      }
    }
  } catch (e: any) {
    fail(String(e?.message ?? e), { id });
  }
} else if (cmd === 'connect-key' && id) {
  try {
    const { loadCatalog }: RegMod = await loadMod('mcp-catalog');
    const entry = (loadCatalog() as any[]).find((e) => e.id === id);
    if (!entry) fail('not in catalog', { id });
    else if (entry.auth?.type !== 'api_key') fail('该集成不是 API-Key 认证：用 connect <id>', { id });
    else {
      // key 走 stdin（评审 MINOR）：argv 会进 ps 看得见；用法 `echo KEY | tsx mcp-cli.ts connect-key <id>`
      const key = await new Promise<string>((res) => {
        let s = '';
        process.stdin.on('data', (d) => { s += d; });
        process.stdin.on('end', () => res(s.trim()));
      });
      if (!key) fail('缺 API Key（经 stdin 传入）', { id });
      else {
        const cfg = deviceCfg();
        if (!cfg.token || !cfg.l1Url) throw new Error('device.json 缺 l1Url/token，无法存凭证');
        const vr = await fetch(`${cfg.l1Url}/vault`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
          body: JSON.stringify({ name: `${entry.name}-key`, kind: 'api_key', value: key, ttl: 0 }),
          signal: AbortSignal.timeout(20000),
        });
        const vj: any = await vr.json().catch(() => ({}));
        if (!vr.ok || !vj?.entry?.id) throw new Error(`凭证入库失败：${vr.status} ${String(vj?.error ?? '').slice(0, 100)}`);
        const vaultId = String(vj.entry.id);
        const env = { [String(entry.auth.apiKeyName ?? 'API_KEY')]: `secret:${vaultId}` };
        upsertServer(id, {
          name: entry.name,
          command: entry.transport.command, args: entry.transport.args ?? [],
          env, note: `via catalog:${id}`,
        });
        console.log(JSON.stringify({ ok: true, id, connected: true, account: null, vaultId }));
      }
    }
  } catch (e: any) {
    fail(String(e?.message ?? e), { id });
  }
} else if (cmd === 'disconnect' && id) {
  try {
    const def = loadRegistry().servers[id];
    if (!def) fail('not in registry', { id });
    else {
      // 连带删除 vault 凭证（从 headers/env 里收 secret:vault-* 引用）
      const refs = new Set<string>();
      for (const map of [def.headers ?? {}, def.env ?? {}]) {
        for (const v of Object.values<string>(map)) {
          for (const m of String(v).matchAll(/secret:(vault-[\w-]+)/g)) refs.add(m[1]);
        }
      }
      removeServer(id);
      const cfg = deviceCfg();
      const removed: string[] = [];
      for (const ref of refs) {
        if (!cfg.token || !cfg.l1Url) break;
        const dr = await fetch(`${cfg.l1Url}/vault/${ref}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
          signal: AbortSignal.timeout(15000),
        });
        if (dr.ok) removed.push(ref);
      }
      console.log(JSON.stringify({ ok: true, id, removedCredentials: removed }));
    }
  } catch (e: any) {
    fail(String(e?.message ?? e), { id });
  }
} else {
  console.log(JSON.stringify({ error: 'usage: list | catalog | show <id> | set <id> <json> | remove <id> | test <id> | connect <id> | connect-key <id>（stdin 传 key） | disconnect <id>' }));
  process.exit(1);
}
