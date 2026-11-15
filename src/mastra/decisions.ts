/**
 * 待办/审批中心（approvals-hub S2.1/S2.2）：统一决策请求模型。
 * - kind：task_ask（专家追问）| permission_ask（权限 ask 策略）| secret_confirm（HITL 收密，写入点随收密流落地）
 * - 与 l2_tasks.ask_* 并存：任务字段是 L2 协议快照，本表是主人视角聚合面（不改 A2A 契约）
 * - 超时 fail-closed：过期 = 拒绝/不放行（对齐 AGENTS §7 审批路由基线），宁可任务失败重来不默认放权
 * 归属约束（多租户）：一切查询/写回按 user_id 过滤。
 */

export type DecisionKind = 'task_ask' | 'permission_ask' | 'secret_confirm';
export type DecisionStatus = 'pending' | 'answered' | 'declined' | 'expired' | 'canceled';

/** 默认 TTL：L2 询问窗口约 3 分钟（asker 轮询超时即兜底），10 分钟收尾补余 */
const TTL_MS: Record<DecisionKind, number> = {
  task_ask: 10 * 60_000,
  permission_ask: 10 * 60_000,
  secret_confirm: 10 * 60_000,
};

export async function ensureDecisionTables(db: any): Promise<void> {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, room_id TEXT,
      question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', answer TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user_id, status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_decisions_expiry ON decisions(status, expires_at)',
  ]) {
    await db.prepare(ddl).run().catch(() => null);
  }
}

export async function createDecision(
  db: any,
  input: { userId: string; kind: DecisionKind; refId?: string | null; roomId?: string | null; question: string; ttlMs?: number },
): Promise<{ id: string; expiresAt: number }> {
  await ensureDecisionTables(db);
  const now = Date.now();
  const ttl = input.ttlMs ?? TTL_MS[input.kind] ?? TTL_MS.task_ask;
  const id = `dc-${crypto.randomUUID()}`;
  await db
    .prepare(`INSERT INTO decisions (id,user_id,kind,ref_id,room_id,question,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`)
    .bind(id, input.userId, input.kind, input.refId ?? null, input.roomId ?? null, String(input.question).slice(0, 500), now, now + ttl)
    .run();
  return { id, expiresAt: now + ttl };
}

/** 回答（含待办中心一键回答）：pending → answered；返回决策行供调用方回写 ask_answer。 */
export async function answerDecision(db: any, userId: string, id: string, answer: string): Promise<{ ok: boolean; row?: any; reason?: string }> {
  await ensureDecisionTables(db);
  const now = Date.now();
  const r = await db
    .prepare(`UPDATE decisions SET status='answered', answer=?, decided_at=? WHERE id=? AND user_id=? AND status='pending'`)
    .bind(String(answer).slice(0, 2000), now, id, userId)
    .run();
  if (!r?.meta?.changes) return { ok: false, reason: 'not pending or not found' };
  const row: any = await db.prepare('SELECT * FROM decisions WHERE id=? AND user_id=?').bind(id, userId).first();
  return { ok: true, row };
}

/** 拒绝：pending → declined（fail-closed 语义；调用方决定对任务的后续动作）。 */
export async function declineDecision(db: any, userId: string, id: string): Promise<{ ok: boolean; row?: any }> {
  await ensureDecisionTables(db);
  const r = await db
    .prepare(`UPDATE decisions SET status='declined', answer=NULL, decided_at=? WHERE id=? AND user_id=? AND status='pending'`)
    .bind(Date.now(), id, userId)
    .run();
  if (!r?.meta?.changes) return { ok: false };
  const row: any = await db.prepare('SELECT * FROM decisions WHERE id=? AND user_id=?').bind(id, userId).first();
  return { ok: true, row };
}

/** 任务侧收尾：该任务的 pending 决策置 canceled（ask-cancel / 任务终态时调用），并清掉任务的挂起提问。 */
export async function cancelDecisionsForTask(db: any, taskId: string, status: 'canceled' | 'expired' = 'canceled'): Promise<void> {
  await ensureDecisionTables(db);
  await db
    .prepare(`UPDATE decisions SET status=?, decided_at=? WHERE ref_id=? AND status='pending'`)
    .bind(status, Date.now(), taskId)
    .run()
    .catch(() => null);
  // 挂起提问一并清掉：防 L2 已退场后，下一条用户消息被劫持成「答案」
  await db.prepare('UPDATE l2_tasks SET ask_question=NULL WHERE task_id=? AND ask_answer IS NULL').bind(taskId).run().catch(() => null);
}

/** 按任务回写答案（房间回复与待办中心共用）：只动 pending，返回是否命中。 */
export async function answerDecisionForTask(db: any, taskId: string, answer: string): Promise<boolean> {
  await ensureDecisionTables(db);
  const r = await db
    .prepare(`UPDATE decisions SET status='answered', answer=?, decided_at=? WHERE ref_id=? AND status='pending'`)
    .bind(String(answer).slice(0, 2000), Date.now(), taskId)
    .run()
    .catch(() => null);
  return !!r?.meta?.changes;
}

/** 过期扫描（fail-closed）：返回被置 expired 的行，调用方发 decision.expired 通知。 */
export async function expireDueDecisions(db: any, now = Date.now()): Promise<any[]> {
  await ensureDecisionTables(db);
  const { results } = await db.prepare("SELECT * FROM decisions WHERE status='pending' AND expires_at<?").bind(now).all();
  const rows = results ?? [];
  for (const r of rows as any[]) {
    await db.prepare("UPDATE decisions SET status='expired', decided_at=? WHERE id=? AND status='pending'").bind(now, r.id).run().catch(() => null);
  }
  return rows;
}

export async function listDecisions(db: any, userId: string, opts: { status?: DecisionStatus; limit?: number } = {}): Promise<any[]> {
  await ensureDecisionTables(db);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const { results } = opts.status
    ? await db.prepare('SELECT * FROM decisions WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT ?').bind(userId, opts.status, limit).all()
    : await db.prepare('SELECT * FROM decisions WHERE user_id=? ORDER BY created_at DESC LIMIT ?').bind(userId, limit).all();
  return results ?? [];
}

export async function pendingCount(db: any, userId: string): Promise<number> {
  await ensureDecisionTables(db);
  const row: any = await db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE user_id=? AND status='pending'").bind(userId).first();
  return Number(row?.n ?? 0);
}
