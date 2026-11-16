import { useEffect, useState } from 'react';
import { getDecisions, answerDecision, declineDecision, type DecisionItem } from '../lib/api';

const KIND_LABEL: Record<string, string> = {
  task_ask: '任务追问',
  permission_ask: '权限确认',
  secret_confirm: '密钥确认',
};

function remaining(expiresAt: number) {
  const s = Math.round((expiresAt - Date.now()) / 1000);
  if (s <= 0) return '已到期';
  if (s < 60) return `${s} 秒后过期`;
  return `${Math.ceil(s / 60)} 分钟后过期`;
}

/** 待办/审批中心（approvals-hub S2.3）：pending 优先，回答/拒绝一键生效（fail-closed 回写）。 */
export function DecisionsPage({ onNavigate, onClose }: { onNavigate: (link: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<DecisionItem[]>([]);
  const [pending, setPending] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');

  async function refresh() {
    try {
      const r = await getDecisions();
      setItems(r.items ?? []);
      setPending(r.pending ?? 0);
    } catch { /* 静默 */ }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, []);

  const pendingItems = items.filter((d) => d.status === 'pending');
  const pastItems = items.filter((d) => d.status !== 'pending');

  async function onAnswer(d: DecisionItem) {
    const text = (drafts[d.id] ?? '').trim();
    if (!text) return;
    setBusy(d.id);
    try {
      await answerDecision(d.id, text);
      setDrafts((m) => ({ ...m, [d.id]: '' }));
      await refresh();
    } catch { /* 静默 */ }
    setBusy('');
  }

  async function onDecline(d: DecisionItem) {
    setBusy(d.id);
    try {
      await declineDecision(d.id);
      await refresh();
    } catch { /* 静默 */ }
    setBusy('');
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 md:px-6 py-4">
        <h2 className="text-base font-semibold">待办 · 等你拍板 {pending > 0 && <span className="ml-1 text-sm text-red-500">{pending}</span>}</h2>
        <button onClick={onClose} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">
          返回聊天
        </button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-4 md:px-6 py-4">
        {pendingItems.length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--color-mut)]">当前没有待拍板的事项</p>
        )}
        {pendingItems.map((d) => (
          <div key={d.id} className="mb-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="rounded-full bg-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-mut)]">
                {KIND_LABEL[d.kind] ?? d.kind}
              </span>
              <span className="text-[10px] text-amber-600">{remaining(d.expires_at)}</span>
            </div>
            <p className="mt-2 text-sm">{d.question}</p>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={drafts[d.id] ?? ''}
                onChange={(e) => setDrafts((m) => ({ ...m, [d.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') onAnswer(d); }}
                placeholder="输入答复（权限类回复 允许 / 拒绝）"
                className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-acc)]"
              />
              <button
                disabled={busy === d.id || !(drafts[d.id] ?? '').trim()}
                onClick={() => onAnswer(d)}
                className="rounded-full bg-[var(--color-fg)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
              >
                回答
              </button>
              <button
                disabled={busy === d.id}
                onClick={() => onDecline(d)}
                className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-mut)] hover:text-red-500 disabled:opacity-40"
              >
                拒绝
              </button>
              {d.room_id && (
                <button
                  onClick={() => onNavigate(`room:${d.room_id}`)}
                  className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
                >
                  去房间
                </button>
              )}
            </div>
          </div>
        ))}

        {pastItems.length > 0 && (
          <>
            <div className="mb-2 mt-6 text-xs text-[var(--color-mut)]">最近已处理</div>
            {pastItems.slice(0, 20).map((d) => (
              <div key={d.id} className="mb-2 flex items-baseline justify-between gap-3 rounded-lg border border-[var(--color-line)] px-3 py-2 opacity-70">
                <div className="min-w-0">
                  <span className="mr-2 rounded-full bg-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-mut)]">
                    {KIND_LABEL[d.kind] ?? d.kind}
                  </span>
                  <span className="text-xs text-[var(--color-mut)]">{d.question}</span>
                </div>
                <span className="shrink-0 text-[10px] text-[var(--color-mut)]">
                  {{ pending: '待处理', answered: '已回答', declined: '已拒绝', expired: '已过期', canceled: '已取消' }[d.status] ?? d.status}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
