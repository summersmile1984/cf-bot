import { useCallback, useEffect, useState } from 'react';
import type { AgentDef, PermRule, Schedule, HarnessInfo, DeviceInfo } from '../lib/api';
import {
  listAgentDefs, createAgentDef, updateAgentDef, deleteAgentDef,
  getPermissions, putPermissions, deletePermission,
  listSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow, listScheduleRuns,
  getHarnessSettings, setHarnessDefault,
  listDevices, createPairingCode, renameDevice, revokeDevice, setDefaultDevice,
} from '../lib/api';

/** L2 控制台（l2-console S2.1–S2.6 + multi-device S2.4）：专家 / 权限 / 例程 / 执行引擎 / 设备 */
export function L2Page({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'experts' | 'perms' | 'sched' | 'harness' | 'devices'>('experts');
  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-5 py-3">
        <h1 className="text-base font-semibold">管理</h1>
        <div className="flex gap-1">
          {([['experts', '专家'], ['perms', '权限'], ['sched', '例程'], ['harness', '执行引擎'], ['devices', '设备']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-full px-3 py-1 text-xs ${tab === k ? 'bg-[var(--color-fg)] text-[var(--color-bg)]' : 'text-[var(--color-mut)] hover:text-[var(--color-fg)]'}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-auto rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">关闭</button>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto p-5">
        {tab === 'experts' && <ExpertsTab />}
        {tab === 'perms' && <PermsTab />}
        {tab === 'sched' && <SchedTab />}
        {tab === 'harness' && <HarnessTab />}
        {tab === 'devices' && <DevicesTab />}
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]';
const labelCls = 'mb-1 block text-xs text-[var(--color-mut)]';

// ---------------- 专家 ----------------
function ExpertsTab() {
  const [defs, setDefs] = useState<AgentDef[]>([]);
  const [editing, setEditing] = useState<Partial<AgentDef> | null>(null);
  const [err, setErr] = useState('');
  const refresh = useCallback(() => listAgentDefs().then(setDefs).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  async function save() {
    if (!editing) return;
    setErr('');
    try {
      if (!editing.name || !editing.instructions) throw new Error('名称与指令必填');
      if (editing.id) await updateAgentDef(editing.id, editing);
      else await createAgentDef(editing);
      setEditing(null);
      refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-[var(--color-mut)]">专家 = 有专长的子代理，可被派发任务；对话工坊适合起草，这里适合精修与治理。</p>
        <button onClick={() => setEditing({ name: '', description: '', instructions: '' })} className="rounded-full bg-[var(--color-fg)] px-3 py-1.5 text-xs text-[var(--color-bg)]">新建专家</button>
      </div>
      {editing && (
        <div className="mb-4 rounded-2xl border border-[var(--color-line)] p-4">
          <p className="mb-3 text-sm font-medium">{editing.id ? '编辑专家' : '新建专家'}</p>
          <label className="mb-2 block"><span className={labelCls}>名称</span>
            <input className={inputCls} value={editing.name ?? ''} maxLength={100} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="mb-2 block"><span className={labelCls}>一句话专长</span>
            <input className={inputCls} value={editing.description ?? ''} maxLength={500} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
          <label className="mb-2 block"><span className={labelCls}>系统指令（instructions）</span>
            <textarea className={inputCls} rows={6} value={editing.instructions ?? ''} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} /></label>
          {(['tools_json', 'mcp_json', 'skills_json', 'memory_json'] as const).map((k) => (
            <label key={k} className="mb-2 block"><span className={labelCls}>{k}（JSON，可空）</span>
              <textarea className={inputCls} rows={2} value={(editing as any)[k] ?? ''} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} /></label>
          ))}
          <label className="mb-3 block"><span className={labelCls}>模型（可空=继承全局）</span>
            <input className={inputCls} value={editing.model ?? ''} onChange={(e) => setEditing({ ...editing, model: e.target.value })} /></label>
          {err && <p className="mb-2 text-sm text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button onClick={save} className="rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs text-[var(--color-bg)]">保存</button>
            <button onClick={() => { setEditing(null); setErr(''); }} className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-xs text-[var(--color-mut)]">取消</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {defs.map((ddef) => (
          <div key={ddef.id} className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{ddef.name}</div>
              <div className="truncate text-xs text-[var(--color-mut)]">{ddef.description || ddef.instructions?.slice(0, 80)}</div>
            </div>
            <button onClick={() => setEditing(ddef)} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">编辑</button>
            <button onClick={async () => { if (confirm(`删除专家「${ddef.name}」？`)) { await deleteAgentDef(ddef.id); refresh(); } }}
              className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-red-500">删除</button>
          </div>
        ))}
        {!defs.length && <p className="py-8 text-center text-sm text-[var(--color-mut)]">还没有专家——可以直接新建，或在聊天里说「帮我建个调研专家」用工坊起草。</p>}
      </div>
    </div>
  );
}

// ---------------- 权限 ----------------
function PermsTab() {
  const [rules, setRules] = useState<PermRule[]>([]);
  const [autoReview, setAutoReview] = useState(true);
  const [tool, setTool] = useState('');
  const [policy, setPolicy] = useState('ask');
  const refresh = useCallback(() => getPermissions().then((r) => { setRules(r.rules ?? []); setAutoReview(!!r.settings?.auto_review); }).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  async function upsert() {
    if (!tool.trim()) return;
    const next = [...rules.filter((r) => r.category_or_tool !== tool.trim()), { category_or_tool: tool.trim(), policy }];
    await putPermissions(next, autoReview);
    setTool('');
    refresh();
  }

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-mut)]">控制 L2 执行工具的边界：deny=直接拒绝；ask=执行前在主会话征求你确认；allow=审计放行。</p>
      <label className="mb-4 flex items-center justify-between rounded-2xl border border-[var(--color-line)] px-4 py-3">
        <span className="text-sm">自动审查（Auto Review）</span>
        <input type="checkbox" className="h-4 w-4" checked={autoReview}
          onChange={async (e) => { setAutoReview(e.target.checked); await putPermissions(rules, e.target.checked); }} />
      </label>
      <div className="mb-3 flex gap-2">
        <input className={inputCls} placeholder="工具或类别（如 computer_screenshot / execute）" value={tool} onChange={(e) => setTool(e.target.value)} />
        <select className={`${inputCls} w-32`} value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="allow">allow</option>
          <option value="ask">ask</option>
          <option value="deny">deny</option>
        </select>
        <button onClick={upsert} className="rounded-full bg-[var(--color-fg)] px-4 text-xs text-[var(--color-bg)]">添加</button>
      </div>
      <div className="space-y-2">
        {rules.map((r) => (
          <div key={r.category_or_tool} className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] px-4 py-2.5">
            <span className="flex-1 truncate font-mono text-xs">{r.category_or_tool}</span>
            <select className={`${inputCls} w-28`} value={r.policy}
              onChange={async (e) => { await putPermissions(rules.map((x) => x.category_or_tool === r.category_or_tool ? { ...x, policy: e.target.value } : x), autoReview); refresh(); }}>
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
            <button onClick={async () => { await deletePermission(r.category_or_tool); refresh(); }}
              className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-red-500">删除</button>
          </div>
        ))}
        {!rules.length && <p className="py-8 text-center text-sm text-[var(--color-mut)]">没有自定义规则——未配置的工具默认走 ask（执行前征求确认）。</p>}
      </div>
    </div>
  );
}

// ---------------- 例程 ----------------
function SchedTab() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<Array<{ status: string; detail?: string; created_at?: number }>>([]);
  const [err, setErr] = useState('');
  const refresh = useCallback(() => listSchedules().then(setItems).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  async function save() {
    if (!editing) return;
    setErr('');
    try {
      if (!editing.name || !editing.prompt || !editing.cron) throw new Error('名称 / 内容 / cron 必填');
      if (editing.id) await updateSchedule(editing.id, editing);
      else await createSchedule({ ...editing, enabled: true });
      setEditing(null);
      refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-[var(--color-mut)]">定时例程：cron 5 字段（分 时 日 月 周）；立即运行会在 1 分钟内执行。</p>
        <button onClick={() => setEditing({ name: '', prompt: '', cron: '0 9 * * *', timezone: 'Asia/Shanghai' })} className="rounded-full bg-[var(--color-fg)] px-3 py-1.5 text-xs text-[var(--color-bg)]">新建例程</button>
      </div>
      {editing && (
        <div className="mb-4 rounded-2xl border border-[var(--color-line)] p-4">
          <p className="mb-3 text-sm font-medium">{editing.id ? '编辑例程' : '新建例程'}</p>
          <label className="mb-2 block"><span className={labelCls}>名称</span>
            <input className={inputCls} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="mb-2 block"><span className={labelCls}>到点执行的内容</span>
            <textarea className={inputCls} rows={3} value={editing.prompt ?? ''} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} /></label>
          <div className="mb-2 flex gap-2">
            <label className="flex-1"><span className={labelCls}>cron</span>
              <input className={inputCls} value={editing.cron ?? ''} onChange={(e) => setEditing({ ...editing, cron: e.target.value })} /></label>
            <label className="flex-1"><span className={labelCls}>时区</span>
              <input className={inputCls} value={editing.timezone ?? 'Asia/Shanghai'} onChange={(e) => setEditing({ ...editing, timezone: e.target.value })} /></label>
          </div>
          <p className="mb-2 text-xs text-[var(--color-mut)]">常用：0 9 * * *（每天9点）· 0 9 * * 1-5（工作日9点）· * * * * *（每分钟）</p>
          {err && <p className="mb-2 text-sm text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button onClick={save} className="rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs text-[var(--color-bg)]">保存</button>
            <button onClick={() => { setEditing(null); setErr(''); }} className="rounded-full border border-[var(--color-line)] px-4 py-1.5 text-xs text-[var(--color-mut)]">取消</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s.id} className="rounded-2xl border border-[var(--color-line)] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.name} <span className="ml-2 font-mono text-[11px] text-[var(--color-mut)]">{s.cron}</span></div>
                <div className="truncate text-xs text-[var(--color-mut)]">{s.prompt}</div>
              </div>
              <button onClick={async () => { await updateSchedule(s.id, { enabled: !s.enabled }); refresh(); }}
                className={`rounded-full px-3 py-1 text-xs ${s.enabled ? 'bg-green-100 text-green-700' : 'bg-[var(--color-line)] text-[var(--color-mut)]'}`}>
                {s.enabled ? '启用中' : '已暂停'}
              </button>
              <button onClick={async () => { const r = await runScheduleNow(s.id); alert(r.ok ? r.note : r.error); }}
                className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">立即运行</button>
              <button onClick={async () => {
                if (runsFor === s.id) { setRunsFor(null); return; }
                setRunsFor(s.id);
                const r = await listScheduleRuns(s.id).catch(() => ({ runs: [] }));
                setRuns((r as any).runs ?? []);
              }} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">记录</button>
              <button onClick={async () => { if (confirm(`删除例程「${s.name}」？`)) { await deleteSchedule(s.id); refresh(); } }}
                className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-red-500">删除</button>
            </div>
            {runsFor === s.id && (
              <div className="mt-2 space-y-1 rounded-xl bg-[var(--color-bg)] p-2 text-xs">
                {runs.length ? runs.map((r, i) => (
                  <div key={i} className="flex gap-2">
                    <span className={r.status === 'success' ? 'text-green-600' : 'text-red-500'}>{r.status}</span>
                    <span className="truncate text-[var(--color-mut)]">{r.detail ?? ''}</span>
                  </div>
                )) : <span className="text-[var(--color-mut)]">暂无运行记录</span>}
              </div>
            )}
          </div>
        ))}
        {!items.length && <p className="py-8 text-center text-sm text-[var(--color-mut)]">还没有例程——可以直接新建，或在聊天里说「每天早上 9 点提醒我」。</p>}
      </div>
    </div>
  );
}

