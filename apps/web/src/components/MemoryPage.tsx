import { useCallback, useEffect, useState } from 'react';
import type { OmOverview, OmProfile, OmRecord } from '../lib/api';
import {
  getOmOverview,
  getOmObservationsAll,
  updateOmProfile,
  updateOmObservation,
  deleteOmObservation,
  exportOmDownload,
} from '../lib/api';

function fmt(ts?: number | null) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '时间未知';
  return new Date(n).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function firstLine(s: string) {
  const t = String(s ?? '').trim();
  return t ? t.split('\n')[0].slice(0, 80) : '（空）';
}

const LIST_FIELDS = [
  { key: 'preferences', label: '偏好' },
  { key: 'ongoing', label: '进行中' },
  { key: 'facts', label: '事实' },
] as const;

function SupersededFold({ records, onOpen }: { records: OmRecord[]; onOpen?: (r: OmRecord) => void }) {
  const [open, setOpen] = useState(false);
  if (!records.length) return null;
  return (
    <div className="mb-2">
      <button onClick={() => setOpen((v) => !v)} className="text-xs text-[var(--color-mut)] underline hover:text-[var(--color-fg)]">
        {open ? '收起' : `展开 ${records.length} 条已被替代的记录`}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 opacity-70">
          {records.map((rec) => (
            <button key={rec.id} onClick={() => onOpen?.(rec)} className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--color-line)] px-3 py-1.5 text-left">
              <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">已被替代</span>
              <span className="min-w-0 flex-1 truncate text-xs">{firstLine(rec.activeObservations)}</span>
              <span className="text-xs text-[var(--color-mut)]">{fmt(rec.updatedAt || rec.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoryPage() {
  const [tab, setTab] = useState<'profile' | 'log' | 'export'>('profile');
  const [overview, setOverview] = useState<OmOverview | null>(null);
  const [rooms, setRooms] = useState<{ thread: string; records: OmRecord[] }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 画像编辑
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<{ name: string; preferredName: string; timezone: string; preferences: string; ongoing: string; facts: string }>(
    { name: '', preferredName: '', timezone: '', preferences: '', ongoing: '', facts: '' },
  );

  // 观测：筛选 + 详情
  const [roomFilter, setRoomFilter] = useState<string | null>(null);
  const [openRec, setOpenRec] = useState<OmRecord | null>(null);
  const [editRec, setEditRec] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // 画像与观测解耦加载：观测要逐房间查（可能慢），不阻塞画像渲染（评审 UX）
    try {
      const o = await getOmOverview();
      setOverview(o);
      const p = o.profile ?? {};
      setForm({
        name: p.name ?? '', preferredName: p.preferredName ?? '', timezone: p.timezone ?? '',
        preferences: (p.preferences ?? []).join('\n'), ongoing: (p.ongoing ?? []).join('\n'), facts: (p.facts ?? []).join('\n'),
      });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    try {
      const a = await getOmObservationsAll();
      setRooms(a.rooms ?? []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function saveProfile() {
    setBusy(true); setErr(null);
    try {
      const payload: OmProfile = {
        name: form.name.trim() || undefined,
        preferredName: form.preferredName.trim() || undefined,
        timezone: form.timezone.trim() || undefined,
        preferences: form.preferences.split('\n').map((x) => x.trim()).filter(Boolean),
        ongoing: form.ongoing.split('\n').map((x) => x.trim()).filter(Boolean),
        facts: form.facts.split('\n').map((x) => x.trim()).filter(Boolean),
      };
      await updateOmProfile(payload);
      setEditMode(false);
      await refresh();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(false);
  }

  async function saveRecord(rec: OmRecord, text: string) {
    setBusy(true); setErr(null);
    try {
      await updateOmObservation(rec.id, { activeObservations: text, expected: rec.activeObservations });
      setEditRec(null);
      await refresh();
    } catch (e) {
      setErr(`${(e as Error)?.message ?? e}（若是并发冲突，请刷新后重试）`);
    }
    setBusy(false);
  }

  async function deleteRecord(rec: OmRecord) {
    if (!window.confirm(`确认删除第 ${rec.generationCount} 代观测？删除后秘书将不再记得这条（不可恢复）。`)) return;
    setBusy(true); setErr(null);
    try {
      await deleteOmObservation(rec.id);
      setOpenRec(null);
      await refresh();
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setBusy(false);
  }

  const profile = overview?.profile;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-6 py-4">
        <h2 className="text-[17px] font-semibold">记忆</h2>
        <div className="flex rounded-full border border-[var(--color-line)] text-sm">
          {([['profile', '主人画像'], ['log', '观测日志'], ['export', '导出']] as const).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 ${tab === t ? 'rounded-full bg-[var(--color-acc)] text-white' : 'text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {tab === 'log' && (
          <select
            value={roomFilter ?? ''}
            onChange={(e) => setRoomFilter(e.target.value || null)}
            className="rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none"
          >
            <option value="">全部房间</option>
            {(overview?.rooms ?? []).map((r) => <option key={r.thread} value={r.thread}>{r.name}（{r.records}）</option>)}
          </select>
        )}
      </div>

      {err && (
        <div className="mx-6 mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {err}
          <button className="ml-3 text-xs underline" onClick={() => setErr(null)}>知道了</button>
        </div>
      )}

      {tab === 'profile' && (
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-5">
          {!editMode ? (
            <div className="max-w-2xl">
              {profile && (profile.name || profile.preferredName || profile.timezone || (profile.facts ?? []).length) ? (
                <div className="flex flex-col gap-3">
                  <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] px-4 py-3">
                    <div className="text-xs text-[var(--color-mut)]">称呼</div>
                    <div className="text-sm">{profile.preferredName || profile.name || '—'}</div>
                    <div className="mt-2 text-xs text-[var(--color-mut)]">时区</div>
                    <div className="text-sm">{profile.timezone || '—'}</div>
                  </div>
                  {LIST_FIELDS.map(({ key, label }) => (
                    <div key={key} className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] px-4 py-3">
                      <div className="text-xs text-[var(--color-mut)]">{label}</div>
                      {(profile[key] ?? []).length
                        ? <ul className="mt-1 list-disc pl-5 text-sm leading-6">{(profile[key] ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
                        : <div className="mt-1 text-sm text-[var(--color-mut)]">—</div>}
                    </div>
                  ))}
                  <div>
                    <button onClick={() => setEditMode(true)} className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white hover:opacity-90">编辑画像</button>
                    <span className="ml-3 text-xs text-[var(--color-mut)]">更新于 {fmt(overview?.profileUpdatedAt)}</span>
                  </div>
                </div>
              ) : (
                <div className="mt-10 text-center text-sm text-[var(--color-mut)]">
                  秘书还在认识你 — 多和它聊聊，这里会慢慢长出你的画像。<br />
                  <button onClick={() => setEditMode(true)} className="mt-3 rounded-full border border-[var(--color-line)] px-4 py-1.5 hover:text-[var(--color-fg)]">手动填写</button>
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-2xl">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-[var(--color-mut)]">称呼
                  <input value={form.preferredName} onChange={(e) => setForm({ ...form, preferredName: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]" />
                </label>
                <label className="text-xs text-[var(--color-mut)]">时区
                  <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Asia/Shanghai" className="mt-1 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]" />
                </label>
              </div>
              {LIST_FIELDS.map(({ key, label }) => (
                <label key={key} className="mt-3 block text-xs text-[var(--color-mut)]">{label}（一行一条）
                  <textarea value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} rows={4} className="mt-1 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]" />
                </label>
              ))}
              <div className="mt-4 flex items-center gap-2">
                <button disabled={busy} onClick={() => void saveProfile()} className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50">保存</button>
                <button onClick={() => setEditMode(false)} className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm text-[var(--color-mut)]">取消</button>
                <span className="text-xs text-[var(--color-mut)]">注意：聊天中学到的新信息仍会并入画像；你删掉的条目可能被重新学到。</span>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="thin-scroll flex-1 overflow-y-auto px-6 py-4">
          {rooms.filter((g) => !roomFilter || g.thread === roomFilter).map((g) => {
            const meta = overview?.rooms.find((r) => r.thread === g.thread);
            return (
              <div key={g.thread} className="mb-5">
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">{meta?.name ?? g.thread}</h3>
                  <span className="text-xs text-[var(--color-mut)]">{g.records.length} 条观测</span>
                </div>
                {!g.records.length && <div className="text-sm text-[var(--color-mut)]">这个房间还没有观测记录</div>}
                <SupersededFold records={g.records.filter((r) => r.supersededBy)} onOpen={(r) => { setOpenRec(r); setEditRec(null); }} />
                <div className="flex flex-col gap-2">
                  {g.records.filter((r) => !r.supersededBy).map((rec) => (
                    <button
                      key={rec.id}
                      onClick={() => { setOpenRec(rec); setEditRec(null); }}
                      className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] px-4 py-2.5 text-left hover:border-[var(--color-acc)]"
                    >
                      <span className="shrink-0 rounded-full bg-[var(--color-line)] px-2 py-0.5 text-xs text-[var(--color-mut)]">第 {rec.generationCount} 代</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{firstLine(rec.activeObservations)}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${rec.supersededBy ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>{rec.supersededBy ? '已被替代' : '已生效'}</span>
                      <span className="shrink-0 text-xs text-[var(--color-mut)]">{fmt(rec.updatedAt || rec.createdAt)}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'export' && (
        <div className="flex-1 px-6 py-8">
          <div className="max-w-md rounded-2xl border border-[var(--color-line)] bg-[var(--color-side)] p-5">
            <h3 className="text-sm font-semibold">导出记忆存档</h3>
            <p className="mt-2 text-xs leading-5 text-[var(--color-mut)]">
              包含主人画像与全部房间的观测日志。JSON 适合机器处理，Markdown 适合人读存档。
            </p>
            <div className="mt-4 flex gap-2">
              <button disabled={busy} onClick={() => void exportOmDownload('md').catch((e) => setErr(String(e)))} className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white hover:opacity-90">导出 Markdown</button>
              <button disabled={busy} onClick={() => void exportOmDownload('json').catch((e) => setErr(String(e)))} className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm hover:text-[var(--color-fg)]">导出 JSON</button>
            </div>
          </div>
        </div>
      )}

      {openRec && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpenRec(null)}>
          <div className="flex max-h-[80vh] w-[640px] flex-col rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-semibold">第 {openRec.generationCount} 代观测 · {fmt(openRec.createdAt)}</h3>
              <button className="text-[var(--color-mut)] hover:text-[var(--color-fg)]" onClick={() => setOpenRec(null)}>✕</button>
            </div>
            {editRec === openRec.id ? (
              <>
                <textarea
                  id="om-edit-text"
                  defaultValue={openRec.activeObservations}
                  rows={12}
                  className="w-full flex-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-acc)]"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm text-[var(--color-mut)]" onClick={() => setEditRec(null)}>取消</button>
                  <button
                    disabled={busy}
                    className="rounded-full bg-[var(--color-acc)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
                    onClick={() => {
                      const ta = document.getElementById('om-edit-text') as HTMLTextAreaElement | null;
                      if (ta) void saveRecord(openRec, ta.value);
                    }}
                  >
                    保存修正
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="thin-scroll flex-1 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--color-line)] bg-[var(--color-side)] px-4 py-3 font-mono text-xs leading-5">
                  {openRec.activeObservations || '（空）'}
                </div>
                {openRec.bufferedReflection && (
                  <div className="mt-2 rounded-xl border border-[var(--color-line)] px-4 py-2 text-xs leading-5 text-[var(--color-mut)]">
                    <b>反思：</b>{openRec.bufferedReflection}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-sm hover:text-[var(--color-fg)]" onClick={() => setEditRec(openRec.id)}>修正</button>
                  <button className="rounded-full border border-red-200 px-4 py-1.5 text-sm text-red-600 hover:bg-red-50" onClick={() => void deleteRecord(openRec)}>删除</button>
                  <span className="ml-auto text-xs text-[var(--color-mut)]">id {openRec.id.slice(0, 12)}…</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
