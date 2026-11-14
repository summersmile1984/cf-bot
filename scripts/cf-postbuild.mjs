// CloudflareDeployer 不支持 assets/DO/AI/Vectorize 配置：build 后给 .mastra/output/wrangler.json 补齐。
// 未命中静态文件的请求（/rooms/*、/auth/*、/health-l1 等自定义路由）照常进入 Mastra Worker。
// - apps/web/dist/      → static/        （SPA：登录 + 房间 + 聊天，根路径唯一入口）
// - room-do.js          → worker-entry.mjs 重导出 RoomDO（mastra 入口只导出 default { fetch }，
//                          DO 类穿不过；wrangler DO 绑定要求类从 main 模块导出，见 spec S2.8.1）
// - AI + VECTORIZE(om-memory)：OM 语义召回的嵌入与向量库（observational-memory spec S2.7）
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
const out = '.mastra/output';
rmSync(`${out}/static`, { recursive: true, force: true });

// SPA（apps/web 构建产物，base=/）
const webDist = 'apps/web/dist';
if (existsSync(`${webDist}/index.html`)) {
  cpSync(webDist, `${out}/static`, { recursive: true });
  // /app 双挂（multi-device 回归修复）：桌面内嵌聊天固定指向 {L1}/app，重构把 SPA 挪到根路径后
  // /app 掉进 Worker playground；assets 是绝对路径 /assets/*，同壳挂到 app/ 不用改 base。
  mkdirSync(`${out}/static/app`, { recursive: true });
  copyFileSync(`${webDist}/index.html`, `${out}/static/app/index.html`);
  console.log('[cf-postbuild] SPA apps/web/dist -> ./static (root) + ./static/app (/app 兼容)');
} else {
  console.log('[cf-postbuild] WARN: apps/web/dist 未找到，跳过 SPA（先跑 npm run web:build）');
}

// RoomDO：拷入产物 + 生成 worker-entry.mjs 重导出
copyFileSync('src/mastra/room-do.js', `${out}/room-do.js`);
writeFileSync(
  `${out}/worker-entry.mjs`,
  [
    "// 生成文件（cf-postbuild.mjs）：DO 类必须从 wrangler main 模块导出。",
    "import base from './index.mjs';",
    "export { RoomDO } from './room-do.js';",
    "// OM 队列消费者（S2.8）与定时任务 tick（S2.1）：挂到 default 导出对象 + 具名导出；",
    "// 逻辑经 globalThis 注册表转发（mastra build 只保留 mastra/default 导出）。",
    "async function queue(batch, env, ctx) {",
    "  const handler = (globalThis).__omQueueHandler;",
    "  if (!handler) { for (const m of batch?.messages ?? []) { try { m.retry(); } catch {} } return; }",
    "  await handler(batch);",
    "}",
    "async function scheduled(event, env, ctx) {",
    "  const handler = (globalThis).__schedulesTick;",
    "  if (handler) await handler();",
    "}",
    "export { queue, scheduled };",
    "export default { ...base, queue, scheduled };",
    '',
  ].join('\n'),
);
console.log('[cf-postbuild] RoomDO -> worker-entry.mjs');

const f = `${out}/wrangler.json`;
const w = JSON.parse(readFileSync(f, 'utf8'));
// html_handling:auto-trailing-slash 让 / 命中 index.html；SPA 无服务端兜底路由，not_found 交 Worker
w.assets = { directory: './static', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };
// main 重指 worker-entry（重导出 RoomDO 供 DO 绑定）
w.main = './worker-entry.mjs';
w.durable_objects = { bindings: [{ name: 'ROOM_DO', class_name: 'RoomDO' }] };
w.migrations = [{ tag: 'v1', new_sqlite_classes: ['RoomDO'] }];
w.ai = { binding: 'AI' };
// Paid 套餐显式锁 30s CPU（免费版曾拒绝此配置，API 100328）
w.limits = { cpu_ms: 30000 };
// Workers AI provider（Mastra provider-registry）鉴权：CLOUDFLARE_API_KEY secret + 账号 ID
// 注意：以下为私有部署值，开源导出（export-open-source.mjs）会抹空——勿从导出目录回拷本文件
w.vars = { ...(w.vars ?? {}), CLOUDFLARE_ACCOUNT_ID: '' };
// 密钥托管（secret-pipeline）：值存 Workers Secrets（动态 env 键，vault.ts 运行时 env[name] 读回）。
// 旧 Secrets Store 店级绑定 wrangler 不支持（secrets_store 字段被丢弃），已移除；VAULT_STORE_ID 仅留作旧 store 标识。
w.vars.VAULT_STORE_ID = '';
// 根 wrangler.jsonc 优先（open-source-split S2.3）：Deploy to Cloudflare 按钮把资源 ID/vars 回写到根配置，
// 这里同步进产物配置——一键部署与手动改配置都走同一条缝，硬编码值仅作兜底。

