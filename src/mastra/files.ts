/**
 * 文件与知识库（file-knowledge S2.1-S2.3）：文本资料上传 → 切块嵌入（Workers AI bge-m3）→
 * 向量检索引用。块写入 memory_messages_1024 同索引但 metadata 带 kind='file_chunk' 且**不带**
 * resource_id/message_id——semanticRecall 按 resource 过滤天然看不见它们，两路检索互不污染。
 * 归属约束（多租户）：user_id 置顶过滤；可选 room_id 绑定（绑定资料仅该房间可见）。
 */
import { createWorkersAiEmbedder } from './workers-ai-embedder';

export const FILE_MAX_BYTES = 512 * 1024;
const CHUNK_CHARS = 1200;
const KINDS = new Set(['txt', 'md', 'csv', 'json', 'log']);

export async function ensureFileTables(db: any): Promise<void> {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS user_files (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL,
      size INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS idx_user_files_user ON user_files(user_id, created_at)',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
}

function chunkText(content: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_CHARS) out.push(content.slice(i, i + CHUNK_CHARS));
  return out.slice(0, 400); // 硬顶：单文件 ~400 块
}

/** 上传（v1 文本档）：落库 pending，摄取交给 waitUntil 异步跑 */
export async function saveFile(
  db: any,
  input: { userId: string; name: string; content: string; kind?: string; roomId?: string | null },
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  await ensureFileTables(db);
  const name = String(input.name ?? '').trim().slice(0, 200) || '未命名.txt';
  const content = String(input.content ?? '');
  const kind = String(input.kind ?? name.split('.').pop() ?? 'txt').toLowerCase().slice(0, 10);
  if (!KINDS.has(kind)) return { ok: false, reason: `v1 只支持文本档：${[...KINDS].join('/')}` };
  const bytes = new TextEncoder().encode(content).length;
  if (!content.trim()) return { ok: false, reason: '内容为空' };
  if (bytes > FILE_MAX_BYTES) return { ok: false, reason: `超过 ${FILE_MAX_BYTES / 1024}KB 上限` };
  const id = `file-${crypto.randomUUID()}`;
  await db
    .prepare('INSERT INTO user_files (id,user_id,room_id,name,kind,size,content,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, input.userId, input.roomId ?? null, name, kind, bytes, content, 'pending', Date.now())
    .run();
  return { ok: true, id };
}

/** 摄取：切块 → 嵌入 → upsert（id 按 file:chunk 幂等）→ 状态 indexed/failed */
export async function ingestFile(E: any, db: any, fileId: string): Promise<void> {
  try {
    const row: any = await db.prepare('SELECT * FROM user_files WHERE id=?').bind(fileId).first();
    if (!row) return;
    const embed = createWorkersAiEmbedder(() => (E as any).AI);
    const chunks = chunkText(String(row.content ?? ''));
    for (let i = 0; i < chunks.length; i += 10) {
      const batch = chunks.slice(i, i + 10);
      const { embeddings } = await embed.doEmbed({ values: batch });
      // 原生 Vectorize binding 形状：数组 {id, values, metadata}
      await (E as any).VECTORIZE.upsert(batch.map((c, j) => ({
        id: `${fileId}#${i + j}`,
        values: embeddings[j],
        metadata: {
          kind: 'file_chunk', file_id: fileId, user_id: String(row.user_id), room_id: row.room_id ?? '',
          name: String(row.name), chunk: i + j, content: c.slice(0, 500),
        },
      })));
    }
    await db.prepare("UPDATE user_files SET status='indexed' WHERE id=?").bind(fileId).run();
    console.log('[files] indexed', fileId, chunks.length, 'chunks');
  } catch (e: any) {
    console.log('[files] ingest failed', fileId, String(e?.message ?? e).slice(0, 120));
    await db.prepare("UPDATE user_files SET status='failed' WHERE id=?").bind(fileId).run().catch(() => null);
  }
}

/** 删除：库行 + 向量块级联 */
export async function deleteFile(E: any, db: any, userId: string, fileId: string): Promise<boolean> {
  await ensureFileTables(db);
  const row: any = await db.prepare('SELECT id, user_id FROM user_files WHERE id=? AND user_id=?').bind(fileId, userId).first();
  if (!row) return false;
  await db.prepare('DELETE FROM user_files WHERE id=?').bind(fileId).run();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) ids.push(`${fileId}#${i}`);
    await (E as any).VECTORIZE.deleteByIds(ids);
  } catch (e: any) {
    console.log('[files] vector delete failed', String(e?.message ?? e).slice(0, 120));
  }
  return true;
}

export async function listFiles(db: any, userId: string): Promise<any[]> {
  await ensureFileTables(db);
  const { results } = await db
    .prepare('SELECT id, room_id, name, kind, size, status, created_at FROM user_files WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
    .bind(userId).all();
  return results ?? [];
}

/** 检索：用户消息 ↔ 资料块（user 作用域 + 房间可见性） */
export async function searchFiles(E: any, db: any, userId: string, query: string, roomId?: string | null, topK = 5): Promise<Array<{ name: string; content: string; score?: number }>> {
  try {
    if (!query.trim() || !(E as any)?.VECTORIZE) return [];
    const embed = createWorkersAiEmbedder(() => (E as any).AI);
    const { embeddings } = await embed.doEmbed({ values: [query.slice(0, 2000)] });
    const res: any = await (E as any).VECTORIZE.query(embeddings[0], {
      topK: topK * 2,
      filter: { kind: 'file_chunk', user_id: userId },
      returnMetadata: 'all',
    });
    const matches = res?.matches ?? [];
    const out: Array<{ name: string; content: string; score?: number }> = [];
    for (const m of matches) {
      const md = m?.metadata ?? {};
      // 房间可见性：绑房间的资料只在该房间命中；未绑房间的全局可见
      if (md.room_id && roomId && String(md.room_id) !== String(roomId)) continue;
      if (md.room_id && !roomId) continue;
      out.push({ name: String(md.name ?? ''), content: String(md.content ?? ''), score: m?.score });
      if (out.length >= topK) break;
    }
    return out;
  } catch (e: any) {
    console.log('[files] search failed', String(e?.message ?? e).slice(0, 120));
    return [];
  }
}
