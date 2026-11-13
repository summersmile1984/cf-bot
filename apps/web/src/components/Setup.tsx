import { useEffect, useState } from 'react';
import { completeSetup, getOnboardingStatus, type OnboardingStatus } from '../lib/api';

/** 首跑向导（onboarding）：无用户时强制进入——建管理员 → 配置检查 → 完成 */
export function Setup({ productName, onDone }: { productName: string; onDone: () => void }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  useEffect(() => {
    getOnboardingStatus().then(setStatus).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await completeSetup({ name, email, password });
      if (!r.ok) throw new Error(r.reason || '创建失败');
      setStep(2);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const checks = status?.checks;
  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8">
        <h1 className="mb-1 text-xl font-semibold">欢迎使用 {productName}</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">首次使用，完成以下设置即可开始。</p>

        {step === 1 && (
          <form onSubmit={submit}>
            <p className="mb-3 text-sm font-medium">① 创建管理员账号</p>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">昵称（可选）</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="怎么称呼你"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]" />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">邮箱</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]" />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">密码（≥8 位）</span>
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]" />
            </label>
            {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
            <button disabled={busy} className="w-full rounded-xl bg-[var(--color-fg)] py-2.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50">
              {busy ? '创建中…' : '创建管理员并继续'}
            </button>
            <p className="mt-3 text-xs text-[var(--color-mut)]">首个账号即管理员；完成后注册默认关闭（可在设置里重开）。</p>
          </form>
        )}

        {step === 2 && (
          <div>
            <p className="mb-3 text-sm font-medium">② 配置检查</p>
            <ul className="mb-5 space-y-2 text-sm">
              <li className="flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2">
                <span>DeepSeek API Key</span>
                <span className={checks?.deepseekKey ? 'text-green-600' : 'text-amber-600'}>
                  {checks?.deepseekKey ? '已配置 ✓' : '未配置——请到 Cloudflare Dashboard → Workers → Settings → Secrets 添加 DEEPSEEK_API_KEY'}
                </span>
              </li>
              <li className="flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2">
                <span>会话密钥（BETTER_AUTH_SECRET）</span>
                <span className={checks?.authSecret ? 'text-green-600' : 'text-amber-600'}>
                  {checks?.authSecret ? '已配置 ✓' : '未配置——登录会话需要它（openssl rand -hex 32 生成后设为 Secret）'}
                </span>
              </li>
              <li className="flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2">
                <span>公开地址（L1_PUBLIC_URL）</span>
                <span className="truncate pl-3 text-right text-xs text-[var(--color-mut)]">
                  {checks?.l1PublicUrl || `建议设为 ${checks?.detectedOrigin || '（你的站点 URL）'}`}
                </span>
              </li>
              <li className="flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2">
                <span>产品名称（白牌）</span>
                <span className="text-xs text-[var(--color-mut)]">默认「{productName}」，可在「设置」里改</span>
              </li>
            </ul>
            <button onClick={onDone} className="w-full rounded-xl bg-[var(--color-fg)] py-2.5 text-sm font-medium text-[var(--color-bg)]">
              完成，开始使用
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
