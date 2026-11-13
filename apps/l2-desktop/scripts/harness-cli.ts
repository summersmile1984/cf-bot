/**
 * Harness 目录本机操作（单一实现，直接复用 src/l2/harness-registry）。
 * 用法: tsx scripts/harness-cli.ts detect | install <id>
 * 导入路径双候选：dev 树（apps/l2-desktop/scripts → 仓库根 src/l2）与打包资源（registry 与本脚本同目录）。
 */
import { spawnSync } from 'node:child_process';

type RegMod = any;
async function loadMod(name: string): Promise<RegMod> {
  try {
    return await import(new URL(`../../../src/l2/${name}.js`, import.meta.url).href);
  } catch (e1: any) {
    try {
      return await import(new URL(`./${name}.js`, import.meta.url).href);
    } catch (e2: any) {
      throw new Error(`${name} 加载失败：[${String(e1?.message ?? e1).slice(0, 120)}] / [${String(e2?.message ?? e2).slice(0, 120)}]`);
    }
  }
}

const { detectOne, loadCatalog }: RegMod = await loadMod('harness-registry');

const [cmd, id] = process.argv.slice(2);
if (cmd === 'detect') {
  console.log(JSON.stringify(detectAll()));
} else if (cmd === 'install' && id) {
  const h = loadCatalog().find((x: any) => x.id === id);
  if (!h?.install?.cmd) { console.log(JSON.stringify({ ok: false, error: 'no install command' })); process.exit(1); }
  const r = spawnSync('sh', ['-c', h.install.cmd], { encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-500);
  const st = detectOne(h);
  console.log(JSON.stringify({ ok: r.status === 0 && st.installed, exit: r.status, output: out, status: st }));
} else {
  console.log(JSON.stringify({ error: 'usage: detect | install <id>' }));
  process.exit(1);
}

function detectAll() { return loadCatalog().map(detectOne); }
