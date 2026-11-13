/**
 * secret:<vault_id> 引用解析（secret-pipeline）：经 L1 /l2-secret 取明文。
 * 轻量模块（仅 proxy-fetch），mcp-cli 面板测试与专家运行时共用；明文只进调用方子进程 env。
 */
import { withProxy } from './proxy-fetch.js';

export function l2SecretResolver(cfg: { l1Url: string; token: string }, taskId: string): (ref: string) => Promise<{ value: string; name?: string | null }> {
  return async (ref: string) => {
    const r = await fetch(`${cfg.l1Url}/l2-secret`, withProxy({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
      body: JSON.stringify({ taskId, ref }),
      signal: AbortSignal.timeout(15000),
    }));
    const j: any = await r.json().catch(() => null);
    if (!r.ok || typeof j?.value !== 'string') throw new Error(`/l2-secret ${r.status} ${JSON.stringify(j?.error ?? '').slice(0, 80)}`);
    return { value: j.value, name: j.name ?? null };
  };
}

/** 解析字符串内所有 secret:vault-xxx 引用（mcp-library S2.3）：支持 "Bearer secret:vault-x" 形态的 in-string 替换。 */
export async function resolveSecretRefsIn(
  value: string,
  resolveSecret: (ref: string) => Promise<string | { value: string; name?: string | null }>,
): Promise<string> {
  const re = /secret:(vault-[\w-]+)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out += value.slice(last, m.index);
    const r = await resolveSecret(m[0]);
    out += typeof r === 'string' ? r : r.value;
    last = m.index + m[0].length;
  }
  return out + value.slice(last);
}
