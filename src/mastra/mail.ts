/**
 * 事务性邮件（account-hardening S2.1）：provider 可插拔，未配置降级为日志——不炸是硬要求。
 * - cf-email（推荐，有 EMAIL binding 时为默认）：Cloudflare Email Service Workers binding（send_email）
 *   需发信域名入网 Email Service（E_SENDER_NOT_VERIFIED / E_SENDER_DOMAIN_NOT_AVAILABLE 即未入网）
 * - resend：RESEND_API_KEY（Bearer 调 api.resend.com）
 * - mailchannels：免密钥（Workers 出口直发），MAIL_FROM 域名需与发信域一致
 * - log（兜底）：只记日志，开发/自部署无邮件也能跑完整流程
 * notifications 片的邮件渠道复用本模块（S2.1 归属决策见 spec Journey log）。
 */

export type MailMsg = { to: string; subject: string; html: string; text?: string; tag?: string };
export type MailResult = { ok: boolean; id?: string; error?: string; skipped?: boolean };

/** 极简事务性邮件模板：品牌名取 persona_config.product_name（白牌一致，不写死产品名） */
export function renderMail(opts: {
  productName: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): { html: string; text: string } {
  const { productName, title, body, ctaLabel, ctaUrl } = opts;
  const btn = ctaLabel && ctaUrl
    ? `<p style="margin:24px 0"><a href="${ctaUrl}" style="background:#111;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">${ctaLabel}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
  <p style="color:#888;font-size:12px;margin:0 0 16px">${productName}</p>
  <h1 style="font-size:18px;margin:0 0 12px;color:#111">${title}</h1>
  <p style="font-size:14px;line-height:1.7;color:#333;margin:0">${body}</p>
  ${btn}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px" />
  <p style="font-size:12px;color:#999;margin:0">这是一封系统通知邮件，请勿直接回复。</p>
</div></body></html>`;
  const text = `${title}\n\n${body}${ctaUrl ? `\n\n${ctaLabel ?? '打开'}：${ctaUrl}` : ''}\n\n— ${productName}`;
  return { html, text };
}

const fromOf = (E: any): string => String(E.MAIL_FROM ?? '');

async function sendViaResend(E: any, m: MailMsg): Promise<MailResult> {
  const key = String(E.RESEND_API_KEY ?? '');
  if (!key) return { ok: false, error: 'RESEND_API_KEY 未配置' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: fromOf(E), to: [m.to], subject: m.subject, html: m.html, text: m.text ?? undefined }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => null);
  return res.ok ? { ok: true, id: j?.id } : { ok: false, error: String(j?.message ?? res.status).slice(0, 160) };
}

async function sendViaMailchannels(E: any, m: MailMsg): Promise<MailResult> {
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: m.to }] }],
      from: { email: fromOf(E) },
      subject: m.subject,
      content: [{ type: 'text/html', value: m.html }, ...(m.text ? [{ type: 'text/plain', value: m.text }] : [])],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? { ok: true } : { ok: false, error: String(res.status) };
}

/** Cloudflare Email Service（send_email binding）：结构化 send()，返回 messageId */
async function sendViaCfEmail(E: any, m: MailMsg): Promise<MailResult> {
  const sender: any = (E as any).EMAIL;
  if (!sender?.send) return { ok: false, error: 'EMAIL binding 未配置（wrangler send_email）' };
  try {
    const res: any = await sender.send({
      to: m.to,
      from: fromOf(E),
      subject: m.subject,
      html: m.html,
      ...(m.text ? { text: m.text } : {}),
    });
    console.log('[mail:cf-email] ok', String(res?.messageId ?? '').slice(0, 40));
    return { ok: true, id: res?.messageId };
  } catch (e: any) {
    // E_SENDER_NOT_VERIFIED / E_SENDER_DOMAIN_NOT_AVAILABLE = 域名未入网 Email Service
    const code = String(e?.code ?? e?.message ?? e).slice(0, 160);
    console.log('[mail:cf-email]', code);
    return { ok: false, error: code };
  }
}

/**
 * 发信（统一入口）。降级语义：provider 未配置/发送失败都返回 ok:false 但绝不抛——
 * 调用方决定是否把「未送达」暴露给用户（验证/重置流用）。
 */
export async function sendMail(E: any, m: MailMsg): Promise<MailResult> {
  if (!m?.to || !m?.subject) return { ok: false, error: 'bad mail' };
  // 同一收件人限频（软闸）：防触发式邮件轰炸
  const limiter: any = (E as any).MAIL_RATE_LIMITER;
  if (limiter?.limit) {
    const r: any = await limiter.limit({ key: `mail:${m.to}` }).catch(() => null);
    if (r && !r.success) return { ok: false, skipped: true, error: '发送太频繁，请稍后再试' };
  }
  // 未显式配置时：有 EMAIL binding 就用 CF Email Service，否则 log 降级
  const provider = String(E.MAIL_PROVIDER ?? ((E as any).EMAIL?.send ? 'cf-email' : 'log')).toLowerCase();
  try {
    if (provider === 'cf-email') return await sendViaCfEmail(E, m);
    if (provider === 'resend') return await sendViaResend(E, m);
    if (provider === 'mailchannels') return await sendViaMailchannels(E, m);
    // log（默认）：记痕不发信
    console.log('[mail:log]', JSON.stringify({ to: m.to, subject: m.subject, tag: m.tag ?? null }));
    return { ok: true, skipped: true, id: 'log' };
  } catch (e: any) {
    console.log('[mail] send failed', String(e?.message ?? e).slice(0, 120));
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}
