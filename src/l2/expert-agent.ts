/**
 * L2 专家 JIT 工厂（expert-forge S2.1，AGENTS.md buildL2Agent 口径）：
 * 专家定义即数据——agent_defs 快照（提示词/tools/mcp/skill/memory）按名现场构建 Mastra Agent，
 * threadId 与 L1 一一对应（同房间共享记忆线，跨房间不串），结果经 compose 回流 L1（权威记忆）。
 * 实例按 def.id+updated_at 缓存；MCP client 每任务独立生命周期。
 */
import { Agent } from '@mastra/core/agent';
import { createSkill } from '@mastra/core/skills';
import { Workspace, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient } from '@mastra/mcp';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTools } from './tools-registry.js';
import { resolveMcpConfig, toClientServerEntry } from './mcp-registry.js';
import { resolveSecretRefsIn } from './secret-resolver.js';
import { makeProgressTool } from './progress.js';
import { makeAskTool } from './ask.js';
import { makeArtifactTool } from './artifacts.js';
import { CuaSandbox } from './cua-sandbox.js';

/** agent_defs 行快照（与 packages/shared ExpertDefSnapshot 同构；JSON 字段为字符串）。 */
export type ExpertDefSnapshot = {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  model?: string | null;
  tools_json?: string | null;
  mcp_json?: string | null;
  skills_json?: string | null;
  memory_json?: string | null;
  updated_at?: number | null;
  /** 派发时快照的权限策略（cua-sandbox-provider S2.3）：computer/execute 类 allow/ask/deny */
  policies?: Record<string, string> | null;
  /** report_progress 工具描述（persona_config.tool_progress 随任务下发，零写死） */
  progress_desc?: string | null;
  ask_desc?: string | null;
  artifact_desc?: string | null;
};

export type L2ExpertTask = {
  prompt: string;
  expertId?: string | null;
  instructions?: string | null;
  model?: string | null;
  name?: string | null;
  threadId?: string | null;
  resourceId?: string | null;
  def?: ExpertDefSnapshot | null;
  /** 任务级/账号默认 harness（harness-registry）：tools_json 未指定时 run_harness 用它，再由设备默认兜底。 */
  harness?: string | null;
  /** secret:<vault_id> 引用解析器（secret-pipeline）：经 L1 /l2-secret 取明文，只进子进程 env。 */
  resolveSecret?: (ref: string) => Promise<string | { value: string; name?: string | null }>;
  /** 已物化的秘钥 env（secret-pipeline）：并入 MCP 子进程环境。 */
  secretEnv?: Record<string, string>;
  /** 一句话进度上报（l2-progress S2.3）：report_progress 工具经此落房间。 */
  reportProgress?: (line: string) => Promise<unknown>;
  /** judgment call 追问（ask-artifacts S2.1）：ask_user 工具经此提问并等答案。 */
  askQuestion?: (question: string) => Promise<string>;
  /** 产物上报（ask-artifacts S2.2）：save_artifact 工具经此落附件。 */
  uploadArtifact?: (p: { kind: 'image' | 'text' | 'page'; caption?: string; data: string }) => Promise<string | null>;
};

/** 造一个经 L1 /l2-secret 取秘钥的解析器（设备令牌 + 任务授权在 L1 侧校验）。实现见 secret-resolver.ts（mcp-cli 共用）。 */
export { l2SecretResolver } from './secret-resolver.js';

let store: any = null;
function localStore(): any {
  if (!store) {
    const dir = resolve(process.env.L2_MEMORY_DIR || 'workspace-l2');
    mkdirSync(dir, { recursive: true });
    store = new LibSQLStore({ id: 'l2-memory', url: `file:${resolve(dir, 'memory.db')}` } as any);
  }
  return store;
}

const FALLBACK_INSTRUCTIONS = '你是专家助手，用中文简短、结构化回复。';

function parseJson<T>(v: unknown): T | null {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return null; }
}

/** memory_json → Memory options（workingMemory 模板 / semanticRecall / OM 透传）。 */
function buildMemory(memoryJson: unknown): InstanceType<typeof Memory> {
  const opts = parseJson<any>(memoryJson) ?? {};
  return new Memory({
    storage: localStore() as any,
    options: {
      lastMessages: Number(opts.lastMessages) > 0 ? Number(opts.lastMessages) : 20,
      ...(opts.workingMemory ? { workingMemory: opts.workingMemory } : {}),
      ...(opts.semanticRecall ? { semanticRecall: opts.semanticRecall } : {}),
      ...(opts.observationalMemory ? { observationalMemory: opts.observationalMemory } : {}),
    },
  } as any) as any;
}

