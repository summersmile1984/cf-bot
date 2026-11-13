import { useState } from 'react';
import type { Room, User } from '../lib/api';

function initials(name?: string | null) {
  const s = (name ?? '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

function timeAgo(ts?: number | null) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function RoomRow({
  room,
  active,
  avatar,
  onSelect,
}: {
  room: Room;
  active: boolean;
  avatar: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(room.id)}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-line)] ${
        active ? 'bg-[var(--color-line)]' : ''
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-acc)] text-sm font-semibold text-white">
        {avatar}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {room.kind === 'topic' && room.status === 'archived' ? (
              <span className="opacity-60">📦 {room.name}</span>
            ) : (
              room.name
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-mut)]">
            {/* 未读点（topic-ia S2.4 回声：主题只给未读点，不刷屏） */}
            {!!(room.last_message_at && (!room.last_read_at || room.last_message_at > room.last_read_at)) && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-acc)]" />
            )}
            {timeAgo(room.last_message_at)}
          </span>
        </div>
        <div className="truncate text-xs text-[var(--color-mut)]">
          {room.kind === 'topic' ? room.summary || room.last_message || '暂无消息' : room.last_message ?? '暂无消息'}
        </div>
      </div>
    </button>
  );
}

export function Sidebar({
  rooms,
  activeId,
  me,
  onSelect,
  onNewRoom,
  onSignOut,
  onOpenSettings,
  onOpenMcp,
  onOpenMemory,
}: {
  rooms: Room[];
  activeId: string | null;
  me: User;
  onSelect: (id: string) => void;
  onNewRoom: (name: string) => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenMemory: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const mainRoom = rooms.find((r) => r.is_main === 1);
  // 主题分区（topic-ia S2.5）：活跃主题 / 多人房间 / 已归档主题（折叠）
  const activeTopics = rooms.filter((r) => r.kind === 'topic' && r.status !== 'archived');
  const archivedTopics = rooms.filter((r) => r.kind === 'topic' && r.status === 'archived');
  const otherRooms = rooms.filter((r) => r.is_main !== 1 && r.kind !== 'topic');

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onNewRoom(n);
    setName('');
    setCreating(false);
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-side)]">
      <div className="px-4 pt-5">
        <h1 className="text-[17px] font-semibold">房间</h1>
      </div>

      <div className="thin-scroll mt-4 flex-1 overflow-y-auto">
        {mainRoom && (
          <>
            <div className="px-4 pb-1 text-xs text-[var(--color-mut)]">主会话</div>
            <RoomRow
              room={mainRoom}
              active={activeId === mainRoom.id}
              avatar="秘"
              onSelect={onSelect}
            />
          </>
        )}

        {activeTopics.length > 0 && (
          <>
            <div className="px-4 pb-1 pt-4 text-xs text-[var(--color-mut)]">主题</div>
            {activeTopics.map((r) => (
              <RoomRow
                key={r.id}
                room={r}
                active={activeId === r.id}
                avatar={initials(r.name)}
                onSelect={onSelect}
              />
            ))}
          </>
        )}

        <div className="flex items-center justify-between px-4 pb-1 pt-4">
          <div className="text-xs text-[var(--color-mut)]">房间</div>
          <button
            onClick={() => setCreating((v) => !v)}
            className="rounded-full border border-[var(--color-line)] px-2.5 py-0.5 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
          >
            + 新建
          </button>
        </div>

        {creating && (
          <form onSubmit={submitNew} className="mx-3 mt-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="房间名称"
              className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-acc)]"
            />
          </form>
        )}

        {otherRooms.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-mut)]">
            还没有房间，点「新建」开始
          </div>
        )}
        {otherRooms.map((r) => (
          <RoomRow
            key={r.id}
            room={r}
            active={activeId === r.id}
            avatar={initials(r.name)}
            onSelect={onSelect}
          />
        ))}

        {archivedTopics.length > 0 && (
          <>
            <div className="px-4 pb-1 pt-4 text-xs text-[var(--color-mut)]">已归档主题</div>
            {archivedTopics.map((r) => (
              <RoomRow
                key={r.id}
                room={r}
                active={activeId === r.id}
                avatar={initials(r.name)}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--color-line)] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-fg)] text-xs font-semibold text-[var(--color-bg)]">
          {initials(me.name || me.email)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{me.name || me.email}</div>
          <div className="truncate text-[11px] text-[var(--color-mut)]">{me.email}</div>
        </div>
        <button
          onClick={onOpenMcp}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          MCP
        </button>
        <button
          onClick={onOpenMemory}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          记忆
        </button>
        <button
          onClick={onOpenSettings}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          设置
        </button>
        <button
          onClick={onSignOut}
          className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-mut)] hover:text-[var(--color-fg)]"
        >
          退出
        </button>
      </div>
    </aside>
  );
}