// ---------------- 执行引擎 ----------------
function HarnessTab() {
  const [harness, setHarness] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<HarnessInfo[]>([]);
  useEffect(() => {
    getHarnessSettings().then((r) => { setHarness(r.harness); setCatalog(r.catalog ?? []); }).catch(() => {});
  }, []);
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-mut)]">选择 L2 任务的 ACP 执行引擎（harness）。安装与本机检测在桌面端完成；这里设「账号默认」。</p>
      <label className="mb-4 block"><span className={labelCls}>账号默认引擎</span>
        <select className={inputCls} value={harness ?? ''}
          onChange={async (e) => { const v = e.target.value || null; setHarness(v); await setHarnessDefault(v); }}>
          <option value="">（跟随设备默认）</option>
          {catalog.map((h) => <option key={h.id} value={h.id}>{h.name}（{h.command}）</option>)}
        </select></label>
      <div className="space-y-2">
        {catalog.map((h) => (
          <div key={h.id} className="rounded-2xl border border-[var(--color-line)] px-4 py-3">
            <div className="text-sm font-medium">{h.name} <span className="ml-2 font-mono text-[11px] text-[var(--color-mut)]">{h.command}</span></div>
            {h.description && <div className="mt-0.5 text-xs text-[var(--color-mut)]">{h.description}</div>}
          </div>
        ))}
        {!catalog.length && <p className="py-8 text-center text-sm text-[var(--color-mut)]">目录为空或加载失败。</p>}
      </div>
    </div>
  );
}

