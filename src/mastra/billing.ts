/**
 * 开源版计费 stub（open-core 拆分，见 docs/compose/spec/open-source-split.md S2.2）。
 * 与 SaaS 版 src/mastra/billing.ts 同名导出面；开源版不含支付/订阅，相关入口一律礼貌拒绝。
 */

export type SubscriptionRow = {
  user_id: string;
  plan_id: string;
  paddle_subscription_id: string | null;
  status: string;
  current_period_end: number | null;
  updated_at: number;
};

export type BillingEnv = {
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICES_JSON?: string;
  DB: any;
};

export async function ensureBillingTables(_db: any): Promise<void> {}

export async function getSubscription(_db: any, _userId: string): Promise<SubscriptionRow | null> {
  return null;
}

export async function verifyPaddleSignature(_rawBody: string, _signatureHeader: string, _secret: string): Promise<boolean> {
  return false;
}

export async function handlePaddleEvent(_env: BillingEnv, _event: any): Promise<{ ok: boolean; note: string }> {
  return { ok: false, note: '开源版不含计费（Self-hosted edition has no billing）' };
}

export async function createCheckout(
  _env: BillingEnv,
  _userId: string,
  _priceKey: string,
  _email?: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  return { ok: false, reason: '开源版不含计费——这是自部署版，全部功能免费使用' };
}