w.vectorize = [
  { binding: 'VECTORIZE', index_name: 'om-memory' },
  { binding: 'VECTORIZE_OBS', index_name: 'om-memory-obs' },
];
// OM 周期走队列（S2.8）：请求侧只入队，consumer 独立 invocation 跑 Observer/Reflector
w.queues = {
  producers: [{ queue: 'om-cycles', binding: 'OM_QUEUE' }],
  consumers: [{ queue: 'om-cycles', max_retries: 10, retry_delay: 30 }],
};
// 定时任务（schedules-secrets S2.1）：每分钟 tick
w.triggers = { crons: ['* * * * *'] };
try {
  const raw = readFileSync(existsSync('.cf-root-config.json') ? '.cf-root-config.json' : 'wrangler.jsonc', 'utf8');
  const root = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => /^\s*\/\//.test(l) ? '' : l).join('\n'));
  // Deploy to Cloudflare 按钮把用户自定义的 Worker 名/资源名/资源 ID 回写根配置——全部同步进产物
  if (root?.name) w.name = root.name;
  const d1 = (root?.d1_databases ?? []).find((x) => x && x.database_id);
  if (d1) {
    w.d1_databases = (w.d1_databases ?? []).map((x) =>
      (x.binding ?? x.database_name) === (d1.binding ?? d1.database_name)
        ? { ...x, database_id: d1.database_id || x.database_id, database_name: d1.database_name ?? x.database_name }
        : x,
    );
    if (d1.database_id) console.log('[cf-postbuild] d1 database_id synced from root wrangler.jsonc');
  }
  // 队列/Vectorize 资源名（按钮可改名）按 binding 对齐
  if (root?.queues?.producers && w.queues?.producers) {
    const byBinding = Object.fromEntries((root.queues.producers ?? []).map((p) => [p.binding, p.queue]));
    w.queues.producers = w.queues.producers.map((p) => ({ ...p, queue: byBinding[p.binding] ?? p.queue }));
    const consByName = Object.fromEntries((root.queues.consumers ?? []).map((c) => [c.queue, c]));
    w.queues.consumers = (w.queues.consumers ?? []).map((c) => {
      const rc = consByName[c.queue];
      return rc ? { ...c, queue: rc.queue } : c;
    });
  }
  if (root?.vectorize && w.vectorize) {
    const vb = Object.fromEntries((root.vectorize ?? []).map((v) => [v.binding, v.index_name]));
    w.vectorize = w.vectorize.map((v) => ({ ...v, index_name: vb[v.binding] ?? v.index_name }));
  }
  for (const k of ['L1_PUBLIC_URL', 'CLOUDFLARE_ACCOUNT_ID', 'VAULT_STORE_ID', 'TURNSTILE_SITEKEY']) {
    if (root?.vars?.[k]) w.vars[k] = root.vars[k];
  }
  // 注册限流 binding（saas S2.7）：根配置声明，产物原样带上（wrangler 字段名是 ratelimits）
  if (Array.isArray(root?.ratelimits) && root.ratelimits.length) w.ratelimits = root.ratelimits;
} catch { /* 无根配置或解析失败：用兜底值 */ }
writeFileSync(f, JSON.stringify(w, null, 2));
console.log('[cf-postbuild] assets -> ./static, main -> ./worker-entry.mjs, DO ROOM_DO, AI + VECTORIZE + queues(om-cycles)');
// 根配置还原（open-source-split S2.3）：mastra build 重写了根 wrangler.jsonc——把按钮/用户写回的
// 快照还原回去，后续步骤（d1 migrations apply 等）与人工查看才读到正确值。
try {
  if (existsSync('.cf-root-config.json')) {
    copyFileSync('.cf-root-config.json', 'wrangler.jsonc');
    console.log('[cf-postbuild] root wrangler.jsonc restored from snapshot');
  }
} catch {}
