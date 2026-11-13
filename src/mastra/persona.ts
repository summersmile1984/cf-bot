// 人格与提示词配置（prompt-config spec S2.2/S2.3）：所有提示词文案都是数据——persona_config 单行配置，
// 出厂种子只是默认值。装配经 Agent.instructions + 消息级 system 前置（见 buildThreadBlock）；
// 代码只做拼装，不含任何写死的提示词文案。
// 生效语义：base_prompt/tone/profile 每轮生效；tool_dispatch 热生效；om_observe/om_reflect 为
// 引擎初始化语义（见 syncEngineCopy 与 S2.1）。
export type PersonaConfig = {
  product_name: string;
  name: string;
  role: string;
  style: string;
  main_room_name: string;
  base_prompt: string;
  tone_main: string;
  tone_room: string;
  om_observe: string;
  om_reflect: string;
  tool_dispatch: string;
  tool_schedule: string;
  tool_expert: string;
  tool_forge: string;
  tool_progress: string;
  tool_ask: string;
  tool_artifact: string;
  tool_topic: string;
  tool_page: string;
  builder_prompt: string;
  routing_prompt: string;
  model_gateway: string;
  model_name: string;
  model_effort: string;
  updated_at: number;
  updated_by: string | null;
};

const SEED: Omit<PersonaConfig, 'updated_at' | 'updated_by'> = {
  product_name: 'cf-bot',
  name: '我的秘书',
  role: '24 小时贴身秘书、管家与伴侣',
  style: '温和、可靠、尽责；记得主人的信息与偏好并自然引用（不要背诵）；「我来处理」式的担当，偶尔一句体己话；说中文，句子短。',
  main_room_name: '我的秘书',
  base_prompt: `你是主人的私人助理，具体人设、称呼与语调以对话开头【你的身份】/【语调】块为准。必须立即回复用户，绝不等待长任务。
慢任务（用户说“帮我…/跑…/分析…/测试…/生成…/构建…/部署…”，需要读写文件、跑命令、做网页、截图等）一律调用 dispatch_to_sandbox 派发，然后立刻用一句话告诉用户“我来处理，好了告诉你”，可以继续聊别的。
对用户不可见的内部细节：绝不提 L2、harness、ACP、沙箱、运行时、任务 id、内部路径、A2A。只用自然语言说“我来处理/处理好了”。
消息含“本地”或 route=local 时 runtime 选 local，否则选 cloud。不要反问澄清，信息不全也直接派发。
专业任务（调研/分析/写代码/排错等）一律经 dispatch_to_expert 派给 L2 专家执行，不要自己扮演专家；点名某位专家时先用 list_experts 查目录。
主人要新建或修改专家时走专家工坊：draft_expert 出草案给主人过目，主人明确确认后才 save_expert 落库，绝不未经确认保存。
派发任务时鼓励专家中途用 report_progress 播一两句话进度（像同事顺口汇报）；任务完成后照常汇报结果。
如果 dispatch_to_sandbox 返回 ok:false，如实简短告诉用户“后台处理暂时不可用”，并给出你力所能及的直接回答。
收到 <sandbox-result> 通知时，简要向用户汇报结果（不要复述内部细节）。
闲聊或询问在线状态直接一句话回复。绝不让用户在聊天里发密码，也绝不复述任何密钥。回复简短，用中文。`,
  tone_main: '【语调】这是与主人的一对一主会话：用亲密的管家伴侣口吻，自然用主人的称呼与偏好，可以有体己话。',
  tone_room: '【语调】这是共享房间：口吻得体、均衡、照顾在场成员，不要向其他成员炫耀对主人的私密了解。',
  om_observe: '你是秘书的记忆观察员。重点记录发言者的身份/称呼、偏好、决定、承诺与待办、在做的事、重要事实；忽略寒暄。',
  om_reflect: '压缩合并时优先保留主人的身份/称呼/偏好/决定/待办/事实，丢弃寒暄与重复。',
  tool_dispatch: '把慢任务派发到后台执行，立即返回（不等待结果）；完成后会自动通知。',
  tool_expert: '把专业任务派给 L2 专家执行（dispatch_to_expert）。专家在用户的电脑/云电脑上干活（Mastra Agent），完成后自动汇报。当任务属于调研/分析/写代码/排错等专业活，或主人点名某位专家时使用：expert=专家名或 id（先用 list_experts 查），task=任务描述，runtime=local（用户电脑）或 cloud（云电脑）。专家任务一律用本工具派发，不要自己扮演专家。',
  tool_forge: '专家工坊（draft_expert / save_expert）：主人说要什么专家时，先用 draft_expert（需求=主人的描述，可基于已有专家或模板改）生成草案，把人话摘要和定义要点讲给主人听；**必须等主人明确确认**（如「就这样/确认」）后才调用 save_expert 落库，绝不未经确认就保存。save_expert 的 draft 要带完整定义 JSON；同名已存在时只有主人要求覆盖才带 overwrite:true。',
  tool_progress: '长任务中途让专家用 report_progress 播报一句话进度（如「14 张票据进来了，还缺一张」）——像同事顺口汇报，简短自然，不刷屏；派发任务时可在 task 里提醒专家报进度。',
  tool_ask: 'ask_user：向主人提一个需要判断的问题（分叉/口径/取舍），会暂停等主人聊天里回复；只在真正需要拍板时用，能自己稳妥决定的不要问。每任务最多 3 次。',
  tool_artifact: 'save_artifact：把截图 base64 或文本块存进任务附件，主人在聊天里直接看到（≤1.2MB 图 / 8KB 文本）；交付截图、报告片段等实物时用。',
  tool_topic: '主题卷宗（open_topic / close_topic）：一件事要持续跟进、有产物或要派活时，用 open_topic 建主题卷宗（name=主题名，summary=一句话摘要）；事情了结时用 close_topic 收卷（topic_id，summary=两三条要点）。日常闲聊不要开卷；收卷前确保事项确实完成。',
  tool_page: '发布页面（publish_page）：把一段完整的 HTML（报告/方案/仪表盘/展示页）发布成独立网页，返回可分享链接。title=页面标题，html=完整 HTML 文档（含 <!DOCTYPE html>，≤2MB）。适合交付结构化的可视化产出；纯文字结论仍走聊天回复。',
  builder_prompt: `你是「专家工坊」。把主人的需求变成一条 L2 专家定义（agent_defs 数据行，不是代码）。方法：①理解需求（职责边界、要什么能力）→ ②规划（专家叫什么、一句话专长、系统提示词要点、需要的工具/技能）→ ③生成定义 → ④自检（字段齐全、指令可执行、不写死假设）。
产出严格 JSON：{"name","description","instructions","model","tools_json","mcp_json","skills_json","memory_json","rationale"}。
- name≤100字；description 一句话专长（≤500字）；instructions 是给专家的系统提示词（≤4000字，中文，含角色/能力/边界/输出风格；提及线程记忆连续性；长任务中途用 report_progress 播一句话进度；收尾必须给出完整结果汇总，禁止只留执行意图）。
- model 通常留空（继承全局）；tools_json 例 ["web_fetch"]；skills_json 例 [{"name","description","instructions"}]——name 只能用小写字母/数字/连字符（如 ticket-sorting），中文说明放 description；mcp_json 例 {"servers":{"名":{"url":"https://..."}}}；memory_json 例 {"lastMessages":20,"workingMemory":{"template":"# 任务档案\\n- 关键事实："}}。没有需要就留 null。
- rationale 用两三句话向主人解释你为什么这样设计。`,
  tool_schedule: '创建定时例程（create_schedule）。当主人用自然语言提到定时安排（如「每天早上8点给我打招呼」）时调用：name=例程名，prompt=到点要执行的内容，cron=5 字段（分 时 日 月 周，时区默认 Asia/Shanghai）。常用换算：每天 8 点=0 8 * * *；每小时=0 * * * *；工作日 9 点=0 9 * * 1-5；每周一 9 点=0 9 * * 1；每分钟=* * * * *。也可用预设 every_minute/hourly/daily_9/weekdays_9/weekly_mon_9。管理用 list_schedules / delete_schedule。',
  // 主题路由判定框（topic-ia S2.2）：{CATALOG}/{STICKY} 为运行时槽位。示例必须与规则字面一致（v2 教训）。
  routing_prompt: `【主题路由判定】你是秘书的路由模块。根据用户消息决定它归属的会话位置。只做判定，不派发任务、不执行、不聊天。

主题目录（活跃）：
{CATALOG}
当前正在聊的主题：{STICKY}

判定规则（按优先级从高到低）：
1. 显式指名主题（如「装修那边」「回到旅行计划」）→ route=topic:<id>
2. 消息与「当前正在聊的主题」是同一件事的延续、追问或补充材料 → route=topic:<id>。省略式追问（「那…呢」「再…一下」「还是用…」）看语境承接，字面没有主题词也算当前主题
3. 消息内容明确属于某个主题的事项 → route=topic:<id>
4. 是一件需要持续跟进、有产出物或要派活的新事情，且与任何现有主题无关 → route=new:<简短名字>
5. 闲聊、简单问答、询问全局状态、要求跨主题汇总、对多个主题同时下指令 → route=main_only
铁律：
- route 中的 topic id 必须原样使用目录里的 id（如 topic-renovation），不得缩写或改写
- 一句话消息、含糊消息、拿不准的 → main_only，绝不硬造新主题
- 明确要求「不用单开/就在这儿说」→ main_only
- 归档主题里的旧事若只是问一般性问题 → main_only
只输出一个 JSON 对象，例如：{"route":"topic:topic-renovation","confidence":"high"}`,
  model_gateway: 'deepseek',
  model_name: 'deepseek-chat',
  model_effort: 'provider-default',
};

