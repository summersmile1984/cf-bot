/**
 * 通知触达（notifications S2.1/S2.3）：事件先落 `notifications` 表（渠道失败不丢事件），
 * 站内铃铛/通知中心消费；Web Push（有 E 且配 VAPID 时）随新通知出线；桌面/邮件渠道为后续切片。
 * 归属约束（多租户）：一切查询/写回按 user_id 过滤。
 */
import { pushToUser } from './push';
import { sendMail, renderMail } from './mail';
import { getPersona } from './persona';

/**
 * 邮件渠道偏好（notifications S2.3）：事件类型 × 渠道矩阵里服务端可控的一维（邮件）。
 * 站内中心恒开；桌面/Web Push 走浏览器授权；邮件按 kind 开关，默认：决策类 + 额度/订阅类开，任务类关。
 */
const EMAIL_DEFAULT: Record<string, boolean> = {
  'decision.requested': true,
  'decision.expired': true,
  'quota.low': true,
  'quota.empty': true,
  'subscription.past_due': true,
  'task.completed': false,
  'task.failed': false,
  'decision.answered': false,
};

export async function getEmailPrefs(db: any, userId: string): Promise<Record<string, boolean>> {
  try {
    const row: any = await db.prepare('SELECT notification_prefs FROM user_settings WHERE user_id=?').bind(userId).first();
    const saved = row?.notification_prefs ? JSON.parse(String(row.notification_prefs)) : {};
    return { ...EMAIL_DEFAULT, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...EMAIL_DEFAULT };
  }
}

export async function patchEmailPrefs(db: any, userId: string, patch: Record<string, boolean>): Promise<void> {
  const cur = await getEmailPrefs(db, userId);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k in EMAIL_DEFAULT && typeof v === 'boolean') next[k] = v;
  }
  await db
    .prepare(`INSERT INTO user_settings (user_id, auto_review, notification_prefs, updated_at) VALUES (?,1,?,?)
      ON CONFLICT(user_id) DO UPDATE SET notification_prefs=excluded.notification_prefs, updated_at=excluded.updated_at`)
    .bind(userId, JSON.stringify(next), Date.now())
    .run();
}

/** 邮件出线（只在新通知落库时调用）：按偏好开关 + 白牌模板；降级不炸 */
async function emailNotify(db: any, E: any, input: NotifyInput): Promise<void> {
  try {
    const prefs = await getEmailPrefs(db, input.userId);
    if (!prefs[input.kind]) return;
    const u: any = await db.prepare('SELECT email FROM user WHERE id=?').bind(input.userId).first();
    if (!u?.email) return;
    const p: any = await getPersona(db).catch(() => ({ product_name: 'cf-bot' }));
    const brand = String(p?.product_name || 'cf-bot');
    const m = renderMail({ productName: brand, title: input.title, body: String(input.body ?? '') });
    await sendMail(E, { to: String(u.email), subject: `【${brand}】${input.title}`, html: m.html, text: m.text, tag: `notify:${input.kind}` });
  } catch (e: any) {
    console.log('[notify] mail failed', String(e?.message ?? e).slice(0, 120));
  }
}

export type NotifyInput = {
  userId: string;
  kind: string; // task.completed | task.failed | decision.* | quota.low | quota.empty | subscription.past_due
  title: string;
  body?: string | null;
  link?: string | null; // 站内深链：room:<id> / room:<id>?msg=<id> / decisions / settings
  refType?: string | null; // task | decision | quota | subscription
  refId?: string | null;
};

const DEDUPE_MS = 5 * 60_000; // 同 ref 同类 5 分钟去重（合并计数）

export async function ensureNotificationTables(db: any): Promise<void> {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
      link TEXT, ref_type TEXT, ref_id TEXT, status TEXT NOT NULL DEFAULT 'unread', count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status, updated_at)',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
}

