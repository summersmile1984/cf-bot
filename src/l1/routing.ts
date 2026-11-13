/**
 * 主题路由判定（topic-ia S2.2）——LLM 判断（L1 现有模型网关），不建分类器。
 * 判定框 = 身份 + 主题目录 + 粘性槽 + 规则链 + 铁律 + JSON 契约（提示词全文存 persona_config.routing_prompt，
 * 文案皆数据）；结果 topic:<id> / new:<名字> / main_only，带 confidence，低置信度由调用方降级 main_only。
 * 提示词 v3 实测：真实链路 18/18（scripts/spike-topic-routing.ts，回归套件）。
 */
import { Agent } from '@mastra/core/agent';
import { getPersona, buildModelId } from '../mastra/persona';
import { topicCatalogText, getRoomRow } from './topics';

export type RouteResult = { route: string; confidence: string; raw?: string };

export function renderRoutingPrompt(template: string, catalog: string, stickyName: string | null): string {
  return template
    .replace('{CATALOG}', catalog)
    .replace('{STICKY}', stickyName ? stickyName : '无');
}

function parseRoute(text: string): RouteResult | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.route === 'string') return { route: j.route, confidence: String(j.confidence ?? 'medium'), raw: text };
  } catch {}
  return null;
}

/**
 * 判定一条主会话消息的归属。stickyName = 当前粘性主题名（无则 null）。
 * 返回 route（已校验存在性：topic:<id> 必须是本人活跃主题，否则降级 main_only）。
 */
export async function routeMessage(
  db: any,
  userId: string,
  text: string,
  stickyName: string | null,
): Promise<RouteResult> {
  const persona = await getPersona(db);
  const catalog = await topicCatalogText(db, userId);
  const frame = renderRoutingPrompt(persona.routing_prompt, catalog, stickyName);
  const judge = new Agent({
    id: 'topic-router',
    instructions: frame,
    model: buildModelId(persona) as any,
    modelSettings: { reasoning: persona.model_effort } as any,
  } as any);
  const res: any = await judge.generate(`用户消息：「${text.slice(0, 500)}」`, { maxSteps: 1 });
  const parsed = parseRoute(String(res?.text ?? ''));
  if (!parsed) return { route: 'main_only', confidence: 'low', raw: String(res?.text ?? '').slice(0, 200) };

  const { route } = parsed;
  if (route.startsWith('topic:')) {
    const id = route.slice(6);
    const row = await getRoomRow(db, id);
    if (!row || row.kind !== 'topic' || row.created_by !== userId || row.status !== 'active') {
      return { ...parsed, route: 'main_only' };
    }
    return parsed;
  }
  if (route.startsWith('new:')) {
    const name = route.slice(4).trim().slice(0, 30);
    return { ...parsed, route: name ? `new:${name}` : 'main_only' };
  }
  return { ...parsed, route: 'main_only' };
}
