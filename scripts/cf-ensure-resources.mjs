/**
 * 部署自举（open-source-split S2.3 / 按钮验证教训）：Deploy to Cloudflare 按钮**不会可靠地代开
 * D1/Vectorize/Queues**（实测 db:migrate 找不到库）。本脚本在部署命令里就地补齐缺失资源：
 * 建库/索引/队列 → ID/名回写根 wrangler.jsonc 与快照 → 重跑 cf-postbuild 同步进产物配置。
 * 幂等：已存在的资源只取 ID，不重建。用法：node scripts/cf-ensure-resources.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const run = (cmd) => {
  try { return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: String(e?.stdout ?? '') + String(e?.stderr ?? e) }; }
};

const CFG_PATH = existsSync('.cf-root-config.json') ? '.cf-root-config.json' : 'wrangler.jsonc';
const parse = (p) => {
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n'));
};
const cfg = parse(CFG_PATH);

// 1) D1：缺库则建，ID 回写
for (const d1 of cfg.d1_databases ?? []) {
  const name = d1.database_name || d1.binding;
  if (!name) continue;
  let id = d1.database_id || '';
  const listed = run(`wrangler d1 list --json`);
  try {
    const rows = JSON.parse(listed.out.trim().split('\n').filter((l) => l.trim().startsWith('[')).pop() ?? '[]');
    const hit = rows.find((r) => r.name === name || r.uuid === id);
    if (hit) id = hit.uuid;
  } catch {}
  if (!id) {
    const created = run(`wrangler d1 create ${name}`);
    const m = created.out.match(/"database_id":\s*"([^"]+)"/) || created.out.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (m) id = m[1];
    console.log(`[ensure] d1 create ${name}: ${id ?? 'FAILED'}`);
  } else console.log(`[ensure] d1 exists ${name}: ${id}`);
  d1.database_id = id;
}

// 2) Vectorize：1024 维 cosine（与嵌入一致），缺则建
for (const v of cfg.vectorize ?? []) {
  const r = run(`wrangler vectorize create ${v.index_name} --dimensions=1024 --metric=cosine`);
  console.log(`[ensure] vectorize ${v.index_name}: ${r.ok ? 'created' : (r.out.includes('already') ? 'exists' : 'check-manually')}`);
}

// 3) Queues：缺则建
for (const q of [...(cfg.queues?.producers ?? []), ...(cfg.queues?.consumers ?? [])]) {
  if (!q.queue) continue;
  const r = run(`wrangler queues create ${q.queue}`);
  console.log(`[ensure] queue ${q.queue}: ${r.ok ? 'created' : (r.out.includes('already') || r.out.includes('exist') ? 'exists' : 'check-manually')}`);
}

// 4) 回写根配置 + 快照（postbuild 以快照同步进产物）
const out = JSON.stringify(cfg, null, 2);
writeFileSync('wrangler.jsonc', out);
writeFileSync('.cf-root-config.json', out);
console.log('[ensure] root wrangler.jsonc + snapshot updated');
