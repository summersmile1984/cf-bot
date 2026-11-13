/**
 * CuaSandbox —— Mastra WorkspaceSandbox + SandboxComputer provider（cua-sandbox-provider S2.1）。
 * 双模式：host=专用机直控（cua do switch host）；vm=按 spaceId get-or-create cua Space（本地/云）。
 * 目标选择是 cua CLI 的全局状态 → 所有动作经 withTarget 串行化（switch+op 配对）。
 * 秘钥 env 经构造/setEnv 注入每次命令（secrets-inject 物化产物直接喂入）。
 */
import { MastraSandbox } from '@mastra/core/workspace';
import type {
  SandboxComputer, ComputerScreenshot, ComputerScreenSize, ComputerPosition,
  CommandResult, ExecuteCommandOptions, SandboxStartOptions, SandboxInfo,
} from '@mastra/core/workspace';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type CuaSandboxOptions = {
  /** host=直控本机（专用机）；vm=操作 cua Space，host 归用户 */
  mode: 'host' | 'vm';
  /** vm 模式：Space 逻辑 id（get-or-create） */
  spaceId?: string;
  /** vm 模式 create 用镜像（默认 env.CUA_IMAGE） */
  image?: string;
  /** cua 可执行文件（默认：CUA_BIN → PATH → ~/.local/bin/cua） */
  bin?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
};

/** VM 镜像默认与 host OS 同族（S2.4 用户定调）：macOS host → macOS VM；Linux/Windows 同理。 */
export function hostDefaultImage(): string {
  if (process.platform === 'darwin') return 'ghcr.io/trycua/macos:26-slim';
  if (process.platform === 'win32') return 'ghcr.io/trycua/windows:2022';
  return 'ghcr.io/trycua/linux:24.04-slim-disk';
}

function resolveCuaBin(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.CUA_BIN?.trim();
  if (fromEnv) return fromEnv;
  const local = join(homedir(), '.local', 'bin', 'cua');
  return existsSync(local) ? local : 'cua';
}

function runCua(bin: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...opts.env, PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}` } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cua ${args[0]} timeout`)); }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

// ---- 全局目标锁：cua 的 target 是进程外全局状态，switch+op 必须配对串行 ----
let targetChain: Promise<unknown> = Promise.resolve();
let currentTarget: string | null = null;
function withTarget<T>(bin: string, target: string, fn: (env: Record<string, string | undefined>) => Promise<T>, env: Record<string, string | undefined>): Promise<T> {
  const run = targetChain.then(async () => {
    if (currentTarget !== target) {
      const sw = await runCua(bin, ['do', 'switch', target], { timeoutMs: 30_000 });
      if (sw.code !== 0) throw new Error(`cua do switch ${target} failed: ${(sw.stderr || sw.stdout).slice(0, 200)}`);
      currentTarget = target;
    }
    return fn(env);
  });
  targetChain = run.catch(() => {});
  return run;
}

