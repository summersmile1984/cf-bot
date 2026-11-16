import { useEffect, useState } from 'react';
import { getTasks, getTaskDetail, type TaskRow, type TaskDetail } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', working: '进行中', completed: '已完成', failed: '未成功', canceled: '已取消', rejected: '已拒绝',
};

function timeAgo(ts: number) {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

/** 任务历史（task-history S2.2）：跨房间时间线 + 筛选 + 抽屉详情（只读审计面）。 */
export function TasksPage({ onNavigate, onClose }: { onNavigate: (link: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<TaskRow[]>([]);
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<{ row: TaskRow; data: TaskDetail } | null>(null);

  async function refresh(f = filter) {
    try {
      setItems(await getTasks({ status: f || undefined, limit: 50 }));
    } catch { /* 静默 */ }
  }

  useEffect(() => { refresh(); }, [filter]);

  const openDetail = async (row: TaskRow) => {
    try { setDetail({ row, data: await getTaskDetail(row.taskId) }); } catch { /* 静默 */ }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 md:px-6 py-4">
        <h2 className="text-base font-semibold">任务 · 执行记录</h2>
        <button onClick={onClose} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">
          返回聊天
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 md:px-6 py-2">
        {[['', '全部'], ['active', '进行中/排队'], ['terminal', '已结束'], ['completed', '完成'], ['failed', '失败']].map(([v, label]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === v ? 'border-[var(--color-acc)] text-[var(--color-acc)]' : 'border-[var(--color-line)] text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-4 md:px-6 py-3">
        {items.length === 0 && <p className="py-10 text-center text-sm text-[var(--color-mut)]">还没有任务记录</p>}
        {items.map((t) => (
          <button
            key={t.taskId}
            onClick={() => openDetail(t)}
            className="mb-2 flex w-full items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-4 py-3 text-left hover:border-[var(--color-acc)]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={`text-xs ${t.status === 'completed' ? 'text-green-600' : t.status === 'failed' || t.status === 'rejected' ? 'text-red-500' : 'text-amber-600'}`}>
                  {STATUS_LABEL[t.status] ?? t.status}
                </span>
                <span className="truncate text-sm">{t.prompt || '(无描述)'}</span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-mut)]">
                {t.roomName ?? t.roomId} · {t.deviceName ?? (t.deviceId ? t.deviceId : t.runtime === 'cloud' ? '云端' : '待认领')} · {timeAgo(t.updatedAt)}
                {t.quotaPoints > 0 && ` · ${t.quotaPoints} 点`}
                {t.artifacts > 0 && ` · ${t.artifacts} 产物`}
                {t.decision === 'pending' && ' · 待拍板'}
              </div>
            </div>
            <span className="shrink-0 text-[var(--color-mut)]">›</span>
          </button>
        ))}
      </div>

      {detail && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setDetail(null)}>
          <div className="thin-scroll h-full w-full max-w-md overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-card)] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{STATUS_LABEL[detail.data.task.status] ?? detail.data.task.status} · {detail.data.task.kind}</h3>
              <button onClick={() => setDetail(null)} className="text-[var(--color-mut)] hover:text-[var(--color-fg)]">✕</button>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{detail.data.task.prompt}</p>
            <div className="mt-3 text-xs text-[var(--color-mut)]">
              {detail.row.roomName ?? detail.data.task.roomId} · {detail.row.deviceName ?? detail.row.runtime ?? ''} · 耗点 {detail.row.quotaPoints}
            </div>
            {detail.data.task.result && (
              <div className="mt-4 rounded-lg border border-[var(--color-line)] p-3 text-xs text-[var(--color-mut)]">
                <p className="mb-1 font-medium text-[var(--color-fg)]">结果摘要</p>
                {String(detail.data.task.result).slice(0, 400)}
              </div>
            )}
            {detail.data.task.progress.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium">进度</p>
                {detail.data.task.progress.map((p: any, i: number) => (
                  <p key={i} className="text-[11px] text-[var(--color-mut)]">· {String(p.line ?? JSON.stringify(p)).slice(0, 120)}</p>
                ))}
              </div>
            )}
            {detail.data.artifacts.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium">产物（{detail.data.artifacts.length}）</p>
                {detail.data.artifacts.map((a) => (
                  <p key={a.id} className="text-[11px] text-[var(--color-mut)]">· [{a.kind}] {a.caption || a.id}</p>
                ))}
              </div>
            )}
            {detail.data.decisions.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium">审批记录</p>
                {detail.data.decisions.map((dc) => (
                  <p key={dc.id} className="text-[11px] text-[var(--color-mut)]">· [{dc.status}] {dc.question}{dc.answer ? ` → ${dc.answer}` : ''}</p>
                ))}
              </div>
            )}
            {detail.data.ledger.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium">额度流水</p>
                {detail.data.ledger.map((l, i) => (
                  <p key={i} className="text-[11px] text-[var(--color-mut)]">· {l.entry === 'refund' ? '退' : '扣'} {l.units} 点 {l.detail ?? ''}</p>
                ))}
              </div>
            )}
            <button
              onClick={() => { setDetail(null); onNavigate(detail.row.link); }}
              className="mt-6 w-full rounded-full bg-[var(--color-fg)] py-2 text-xs font-medium text-[var(--color-bg)]"
            >
              去房间
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