// ---------------- 设备（multi-device S2.4） ----------------
function DevicesTab() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const refresh = useCallback(() => listDevices().then(setDevices).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  const fmt = (ts: number | null) => {
    if (!ts) return '从未';
    const diff = Date.now() - ts;
    if (diff < 90_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(ts).toLocaleString();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-[var(--color-mut)]">把你的电脑接进来：生成配对码 → 在桌面端输入，即可成为一台执行设备。多台电脑可分别配对、指定默认。</p>
        <button onClick={async () => setCode(await createPairingCode())}
          className="rounded-full bg-[var(--color-fg)] px-3 py-1.5 text-xs text-[var(--color-bg)]">生成配对码</button>
      </div>
      {code && (
        <div className="mb-4 rounded-2xl border border-[var(--color-acc)] p-4">
          <p className="text-xs text-[var(--color-mut)]">配对码（10 分钟内有效，一次一码）</p>
          <p className="my-1 font-mono text-2xl font-semibold tracking-widest">{code.code}</p>
          <p className="text-xs text-[var(--color-mut)]">在桌面端「设备配对」里填入此码；配对成功后这台电脑会自动出现在下方列表。</p>
        </div>
      )}
      <div className="space-y-2">
        {devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {d.name}
                {d.isDefault && <span className="ml-2 rounded-full bg-[var(--color-acc)] px-2 py-0.5 text-[10px] text-white">默认</span>}
                {d.status !== 'active' && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-600">已吊销</span>}
              </div>
              <div className="truncate text-xs text-[var(--color-mut)]">
                最后活跃 {fmt(d.lastSeenAt)}
                {Object.keys(d.capabilities ?? {}).length > 0 && ` · 能力 ${Object.keys(d.capabilities).join('/')}`}
              </div>
            </div>
            {d.status === 'active' && !d.isDefault && (
              <button onClick={async () => { await setDefaultDevice(d.id); refresh(); }}
                className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">设为默认</button>
            )}
            {d.status === 'active' && d.isDefault && (
              <button onClick={async () => { await setDefaultDevice(null); refresh(); }}
                className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">取消默认</button>
            )}
            {d.status === 'active' && (
              <>
                <button onClick={async () => {
                  const name = prompt('设备名称', d.name);
                  if (name != null && name.trim()) { await renameDevice(d.id, name.trim()); refresh(); }
                }} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]">改名</button>
                <button onClick={async () => {
                  if (confirm(`吊销「${d.name}」？这台电脑将无法再接收任务。`)) { await revokeDevice(d.id); refresh(); }
                }} className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-red-500">吊销</button>
              </>
            )}
          </div>
        ))}
        {!devices.length && <p className="py-8 text-center text-sm text-[var(--color-mut)]">还没有设备——点右上「生成配对码」，在桌面端输入即可接入。</p>}
      </div>
    </div>
  );
}
