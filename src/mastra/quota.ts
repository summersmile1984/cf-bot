/**
 * 开源版额度 stub（open-core 拆分，见 docs/compose/spec/open-source-split.md S2.2）。
 * 与 SaaS 版 src/mastra/quota.ts 同名导出面，但恒放行：单租户自部署无计量需求。
 * getQuota 返 null → 前端额度条自动隐藏（Chat 以 quota 非空为渲染条件）。
 */

export const TASK_POINTS = 25;
export const PUBLISH_POINTS = 5;
export const CLOUD_TASK_MINUTES = 5;
export const SIGNUP_GIFT_POINTS = 200;

export type QuotaKind = 'pool' | 'credit' | 'cloud';

export type QuotaSnapshot = {
  planId: string;
  weekId: string;
  weekPool: { used: number; total: number };
  credits: { balance: number; expiresAt: number | null };
  cloud: { used: number; bought: number };
};

export type ChargeResult = { ok: true; charged: QuotaKind } | { ok: false; reason: string; quota: QuotaSnapshot };

export const PLAN_SEED: Array<{ id: string; name: string; price_cents: number; weekly_pool_points: number }> = [];

export function weekIdOf(ts = Date.now()): string {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export async function ensureQuotaTables(_db: any): Promise<void> {}

export async function ensureQuotaAccount(_db: any, _userId: string): Promise<QuotaSnapshot | null> {
  return null;
}

export async function getQuota(_db: any, _userId: string): Promise<null> {
  return null;
}

export async function chargeQuota(
  _db: any,
  _userId: string,
  args: { kind: QuotaKind; units: number; idempotencyKey: string; detail?: string; allowOverage?: boolean },
): Promise<ChargeResult> {
  return { ok: true, charged: args.kind };
}

export async function refundQuota(_db: any, _userId: string, _idempotencyKey: string, _units: number): Promise<boolean> {
  return true;
}

export async function addCredit(_db: any, _userId: string, _units: number, _idempotencyKey: string, _detail?: string): Promise<boolean> {
  return true;
}

export async function addCloudMinutes(_db: any, _userId: string, _minutes: number, _idempotencyKey: string): Promise<boolean> {
  return true;
}

export async function applySubscription(_db: any, _userId: string, _planId: string, _idempotencyKey: string): Promise<boolean> {
  return true;
}