/** 写入一条通知；同 user+kind+ref 在 5 分钟窗口内合并（count+1，保首条文案）。传 E 时顺带 Web Push。 */
export async function notifyUser(db: any, input: NotifyInput, E?: any): Promise<void> {
  try {
    await ensureNotificationTables(db);
    const now = Date.now();
    if (input.refType && input.refId) {
      const dup: any = await db
        .prepare(`SELECT id FROM notifications WHERE user_id=? AND kind=? AND ref_type=? AND ref_id=?
          AND created_at>? ORDER BY created_at DESC LIMIT 1`)
        .bind(input.userId, input.kind, input.refType, input.refId, now - DEDUPE_MS)
        .first();
      if (dup) {
        await db.prepare('UPDATE notifications SET count=count+1, updated_at=? WHERE id=?').bind(now, dup.id).run();
        return;
      }
    }
    await db
      .prepare(`INSERT INTO notifications (id,user_id,kind,title,body,link,ref_type,ref_id,status,count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'unread',1,?,?)`)
      .bind(`nt-${crypto.randomUUID()}`, input.userId, input.kind, String(input.title).slice(0, 200), input.body?.slice(0, 500) ?? null,
        input.link ?? null, input.refType ?? null, input.refId ?? null, now, now)
      .run();
    if (E) {
      await pushToUser(db, E, input.userId);
      await emailNotify(db, E, input);
    }
  } catch (e: any) {
    console.log('[notify] write failed', String(e?.message ?? e).slice(0, 120));
  }
}

export async function listNotifications(db: any, userId: string, limit = 30): Promise<any[]> {
  await ensureNotificationTables(db);
  const { results } = await db
    .prepare('SELECT id, kind, title, body, link, ref_type, ref_id, status, count, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, Math.min(100, Math.max(1, limit)))
    .all();
  return results ?? [];
}

export async function unreadCount(db: any, userId: string): Promise<number> {
  await ensureNotificationTables(db);
  const row: any = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND status='unread'").bind(userId).first();
  return Number(row?.n ?? 0);
}

/** 已读：ids 指定集合，或 'all' 全清。返回受影响条数。 */
export async function markNotificationsRead(db: any, userId: string, ids: string[] | 'all'): Promise<number> {
  await ensureNotificationTables(db);
  const now = Date.now();
  if (ids === 'all') {
    const r = await db.prepare("UPDATE notifications SET status='read', updated_at=? WHERE user_id=? AND status='unread'").bind(now, userId).run();
    return Number(r?.meta?.changes ?? 0);
  }
  const list = (ids ?? []).filter((s) => typeof s === 'string' && s.startsWith('nt-')).slice(0, 100);
  if (!list.length) return 0;
  const marks = list.map(() => '?').join(',');
  const r = await db
    .prepare(`UPDATE notifications SET status='read', updated_at=? WHERE user_id=? AND id IN (${marks}) AND status='unread'`)
    .bind(now, userId, ...list)
    .run();
  return Number(r?.meta?.changes ?? 0);
}

/**
 * 额度阈值通知（quota.low ≥80%、quota.empty 池耗尽）：ref 按周池去重，跨过阈值才响一次。
 * 由 quota.chargeQuota 成功路径调用（商业层内联；OSS stub 不调用即无感）。
 */
export async function notifyQuota(db: any, userId: string, snap: any): Promise<void> {
  try {
    if (!snap?.weekPool) return;
    const { used = 0, total = 0 } = snap.weekPool;
    if (!total) return;
    const pct = used / total;
    const refId = `week:${snap.weekId ?? ''}`;
    if (used >= total) {
      await notifyUser(db, {
        userId, kind: 'quota.empty', refType: 'quota', refId,
        title: '本周额度已用完', body: '可以购买 top-up、等待下周刷新，或升级档位；进行中的对话不受影响。',
        link: 'settings',
      });
    } else if (pct >= 0.8) {
      await notifyUser(db, {
        userId, kind: 'quota.low', refType: 'quota', refId,
        title: `本周额度已用 ${Math.round(pct * 100)}%`, body: '接近上限时可购买 top-up 或等下周刷新。',
        link: 'settings',
      });
    }
  } catch (e: any) {
    console.log('[notify] quota check failed', String(e?.message ?? e).slice(0, 120));
  }
}
