/**
 * Harness 目录与检测（harness-registry S2.1/S2.2）：
 * 数据驱动清单（harnesses.json + 用户自定义）→ 本机检测（捆绑路径/PATH + --version）→ resolve 供 AcpAgent 起进程。
 * 检测是本机行为：结果只留本机/面板，不上云。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HarnessInstall = { type: 'npx' | 'brew' | 'script' | 'manual'; cmd?: string; note?: string };
export type HarnessDef = {
  id: string;
  name: string;
  vendor?: string;
  acp: 'native' | 'adapter' | 'none';
  command: string;
  args: string[];
  /** 版本探活候选（首个在 PATH 的）；不参与「是否已安装」判定。 */
  detectBins?: string[];
  versionArgs?: string[];
  bundledPaths?: string[];
  /** npx/node 启动器即用（包按需拉取）：启动器在位即视为已安装，还需 `requires` 全部在位。 */
  zeroInstall?: boolean;
  /** 额外必需的本体命令（如适配器之于 claude）；缺失即未安装。 */
  requires?: string[];
  install?: HarnessInstall;
  homepage?: string;
  note?: string;
};
export type HarnessStatus = HarnessDef & { installed: boolean; path?: string; version?: string; error?: string };

const USER_FILE = () => join(homedir(), '.config', 'mastra-l2', 'harnesses.json');

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 内置目录 + 用户自定义（同 id 覆盖、新 id 追加）。 */
export function loadCatalog(): HarnessDef[] {
  // fileURLToPath 而非 URL.pathname：打包路径含空格（如 "Mastra Desktop.app"）时 pathname 是百分号编码
  const builtIn: HarnessDef[] = (readJson(presolve(fileURLToPath(new URL('./harnesses.json', import.meta.url)))) ?? {}).harnesses ?? [];
  const user: HarnessDef[] = (readJson(USER_FILE()) ?? {}).harnesses ?? [];
  const byId = new Map<string, HarnessDef>();
  for (const h of [...builtIn, ...user]) if (h?.id) byId.set(h.id, h);
  return [...byId.values()];
}

function which(bin: string): string | null {
  try {
    const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).trim().split('\n')[0];
    return p || null;
  } catch { return null; }
}

/** npx/node 是启动器不是 harness 本体：不能拿启动器在位冒充「已安装」，也不能拿启动器版本冒充 harness 版本。 */
const isLauncher = (bin: string) => bin === 'npx' || bin === 'node';

/** 解析本体可执行位置：bundledPaths（绝对文件优先）→ detectBins/command 的 PATH（启动器命令不参与）。 */
export function resolveBin(h: HarnessDef): string | null {
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  for (const p of h.bundledPaths ?? []) {
    const abs = p.replace(/^~(?=$|\/)/, homedir());
    if (isFile(abs)) return abs;
  }
  const bins = [...(h.detectBins ?? []), ...(isLauncher(h.command) ? [] : [h.command])];
  for (const bin of bins) {
    if (!bin) continue;
    if (bin.includes('/') && isFile(bin)) return bin;
    const w = which(bin);
    if (w && isFile(w)) return w;
  }
  return null;
}

/** 单条检测：存在性 + 版本探活。 */
export function detectOne(h: HarnessDef): HarnessStatus {
  const missing = (h.requires ?? []).filter((b) => !which(b));
  if (missing.length) return { ...h, installed: false, error: `missing: ${missing.join(', ')}` };
  let path = resolveBin(h);
  if (!path) {
    // zeroInstall（npx/node 启动器按需拉包）：启动器在位即视为可用；其余按本体在位判定
    if (h.zeroInstall && isLauncher(h.command)) path = which(h.command);
    if (!path) return { ...h, installed: false, error: 'not found' };
  }
  // 版本探活只探本体（detectBins 首个在位的，或非启动器 command）；失败不挡已安装判定
  const probeBin = (h.detectBins ?? []).find((b) => which(b)) ?? (isLauncher(h.command) ? null : h.command);
  let version = '';
  if (probeBin) {
    try {
      const r = spawnSync(probeBin, h.versionArgs ?? ['--version'], { encoding: 'utf8', timeout: 8_000 });
      version = String(r.stdout ?? '').trim().split('\n')[0].slice(0, 60);
    } catch { /* 版本探活失败不挡已安装判定 */ }
  }
  return { ...h, installed: true, path, version: version || undefined };
}

/** 全目录检测。 */
export function detectAll(): HarnessStatus[] {
  return loadCatalog().map(detectOne);
}

/** 设备默认 harness（device.json.harness），供无显式 id 时的三级选择兜底。 */
export function deviceDefaultHarness(): string | null {
  try {
    const j = JSON.parse(readFileSync(USER_FILE().replace(/harnesses\.json$/, 'device.json'), 'utf8'));
    return typeof j?.harness === 'string' && j.harness ? j.harness : null;
  } catch { return null; }
}

/**
 * 解析运行配置：显式 id > 设备默认（device.json.harness）> dsh。
 * 未知显式 id / acp:'none' 直接抛错（评审 MAJOR：不许静默降级跑错 harness）。
 */
export function resolveHarness(id?: string | null): { id: string; command: string; args: string[]; def?: HarnessDef } {
  const cat = loadCatalog();
  const want = id || deviceDefaultHarness();
  if (want) {
    const def = cat.find((h) => h.id === want);
    if (!def) {
      if (id) throw new Error(`unknown harness: ${id}`);
    } else if (def.acp === 'none') {
      if (id) throw new Error(`harness ${id} 不支持 ACP，请改用 CUA 通道`);
    } else {
      const starter = isLauncher(def.command);
      const bin = starter ? def.command : (resolveBin(def) ?? def.command);
      return { id: def.id, command: bin, args: def.args ?? [], def };
    }
  }
  const def = cat.find((h) => h.id === 'dsh') || cat[0];
  if (!def) return { id: 'dsh', command: 'dsh', args: ['--profile', 'acp'] };
  return { id: def.id, command: def.command, args: def.args ?? [], def };
}
