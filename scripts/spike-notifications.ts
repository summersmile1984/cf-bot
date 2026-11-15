/**
 * 通知与待办回归（notifications / approvals-hub / account-hardening T1）：node:sqlite 适配 D1 形状接口，真 SQL 验证。
 * 通知去重合并、已读、额度阈值；决策回答/拒绝/取消/过期（fail-closed）与跨用户归属；邮件 log 降级。
 * 运行：npx tsx scripts/spike-notifications.ts
 */
import { DatabaseSync } from 'node:sqlite';
import {
  ensureNotificationTables, notifyUser, listNotifications, unreadCount, markNotificationsRead, notifyQuota,
  getEmailPrefs, patchEmailPrefs,
} from '../src/mastra/notifications';
import {
  ensureDecisionTables, createDecision, answerDecision, declineDecision, answerDecisionForTask,
  cancelDecisionsForTask, expireDueDecisions, listDecisions, pendingCount,
} from '../src/mastra/decisions';
import { sendMail, renderMail } from '../src/mastra/mail';

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
  db.exec(`CREATE TABLE l2_tasks (task_id TEXT PRIMARY KEY, ask_question TEXT, ask_answer TEXT)`);
  db.exec(`CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, auto_review INTEGER, notification_prefs TEXT, updated_at INTEGER)`);
  await ensureNotificationTables(d1);
  await ensureDecisionTables(d1);
  const uid = 'u-1', other = 'u-2';

  // ① 通知去重合并
  await notifyUser(d1, { userId: uid, kind: 'task.completed', title: '完成', refType: 'task', refId: 't-1', link: 'room:r1' });
  await notifyUser(d1, { userId: uid, kind: 'task.completed', title: '完成', refType: 'task', refId: 't-1' });
  await notifyUser(d1, { userId: uid, kind: 'task.failed', title: '失败', refType: 'task', refId: 't-2' });
  let list = await listNotifications(d1, uid);
  const n1 = list.find((x: any) => x.ref_id === 't-1');
  check('① 同 ref 5 分钟去重合并', list.length === 2 && n1?.count === 2, `items=${list.length} count=${n1?.count}`);
  check('② 未读数', (await unreadCount(d1, uid)) === 2);

  // ② 已读
  await markNotificationsRead(d1, uid, [String(n1?.id)]);
  check('③ 单条已读', (await unreadCount(d1, uid)) === 1);
  await markNotificationsRead(d1, uid, 'all');
  check('④ 全部已读', (await unreadCount(d1, uid)) === 0);

  // ③ 额度阈值（低水位 80% / 耗尽；按周去重）
  const snap = { weekId: '2026-11-09', weekPool: { used: 85, total: 100 } };
  await notifyQuota(d1, uid, snap);
  await notifyQuota(d1, uid, snap);
  list = await listNotifications(d1, uid);
  check('⑤ quota.low 触发并去重', list.filter((x: any) => x.kind === 'quota.low').length === 1, `low=${list.filter((x: any) => x.kind === 'quota.low').length}`);
  await notifyQuota(d1, uid, { weekId: '2026-11-09', weekPool: { used: 100, total: 100 } });
  list = await listNotifications(d1, uid);
  check('⑥ quota.empty 触发', list.some((x: any) => x.kind === 'quota.empty'));

  // ④ 决策生命周期：创建 → 房间回复式回答
  const dA = await createDecision(d1, { userId: uid, kind: 'task_ask', refId: 't-9', roomId: 'r-9', question: '要不要继续？' });
  check('⑦ pending 计数', (await pendingCount(d1, uid)) === 1);
  const hit = await answerDecisionForTask(d1, 't-9', '继续');
  const dRow = (await listDecisions(d1, uid)).find((x: any) => x.id === dA.id);
  check('⑧ 房间回复回写决策', hit && dRow?.status === 'answered' && dRow?.answer === '继续', `status=${dRow?.status}`);

  // ⑤ 拒绝 + fail-closed 回写语义由路由层负责（这里验状态）
  const dB = await createDecision(d1, { userId: uid, kind: 'permission_ask', refId: 't-10', question: '执行「删文件」？' });
  const dec = await declineDecision(d1, uid, dB.id);
  check('⑨ 拒绝生效', dec.ok && dec.row?.status === 'declined');

  // ⑥ 归属：跨用户回答/拒绝被挡
  const dC = await createDecision(d1, { userId: uid, kind: 'task_ask', refId: 't-11', question: '选 A 还是 B？' });
  const cross = await answerDecision(d1, other, dC.id, 'A');
  const cross2 = await declineDecision(d1, other, dC.id);
  check('⑩ 跨用户回答/拒绝被挡', !cross.ok && !cross2.ok);

  // ⑦ 取消：清决策 + 清挂起提问（防劫持）
  db.prepare("INSERT INTO l2_tasks (task_id, ask_question, ask_answer) VALUES ('t-11', 'q', NULL)").run();
  await cancelDecisionsForTask(d1, 't-11');
  const dC2 = (await listDecisions(d1, uid)).find((x: any) => x.id === dC.id);
  const task: any = db.prepare("SELECT ask_question, ask_answer FROM l2_tasks WHERE task_id='t-11'").get();
  check('⑪ 取消清决策并清挂起提问', dC2?.status === 'canceled' && task.ask_question === null, `status=${dC2?.status} q=${task.ask_question}`);

  // ⑧ 过期扫描（fail-closed）
  const dD = await createDecision(d1, { userId: uid, kind: 'secret_confirm', refId: 't-12', question: '给个密钥', ttlMs: -1000 });
  const expired = await expireDueDecisions(d1);
  const dD2 = (await listDecisions(d1, uid)).find((x: any) => x.id === dD.id);
  check('⑫ 过期 fail-closed 置 expired', expired.length >= 1 && dD2?.status === 'expired', `expired=${expired.length}`);

  // ⑨ 邮件 log 降级（account-hardening T1）
  const m = renderMail({ productName: 'cf-bot', title: '验证邮箱', body: '点击按钮完成验证', ctaLabel: '验证', ctaUrl: 'https://example.com/v' });
  const sent = await sendMail({ MAIL_PROVIDER: 'log' }, { to: 'u@example.com', subject: '验证邮箱', html: m.html, text: m.text });
  check('⑬ 邮件 log 降级可发不炸', sent.ok && sent.skipped === true && m.html.includes('验证邮箱'));
  const bad = await sendMail({ MAIL_PROVIDER: 'resend' }, { to: 'u@example.com', subject: 'x', html: 'x' });
  check('⑭ 未配 API key 明确失败不抛', !bad.ok && !!bad.error);

  // ⑩ 通知偏好（邮件渠道矩阵）：默认集 + patch 合并
  const prefs = await getEmailPrefs(d1, uid);
  check('⑮ 邮件偏好默认（决策/额度开、任务关）',
    prefs['decision.requested'] === true && prefs['quota.low'] === true && prefs['task.completed'] === false);
  await patchEmailPrefs(d1, uid, { 'decision.requested': false, 'task.completed': true, 'evil.kind': true });
  const p2 = await getEmailPrefs(d1, uid);
  check('⑯ 偏好 patch 合并且白名单过滤', p2['decision.requested'] === false && p2['task.completed'] === true && !('evil.kind' in p2));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n---- 汇总：${passed}/${results.length} 通过 ----`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
