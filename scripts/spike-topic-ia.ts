/**
 * 主题 IA 验证 spike（一次性验证脚本）：
 * 验证「主会话 + 主题 thread」设计所依赖的 @mastra/memory 存储层能力——
 *   1) saveThread 带 metadata 建主题卷宗
 *   2) listThreads 按 metadata 过滤（主题目录）
 *   3) updateThread 改名/改状态（titlePinned 保手工命名）
 *   4) 消息按 thread 隔离（recall 不串卷）
 *   5) getThreadById / 分页排序
 * 纯存储层，不调模型（generateTitle / summarizeThread 另行源码级确认）。
 * 运行：npx tsx scripts/spike-topic-ia.ts
 */
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const store = new LibSQLStore({ id: 'spike-topic-ia', url: ':memory:' });
  const memory = new Memory({ storage: store, options: { lastMessages: 10 } });

  const now = new Date();
  const user = 'user-1';

  // ---- 1. 建三个 thread：两个主题卷宗 + 一个普通房间 ----
  const topicA = await memory.saveThread({
    thread: {
      id: 'topic-renovation',
      title: '装修',
      resourceId: user,
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'topic', status: 'active', summary: '厨房翻新跟进' },
    } as any,
  });
  const topicB = await memory.saveThread({
    thread: {
      id: 'topic-travel',
      title: '旅行计划',
      resourceId: user,
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'topic', status: 'active', summary: '国庆出行' },
    } as any,
  });
  const archived = await memory.saveThread({
    thread: {
      id: 'topic-expense',
      title: '报销',
      resourceId: user,
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'topic', status: 'archived', summary: 'Q3 报销已结' },
    } as any,
  });
  await memory.saveThread({
    thread: {
      id: 'room-shared',
      title: '家人群',
      resourceId: user,
      createdAt: now,
      updatedAt: now,
      metadata: { kind: 'room' },
    } as any,
  });

  check(
    'saveThread 保存 metadata',
    topicA.metadata?.kind === 'topic' && topicA.metadata?.status === 'active',
    `topicA.metadata=${JSON.stringify(topicA.metadata)}`,
  );

  // ---- 2. listThreads 过滤：主题目录 ----
  const all = await memory.listThreads({ filter: { resourceId: user }, perPage: false });
  const topics = await memory.listThreads({ filter: { resourceId: user, metadata: { kind: 'topic' } }, perPage: false });
  const activeTopics = await memory.listThreads({
    filter: { resourceId: user, metadata: { kind: 'topic', status: 'active' } },
    perPage: false,
    orderBy: { field: 'updatedAt', direction: 'DESC' },
  });
  check('listThreads 全量', all.threads.length === 4, `n=${all.threads.length}`);
  check('listThreads metadata 过滤 kind=topic', topics.threads.length === 3, `n=${topics.threads.length}`);
  check(
    'listThreads metadata AND 过滤 kind=topic & status=active',
    activeTopics.threads.length === 2 && activeTopics.threads.every((t) => t.metadata?.status === 'active'),
    `n=${activeTopics.threads.length}`,
  );

  // ---- 3. updateThread：改名 + titlePinned + 归档 ----
  const renamed = await memory.updateThread({
    id: topicA.id,
    title: '装修（厨房翻新）',
    metadata: { kind: 'topic', status: 'active', summary: '厨房翻新跟进', titlePinned: true },
  });
  check('updateThread 改名 + titlePinned', renamed.title === '装修（厨房翻新）' && renamed.metadata?.titlePinned === true);
  await memory.updateThread({ id: topicB.id, metadata: { kind: 'topic', status: 'archived', summary: '国庆出行' } });
  const activeAfter = await memory.listThreads({
    filter: { resourceId: user, metadata: { kind: 'topic', status: 'active' } },
    perPage: false,
  });
  check('归档后主题目录收缩', activeAfter.threads.length === 1 && activeAfter.threads[0].id === topicA.id);

  // ---- 4. 消息隔离：A/B 两个卷宗互不串 ----
  await memory.saveMessages({
    messages: [
      { id: 'm-a1', threadId: topicA.id, resourceId: user, role: 'user', content: '厨房报价单发我', type: 'text', createdAt: now } as any,
      { id: 'm-a2', threadId: topicA.id, resourceId: user, role: 'assistant', content: '报价单在卷宗里，合计 8.2 万', type: 'text', createdAt: now } as any,
      { id: 'm-b1', threadId: topicB.id, resourceId: user, role: 'user', content: '国庆去哪玩', type: 'text', createdAt: now } as any,
    ],
  } as any);
  const recallA = await memory.recall({ threadId: topicA.id, perPage: false });
  const recallB = await memory.recall({ threadId: topicB.id, perPage: false });
  const textOf = (m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const textsA = recallA.messages.map(textOf).join(' | ');
  const textsB = recallB.messages.map(textOf).join(' | ');
  check(
    'recall 按 thread 隔离（不串卷）',
    textsA.includes('报价') && !textsA.includes('国庆') && textsB.includes('国庆') && !textsB.includes('报价'),
    `A=「${textsA.slice(0, 40)}…」 B=「${textsB.slice(0, 40)}…」`,
  );

  // ---- 5. getThreadById ----
  const fetched = await memory.getThreadById({ threadId: topicA.id, resourceId: user });
  check('getThreadById 按主题取卷', fetched?.id === topicA.id && fetched?.metadata?.kind === 'topic');

  console.log('\n---- 汇总 ----');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('spike 崩了:', e);
  process.exitCode = 1;
});
