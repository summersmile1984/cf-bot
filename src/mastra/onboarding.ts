/**
 * 首跑引导（onboarding）：部署完打开站点 → 无用户时强制进 /setup 向导。
 * ①创建管理员（第一个用户 = 管理员）②配置检查（DEEPSEEK_API_KEY / L1_PUBLIC_URL / 产品名）
 * ③默认关闭开放注册（管理员可在设置里重开）——注册闸门由 /auth/* catch-all 调 isSignUpOpen 执行。
 */
import { getAuth } from '../auth';

export type OnboardingStatus = {
  needsSetup: boolean;
  signupsOpen: boolean;
  checks: { deepseekKey: boolean; l1PublicUrl: string; detectedOrigin: string; productName: string };
};

export async function ensureAppSettings(db: any): Promise<void> {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)')
    .run()
    .catch(() => null);
}

async function getSetting(db: any, key: string): Promise<string | null> {
  const row: any = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first();
  return row?.value ?? null;
}

async function setSetting(db: any, key: string, value: string): Promise<void> {
  await ensureAppSettings(db);
  await db
    .prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .bind(key, value, Date.now())
    .run();
}

export async function userCount(db: any): Promise<number> {
  const row: any = await db.prepare('SELECT COUNT(*) AS n FROM user').first().catch(() => null);
  return Number(row?.n ?? 0);
}

/** 注册闸门：无用户（首跑中）或显式开放时允许 sign-up */
export async function isSignUpOpen(db: any): Promise<boolean> {
  try {
    await ensureAppSettings(db);
    const flag = await getSetting(db, 'signups_open');
    if (flag === '1') return true;
    if (flag === '0') return false;
    return (await userCount(db)) === 0; // 未配置：首跑开放，有用户后视作关闭
  } catch {
    return true;
  }
}

export async function getOnboardingStatus(db: any, E: any, requestUrl: string): Promise<OnboardingStatus> {
  await ensureAppSettings(db);
  let origin = '';
  try { origin = new URL(requestUrl).origin; } catch {}
  return {
    needsSetup: (await userCount(db)) === 0,
    signupsOpen: await isSignUpOpen(db),
    checks: {
      deepseekKey: !!E.DEEPSEEK_API_KEY,
      l1PublicUrl: String(E.L1_PUBLIC_URL ?? ''),
      detectedOrigin: origin,
      productName: 'cf-bot',
    },
  };
}

/** 首跑建管：仅无用户时可调；创建第一个用户（=管理员），随即默认关注册 */
export async function completeSetup(
  db: any,
  E: any,
  input: { name?: string; email: string; password: string },
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  await ensureAppSettings(db);
  if ((await userCount(db)) > 0) return { ok: false, reason: '已初始化（setup 只能运行一次）' };
  if (!input.email || !input.password || input.password.length < 8) return { ok: false, reason: '邮箱或密码不合法（密码 ≥8 位）' };
  try {
    const auth = getAuth(E as any);
    const res: any = await (auth.api as any).signUpEmail({
      body: { name: input.name || input.email.split('@')[0], email: input.email, password: input.password },
    });
    const userId = String(res?.user?.id ?? res?.id ?? '');
    if (!userId) return { ok: false, reason: '账号创建失败' };
    await setSetting(db, 'admin_user_id', userId);
    await setSetting(db, 'signups_open', '0'); // 默认关注册（首用户=管理员）
    return { ok: true, userId };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function setSignupsOpen(db: any, userId: string, open: boolean): Promise<{ ok: boolean; reason?: string }> {
  await ensureAppSettings(db);
  const admin = await getSetting(db, 'admin_user_id');
  if (!admin || admin !== userId) return { ok: false, reason: '仅管理员可改' };
  await setSetting(db, 'signups_open', open ? '1' : '0');
  return { ok: true };
}
