import { useCallback, useEffect, useState } from 'react';
import type { Member, Persona, Room, User } from './lib/api';
import { getSession, signOut, listRooms, createRoom, getRoom, getBrand, getOnboardingStatus } from './lib/api';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/SettingsPanel';
import { McpPage } from './components/McpPage';
import { MemoryPage } from './components/MemoryPage';

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [roomName, setRoomName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'mcp' | 'memory'>('chat');
  const [mcpTab, setMcpTab] = useState<'market' | 'mine'>('market');
  const [mcpToast, setMcpToast] = useState<string | null>(null);
  const [productName, setProductName] = useState('cf-bot');
  const [onboarding, setOnboarding] = useState<'checking' | 'setup' | 'ready'>('checking');

  // 产品名（白牌化）：公开接口拉取，标题/登录页统一使用
  useEffect(() => {
    getBrand()
      .then((b) => setProductName(b.productName))
      .catch(() => {});
  }, []);
  // 首跑向导（onboarding）：无用户时强制进 /setup
  useEffect(() => {
    getOnboardingStatus()
      .then((s) => setOnboarding(s.needsSetup ? 'setup' : 'ready'))
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

  if (!me) {
    return (
      <Login
        productName={productName}
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
      <Sidebar
        rooms={rooms}
        activeId={activeId}
        me={me}
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
      />
      {mcpToast && (
        <div className="fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-5 py-2 text-sm shadow-lg">
          {mcpToast}
          <button className="ml-3 text-[var(--color-mut)]" onClick={() => setMcpToast(null)}>✕</button>
        </div>
      )}
      {view === 'mcp' ? (
        <McpPage key={mcpTab} initialTab={mcpTab} />
      ) : view === 'memory' ? (
        <MemoryPage />
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
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSuccess={handlePersonaSaved}
        />
      )}
    </div>
  );
}
