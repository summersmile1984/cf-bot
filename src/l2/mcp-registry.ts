/**
 * MCP 服务器注册表（mcp-connections S2.1）：
 * 本机数据文件 ~/.config/mastra-l2/mcp.json（秘钥只允许 secret:<vault_id> 引用）。
 * 单一实现：面板 mcp-cli 与 L2 buildMcpClient 的 use 引用解析都走这里。
 * 零第三方依赖（node 内置）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type McpServerDef = {
  name?: string;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  /** remote MCP 的 HTTP 头（如 Authorization: Bearer secret:cred:<id>）；值支持 secret: 引用（mcp-library S2.3）。 */
  headers?: Record<string, string>;
  requireToolApproval?: boolean;
  enabled?: boolean;
  note?: string;
};

export type McpRegistry = { servers: Record<string, McpServerDef> };

const ALLOWED_FIELDS = new Set(['name', 'command', 'url', 'args', 'env', 'headers', 'requireToolApproval', 'enabled', 'note']);

export function registryPath(): string {
  return join(homedir(), '.config', 'mastra-l2', 'mcp.json');
}

export function isValidServerId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(id);
}

/** 明文令牌检测：去掉所有 secret:vault-* 引用后，余下部分仍像令牌才拒（评审 MINOR：`sk-abc-secret:zz` 不许绕过）。 */
function looksLikePlaintextToken(v: string): boolean {
  const stripped = v.replace(/secret:vault-[\w-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return false; // 纯引用
  if (/^Bearer$/i.test(stripped)) return false; // "Bearer secret:vault-x" 去引用后只剩 Bearer
  return /^(sk-[a-z0-9]|ghp_|gho_|github_pat_|xox[baprs]-|Bearer\s+\S)/i.test(stripped);
}

/** 条目校验：command|url 二选一，未知字段拒（与 experts.ts mcp server 规则一致）。返回错误文案或 null。 */
export function validateServerDef(def: any): string | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return 'server 定义须为对象';
  for (const k of Object.keys(def)) if (!ALLOWED_FIELDS.has(k)) return `不支持字段 ${k}`;
  if (!def.command && !def.url) return '须含 command（stdio）或 url（http）';
  if (def.command && def.url) return 'command 与 url 只能二选一';
  if (def.command != null && typeof def.command !== 'string') return 'command 须为字符串';
  if (def.url != null && typeof def.url !== 'string') return 'url 须为字符串';
  if (def.url != null) { try { new URL(String(def.url)); } catch { return 'url 非法'; } }
  if (def.args != null && (!Array.isArray(def.args) || def.args.some((a: any) => typeof a !== 'string'))) return 'args 须为字符串数组';
  if (def.env != null) {
    if (typeof def.env !== 'object' || Array.isArray(def.env)) return 'env 须为对象';
    for (const [k, v] of Object.entries<any>(def.env)) {
      if (typeof v !== 'string') return `env.${k} 须为字符串（值或 secret:<vault_id>）`;
      // 安全硬约束：疑似明文令牌不入库，改用 secret:<vault_id> 引用
      if (looksLikePlaintextToken(v)) return `env.${k} 疑似明文令牌——改用 secret:<vault_id> 引用`;
    }
  }
  if (def.headers != null) {
    if (typeof def.headers !== 'object' || Array.isArray(def.headers)) return 'headers 须为对象';
    for (const [k, v] of Object.entries<any>(def.headers)) {
      if (typeof v !== 'string') return `headers.${k} 须为字符串（值或 secret:<vault_id>）`;
      if (looksLikePlaintextToken(v)) return `headers.${k} 疑似明文令牌——改用 secret:<vault_id> 引用`;
    }
  }
  if (def.enabled != null && typeof def.enabled !== 'boolean') return 'enabled 须为布尔';
  return null;
}

/** 原始（未过滤）servers 面：增删操作在此之上进行，历史非法条目也保留可删（评审 MINOR：读时过滤会让毒条目删不掉）。 */
function rawServers(): Record<string, any> {
  try {
    if (!existsSync(registryPath())) return {};
    return JSON.parse(readFileSync(registryPath(), 'utf8'))?.servers ?? {};
  } catch { return {}; }
}

/** web 连接同步面（web-mcp S2.3）：claim loop 从 L1 拉取后落盘，同 id 覆盖本地（「我的 MCP」以 web 为准）。 */
export function managedRegistryPath(): string {
  return join(homedir(), '.config', 'mastra-l2', 'mcp-managed.json');
}

function managedServers(): Record<string, any> {
  try {
    if (!existsSync(managedRegistryPath())) return {};
    return JSON.parse(readFileSync(managedRegistryPath(), 'utf8'))?.servers ?? {};
  } catch { return {}; }
}

export function loadRegistry(): McpRegistry {
  const servers: Record<string, McpServerDef> = {};
  // 本地先、managed 后覆盖（web 权威）
  for (const [id, def] of Object.entries({ ...rawServers(), ...managedServers() })) {
    if (isValidServerId(id) && !validateServerDef(def)) servers[id] = def;
  }
  return { servers };
}

function writeRegistry(reg: McpRegistry): void {
  const dir = join(homedir(), '.config', 'mastra-l2');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 原子写（tmp + rename）：避免半截文件把注册表打没
  const tmp = `${registryPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ servers: reg.servers }, null, 2), { mode: 0o600 });
  renameSync(tmp, registryPath());
}

/** 新增/更新一条；校验不过抛错。其余条目（含历史非法）原样保留。 */
export function upsertServer(id: string, def: McpServerDef): void {
  if (!isValidServerId(id)) throw new Error(`非法 id：${id}`);
  const err = validateServerDef(def);
  if (err) throw new Error(err);
  const all = rawServers();
  all[id] = def;
  writeRegistry({ servers: all } as McpRegistry);
}

export function removeServer(id: string): boolean {
  const all = rawServers();
  if (!(id in all)) return false;
  delete all[id];
  writeRegistry({ servers: all } as McpRegistry);
  return true;
}

export type ResolvedMcp = {
  /** 喂给 MCPClient 的 servers 面（仅 enabled 条目）。 */
  servers: Record<string, McpServerDef>;
  /** use 引用但缺失/停用的 id：调用方须打日志/进度，不许无声（S2.4）。 */
  skipped: string[];
};

/**
 * mcp_json → 合并后的 servers 面（mcp-connections S2.4）：
 * `{"servers": {...内联...}, "use": ["<注册表id>", ...]}`；同名内联覆盖注册表；缺失/停用的 use id 进 skipped。
 */
export function resolveMcpConfig(mcpJson: unknown, registry?: McpRegistry): ResolvedMcp {
  let cfg: any = mcpJson;
  if (typeof mcpJson === 'string') { try { cfg = JSON.parse(mcpJson); } catch { return { servers: {}, skipped: [] }; } }
  if (!cfg || typeof cfg !== 'object') return { servers: {}, skipped: [] };
  const reg = registry ?? loadRegistry();
  const servers: Record<string, McpServerDef> = {};
  const skipped: string[] = [];
  for (const id of Array.isArray(cfg.use) ? cfg.use.map((x: any) => String(x)) : []) {
    const def = reg.servers[id];
    if (!def || def.enabled === false) { skipped.push(id); continue; }
    servers[id] = def;
  }
  for (const [name, def] of Object.entries<any>(cfg.servers ?? {})) {
    if (def && typeof def === 'object') servers[name] = def;
  }
  return { servers, skipped };
}

/** def + 已解析 env/headers → MCPClient servers 面的一条（buildMcpClient 与连接测试共用，单一实现）。
 * 不设 inheritDefaultEnv:false：那会压制默认环境（含 PATH），stdio 服务器（npx/node）必炸；沿用 MCPClient 默认 curated env + 配置覆盖。
 * remote 条目经 requestInit.headers 带 Bearer（mcp-library S2.3）。args 中的 `~/` 展开为家目录（exec 不做波浪展开）。 */
export function toClientServerEntry(def: McpServerDef, env: Record<string, string>, headers?: Record<string, string>): any {
  const expand = (s: string) => s.replace(/^~(?=$|\/)/, homedir());
  return def.command
    ? { command: def.command, args: (def.args ?? []).map(expand), env }
    : {
        url: new URL(String(def.url)),
        requestInit: { headers: { ...(headers ?? {}) } },
        requireToolApproval: def.requireToolApproval,
      };
}
