/**
 * 多设备（multi-device S2.2/S2.3）：设备身份、配对码、任务设备路由。
 * - 配对：web 生成一次性码（10 分钟）→ 桌面 POST /devices/pair → 换 deviceId + device token（长期，可吊销）
 * - claim 认证：device token（token_hash 匹配）优先；共享 PUSH_TOKEN 老路径兼容（匿名设备）
 * - 任务绑定语义（S2.1 决策）：派发时解析——显式 device > 用户默认设备 > NULL（抢单）；
 *   claim 过滤 state='queued' AND (device_id IS NULL OR device_id=me)，原子领取不变
 */
import { createHash, randomBytes } from 'node:crypto';

export type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  capabilities: string | null;
  last_seen_at: number | null;
  status: string;
  is_default: number;
  created_at: number;
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export async function ensureDeviceTables(db: any): Promise<void> {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL,
      capabilities TEXT, last_seen_at INTEGER, status TEXT NOT NULL DEFAULT 'active', is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`,
    'ALTER TABLE l2_tasks ADD COLUMN device_id TEXT',
    'ALTER TABLE l2_tasks ADD COLUMN owner_id TEXT',
    'ALTER TABLE user_settings ADD COLUMN default_device_id TEXT',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
}

export async function createPairingCode(db: any, userId: string): Promise<{ code: string; expiresAt: number }> {
  await ensureDeviceTables(db);
  const code = randomBytes(4).toString('hex').toUpperCase(); // 8 位可输入码
  const expiresAt = Date.now() + 10 * 60_000;
  await db.prepare('INSERT INTO pairing_codes (code,user_id,expires_at,used) VALUES (?,?,?,0)').bind(code, userId, expiresAt).run();
  return { code, expiresAt };
}

/** 配对：一次性码换设备凭据 */
export async function registerDevice(
  db: any,
  code: string,
  input: { name?: string; capabilities?: Record<string, unknown> },
): Promise<{ ok: true; deviceId: string; token: string; userId: string } | { ok: false; reason: string }> {
  await ensureDeviceTables(db);
  const row: any = await db.prepare('SELECT * FROM pairing_codes WHERE code=?').bind(String(code ?? '').trim()).first();
  if (!row || Number(row.used) || Date.now() > Number(row.expires_at)) return { ok: false, reason: '配对码无效或已过期' };
  await db.prepare('UPDATE pairing_codes SET used=1 WHERE code=?').bind(row.code).run();
  const deviceId = `device-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  const name = String(input.name ?? '').trim().slice(0, 40) || `设备-${deviceId.slice(-4)}`;
  await db
    .prepare('INSERT INTO devices (id,user_id,name,token_hash,capabilities,last_seen_at,status,is_default,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .bind(deviceId, row.user_id, name, hash(token), JSON.stringify(input.capabilities ?? {}), Date.now(), 'active', Date.now())
    .run();
  return { ok: true, deviceId, token, userId: String(row.user_id) };
}

/** device token → 设备行（claim 认证）；并刷新 last_seen */
export async function authDevice(db: any, token: string): Promise<DeviceRow | null> {
  try {
    await ensureDeviceTables(db);
    const row: any = await db.prepare('SELECT * FROM devices WHERE token_hash=?').bind(hash(String(token ?? ''))).first();
    if (!row || String(row.status) !== 'active') return null;
    await db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').bind(Date.now(), row.id).run().catch(() => null);
    return row as DeviceRow;
  } catch {
    return null;
  }
}

export async function listDevices(db: any, userId: string): Promise<DeviceRow[]> {
  await ensureDeviceTables(db);
  const { results } = await db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY created_at').bind(userId).all();
  return (results ?? []) as DeviceRow[];
}

export async function revokeDevice(db: any, userId: string, deviceId: string): Promise<boolean> {
  const u = await db.prepare("UPDATE devices SET status='revoked', is_default=0 WHERE id=? AND user_id=?").bind(deviceId, userId).run();
  if (u?.meta?.changes) {
    await db.prepare('UPDATE user_settings SET default_device_id=NULL WHERE user_id=? AND default_device_id=?').bind(userId, deviceId).run().catch(() => null);
  }
  return !!u?.meta?.changes;
}

export async function renameDevice(db: any, userId: string, deviceId: string, name: string): Promise<boolean> {
  const u = await db.prepare('UPDATE devices SET name=? WHERE id=? AND user_id=?').bind(String(name).trim().slice(0, 40), deviceId, userId).run();
  return !!u?.meta?.changes;
}

export async function setDefaultDevice(db: any, userId: string, deviceId: string | null): Promise<{ ok: boolean; reason?: string }> {
  await ensureDeviceTables(db);
  if (deviceId) {
    const d: any = await db.prepare("SELECT id FROM devices WHERE id=? AND user_id=? AND status='active'").bind(deviceId, userId).first();
    if (!d) return { ok: false, reason: '设备不存在或已吊销' };
    await db.prepare('UPDATE devices SET is_default=0 WHERE user_id=?').bind(userId).run();
    await db.prepare('UPDATE devices SET is_default=1 WHERE id=? AND user_id=?').bind(deviceId, userId).run();
    await db.prepare('INSERT INTO user_settings (user_id, auto_review, default_device_id, updated_at) VALUES (?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET default_device_id=excluded.default_device_id, updated_at=excluded.updated_at')
      .bind(userId, deviceId, Date.now()).run().catch(() => null);
  } else {
    await db.prepare('UPDATE devices SET is_default=0 WHERE user_id=?').bind(userId).run();
    await db.prepare('UPDATE user_settings SET default_device_id=NULL WHERE user_id=?').bind(userId).run().catch(() => null);
  }
  return { ok: true };
}

/**
 * 派发时解析任务设备（S2.1）：显式（设备名或 id）> 用户默认设备 > NULL（抢单）。
 * 显式指向无效设备时返回错误（不闷派）。
 */
export async function resolveDeviceForTask(
  db: any,
  userId: string,
  explicit?: string | null,
): Promise<{ ok: true; deviceId: string | null } | { ok: false; reason: string }> {
  await ensureDeviceTables(db);
  const exp = String(explicit ?? '').trim();
  if (exp) {
    const row: any = await db
      .prepare("SELECT id FROM devices WHERE user_id=? AND status='active' AND (id=? OR name=?)")
      .bind(userId, exp, exp)
      .first();
    if (!row) return { ok: false, reason: `找不到可用设备「${exp}」（先在 管理→设备 里配对）` };
    return { ok: true, deviceId: String(row.id) };
  }
  const def: any = await db.prepare('SELECT default_device_id FROM user_settings WHERE user_id=?').bind(userId).first().catch(() => null);
  const defId = def?.default_device_id ? String(def.default_device_id) : null;
  if (defId) {
    const live: any = await db.prepare("SELECT id FROM devices WHERE id=? AND status='active'").bind(defId).first();
    if (live) return { ok: true, deviceId: defId };
  }
  return { ok: true, deviceId: null }; // 无默认 → 抢单
}
