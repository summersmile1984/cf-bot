import { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpCatalogEntry, McpConnection } from '../lib/api';
import {
  getMcpCatalog,
  listMcpConnections,
  deleteMcpConnection,
  startMcpOAuth,
  connectMcpKey,
  connectMcpNone,
} from '../lib/api';

const AUTH_BADGE: Record<string, string> = { oauth2: '🔐 OAuth', api_key: '🔑 API Key', none: '免认证' };

function timeAgo(ts?: number | null) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[420px] rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button className="text-[var(--color-mut)] hover:text-[var(--color-fg)]" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function McpPage({ initialTab = 'market' }: { initialTab?: 'market' | 'mine' }) {
  const [tab, setTab] = useState<'market' | 'mine'>(initialTab);
  const [entries, setEntries] = useState<McpCatalogEntry[]>([]);
  const [conns, setConns] = useState<McpConnection[]>([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [oauthFor, setOauthFor] = useState<McpCatalogEntry | null>(null);
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [keyFor, setKeyFor] = useState<McpCatalogEntry | null>(null);
  const [keyVal, setKeyVal] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([getMcpCatalog(), listMcpConnections()]);
      setEntries(e);
      setConns(c);
    } catch (e2) {
      setErr(String((e2 as Error)?.message ?? e2));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connectedIds = useMemo(() => new Set(conns.map((c) => c.catalogId)), [conns]);
  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))], [entries]);
  const filtered = entries.filter((e) =>
    (!cat || e.category === cat) &&
    (!q || `${e.name}${e.vendor}${e.description}`.toLowerCase().includes(q.toLowerCase())),
  );

  async function doOauthGo() {
    if (!oauthFor) return;
    setBusy(oauthFor.id);
    setErr(null);
    try {
      const r = await startMcpOAuth(oauthFor.id, oauthClientId.trim() || undefined, oauthClientSecret.trim() || undefined);
      window.location.href = r.authUrl;
    } catch (e) {
      setErr(`${(e as Error).message}${(e as any).hint ? ` — ${(e as any).hint}` : ''}`);
      setBusy(null);
    }
  }

  async function doKeySubmit() {
    if (!keyFor) return;
    setBusy(keyFor.id);
    setErr(null);
    try {
      await connectMcpKey(keyFor.id, keyVal.trim());
      setKeyFor(null);
      setKeyVal('');
      setTab('mine');
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    setBusy(null);
  }

  async function doNone(entry: McpCatalogEntry) {
    setBusy(entry.id);
    setErr(null);
    try {
      await connectMcpNone(entry.id);
      setTab('mine');
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    setBusy(null);
  }

  async function doDisconnect(c: McpConnection) {
    if (!window.confirm(`确认断开「${c.name}」？将移除连接并删除已存凭证。`)) return;
    setBusy(c.id);
    try {
      await deleteMcpConnection(c.id);
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    setBusy(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-6 py-4">
        <h2 className="text-[17px] font-semibold">MCP</h2>
        <div className="flex rounded-full border border-[var(--color-line)] text-sm">
          {(['market', 'mine'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 ${tab === t ? 'rounded-full bg-[var(--color-acc)] text-white' : 'text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}
            >
              {t === 'market' ? 'MCP 市场' : '我的 MCP'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {tab === 'market' && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索集成…"
            className="w-56 rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-4 py-1.5 text-sm outline-none focus:border-[var(--color-acc)]"
          />
        )}
      </div>

      {err && (
        <div className="mx-6 mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {err}
          <button className="ml-3 text-xs underline" onClick={() => setErr(null)}>知道了</button>
        </div>
      )}

      {tab === 'market' ? (
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setCat(null)}
              className={`rounded-full border px-3 py-1 text-xs ${!cat ? 'border-[var(--color-acc)] bg-[var(--color-acc)] text-white' : 'border-[var(--color-line)] text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}
            >
              全部
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`rounded-full border px-3 py-1 text-xs ${cat === c ? 'border-[var(--color-acc)] bg-[var(--color-acc)] text-white' : 'border-[var(--color-line)] text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((e) => (
              <div key={e.id} className="flex flex-col rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{e.name}</div>
                    <div className="text-xs text-[var(--color-mut)]">{e.vendor} · {e.category} · {AUTH_BADGE[e.auth.type] ?? e.auth.type}</div>
                  </div>
                  {connectedIds.has(e.id) && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">✓ 已连接</span>
                  )}
                </div>
                <div className="mt-2 flex-1 text-xs leading-5 text-[var(--color-mut)]">{e.description}</div>
                <div className="mt-3 flex items-center gap-2">
                  {connectedIds.has(e.id) ? (
                    <button onClick={() => setTab('mine')} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">
                      管理
                    </button>
                  ) : e.auth.type === 'oauth2' ? (
                    <button
                      disabled={busy === e.id}
                      onClick={() => { setOauthFor(e); setOauthClientId(''); setOauthClientSecret(''); }}
                      className="rounded-full bg-[var(--color-acc)] px-3.5 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                    >
                      去授权
                    </button>
                  ) : e.auth.type === 'api_key' ? (
                    <button
                      disabled={busy === e.id}
                      onClick={() => { setKeyFor(e); setKeyVal(''); }}
                      className="rounded-full bg-[var(--color-acc)] px-3.5 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                    >
                      填 Key 连接
                    </button>
                  ) : (
                    <button
                      disabled={busy === e.id}
                      onClick={() => void doNone(e)}
                      className="rounded-full bg-[var(--color-acc)] px-3.5 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                    >
                      连接
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!filtered.length && <div className="mt-10 text-center text-sm text-[var(--color-mut)]">没有匹配的集成</div>}
        </div>
      ) : (
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-4">
          {!conns.length ? (
            <div className="mt-10 text-center text-sm text-[var(--color-mut)]">
              还没有连接任何集成 —
              <button className="ml-1 underline" onClick={() => setTab('market')}>去 MCP 市场</button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {conns.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">
                      {c.name}
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${c.status === 'connected' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                        {c.status === 'connected' ? '✓ 已连接' : c.status}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--color-mut)]">
                      {c.account ? `账号 ${c.account} · ` : ''}连接于 {timeAgo(c.createdAt)}
                    </div>
                  </div>
                  <button
                    disabled={busy === c.id}
                    onClick={() => void doDisconnect(c)}
                    className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-red-600 disabled:opacity-50"
                  >
                    断开
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {oauthFor && (
        <Modal title={`连接 ${oauthFor.name}`} onClose={() => setOauthFor(null)}>
          <div className="text-xs leading-5 text-[var(--color-mut)]">
            即将前往 {oauthFor.vendor} 授权（OAuth 2.1 + PKCE，完成后自动回到这里）。
            {oauthFor.auth.provider === 'google' && (
              <> 首次需填 Google OAuth client（Google Auth Platform → Clients 创建，回调 URI 填 <code className="rounded bg-[var(--color-line)] px-1">{location.origin}/oauth/callback</code>，勾选 AI-powered agent）。</>
            )}
          </div>
          <input
            value={oauthClientId}
            onChange={(e) => setOauthClientId(e.target.value)}
            placeholder="client_id（填过会记住）"
            className="mt-3 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]"
          />
          <input
            value={oauthClientSecret}
            onChange={(e) => setOauthClientSecret(e.target.value)}
            placeholder="client_secret（如有）"
            type="password"
            className="mt-2 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm text-[var(--color-mut)]" onClick={() => setOauthFor(null)}>取消</button>
            <button
              className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
              disabled={!oauthClientId.trim() || busy === oauthFor.id}
              onClick={() => void doOauthGo()}
            >
              去授权 →
            </button>
          </div>
        </Modal>
      )}

      {keyFor && (
        <Modal title={`连接 ${keyFor.name}`} onClose={() => setKeyFor(null)}>
          <div className="text-xs leading-5 text-[var(--color-mut)]">
            {keyFor.auth.apiKeyHint || '输入 API Key（只存入密钥库，不落明文配置）'}
          </div>
          <input
            value={keyVal}
            onChange={(e) => setKeyVal(e.target.value)}
            placeholder="API Key"
            type="password"
            className="mt-3 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm text-[var(--color-mut)]" onClick={() => setKeyFor(null)}>取消</button>
            <button
              className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
              disabled={!keyVal.trim() || busy === keyFor.id}
              onClick={() => void doKeySubmit()}
            >
              连接
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
