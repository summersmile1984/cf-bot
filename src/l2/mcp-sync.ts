/**
 * web 连接同步（web-mcp S2.3）：claim loop 节流拉取 L1 `/mcp-connections` →
 * 落盘 ~/.config/mastra-l2/mcp-managed.json（loadRegistry 合并，web 同名覆盖本地）。
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function syncManagedConnections(l1Url: string, token: string, timeoutMs = 15_000): Promise<number> {
  const res = await fetch(`${l1Url}/mcp-connections`, {
    headers: { authorization: `Bearer ${token}`, 'x-a2a-notification-token': token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(j?.connections)) return -1;
  const servers: Record<string, unknown> = {};
  for (const c of j.connections) {
    if (!c?.catalogId || !c?.transport) continue;
    servers[String(c.catalogId)] = { ...(c.transport as object), enabled: c.status === 'connected' };
  }
  const dir = join(homedir(), '.config', 'mastra-l2');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, 'mcp-managed.json');
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  return Object.keys(servers).length;
}
