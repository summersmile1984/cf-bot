import { useEffect, useRef, useState } from 'react';
import { getNotifications, markNotificationsRead, type NotificationItem } from '../lib/api';

function timeAgo(ts: number) {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

/** 通知铃铛（notifications S2.3）：未读徽标 + 下拉通知中心；点击条目深链跳转并已读。 */
export function NotificationsBell({ onNavigate }: { onNavigate: (link: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const r = await getNotifications(30);
      setItems(r.items ?? []);
      setUnread(r.unread ?? 0);
    } catch { /* 会话失效等情况静默 */ }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function onItemClick(n: NotificationItem) {
    try { await markNotificationsRead([n.id]); } catch {}
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, status: 'read' } : x)));
    setUnread((v) => Math.max(0, v - 1));
    setOpen(false);
    if (n.link) onNavigate(n.link);
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="通知"
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-line)] text-sm text-[var(--color-mut)] hover:text-[var(--color-fg)]"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 w-80 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] shadow-lg">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2">
            <span className="text-xs font-medium">通知</span>
            <button
              className="text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
              onClick={async () => {
                try { await markNotificationsRead('all'); } catch {}
                setItems((list) => list.map((x) => ({ ...x, status: 'read' })));
                setUnread(0);
              }}
            >
              全部已读
            </button>
          </div>
          <div className="thin-scroll max-h-80 overflow-y-auto">
            {items.length === 0 && <div className="px-3 py-6 text-center text-xs text-[var(--color-mut)]">暂无通知</div>}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => onItemClick(n)}
                className={`block w-full border-b border-[var(--color-line)] px-3 py-2.5 text-left hover:bg-[var(--color-line)] ${
                  n.status === 'unread' ? 'bg-[var(--color-bg)]' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium">
                    {n.status === 'unread' && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />}
                    {n.title}
                    {n.count > 1 && <span className="ml-1 text-[10px] text-[var(--color-mut)]">×{n.count}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--color-mut)]">{timeAgo(n.created_at)}</span>
                </div>
                {n.body && <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-mut)]">{n.body}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