/** 技能名 slug 化：Mastra createSkill 仅允许 [a-z0-9-]；中文名保留进 description。 */
function slugifySkillName(name: string, used: Set<string>): string {
  let s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  if (!/^[a-z0-9]/.test(s)) s = `s-${s}`;
  let out = s, i = 2;
  while (used.has(out)) out = `${s}-${i++}`;
  used.add(out);
  return out;
}

/** skills_json → createSkill 内联技能（按需加载）。 */
function buildSkills(skillsJson: unknown): any[] {
  const list = parseJson<any[]>(skillsJson);
  if (!Array.isArray(list)) return [];
  const used = new Set<string>();
  return list
    .filter((s) => s && typeof s.name === 'string' && typeof s.instructions === 'string')
    .map((s) => createSkill({
      name: slugifySkillName(s.name, used),
      description: String(s.description ?? '').slice(0, 200) || `技能「${String(s.name).slice(0, 40)}」（按需加载）`,
      instructions: String(s.instructions).slice(0, 8000),
    }));
}

type McpConfig = { servers?: Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; requireToolApproval?: boolean }> };

/** mcp_json → 每任务独立 MCPClient（mcp-connections S2.4：use 引用注册表合并，内联同名覆盖）。
 * env/headers 支持 secret:<vault_id>（含 secret:cred: 凭证，resolver 解析并自动刷新）与已物化 secretEnv 注入；
 * 缺失 use id 跳过但必留声（不许无声降级）。 */
async function buildMcpClient(mcpJson: unknown, resolveSecret?: (ref: string) => Promise<string | { value: string; name?: string | null }>, secretEnv?: Record<string, string>): Promise<InstanceType<typeof MCPClient> | null> {
  const { servers: raw, skipped } = resolveMcpConfig(mcpJson);
  if (skipped.length) {
    const line = `⚠️ MCP 注册表缺/停用：${skipped.join('、')}，已跳过`;
    console.log('[expert]', line);
    try { await activeProgress?.(line); } catch { /* 进度不阻断 */ }
  }
  if (!Object.keys(raw).length) return null;
  const resolveMap = async (map: Record<string, string>, allowSecretEnv: boolean): Promise<Record<string, string>> => {
    const out: Record<string, string> = allowSecretEnv ? { ...(secretEnv ?? {}) } : {};
    for (const [k, v] of Object.entries(map ?? {})) {
      const val = String(v);
      if (val.startsWith('secret:') && allowSecretEnv && secretEnv && Object.prototype.hasOwnProperty.call(secretEnv, k)) {
        // 已物化进 secretEnv 的直接用（避免重复解析）
        out[k] = secretEnv[k];
        continue;
      }
      if (val.includes('secret:')) {
        if (!resolveSecret) throw new Error(`MCP ${k} 用了 secret: 引用但没有解析器`);
        out[k] = await resolveSecretRefsIn(val, resolveSecret);
      } else {
        out[k] = val;
      }
    }
    return out;
  };
  const servers: Record<string, any> = {};
  for (const [name, s] of Object.entries(raw)) {
    const env = await resolveMap(s.env ?? {}, true);
    const headers = await resolveMap(s.headers ?? {}, false);
    servers[name] = toClientServerEntry(s, env, headers);
  }
  return new MCPClient({ id: `l2-mcp-${Date.now().toString(36)}`, servers } as any) as any;
}

/** 每任务进度槽（agent 实例缓存，工具经全局槽拿到当前任务的上报器） */
let activeProgress: ((line: string) => Promise<unknown>) | null = null;
/** 每任务追问槽（ask-artifacts S2.1） */
let activeAsk: ((q: string) => Promise<string>) | null = null;
/** 每任务产物槽（ask-artifacts S2.2） */
let activeArtifact: ((p: { kind: 'image' | 'text' | 'page'; caption?: string; data: string }) => Promise<string | null>) | null = null;

const agentCache = new Map<string, InstanceType<typeof Agent>>();
const sandboxByAgent = new Map<string, CuaSandbox>();
/** 每个 sandbox 当前注入的任务级秘钥键（跨任务清理用） */
const secretKeys = new WeakMap<CuaSandbox, string[]>();

