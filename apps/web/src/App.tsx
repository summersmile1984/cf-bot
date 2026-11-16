import { useCallback, useEffect, useState } from 'react';
import type { Member, Persona, Room, User } from './lib/api';
import { getSession, signOut, listRooms, createRoom, getRoom, getBrand, getOnboardingStatus, verifyEmailByToken, getNotifications, pushSubscribe } from './lib/api';
import { Login } from './components/Login';
import { ResetPassword } from './components/ResetPassword';
import { Setup } from './components/Setup';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/SettingsPanel';
import { McpPage } from './components/McpPage';
import { MemoryPage } from './components/MemoryPage';
import { L2Page } from './components/L2Page';
import { DecisionsPage } from './components/DecisionsPage';
import { TasksPage } from './components/TasksPage';
import { NotificationsBell } from './components/NotificationsBell';

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [roomName, setRoomName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'mcp' | 'memory' | 'l2' | 'decisions' | 'tasks'>('chat');
  const [mcpTab, setMcpTab] = useState<'market' | 'mine'>('market');
  const [mcpToast, setMcpToast] = useState<string | null>(null);
  const [productName, setProductName] = useState('cf-bot');
  const [onboarding, setOnboarding] = useState<'checking' | 'setup' | 'ready'>('checking');
  const [tsSitekey, setTsSitekey] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);

  // 站内深链（通知/待办共用）：room:<id> / decisions / settings
  const navigateLink = useCallback((link: string) => {
    if (link === 'decisions') { setView('decisions'); return; }
    if (link === 'settings') { setSettingsOpen(true); return; }
    if (link.startsWith('room:')) {
      const id = link.slice(5).split('?')[0];
      const r = rooms.find((x) => x.id === id);
      setView('chat');
      setActiveId(id);
      if (r) setRoomName(r.name);
    }
  }, [rooms]);

  // Web Push（notifications T4）：授权后注册 SW 并订阅推送；空载荷推送由 SW 拉取展示
  const enablePush = useCallback(async () => {
    try {
      if (!('serviceWorker' in navigator) || typeof Notification === 'undefined') return;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.register('/sw.js');
      const { vapidPublicKey } = await getNotifications(1);
      if (!vapidPublicKey || !('PushManager' in window)) return;
      const key = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await pushSubscribe(sub.toJSON() as any);
    } catch { /* 不支持的环境（无 PushManager 等）静默跳过 */ }
  }, []);

  // SW 点击通知 → 深链
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'navigate') navigateLink(String(e.data.link ?? '')); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [navigateLink]);

  // 账号链接入站：?reset_token= 重置表单；?verify_token= 静默验证（account-hardening S2.2/S2.3）
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const rv = p.get('reset_token');
    const vf = p.get('verify_token');
    const taskDraft = p.get('task');
    if (rv || vf || taskDraft) {
      p.delete('reset_token'); p.delete('verify_token'); p.delete('task');
      const q = p.toString();
      history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
    }
    if (taskDraft) {
      // 网页交办草稿交 Chat 一次性消费（sessionStorage：房间切换重挂不重复填）
      try { sessionStorage.setItem('taskPrefill', taskDraft.slice(0, 8000)); } catch { /* 静默 */ }
      setPrefill(taskDraft.slice(0, 8000));
    }
    if (rv) setResetToken(rv);
    if (vf) {
      verifyEmailByToken(vf)
        .then(() => setMcpToast('✓ 邮箱已验证'))
        .catch(() => setMcpToast('验证链接无效或已过期'))
        .finally(() => { const t = setTimeout(() => setMcpToast(null), 6000); return () => clearTimeout(t); });
    }
  }, []);

  // 产品名（白牌化）：公开接口拉取，标题/登录页统一使用
  useEffect(() => {
    getBrand()
      .then((b) => setProductName(b.productName))
      .catch(() => {});
  }, []);
  // 首跑向导（onboarding）：无用户时强制进 /setup
  useEffect(() => {
    getOnboardingStatus()
      .then((s) => {
        setTsSitekey(s.turnstileSitekey ?? null);
        setOnboarding(s.needsSetup ? 'setup' : 'ready');
      })
      .catch(() => setOnboarding('ready'));
  }, []);
  useEffect(() => {
    document.title = `${productName} · 房间`;
  }, [productName]);

  // OAuth 回跳：/app?mcp=connected|error → toast + 切「我的 MCP」（web-mcp S2.2）
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const mcp = p.get('mcp');
    if (!mcp) return;
    const name = p.get('name') ?? '';
    const account = p.get('account') ?? '';
    const reason = p.get('reason') ?? '';
    if (mcp === 'connected') {
      setMcpToast(`✓ ${name} 已连接${account ? `（${account}）` : ''}`);
      setMcpTab('mine');
    } else {
      setMcpToast(`连接失败${reason ? `：${reason}` : ''}`);
    }
    setView('mcp');
    p.delete('mcp'); p.delete('name'); p.delete('account'); p.delete('reason');
    const q = p.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
    const t = setTimeout(() => setMcpToast(null), 6000);
    return () => clearTimeout(t);
  }, []);

  // 桌面/浏览器系统通知（notifications T2）：授权后，新未读直接弹系统通知，点击聚焦并深链
  useEffect(() => {
    if (!me?.id || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const known = new Set<string>();
    let first = true;
    const tick = async () => {
      try {
        const r = await getNotifications(10);
        const fresh = (r.items ?? []).filter((n: any) => n.status === 'unread' && !known.has(n.id));
        if (!first) {
          for (const n of fresh) {
            try {
              const note = new Notification(n.title, { body: n.body ?? '', tag: n.id });
              note.onclick = () => { window.focus(); if (n.link) navigateLink(n.link); note.close(); };
            } catch { /* 单条失败不影响后续 */ }
          }
        }
        for (const n of r.items ?? []) known.add(n.id);
        first = false;
      } catch { /* 静默 */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [me?.id, navigateLink]);

  const refreshRooms = useCallback(async () => {
    try {
      const rs = await listRooms();
      setRooms(rs);
      return rs;
    } catch {
      return [] as Room[];
    }
  }, []);

  // 会话 + 房间列表
  useEffect(() => {
    (async () => {
      const u = await getSession();
      setMe(u);
      setLoading(false);
      if (u) {
        const rs = await refreshRooms();
        if (rs.length && !activeId) {
          setActiveId(rs[0].id);
          setRoomName(rs[0].name);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  // 网页交办草稿（browser-ext S2.2）：切主会话并预填输入框（不自动发送）
  useEffect(() => {
    if (!prefill || !rooms.length) return;
    const main = rooms.find((r) => r.is_main === 1) ?? rooms[0];
    if (main) {
      setView('chat');
      setActiveId(main.id);
      setRoomName(main.name);
    }
    setPrefill(null);
  }, [prefill, rooms]);

  // 当前房间成员
  useEffect(() => {
    if (!activeId) return;
    getRoom(activeId)
      .then(({ room, members }) => {
        setMembers(members);
        setRoomName(room.name);
      })
      .catch(() => setMembers([]));
  }, [activeId]);

  async function handleSignOut() {
    await signOut();
    setMe(null);
    setRooms([]);
    setActiveId(null);
  }

  async function handleNewRoom(name: string) {
    const r = await createRoom(name);
    await refreshRooms();
    setActiveId(r.id);
    setRoomName(r.name);
  }

  function handlePersonaSaved(p: Persona) {
    if (p.product_name) setProductName(p.product_name);
    setRooms((rs) => rs.map((r) => (r.is_main === 1 ? { ...r, name: p.main_room_name } : r)));
    const active = rooms.find((r) => r.id === activeId);
    if (active?.is_main === 1) setRoomName(p.main_room_name);
    setSettingsOpen(false);
  }

  if (loading || onboarding === 'checking') {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-mut)]">加载中…</div>
    );
  }

  if (onboarding === 'setup') {
    return <Setup productName={productName} onDone={() => setOnboarding('ready')} />;
  }

  if (resetToken) {
    return <ResetPassword token={resetToken} productName={productName} onDone={() => { window.location.href = '/'; }} />;
  }

  if (!me) {
    return (
      <Login
        productName={productName}
        turnstileSitekey={tsSitekey}
        onDone={async () => {
          const u = await getSession();
          setMe(u);
          if (u) {
            const rs = await refreshRooms();
            if (rs.length) {
              setActiveId(rs[0].id);
              setRoomName(rs[0].name);
            }
          }
        }}
      />
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* 移动顶栏（mobile-web S2.1）：汉堡 + 视图名 + 通知铃；桌面无此栏 */}
      <div className="fixed inset-x-0 top-0 z-20 flex h-13 items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-side)] px-3 py-2.5 md:hidden">
        <button
          aria-label="菜单"
          onClick={() => setNavOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-line)] text-[var(--color-mut)]"
        >
          ☰
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {view === 'chat' ? (roomName || '房间') : { mcp: 'MCP', memory: '记忆', l2: '管理', decisions: '待办', tasks: '任务' }[view]}
        </div>
        <NotificationsBell onNavigate={(l) => { navigateLink(l); setNavOpen(false); }} />
      </div>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} />}
      <Sidebar
        rooms={rooms}
        activeId={activeId}
        me={me}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onSelect={(id) => {
          setView('chat');
          setActiveId(id);
          const r = rooms.find((x) => x.id === id);
          if (r) setRoomName(r.name);
        }}
        onNewRoom={handleNewRoom}
        onSignOut={handleSignOut}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMcp={() => setView('mcp')}
        onOpenMemory={() => setView('memory')}
        onOpenL2={() => setView('l2')}
        onOpenDecisions={() => setView('decisions')}
        onOpenTasks={() => setView('tasks')}
        onNavigate={navigateLink}
      />
      {mcpToast && (
        <div className="fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-5 py-2 text-sm shadow-lg">
          {mcpToast}
          <button className="ml-3 text-[var(--color-mut)]" onClick={() => setMcpToast(null)}>✕</button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col pt-[52px] md:pt-0">
      {view === 'mcp' ? (
        <McpPage key={mcpTab} initialTab={mcpTab} />
      ) : view === 'memory' ? (
        <MemoryPage />
      ) : view === 'l2' ? (
        <L2Page onClose={() => setView('chat')} />
      ) : view === 'decisions' ? (
        <DecisionsPage onNavigate={navigateLink} onClose={() => setView('chat')} />
      ) : view === 'tasks' ? (
        <TasksPage onNavigate={navigateLink} onClose={() => setView('chat')} />
      ) : activeId ? (
        <Chat
          key={activeId}
          roomId={activeId}
          roomName={roomName}
          me={me}
          members={members}
          onMembersChanged={async () => {
            if (activeId) {
              try {
                const { members } = await getRoom(activeId);
                setMembers(members);
              } catch {}
            }
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[var(--color-mut)]">
          选择或新建一个房间
        </div>
      )}
      </div>
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSuccess={handlePersonaSaved}
          me={me}
          onEnablePush={enablePush}
        />
      )}
    </div>
  );
}
