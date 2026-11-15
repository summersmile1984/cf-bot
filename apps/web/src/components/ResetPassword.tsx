import { useState } from 'react';
import { resetPassword } from '../lib/api';

/** 重置密码表单（account-hardening S2.3）：链接带 reset_token 入站，成功后回登录。 */
export function ResetPassword({ token, productName = 'cf-bot', onDone }: { token: string; productName?: string; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) { setErr('密码至少 8 位'); return; }
    if (pw !== pw2) { setErr('两次输入不一致'); return; }
    setBusy(true);
    try {
      await resetPassword(token, pw);
      setOk(true);
    } catch (e: any) {
      setErr(String(e?.message ?? '').includes('expired') || String(e?.message ?? '').includes('token') ? '链接无效或已过期，请重新发起找回密码' : '重置失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8">
        <h1 className="mb-1 text-xl font-semibold">{productName}</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">设置新登录密码</p>
        {ok ? (
          <>
            <p className="mb-4 text-sm text-[var(--color-mut)]">密码已重置，请用新密码登录。</p>
            <button type="button" onClick={onDone} className="w-full rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)]">
              去登录
            </button>
          </>
        ) : (
          <>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">新密码</span>
              <input
                type="password"
                required
                minLength={8}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="至少 8 位"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">再输一次</span>
              <input
                type="password"
                required
                minLength={8}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                placeholder="至少 8 位"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            {err && <p className="mb-3 text-sm text-red-500">{err}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)] disabled:opacity-50">
              {busy ? '请稍候…' : '重置密码'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