/** tools_json 里的 cua/computer 条目 → CuaSandbox workspace（cua-sandbox-provider S2.3）。 */
function cuaWorkspace(def: ExpertDefSnapshot): { workspace: InstanceType<typeof Workspace>; sandbox: CuaSandbox } | null {
  let list: any[] = [];
  try { list = def.tools_json ? JSON.parse(String(def.tools_json)) : []; } catch { return null; }
  const entry = Array.isArray(list) ? list.find((t) => {
    const id = typeof t === 'string' ? t : String(t?.id ?? '');
    return id === 'cua' || id === 'computer';
  }) : null;
  if (!entry) return null;
  const opts = typeof entry === 'object' ? (entry?.options ?? {}) : {};
  const mode: 'host' | 'vm' = opts.mode === 'host' ? 'host' : opts.mode === 'vm' ? 'vm' : 'vm';
  const sandbox = new CuaSandbox({
    mode,
    spaceId: opts.spaceId ?? (def.id ? `exp-${def.id}` : undefined),
    env: {},
  });
  // 权限策略（S2.3）：deny → 工具短路；ask → 审计放行（弹窗审批递延）；allow → 放行
  // 注意：@mastra/core 1.81 resolveToolConfig 只认 toolsConfig 顶层 hooks（评审 CRITICAL）——统一钩子按工具名分发
  const pol = (k: string): string => String(def.policies?.[k] ?? def.policies?.computer ?? 'ask');
  const tools: any = {
    hooks: {
      beforeToolCall: async (ctx: any) => {
        const name = String(ctx?.workspaceToolName ?? ctx?.toolName ?? ctx?.name ?? '');
        const label = name.replace('mastra_workspace_computer_', '').replace('mastra_workspace_', '');
        const p = pol(`computer_${label}`);
        console.log('[cua-tool]', label, p, JSON.stringify(ctx?.input ?? {}).slice(0, 120));
        if (p === 'deny') return { proceed: false as const, output: `denied by policy (computer_${label})` };
        // ask → 真审批（AGENTS.md §7）：报主人拍板；fail-closed（无通道/未答/拒绝 → 拒绝）
        if (p === 'ask') {
          if (!activeAsk) return { proceed: false as const, output: 'denied: 需要审批但问答通道未接通' };
          const ans = String((await activeAsk(`权限确认：要执行「${label}」，允许还是拒绝？（回复 允许 / 拒绝）`).catch(() => '')) ?? '').trim();
          const allow = /允许|可以|同意|继续|^y(es)?$/i.test(ans) && !/拒绝|不行|不要|^n(o)?$/i.test(ans);
          if (!allow) return { proceed: false as const, output: 'denied by owner' };
        }
        return undefined;
      },
    },
    [WORKSPACE_TOOLS.COMPUTER.SCREENSHOT]: { enabled: pol('computer_screenshot') !== 'deny' },
    [WORKSPACE_TOOLS.COMPUTER.CLICK]: { screenshotAfterAction: true },
    [WORKSPACE_TOOLS.COMPUTER.DOUBLE_CLICK]: { screenshotAfterAction: true },
    [WORKSPACE_TOOLS.COMPUTER.RIGHT_CLICK]: { screenshotAfterAction: true },
    [WORKSPACE_TOOLS.COMPUTER.TYPE]: {},
    [WORKSPACE_TOOLS.COMPUTER.PRESS_KEY]: {},
  };
  const workspace = new Workspace({ sandbox, tools } as any) as any;
  return { workspace, sandbox };
}

