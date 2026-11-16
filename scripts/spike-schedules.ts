/**
 * 例程可靠性回归（schedule-reliability S2.1/S2.2）：node:sqlite 适配 D1 形状接口。
 * 同窗口 run 记录 upsert（重试复用一行、created_at 保首跑）、attempt 累进、retry_at 调度与清理。
 * 运行：npx tsx scripts/spike-schedules.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { markRun, lastRun, setRetry, clearRetry, retrySchedules, listRuns } from '../src/l1/schedules';

const db = new DatabaseSync(':memory:');
const d1 = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            const st = db.prepare(sql);
            const r = st.run(...(args as never[]));
            return { meta: { changes: Number(r.changes) } };
          },
          async first() {
            const st = db.prepare(sql);
            return st.get(...(args as never[])) ?? null;
          },
          async all() {
            const st = db.prepare(sql);
            return { results: st.all(...(args as never[])) };
          },
        };
      },
      async run() { return this.bind().run(); },
    };
  },
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, cron TEXT, timezone TEXT, prompt TEXT,
    target_type TEXT, target_id TEXT, enabled INTEGER DEFAULT 1, next_run_at INTEGER, last_run_at INTEGER,
    created_at INTEGER, updated_at INTEGER, retry_at INTEGER, retry_attempt INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT, user_id TEXT, status TEXT, detail TEXT,
    created_at INTEGER, attempt INTEGER DEFAULT 1, catch_up INTEGER DEFAULT 0, window_at INTEGER)`);
  const uid = 'u-1', sid = 'sch-abc';
  db.prepare(`INSERT INTO schedules (id,user_id,name,cron,timezone,prompt,target_type,target_id,enabled,next_run_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,0,1,1)`).run(sid, uid, '晨报', '* * * * *', 'Asia/Shanghai', '发日报', 'room', 'r-1');

  // ① 同窗口 upsert：重试复用同一行，created_at 保首跑
  const w = 1794700000000;
  const r1 = await markRun(d1, { scheduleId: sid, userId: uid, status: 'retrying', detail: 'boom', attempt: 1, catchUp: true, windowAt: w });
  const t1 = (db.prepare('SELECT created_at FROM schedule_runs WHERE schedule_id=?').get(sid) as any).created_at;
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await markRun(d1, { scheduleId: sid, userId: uid, status: 'success', detail: 'ok', attempt: 2, catchUp: true, windowAt: w });
  const row: any = db.prepare('SELECT * FROM schedule_runs WHERE schedule_id=?').get(sid);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id=?').get(sid) as any).n;
  check('① 同窗口重试复用同一记录', r1 === r2 && count === 1 && row.attempt === 2 && row.status === 'success' && row.catch_up === 1, `rows=${count} attempt=${row.attempt}`);
  check('① created_at 保首跑', row.created_at === t1 && row.window_at === w, `created_at=${row.created_at} window=${row.window_at}`);

  // ② attempt 累进至 3
  await markRun(d1, { scheduleId: sid, userId: uid, status: 'failed', detail: 'dead', attempt: 3, windowAt: w });
  const last = await lastRun(d1, sid);
  check('② attempt 累进', last?.attempt === 3 && last?.status === 'failed');

  // ③ retry_at 调度/清理 + retrySchedules 过滤
  await setRetry(d1, sid, 1794700060000, 1);
  const due1 = await retrySchedules(d1, 1794700030000);
  const due2 = await retrySchedules(d1, 1794700070000);
  check('③ retry 到期才出队', due1.length === 0 && due2.length === 1, `due@60s=${due1.length} due@70s=${due2.length}`);
  await clearRetry(d1, sid);
  const due3 = await retrySchedules(d1, 1794700100000);
  check('③ 清理后不再出队', due3.length === 0);

  // ④ listRuns 带 attempt/catch_up
  const runs = await listRuns(d1, uid, sid);
  check('④ listRuns 返回新字段', runs.length === 1 && (runs[0] as any).attempt === 3 && (runs[0] as any).catch_up === 1);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
