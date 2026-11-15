import { useEffect, useState } from 'react';
import type { Persona, SessionRow, User } from '../lib/api';
import { getModels, getPersona, updatePersona, getOnboardingStatus, setRegistration, sendVerificationEmail, listSessions, revokeSession, revokeOtherSessions, getNotificationPrefs, patchNotificationPrefs } from '../lib/api';

export function SettingsPanel({
  onClose,
  onSuccess,
  me,
  onEnablePush,
}: {
  onClose: () => void;
  onSuccess: (p: Persona) => void;
  me?: User | null;
  onEnablePush?: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [style, setStyle] = useState('');
  const [mainRoomName, setMainRoomName] = useState('');
  const [productName, setProductName] = useState('');
  const [basePrompt, setBasePrompt] = useState('');
  const [toneMain, setToneMain] = useState('');
  const [toneRoom, setToneRoom] = useState('');
  const [omObserve, setOmObserve] = useState('');
  const [omReflect, setOmReflect] = useState('');
  const [toolDispatch, setToolDispatch] = useState('');
  const [modelGateway, setModelGateway] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelEffort, setModelEffort] = useState('');
  const [gateways, setGateways] = useState<{ gateway: string; models: string[] }[]>([]);
  const [effortLevels, setEffortLevels] = useState<string[]>([]);
  const [signupsOpen, setSignupsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [secMsg, setSecMsg] = useState('');
  const [notifPerm, setNotifPerm] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [mailPrefs, setMailPrefs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([getPersona(), getModels()])
      .then(([p, m]) => {
        setProductName(p.product_name ?? '');
        setName(p.name);
        setRole(p.role);
        setStyle(p.style);
        setMainRoomName(p.main_room_name);
        setBasePrompt(p.base_prompt ?? '');
        setToneMain(p.tone_main ?? '');
        setToneRoom(p.tone_room ?? '');
        setOmObserve(p.om_observe ?? '');
        setOmReflect(p.om_reflect ?? '');
        setToolDispatch(p.tool_dispatch ?? '');
        setModelGateway(p.model_gateway ?? '');
        setModelName(p.model_name ?? '');
        setModelEffort(p.model_effort ?? '');
        setGateways(m.gateways);
        setEffortLevels(m.effortLevels);
      })
      .catch(() => setErr('加载配置失败，请稍后重试'))
      .finally(() => setLoading(false));
    getOnboardingStatus().then((s) => setSignupsOpen(s.signupsOpen)).catch(() => {});
    listSessions().then(setSessions).catch(() => {});
    getNotificationPrefs().then(setMailPrefs).catch(() => {});
  }, []);

  const toggleMailGroup = async (kinds: string[], on: boolean) => {
    const patch: Record<string, boolean> = {};
    for (const k of kinds) patch[k] = on;
    setMailPrefs((m) => ({ ...m, ...patch }));
    try { setMailPrefs(await patchNotificationPrefs(patch)); } catch { /* 保留乐观值，下次打开自愈 */ }
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const p = await updatePersona({
        product_name: productName,
        name,
        role,
        style,
        main_room_name: mainRoomName,
        base_prompt: basePrompt,
        tone_main: toneMain,
        tone_room: toneRoom,
        om_observe: omObserve,
        om_reflect: omReflect,
        tool_dispatch: toolDispatch,
        model_gateway: modelGateway,
        model_name: modelName,
        model_effort: modelEffort,
      });
      onSuccess(p);
    } catch {
      setErr('保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  const gatewayModels = gateways.find((g) => g.gateway === modelGateway)?.models ?? [];
  const modelOptions =
    modelName && !gatewayModels.includes(modelName) ? [...gatewayModels, modelName] : gatewayModels;

  function onGatewayChange(g: string) {
    setModelGateway(g);
    setModelName(gateways.find((x) => x.gateway === g)?.models[0] ?? '');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-8"
      >
        <h1 className="mb-1 text-xl font-semibold">秘书设置</h1>
        <p className="mb-6 text-sm text-[var(--color-mut)]">调整秘书的人格与主会话</p>

        {loading ? (
          <div className="py-10 text-center text-sm text-[var(--color-mut)]">加载中…</div>
        ) : (
          <>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>产品名称（白牌化）</span>
                <span>{productName.length}/100</span>
              </span>
              <input
                value={productName}
                maxLength={100}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="cf-bot"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
              <span className="mt-1 block text-xs text-[var(--color-mut)]">登录页与浏览器标题显示的产品名（白牌化），默认 cf-bot</span>
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>秘书名称</span>
                <span>{name.length}/200</span>
              </span>
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder="怎么称呼秘书"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>身份角色</span>
                <span>{role.length}/500</span>
              </span>
              <input
                value={role}
                maxLength={500}
                onChange={(e) => setRole(e.target.value)}
                placeholder="如 24 小时贴身秘书、管家与伴侣"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>语调风格</span>
                <span>{style.length}/1000</span>
              </span>
              <textarea
                value={style}
                maxLength={1000}
                rows={4}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="语调与性格要点"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>主会话名称</span>
                <span>{mainRoomName.length}/50</span>
              </span>
              <input
                value={mainRoomName}
                maxLength={50}
                onChange={(e) => setMainRoomName(e.target.value)}
                placeholder="主会话显示名"
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">提示词高级设置</p>
              <p className="text-xs text-[var(--color-mut)]">控制秘书在不同场景下的提示词行为</p>
            </div>

            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>基础提示词</span>
                <span>{basePrompt.length}/4000</span>
              </span>
              <textarea
                value={basePrompt}
                maxLength={4000}
                rows={6}
                onChange={(e) => setBasePrompt(e.target.value)}
                placeholder="每轮都生效的基础人设与规则"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>主会话语调</span>
                <span>{toneMain.length}/500</span>
              </span>
              <textarea
                value={toneMain}
                maxLength={500}
                rows={2}
                onChange={(e) => setToneMain(e.target.value)}
                placeholder="主会话语调"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>共享房间语调</span>
                <span>{toneRoom.length}/500</span>
              </span>
              <textarea
                value={toneRoom}
                maxLength={500}
                rows={2}
                onChange={(e) => setToneRoom(e.target.value)}
                placeholder="共享房间语调"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>记忆观察员指令（引擎重启后生效）</span>
                <span>{omObserve.length}/500</span>
              </span>
              <textarea
                value={omObserve}
                maxLength={500}
                rows={2}
                onChange={(e) => setOmObserve(e.target.value)}
                placeholder="记忆观察员指令"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>记忆压缩指令（引擎重启后生效）</span>
                <span>{omReflect.length}/500</span>
              </span>
              <textarea
                value={omReflect}
                maxLength={500}
                rows={2}
                onChange={(e) => setOmReflect(e.target.value)}
                placeholder="记忆压缩指令"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>
            <label className="mb-5 block">
              <span className="mb-1 flex items-baseline justify-between text-xs text-[var(--color-mut)]">
                <span>任务派发工具描述（即改即生效）</span>
                <span>{toolDispatch.length}/500</span>
              </span>
              <textarea
                value={toolDispatch}
                maxLength={500}
                rows={2}
                onChange={(e) => setToolDispatch(e.target.value)}
                placeholder="任务派发工具描述"
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              />
            </label>

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">注册设置</p>
              <p className="text-xs text-[var(--color-mut)]">是否允许新用户自行注册（管理员可随时切换）</p>
            </div>
            <label className="mb-5 flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <span className="text-sm">开放注册</span>
              <input
                type="checkbox"
                checked={signupsOpen}
                onChange={async (e) => {
                  const v = e.target.checked;
                  setSignupsOpen(v);
                  const r = await setRegistration(v);
                  if (!r.ok) setSignupsOpen(!v);
                }}
                className="h-4 w-4"
              />
            </label>

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">账号与安全</p>
              <p className="text-xs text-[var(--color-mut)]">邮箱验证、登录会话与桌面通知</p>
            </div>
            <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <div>
                <span className="text-sm">邮箱验证</span>
                <p className="text-xs text-[var(--color-mut)]">
                  {me?.emailVerified ? `${me.email} · 已验证` : '未验证（订阅前需完成验证）'}
                </p>
              </div>
              {!me?.emailVerified && (
                <button
                  type="button"
                  onClick={async () => {
                    setSecMsg('');
                    try {
                      await sendVerificationEmail(me?.email ?? '');
                      setSecMsg('验证邮件已发出，请查收');
                    } catch {
                      setSecMsg('发送失败，请稍后再试');
                    }
                  }}
                  className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
                >
                  发验证邮件
                </button>
              )}
            </div>
            <div className="mb-3 rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm">登录会话（{sessions.length}）</span>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    onClick={async () => {
                      try { await revokeOtherSessions(); setSessions(await listSessions()); setSecMsg('其他会话已全部下线'); } catch { setSecMsg('操作失败'); }
                    }}
                    className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-red-500"
                  >
                    其他全部下线
                  </button>
                )}
              </div>
              <div className="mt-2 space-y-1">
                {sessions.slice(0, 8).map((s) => (
                  <div key={s.token} className="flex items-center justify-between gap-2 text-xs text-[var(--color-mut)]">
                    <span className="truncate">{(s.userAgent ?? '未知设备').slice(0, 48)} · {new Date(s.createdAt).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        try { await revokeSession(s.token); setSessions(await listSessions()); } catch { setSecMsg('下线失败'); }
                      }}
                      className="shrink-0 hover:text-red-500"
                    >
                      下线
                    </button>
                  </div>
                ))}
                {sessions.length === 0 && <p className="text-xs text-[var(--color-mut)]">暂无其他登录记录</p>}
              </div>
              <p className="mt-2 text-[11px] text-[var(--color-mut)]">登录会话是「看得到聊天的入口」，与「执行设备」（跑任务的电脑）分开管理。</p>
            </div>
            <div className="mb-5 flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <div>
                <span className="text-sm">桌面/浏览器通知</span>
                <p className="text-xs text-[var(--color-mut)]">
                  {{ granted: '已开启', denied: '已拒绝（需在系统设置里改）', default: '未授权', unsupported: '当前环境不支持' }[notifPerm] ?? notifPerm}
                </p>
              </div>
              {notifPerm === 'default' && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const p = await Notification.requestPermission();
                      setNotifPerm(p);
                      if (p === 'granted') {
                        setSecMsg('已开启桌面通知');
                        await onEnablePush?.();
                      }
                    } catch { setSecMsg('开启失败'); }
                  }}
                  className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
                >
                  开启
                </button>
              )}
            </div>
            <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <div>
                <span className="text-sm">决策提醒邮件</span>
                <p className="text-xs text-[var(--color-mut)]">拍板请求与过期提醒发到邮箱</p>
              </div>
              <input
                type="checkbox"
                checked={mailPrefs['decision.requested'] !== false && mailPrefs['decision.expired'] !== false}
                onChange={(e) => toggleMailGroup(['decision.requested', 'decision.expired'], e.target.checked)}
                className="h-4 w-4"
              />
            </div>
            <div className="mb-5 flex items-center justify-between rounded-xl border border-[var(--color-line)] px-3 py-2.5">
              <div>
                <span className="text-sm">额度与账单邮件</span>
                <p className="text-xs text-[var(--color-mut)]">额度预警/耗尽与订阅欠费提醒</p>
              </div>
              <input
                type="checkbox"
                checked={mailPrefs['quota.low'] !== false && mailPrefs['quota.empty'] !== false && mailPrefs['subscription.past_due'] !== false}
                onChange={(e) => toggleMailGroup(['quota.low', 'quota.empty', 'subscription.past_due'], e.target.checked)}
                className="h-4 w-4"
              />
            </div>
            {secMsg && <p className="mb-4 text-xs text-[var(--color-acc)]">{secMsg}</p>}

            <div className="mb-4 mt-6 border-t border-[var(--color-line)] pt-4">
              <p className="text-sm font-semibold">模型设置</p>
              <p className="text-xs text-[var(--color-mut)]">选择模型网关、模型与推理力度</p>
            </div>

            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">模型网关</span>
              <select
                value={modelGateway}
                onChange={(e) => onGatewayChange(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {gateways.map((g) => (
                  <option key={g.gateway} value={g.gateway}>
                    {g.gateway}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">模型</span>
              <select
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-5 block">
              <span className="mb-1 block text-xs text-[var(--color-mut)]">推理力度 / effort</span>
              <select
                value={modelEffort}
                onChange={(e) => setModelEffort(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-acc)]"
              >
                {effortLevels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {err && <p className="mb-3 text-sm text-red-500">{err}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-[var(--color-line)] py-2.5 font-medium text-[var(--color-mut)] hover:text-[var(--color-fg)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || loading}
            className="flex-1 rounded-full bg-[var(--color-fg)] py-2.5 font-medium text-[var(--color-bg)] disabled:opacity-50"
          >
            {busy ? '请稍候…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