/** def → Mastra Agent（JIT 装配；按 def.id+updated_at 缓存实例）。 */
export async function buildL2Agent(def: ExpertDefSnapshot, harnessFallback?: string | null): Promise<InstanceType<typeof Agent>> {
  const key = `${def.id ?? 'anon'}:${def.updated_at ?? 0}`;
  const hit = agentCache.get(key);
  if (hit) return hit;
  // 同 def.id 只保留最新一份（评审 MINOR：缓存不失效旧条目；sandbox 同步清）
  for (const k of [...agentCache.keys()]) if (k !== key && k.startsWith(`${def.id ?? 'anon'}:`)) {
    agentCache.delete(k);
    const old = sandboxByAgent.get(k);
    if (old) { sandboxByAgent.delete(k); secretKeys.delete(old); }
  }
  const skills = buildSkills(def.skills_json);
  const tools = resolveTools(def.tools_json, harnessFallback);
  // 每位专家都带 report_progress（l2-progress S2.3）：Grok 式一句话进度；描述走 persona 下发（零写死）
  tools.report_progress = makeProgressTool(() => activeProgress, def.progress_desc || undefined);
  // judgment call 追问 + 产物上报（ask-artifacts S2.1/S2.2）
  tools.ask_user = makeAskTool(() => activeAsk, def.ask_desc || undefined);
  tools.save_artifact = makeArtifactTool(() => activeArtifact, def.artifact_desc || undefined);
  const cw = cuaWorkspace(def);
  const agent = new Agent({
    id: `l2-${def.id ?? def.name ?? 'expert'}`,
    name: String(def.name ?? 'expert'),
    instructions: String(def.instructions || FALLBACK_INSTRUCTIONS),
    model: (def.model || process.env.L2_EXPERT_MODEL || 'deepseek/deepseek-chat') as any,
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(skills.length ? { skills } : {}),
    ...(cw ? { workspace: cw.workspace } : {}),
    memory: buildMemory(def.memory_json),
  } as any) as any;
  agentCache.set(key, agent);
  if (cw) sandboxByAgent.set(key, cw.sandbox);
  return agent;
}

/** 真执行：JIT 构建 + thread 对齐记忆 +（可选）MCP toolsets（握手失败降级为无工具，不挂任务）。 */
export async function runExpertAgent(task: L2ExpertTask): Promise<string> {
  const def: ExpertDefSnapshot = task.def ?? {
    id: task.expertId, name: task.name, instructions: task.instructions, model: task.model,
    updated_at: 0,
  };
  const agent = await buildL2Agent(def, task.harness);
  // 进度槽挂到本任务（report_progress 工具经全局槽分发）
  activeProgress = task.reportProgress ?? null;
  activeAsk = task.askQuestion ?? null;
  activeArtifact = task.uploadArtifact ?? null;
  // 任务级秘钥 env 注入 sandbox（setEnv 合并进每次命令；用后即清上一轮键，防跨任务残留——评审 MAJOR）
  const sb = sandboxByAgent.get(`${def.id ?? 'anon'}:${def.updated_at ?? 0}`);
  if (sb && task.secretEnv) {
    const prev = secretKeys.get(sb) ?? [];
    sb.setEnv((e) => {
      const n: Record<string, string | undefined> = { ...e };
      for (const k of prev) delete n[k];
      return { ...n, ...task.secretEnv };
    });
    secretKeys.set(sb, Object.keys(task.secretEnv));
  }
  const threadId = String(task.threadId || `expert-${Date.now()}`);
  const resourceId = String(task.resourceId || 'user:master');
  const mcp = await buildMcpClient(def.mcp_json, task.resolveSecret, task.secretEnv);
  try {
    let extra: any = {};
    if (mcp) {
      try { extra = { toolsets: await (mcp as any).listToolsets() }; }
      catch (e: any) { console.log('[expert] mcp toolsets unavailable, continue without', String(e?.message ?? e).slice(0, 100)); }
    }
    const res: any = await agent.generate([{ role: 'user', content: String(task.prompt).slice(0, 20000) }], {
      memory: { thread: threadId, resource: resourceId },
      // 步数预算要盖住「多步任务 + 收尾汇总」：默认步数会把循环掐断在最后一步前（结果只剩开头意图句）
      maxSteps: 20,
      ...extra,
    } as any);
    let out = String(res?.text ?? '').trim();
    // 兜底：正文过短且有工具轨迹时，从工具结果拼一段执行记录（防「空终稿」）
    if (out.length < 40 && Array.isArray(res?.steps)) {
      const notes: string[] = [];
      for (const s of res.steps) {
        for (const tr of s?.toolResults ?? []) {
          const v = tr?.result ?? tr?.output ?? '';
          const t = typeof v === 'string' ? v : JSON.stringify(v);
          if (t) notes.push(String(t).slice(0, 120));
        }
        for (const tc of s?.toolCalls ?? []) {
          if (tc?.toolName === 'report_progress' && tc?.args?.line) notes.push(`播报：${tc.args.line}`);
        }
      }
      if (notes.length) out = `${out ? out + '\n' : ''}（执行记录）${notes.slice(-8).join('；')}`;
    }
    return out || '(empty expert reply)';
  } finally {
    activeProgress = null;
    activeAsk = null;
    activeArtifact = null;
    if (mcp) { try { await (mcp as any).disconnect(); } catch {} }
  }
}