const LIMITS = {
  product_name: 100, name: 200, role: 500, style: 1000, main_room_name: 50,
  base_prompt: 4000, tone_main: 500, tone_room: 500, om_observe: 500, om_reflect: 500, tool_dispatch: 500, tool_schedule: 1000, tool_expert: 800, tool_forge: 1500, tool_progress: 400, tool_ask: 400, tool_artifact: 400, tool_topic: 500, tool_page: 500, builder_prompt: 4000, routing_prompt: 4000,
  model_gateway: 100, model_name: 200, model_effort: 20,
};

export async function ensurePersonaConfig(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS persona_config (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, style TEXT NOT NULL,
        main_room_name TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,
    )
    .run();
  // 0003/0004 扩展列（幂等；旧库补列）
  for (const col of ['product_name', 'base_prompt', 'tone_main', 'tone_room', 'om_observe', 'om_reflect', 'tool_dispatch', 'tool_schedule', 'tool_expert', 'tool_forge', 'tool_progress', 'tool_ask', 'tool_artifact', 'tool_topic', 'tool_page', 'builder_prompt', 'routing_prompt', 'model_gateway', 'model_name', 'model_effort']) {
    await db.prepare(`ALTER TABLE persona_config ADD COLUMN ${col} TEXT`).run().catch(() => null);
  }
  await db
    .prepare(
      `INSERT INTO persona_config (id, name, role, style, main_room_name, updated_at, updated_by)
       SELECT 1, ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM persona_config WHERE id = 1)`,
    )
    .bind(SEED.name, SEED.role, SEED.style, SEED.main_room_name, Date.now())
    .run();
  // 存量行补种子（NULL → 种子）
  await db
    .prepare(
      `UPDATE persona_config SET product_name = COALESCE(product_name, ?), base_prompt = COALESCE(base_prompt, ?), tone_main = COALESCE(tone_main, ?),
       tone_room = COALESCE(tone_room, ?), om_observe = COALESCE(om_observe, ?), om_reflect = COALESCE(om_reflect, ?),
       tool_dispatch = COALESCE(tool_dispatch, ?), tool_schedule = COALESCE(tool_schedule, ?), tool_expert = COALESCE(tool_expert, ?), tool_forge = COALESCE(tool_forge, ?), tool_progress = COALESCE(tool_progress, ?), tool_ask = COALESCE(tool_ask, ?), tool_artifact = COALESCE(tool_artifact, ?), tool_topic = COALESCE(tool_topic, ?), tool_page = COALESCE(tool_page, ?), builder_prompt = COALESCE(builder_prompt, ?), routing_prompt = COALESCE(routing_prompt, ?), model_gateway = COALESCE(model_gateway, ?),
       model_name = COALESCE(model_name, ?), model_effort = COALESCE(model_effort, ?) WHERE id = 1`,
    )
    .bind(SEED.product_name, SEED.base_prompt, SEED.tone_main, SEED.tone_room, SEED.om_observe, SEED.om_reflect, SEED.tool_dispatch, SEED.tool_schedule, SEED.tool_expert, SEED.tool_forge, SEED.tool_progress, SEED.tool_ask, SEED.tool_artifact, SEED.tool_topic, SEED.tool_page, SEED.builder_prompt, SEED.routing_prompt,
      SEED.model_gateway, SEED.model_name, SEED.model_effort)
    .run();
}

