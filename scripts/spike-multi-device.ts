/**
 * 多设备回归（multi-device S2.1/S2.2）：node:sqlite 适配 D1 形状接口，真 SQL 验证。
 * 配对码一次性/过期、设备认证、吊销失效、改名、默认设备、任务设备解析链。
 * 运行：npx tsx scripts/spike-multi-device.ts
 */
import { DatabaseSync } from 'node:sqlite';
import {
  ensureDeviceTables, createPairingCode, registerDevice, authDevice,
  listDevices, revokeDevice, renameDevice, setDefaultDevice, resolveDeviceForTask,
} from '../src/mastra/devices';

const db = new DatabaseSync(':memory:');
const d1 = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            const st = db.prepare(sql);
            const r = st.run(...(args as never[]));
            return { meta: { changes: Number(r.changes) } };
          },
          async first() {
            const st = db.prepare(sql);
            return st.get(...(args as never[])) ?? null;
          },
          async all() {
            const st = db.prepare(sql);
            return { results: st.all(...(args as never[])) };
          },
        };
      },
      async run() { return this.bind().run(); },
    };
  },
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // user_settings 基表（生产由早期迁移建立；devices 层只 ALTER 加 default_device_id）
  db.exec('CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, auto_review INTEGER, harness TEXT, updated_at INTEGER)');
  await ensureDeviceTables(d1);
  const uid = 'u-e2e';

  // ① 配对码：8 位、10 分钟有效
  const p1 = await createPairingCode(d1, uid);
  check('① 配对码格式', /^[0-9A-F]{8}$/.test(p1.code), p1.code);
  check('① 有效期 10 分钟', Math.abs(p1.expiresAt - Date.now() - 600_000) < 5_000);

  // ② 配对换设备凭据
  const regA = await registerDevice(d1, p1.code, { name: '公司电脑', capabilities: { platform: 'mac' } });
  check('② 配对成功', regA.ok && !!regA.token && !!regA.deviceId, regA.ok ? regA.deviceId : JSON.stringify(regA));
  if (!regA.ok) return finish();
  const devA = regA.deviceId;

  // ③ 配对码一次性
  const reuse = await registerDevice(d1, p1.code, { name: '再来一台' });
  check('③ 配对码不可复用', !reuse.ok);
  const expired = await registerDevice(d1, 'DEADBEEF', {});
  check('③ 无效码拒绝', !expired.ok);

  // ④ 设备认证（token → 设备；坏 token → null）
  const authA = await authDevice(d1, regA.token);
  check('④ device token 认证', !!authA && authA.id === devA);
  check('④ 坏 token 拒绝', (await authDevice(d1, 'nope')) === null);

  // ⑤ 第二台设备（B）
  const p2 = await createPairingCode(d1, uid);
  const regB = await registerDevice(d1, p2.code, { name: '家里电脑' });
  check('⑤ 第二台配对', regB.ok, regB.ok ? regB.deviceId : '');
  if (!regB.ok) return finish();
  const devB = regB.deviceId;

  // ⑥ 列表 / 改名
  const list1 = await listDevices(d1, uid);
  check('⑥ 列表 2 台', list1.length === 2);
  check('⑥ 改名', await renameDevice(d1, uid, devA, '公司电脑-新') && (await listDevices(d1, uid)).some((d) => d.name === '公司电脑-新'));

  // ⑦ 解析链：显式（名字/id）> 默认 > 抢单
  const rName = await resolveDeviceForTask(d1, uid, '家里电脑');
  check('⑦ 显式按名解析', rName.ok && rName.deviceId === devB, JSON.stringify(rName));
  const rId = await resolveDeviceForTask(d1, uid, devA);
  check('⑦ 显式按 id 解析', rId.ok && rId.deviceId === devA);
  const rBad = await resolveDeviceForTask(d1, uid, '不存在的机器');
  check('⑦ 无效设备名报错', !rBad.ok, rBad.ok ? '' : rBad.reason);
  const rNone = await resolveDeviceForTask(d1, uid, null);
  check('⑦ 无默认 → 抢单(NULL)', rNone.ok && rNone.deviceId === null);

  // ⑧ 默认设备
  await setDefaultDevice(d1, uid, devA);
  const rDef = await resolveDeviceForTask(d1, uid, null);
  check('⑧ 默认设备绑定', rDef.ok && rDef.deviceId === devA, JSON.stringify(rDef));
  const rDefOverride = await resolveDeviceForTask(d1, uid, '家里电脑');
  check('⑧ 显式覆盖默认', rDefOverride.ok && rDefOverride.deviceId === devB);

  // ⑨ 吊销：认证失效 + 不可被解析
  check('⑨ 吊销 B', await revokeDevice(d1, uid, devB));
  check('⑨ 吊销后 token 失效', (await authDevice(d1, regB.token)) === null);
  const rRevoked = await resolveDeviceForTask(d1, uid, '家里电脑');
  check('⑨ 吊销后解析报错', !rRevoked.ok);
  const rDefRevoked = await setDefaultDevice(d1, uid, devB);
  check('⑨ 吊销设备不可设默认', !rDefRevoked.ok);

  // ⑩ 默认指向已吊销 → 回落抢单；取消默认 → 抢单
  await setDefaultDevice(d1, uid, devA);
  await revokeDevice(d1, uid, devA);
  // 人为回插悬挂 default（模拟吊销清理遗漏/并发）：解析必须回落抢单而非报错
  await d1.prepare('UPDATE user_settings SET default_device_id=? WHERE user_id=?').bind(devA, uid).run();
  const rFall = await resolveDeviceForTask(d1, uid, null);
  check('⑩ 默认失效回落抢单', rFall.ok && rFall.deviceId === null, JSON.stringify(rFall));
  await setDefaultDevice(d1, uid, null);
  const rClear = await resolveDeviceForTask(d1, uid, null);
  check('⑩ 取消默认 → 抢单', rClear.ok && rClear.deviceId === null);

  finish();
}

function finish() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} passed${fail ? `，${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
