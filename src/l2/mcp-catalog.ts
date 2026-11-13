/**
 * MCP 库内置精选目录（mcp-library S2.1）：应用商店式集成清单（真条目，含官方 URL/scopes）。
 * 数据驱动：src/l2/mcp-catalog.json + 用户扩展 ~/.config/mastra-l2/mcp-catalog.json（同 id 覆盖、新 id 追加）。
 * 零第三方依赖。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as presolve } from 'node:path';

export type McpCatalogAuth = {
  type: 'oauth2' | 'api_key' | 'none';
  provider?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  extraAuthParams?: Record<string, string>;
  apiKeyName?: string;
  apiKeyHint?: string;
};

export type McpCatalogEntry = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  icon?: string;
  transport: { type: 'remote' | 'stdio'; url?: string; command?: string; args?: string[] };
  auth: McpCatalogAuth;
  note?: string;
};

export function loadCatalog(): McpCatalogEntry[] {
  const byId = new Map<string, McpCatalogEntry>();
  const push = (list: any[]) => {
    for (const e of list ?? []) if (e?.id && e?.transport && e?.auth) byId.set(String(e.id), e as McpCatalogEntry);
  };
  try {
    const p = presolve(fileURLToPath(new URL('./mcp-catalog.json', import.meta.url)));
    push(JSON.parse(readFileSync(p, 'utf8'))?.entries);
  } catch { /* 内置缺失时只用用户目录 */ }
  try {
    const up = join(homedir(), '.config', 'mastra-l2', 'mcp-catalog.json');
    if (existsSync(up)) push(JSON.parse(readFileSync(up, 'utf8'))?.entries);
  } catch { /* 用户目录损坏不影响内置 */ }
  return [...byId.values()];
}