// ---- viewer（streamUrl）：常驻 cua viewer，进程内去重 + 可释放 ----
let viewerProc: ReturnType<typeof spawn> | null = null;
let viewerUrl: string | null = null;
let viewerStarting: Promise<string | null> | null = null;
async function ensureViewer(bin: string): Promise<string | null> {
  if (viewerUrl) return viewerUrl;
  if (viewerStarting) return viewerStarting;
  viewerStarting = new Promise((resolve) => {
    const child = spawn(bin, ['viewer', '--no-open'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.unref();
    const t = setTimeout(() => resolve(viewerUrl), 5000);
    child.stdout.on('data', (d: Buffer) => {
      const m = d.toString().match(/https?:\/\/\S+/);
      if (m && !viewerUrl) {
        viewerUrl = m[0].replace(/\s+$/, '');
        clearTimeout(t);
        resolve(viewerUrl);
      }
    });
    child.on('error', () => { clearTimeout(t); viewerStarting = null; resolve(null); });
    viewerProc = child;
  });
  return viewerStarting;
}

/** 释放 viewer（destroy 时调用；共享进程，尽力而为）。 */
export function disposeViewer(): void {
  try { viewerProc?.kill('SIGTERM'); } catch {}
  viewerProc = null;
  viewerUrl = null;
  viewerStarting = null;
}

export class CuaSandbox extends MastraSandbox<string> {
  readonly id: string;
  readonly name = 'Cua Sandbox';
  readonly provider = 'cua';
  status: MastraSandbox<string>['status'] = 'pending';
  readonly mode: 'host' | 'vm';
  readonly computer: SandboxComputer;
  private readonly bin: string;
  private readonly spaceId?: string;
  private readonly image: string;
  private target: string;

  constructor(opts: CuaSandboxOptions) {
    super({ workingDirectory: opts.workingDirectory, env: opts.env } as any);
    this.mode = opts.mode;
    this.bin = resolveCuaBin(opts.bin);
    this.spaceId = opts.spaceId;
    this.image = opts.image || process.env.CUA_IMAGE || hostDefaultImage();
    this.id = opts.mode === 'host' ? 'cua-host' : `cua-space-${opts.spaceId ?? 'default'}`;
    this.target = opts.mode === 'host' ? 'host' : (opts.spaceId ? `local:${opts.spaceId}` : 'host');
    this._workingDirectory = opts.workingDirectory;
    this.computer = this.makeComputer();
  }

  /** 目标 ref（do switch 用） */
  private get targetRef(): string { return this.target; }

  private async act(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return withTarget(this.bin, this.targetRef, (env) => runCua(this.bin, args, { timeoutMs, env }), this.getEnv());
  }

  private makeComputer(): SandboxComputer {
    const A = (args: string[], timeoutMs?: number) => this.act(args, timeoutMs).then((r) => {
      if (r.code !== 0) throw new Error(`cua ${args.slice(0, 2).join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 200)}`);
      return r;
    });
    return {
      screenshot: async (): Promise<ComputerScreenshot> => {
        const dir = mkdtempSync(join(tmpdir(), 'cua-shot-'));
        const p = join(dir, 's.png');
        try {
          await A(['do', 'screenshot', '-s', p], 60_000);
          return { data: new Uint8Array(readFileSync(p)), mediaType: 'image/png' };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      },
      leftClick: (x, y) => A(['do', 'click', String(Math.round(x)), String(Math.round(y))]).then(() => {}),
      rightClick: (x, y) => A(['do', 'click', String(Math.round(x)), String(Math.round(y)), 'right']).then(() => {}),
      doubleClick: (x, y) => A(['do', 'dclick', String(Math.round(x)), String(Math.round(y))]).then(() => {}),
      moveMouse: (x, y) => A(['do', 'move', String(Math.round(x)), String(Math.round(y))]).then(() => {}),
      drag: (from, to) => A(['do', 'drag', String(Math.round(from.x)), String(Math.round(from.y)), String(Math.round(to.x)), String(Math.round(to.y))]).then(() => {}),
      scroll: (direction, amount) => A(['do', 'scroll', direction, String(Math.max(1, Math.round(amount)))]).then(() => {}),
      type: (text) => A(['do', 'type', text]).then(() => {}),
      press: (key) => Array.isArray(key)
        ? A(['do', 'hotkey', key.join('+')]).then(() => {})
        : A(['do', 'key', key]).then(() => {}),
      getScreenSize: async (): Promise<ComputerScreenSize> => {
        // 用截图 PNG 头读显示尺寸（cua 无独立 screen-size 子命令）
        const dir = mkdtempSync(join(tmpdir(), 'cua-size-'));
        const p = join(dir, 's.png');
        try {
          await A(['do', 'screenshot', '-s', p]);
          const b = readFileSync(p);
          return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      },
      getCursorPosition: async (): Promise<ComputerPosition> => {
        const r = await A(['do', 'cursor']);
        const m = r.stdout.match(/(-?\d+)\D+(-?\d+)/);
        return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0) };
      },
      streamUrl: async (): Promise<string | null> => {
        if (this.mode !== 'vm') return null;
        const base = await ensureViewer(this.bin);
        return base ? `${base}${base.includes('?') ? '&' : '?'}id=${encodeURIComponent(this.target)}` : null;
      },
    };
  }

  // ---- 生命周期（rung 1：find/connect/create，outcome 由基类推导）----
  protected async find(_options?: SandboxStartOptions): Promise<string | undefined> {
    if (this.mode === 'host') {
      const r = await runCua(this.bin, ['do', 'status'], { timeoutMs: 15_000 });
      return r.code === 0 ? 'host' : undefined;
    }
    const r = await runCua(this.bin, ['sb', 'info', String(this.spaceId)], { timeoutMs: 30_000 });
    return r.code === 0 ? this.target : undefined;
  }

  protected async connect(handle: string, _options?: SandboxStartOptions): Promise<void> {
    this.target = handle;
    if (this.mode === 'vm') {
      await runCua(this.bin, ['sb', 'resume', String(this.spaceId)], { timeoutMs: 120_000 }).catch(() => undefined);
    }
    currentTarget = null; // 强制下次 op 重新 switch
  }

  protected async create(_options?: SandboxStartOptions): Promise<void> {
    if (this.mode === 'host') {
      // host 没有“创建”：探测 do 可用（权限未授予时此处失败并给出指引）
      const r = await runCua(this.bin, ['do', 'status'], { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(`host 模式不可用（授权？）：${(r.stderr || r.stdout).slice(0, 160)}`);
      this.target = 'host';
      currentTarget = null;
      return;
    }
    if (!this.image) throw new Error('vm 模式需要 image（构造参数或 CUA_IMAGE）');
    // --name 必须与 spaceId 对齐（评审 CRITICAL）：否则生成 sb-* 名字，do switch <spaceId> 找不到
    const nameArg = this.spaceId ? ['--name', String(this.spaceId)] : [];
    const r = await runCua(this.bin, ['sb', 'create', this.image, '--on', 'local', ...nameArg], { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`cua sb create failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    this.target = this.spaceId ? `local:${this.spaceId}` : this.target;
    currentTarget = null;
  }

  // ---- 命令执行 ----
  async executeCommand(command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<CommandResult> {
    // 两种调用形态：workspace 工具传整行（args 空）→ 作为脚本原文；(cmd, args[]) → 逐词引用
    const script = args.length
      ? [command, ...args].map((s) => (/^[\w./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)).join(' ')
      : String(command);
    const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const cwd = options.cwd || this._workingDirectory;
    const inner = `${cwd ? `cd ${q(cwd)} && ` : ''}/bin/bash -lc ${q(script)}`;
    const env = { ...(options.env ?? {}) };
    const r = await withTarget(this.bin, this.targetRef, (e) => runCua(this.bin, ['do', 'shell', '--', inner], {
      timeoutMs: options.timeout ?? 120_000, env: { ...e, ...env },
    }), this.getEnv());
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr } as CommandResult;
  }

  async getInfo(): Promise<SandboxInfo> {
    return { status: this.status === 'running' ? 'running' : this.status } as SandboxInfo;
  }

  getInstructions(): string {
    return this.mode === 'host'
      ? 'CUA host 模式：直接控制本机桌面（专用机）。动作会真实影响主机。'
      : `CUA vm 模式：操作虚拟机 Space（${this.spaceId ?? 'default'}），用户 host 不受影响。`;
  }

  async stop(): Promise<void> {
    if (this.mode === 'vm' && this.spaceId) await runCua(this.bin, ['sb', 'suspend', this.spaceId], { timeoutMs: 120_000 }).catch(() => undefined);
    this.status = 'stopped';
  }

  async destroy(): Promise<void> {
    if (this.mode === 'vm' && this.spaceId) {
      await runCua(this.bin, ['sb', 'rm', '--force', this.spaceId], { timeoutMs: 120_000 }).catch(() => undefined);
    }
    disposeViewer();
    this.status = 'destroyed';
  }
}
