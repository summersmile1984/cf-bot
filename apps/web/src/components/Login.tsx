import { useEffect, useRef, useState } from 'react';
import { signIn, signUp } from '../lib/api';

export function Login({ onDone, productName = 'cf-bot', turnstileSitekey }: { onDone: () => void; productName?: string; turnstileSitekey?: string | null }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tsToken, setTsToken] = useState('');
  const tsRef = useRef<HTMLDivElement>(null);
  const tsWidget = useRef<string | null>(null);

  // 注册挑战（saas S2.6）：注册模式 + 已配置站点密钥时挂 Turnstile 挂件
  useEffect(() => {
    if (mode !== 'up' || !turnstileSitekey) return;
    let cancelled = false;
    const w = window as any;
    const render = () => {
      if (cancelled || !tsRef.current || !w.turnstile || tsWidget.current) return;
      tsWidget.current = w.turnstile.render(tsRef.current, {
        sitekey: turnstileSitekey,
        callback: (t: string) => setTsToken(t),
        'expired-callback': () => setTsToken(''),
      });
    };
    if (w.turnstile) render();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }
    return () => {
      cancelled = true;
      if (tsWidget.current && w.turnstile) { try { w.turnstile.remove(tsWidget.current); } catch {} }
      tsWidget.current = null;
      setTsToken('');
    };
  }, [mode, turnstileSitekey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (mode === 'up' && turnstileSitekey && !tsToken) {
      setErr('请先完成人机验证');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp(name || email.split('@')[0], email, password, tsToken || undefined);
      onDone();
    } catch (e: any) {
      setErr(mode === 'in' ? '登录失败，请检查邮箱和密码' : '注册失败，邮箱可能已存在');
      if (mode === 'up' && tsWidget.current) {
        const w = window as any;
        try { w.turnstile?.reset(tsWidget.current); } catch {}
        setTsToken('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-[var(--color-bg)] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8"
      >
        <h1 className="mb-1 text-xl font-semibold">{productName}</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">
          {mode === 'in' ? '登录以进入你的房间' : '创建一个账号'}
        </p>

        {mode === 'up' && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-[var(--color-mut)]">昵称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="怎么称呼你"
              className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
            />
          </label>
        )}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-[var(--color-mut)]">邮箱</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
          />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-xs text-[var(--color-mut)]">密码</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位"
            className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
          />
        </label>

        {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

        {mode === 'up' && turnstileSitekey && <div ref={tsRef} className="mb-4" />}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)] disabled:opacity-50"
        >
          {busy ? '请稍候…' : mode === 'in' ? '登录' : '注册'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setErr('');
          }}
          className="mt-4 w-full text-center text-sm text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          {mode === 'in' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  );
}