let cache: { persona: PersonaConfig; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getPersona(db: any, force = false): Promise<PersonaConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.persona;
  let row: any = null;
  try {
    row = await db.prepare('SELECT * FROM persona_config WHERE id = 1').first();
  } catch {}
  if (!row) {
    try {
      await ensurePersonaConfig(db);
      row = await db.prepare('SELECT * FROM persona_config WHERE id = 1').first();
    } catch {}
  }
  if (!row) {
    const seeded: PersonaConfig = { ...SEED, updated_at: 0, updated_by: null };
    cache = { persona: seeded, at: Date.now() };
    return seeded;
  }
  const pick = (k: keyof typeof SEED) => {
    const v = row[k];
    return v === null || v === undefined || v === '' ? SEED[k] : String(v);
  };
  const persona: PersonaConfig = {
    product_name: pick('product_name'), name: pick('name'), role: pick('role'), style: pick('style'), main_room_name: pick('main_room_name'),
    base_prompt: pick('base_prompt'), tone_main: pick('tone_main'), tone_room: pick('tone_room'),
    om_observe: pick('om_observe'), om_reflect: pick('om_reflect'), tool_dispatch: pick('tool_dispatch'), tool_schedule: pick('tool_schedule'), tool_expert: pick('tool_expert'),
    tool_forge: pick('tool_forge'), tool_progress: pick('tool_progress'), tool_ask: pick('tool_ask'), tool_artifact: pick('tool_artifact'), tool_topic: pick('tool_topic'), tool_page: pick('tool_page'), builder_prompt: pick('builder_prompt'), routing_prompt: pick('routing_prompt'),
    model_gateway: pick('model_gateway'), model_name: pick('model_name'), model_effort: pick('model_effort'),
    updated_at: Number(row?.updated_at ?? 0),
    updated_by: row?.updated_by ? String(row.updated_by) : null,
  };
  cache = { persona, at: Date.now() };
  return persona;
}

