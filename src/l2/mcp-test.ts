/**
 * MCP 连接测试（mcp-connections S2.2）：真握手（@mastra/mcp MCPClient + listToolsets），无 mock。
 * 仅供本机 CLI/面板调用；不回显 env 值（只报变量名）。
 * @mastra/mcp 懒加载：打包应用缺依赖时返回明确错误，不拖垮 list/set/remove。
 */
import { toClientServerEntry, type McpServerDef } from './mcp-registry.js';

export type McpTestResult = {
  ok: boolean;
  id: string;
  tools: string[];
  ms: number;
  envVars?: string[];
  error?: string;
};

/** 测一条 server def：握手 + 列工具。env/headers 须已解析好明文（secret: 引用由调用方处理）。 */
export async function testMcpServer(id: string, def: McpServerDef, env: Record<string, string> = {}, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<McpTestResult> {
  const t0 = Date.now();
  const envVars = Object.keys(def.env ?? {});
  const base = { ok: false, id, tools: [] as string[], envVars: envVars.length ? envVars : undefined };
  let MCPClient: any;
  try {
    ({ MCPClient } = await import('@mastra/mcp'));
  } catch (e: any) {
    return { ...base, ms: Date.now() - t0, error: `连接测试需要应用完整依赖（@mastra/mcp 不可加载）：${String(e?.message ?? e).slice(0, 120)}` };
  }
  let client: any = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    client = new MCPClient({ id: `mcp-test-${Date.now().toString(36)}`, servers: { [id]: toClientServerEntry(def, env, headers) } } as any);
    const toolsets: any = await Promise.race([
      client.listToolsets(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`握手超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    // listToolsets 对连接失败吞错返回缺项：用「本 server 的 key 是否在」区分 连不上 / 连上但零工具
    const ts = toolsets?.[id];
    if (ts === undefined) return { ...base, ms: Date.now() - t0, error: '连接失败（未返回本服务器 toolset，检查 command/url 与依赖）' };
    return { ...base, ok: true, tools: Object.keys(ts ?? {}), ms: Date.now() - t0 };
  } catch (e: any) {
    return { ...base, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
    try { await client?.disconnect?.(); } catch { /* 清理失败不影响结果 */ }
  }
}
