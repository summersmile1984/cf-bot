/**
 * 主题卷宗（topic-ia S2.1/S2.3）：
 * - rooms.kind='topic' 的单人工作卷宗（装修/旅行/报销各一摊），与多人共享房间（kind='room'）分离
 * - 资源映射分层：主题 thread 用 resource=user:<uid>（激活 semanticRecall.scope:'resource' 跨主题召回
 *   与 OM recall 跨卷浏览）；多人房保持 resource=room:<id> 不动；主会话暂保持 room:<id>（存量向量兼容）
 * - Mastra thread 元数据（kind/status/summary/titlePinned）与 rooms 行同步
 */

export type RoomRow = {
  id: string;
  name: string;
  created_by: string | null;
  is_main?: number;
  kind: string;
  status: string;
  summary: string | null;
  last_topic_id?: string | null;
};

/** 迁移 0008 的运行时幂等兜底（与 ensurePersonaConfig 同模式） */
export async function ensureTopicCols(db: any): Promise<void> {
  for (const ddl of [
    "ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'",
    "ALTER TABLE rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE rooms ADD COLUMN summary TEXT',
    'ALTER TABLE rooms ADD COLUMN last_topic_id TEXT',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
  await db.prepare("UPDATE rooms SET kind='main' WHERE is_main=1 AND kind='room'").run().catch(() => null);
}

/** 资源映射分层（S2.1）：主题→user:<uid>；多人房/主会话→room:<id> */
export function resourceFor(room: { id: string; kind?: string | null; created_by?: string | null }): string {
  if (room.kind === 'topic' && room.created_by) return `user:${room.created_by}`;
  return `room:${room.id}`;
}

export async function getRoomRow(db: any, roomId: string): Promise<RoomRow | null> {
  await ensureTopicCols(db);
  const row: any = await db
    .prepare('SELECT id, name, created_by, is_main, kind, status, summary, last_topic_id FROM rooms WHERE id=?')
    .bind(roomId)
    .first();
  return (row as RoomRow) ?? null;
}

/** 主题目录文本（S2.2 路由判定上下文）：活跃主题 + 最近归档，≤20 行 */
export async function topicCatalogText(db: any, userId: string): Promise<string> {
  await ensureTopicCols(db);
  const { results } = await db
    .prepare(
      `SELECT id, name, summary, status, updated_at FROM rooms
       WHERE created_by=? AND kind='topic' ORDER BY (status='active') DESC, updated_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all();
  const active: string[] = [];
  const archived: string[] = [];
  for (const r of (results ?? []) as any[]) {
    const line = `${r.id}「${r.name}」：${r.summary || '（无摘要）'}`;
    if (r.status === 'active') active.push(`- ${line}`);
    else if (archived.length < 5) archived.push(line);
  }
  const out = [...active];
  if (archived.length) out.push(`最近归档：${archived.join('；')}`);
  return out.join('\n') || '（暂无主题）';
}

/** 成卷（S2.3）：建主题房间 + 成员 + Mastra thread 元数据（resource=user:<uid>） */
export async function createTopicRoom(
  db: any,
  memory: any,
  opts: { userId: string; name: string; summary?: string },
): Promise<RoomRow> {
  await ensureTopicCols(db);
  const id = `topic-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const name = opts.name.trim().slice(0, 30) || '新主题';
  const summary = (opts.summary ?? '').trim().slice(0, 60) || null;
  await db
    .prepare('INSERT INTO rooms (id, name, created_by, created_at, updated_at, is_main, kind, status, summary) VALUES (?,?,?,?,?,0,?,?,?)')
    .bind(id, name, opts.userId, now, now, 'topic', 'active', summary)
    .run();
  await db
    .prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)')
    .bind(id, opts.userId, 'owner', now)
    .run();
  // thread 元数据随建卷落 Mastra（owner=resource，创建后不可变——必须一次给对）
  try {
    if (memory?.saveThread) {
      await memory.saveThread({
        thread: {
          id,
          title: name,
          resourceId: `user:${opts.userId}`,
          createdAt: new Date(now),
          updatedAt: new Date(now),
          metadata: { kind: 'topic', status: 'active', summary },
        } as any,
      });
    }
  } catch (e: any) {
    console.log('[topic] saveThread failed', String(e?.message ?? e).slice(0, 120));
  }
  return { id, name, created_by: opts.userId, kind: 'topic', status: 'active', summary };
}

/** 收卷（S2.3）：归档 + 落要点摘要 */
export async function archiveTopic(db: any, memory: any, topicId: string, summary: string): Promise<boolean> {
  const u = await db
    .prepare("UPDATE rooms SET status='archived', summary=?, updated_at=? WHERE id=? AND kind='topic' AND status='active'")
    .bind(summary.slice(0, 60), Date.now(), topicId)
    .run();
  if (!u?.meta?.changes) return false;
  try {
    if (memory?.updateThread) {
      await memory.updateThread({ id: topicId, metadata: { kind: 'topic', status: 'archived', summary: summary.slice(0, 60) } });
    }
  } catch (e: any) {
    console.log('[topic] updateThread failed', String(e?.message ?? e).slice(0, 120));
  }
  return true;
}

/** 主会话粘性：最近路由到的主题（S2.2 会话粘性） */
export async function setSticky(db: any, mainRoomId: string, topicId: string | null): Promise<void> {
  await db.prepare('UPDATE rooms SET last_topic_id=? WHERE id=?').bind(topicId, mainRoomId).run().catch(() => null);
}

/** thread 元数据同步（改名 pin / 摘要更新） */
export async function updateThreadMeta(memory: any, threadId: string, meta: Record<string, unknown>): Promise<void> {
  try {
    if (memory?.updateThread) await memory.updateThread({ id: threadId, metadata: meta });
  } catch (e: any) {
    console.log('[topic] updateThreadMeta failed', String(e?.message ?? e).slice(0, 120));
  }
}