function clip(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().slice(0, max);
  return s || undefined;
}

const UPDATABLE = Object.keys(LIMITS) as Array<keyof typeof LIMITS>;

export async function updatePersona(db: any, patch: Record<string, unknown>, updatedBy: string): Promise<PersonaConfig> {
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const k of UPDATABLE) {
    const v = clip(patch[k], LIMITS[k]);
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      args.push(v);
    }
  }
  if (fields.length) {
    args.push(Date.now(), updatedBy);
    await db.prepare(`UPDATE persona_config SET ${fields.join(', ')}, updated_at = ?, updated_by = ? WHERE id = 1`).bind(...args).run();
  }
  return getPersona(db, true);
}

/** 种子模型串（OM 构造等模块级场景用，运行期以配置为准）。 */
export const SEED_MODEL_ID = `${SEED.model_gateway}/${SEED.model_name}`;

/** 模型串（model-gateway-config S2.1）：Mastra ModelRouter 路由形式 gateway/model。 */
export function buildModelId(p: Pick<PersonaConfig, 'model_gateway' | 'model_name'>): string {
  return `${p.model_gateway}/${p.model_name}`;
}

/** 装配进上下文的身份块（S2.3）。 */
export function personaBlock(p: PersonaConfig): string {
  return `【你的身份】你是${p.name}，${p.role}。${p.style}`;
}

/**
 * thread 作用域块（S2.3）：语调 + 成员画像。base_prompt/身份走 Agent.instructions 函数；
 * 本块经消息级 system 前置注入（chat 与后台汇报共用）。
 * 注：官方 Memory.getSystemMessage 槽位在启用 OM 的 processor 管道里产物会被丢弃
 * （@mastra/memory 1.40 实测），故 thread 相关块走消息级前置——实测可达模型。
 */
export async function buildThreadBlock(
  db: any,
  threadId: string | undefined,
  loadProfileBlock: (db: any, threadId: string) => Promise<string>,
): Promise<string | null> {
  try {
    const p = await getPersona(db);
    let isMain = false;
    try {
      if (threadId) {
        const r: any = await db.prepare('SELECT is_main FROM rooms WHERE id = ?').bind(threadId).first();
        isMain = !!r?.is_main;
      }
    } catch {}
    // 查询失败默认按房间语调（S2.3）
    const parts = [isMain ? p.tone_main : p.tone_room];
    if (threadId) {
      try {
        const block = await loadProfileBlock(db, threadId);
        if (block) parts.push(block);
      } catch {}
    }
    return parts.join('\n');
  } catch {
    return null;
  }
}
