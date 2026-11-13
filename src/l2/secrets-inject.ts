/**
 * 沙箱秘钥注入（secret-pipeline 扩展）：CF vault 的 secret:vault-* 句柄 → 明文只进
 * ① 子进程 env（MCP/ACP）② 一次性 0600 文件（dsh 会清洗 env / cua 目标 shell 不继承 env），
 * 任务结束 cleanup 销毁。模型/日志只见句柄。（AGENTS.md §5：派发时绑定为 L2 子进程 env + 一次性 0600 文件）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const VAULT_REF_RE = /secret:(vault-[\w-]+)/g;

export function collectVaultRefs(...texts: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(VAULT_REF_RE)) set.add(`secret:${m[1]}`);
  }
  return [...set];
}

export type MaterializedSecrets = {
  /** 子进程 env（KEY → 明文） */
  env: Record<string, string>;
  /** 0600 文件目录：每 KEY 一个文件，内容为明文 */
  fileDir: string;
  /** 句柄 → env KEY（供 prompt 改写 `$KEY`） */
  byRef: Record<string, string>;
  /** 任务结束调用：销毁文件 */
  cleanup: () => void;
};

/** 把 prompt 里的 secret: 句柄改写成 $ENV_KEY（给 shell 类执行位；模型侧不回填明文）。 */
export function rewriteRefs(text: string, byRef: Record<string, string>): string {
  let out = text;
  for (const [ref, key] of Object.entries(byRef)) out = out.split(ref).join(`$${key}`);
  return out;
}

function envKeyFromName(name: string, used: Set<string>): string {
  let s = String(name).trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'L2_SECRET';
  if (!/^[A-Za-z_]/.test(s)) s = `L2_SECRET_${s}`;
  let out = s, i = 2;
  while (used.has(out)) out = `${s}_${i++}`;
  used.add(out);
  return out;
}

/**
 * 物化秘钥：解析 refs + 显式映射（如 mcp env 的 NAME→句柄），写 0600 文件。
 * resolveSecret 逐句柄取明文（经 L1 /l2-secret，任务授权在 L1 侧）；返回值可带 vault 条目名（env 键名）。
 */
export async function materializeSecrets(opts: {
  refs: string[];
  /** NAME → 句柄或字面值；句柄会被解析，字面值原样进 env */
  explicitEnv?: Record<string, string>;
  resolveSecret: (ref: string) => Promise<{ value: string; name?: string | null } | string>;
  taskId: string;
}): Promise<MaterializedSecrets> {
  const env: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  const used = new Set<string>();
  const fileDir = join(tmpdir(), 'l2-secrets', String(opts.taskId).replace(/[^\w-]/g, '_'));
  mkdirSync(fileDir, { recursive: true, mode: 0o700 });
  const get = async (ref: string) => {
    const r = await opts.resolveSecret(ref);
    return typeof r === 'string' ? { value: r } : r;
  };

  // ① 显式映射（mcp env 等）：NAME 优先
  for (const [name, v] of Object.entries(opts.explicitEnv ?? {})) {
    const val = String(v);
    const key = envKeyFromName(name, used);
    env[key] = val.startsWith('secret:') ? (await get(val)).value : val;
    if (val.startsWith('secret:')) byRef[val] = key;
  }
  // ② 其余句柄：按 vault 条目名命名
  for (const ref of opts.refs) {
    if (byRef[ref]) continue;
    const got = await get(ref);
    const key = envKeyFromName(got.name ?? `L2_SECRET_${Object.keys(byRef).length + 1}`, used);
    env[key] = got.value;
    byRef[ref] = key;
  }
  // 一次性 0600 文件（dsh 清洗 env / cua 目标 shell 不继承 env 时的备用通道）
  for (const [k, v] of Object.entries(env)) writeFileSync(join(fileDir, k), v, { mode: 0o600 });
  return {
    env, fileDir, byRef,
    cleanup: () => { try { rmSync(fileDir, { recursive: true, force: true }); } catch {} },
  };
}

/** 给 shell 类执行位的提示行（对齐 a2a-l2 既有 .l2secret 提示风格）。 */
export function secretsHint(sec: MaterializedSecrets): string {
  const keys = Object.keys(sec.env);
  if (!keys.length) return '';
  return `\n（敏感值在文件 ${sec.fileDir}/<变量名> 中，变量名：${keys.join(', ')}；只能用 $(cat 文件) 引用，绝不打印或写出其内容）`;
}
