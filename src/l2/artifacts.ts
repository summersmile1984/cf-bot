/**
 * 产物预览（ask-artifacts S2.2）：save_artifact 工具 + CUA 截图自动入档。
 * 图片 base64 ≤1.2MB / 文本 ≤8KB；经 /l2-artifact 落库并在房间附件呈现。
 */
import { createTool } from '@mastra/core/tools';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { withProxy } from './proxy-fetch.js';

export type ArtifactCfg = { l1Url: string; token: string };

/** 上报一件产物（image: base64；text: 文本块；page: HTML 页面，L1 发布到 CF Pages）。 */
export async function uploadArtifact(
  cfg: ArtifactCfg, taskId: string,
  payload: { kind: 'image' | 'text' | 'page'; caption?: string; data: string },
): Promise<string | null> {
  try {
    const r = await fetch(`${cfg.l1Url}/l2-artifact`, withProxy({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, 'x-a2a-notification-token': cfg.token },
      body: JSON.stringify({ taskId, ...payload }),
      signal: AbortSignal.timeout(30_000),
    }));
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !j?.id) { console.log('[artifact] upload failed', r.status, JSON.stringify(j?.error ?? '').slice(0, 80)); return null; }
    return String(j.id);
  } catch (e: any) {
    console.log('[artifact] upload error', String(e?.message ?? e).slice(0, 120));
    return null;
  }
}

/** 截图文件自动入档（≤1.2MB 才收）。 */
export async function uploadScreenshot(cfg: ArtifactCfg, taskId: string, filePath: string, caption = '屏幕截图'): Promise<string | null> {
  try {
    const buf = readFileSync(filePath);
    if (buf.length > 1_200_000) return null;
    return await uploadArtifact(cfg, taskId, { kind: 'image', caption, data: buf.toString('base64') });
  } catch { return null; }
}

/** save_artifact 工具：sink 由 runExpertAgent 注入（全局槽）。 */
export function makeArtifactTool(sink: () => ((p: { kind: 'image' | 'text' | 'page'; caption?: string; data: string }) => Promise<string | null>) | null, description?: string) {
  return createTool({
    id: 'save_artifact',
    description: description || '把一件产物（截图 base64 或文本块）存进任务附件，主人能在聊天里直接看到。适合交付截图、报告片段、抓取的表格等。图片 base64 ≤1.2MB，文本 ≤8KB。',
    inputSchema: z.object({
      kind: z.enum(['image', 'text', 'page']),
      caption: z.string().describe('一句话说明（≤60 字）'),
      data: z.string().describe('image=PNG base64（≤1.2MB）；text=文本内容；page=完整 HTML 文档（≤2MB）'),
    }),
    execute: async (p: { kind: 'image' | 'text' | 'page'; caption?: string; data: string }) => {
      const fn = sink();
      if (!fn) return { ok: false, reason: 'no artifact channel' };
      const data = String(p.data ?? '');
      // 超限拒绝而非截断（评审 MAJOR：截断 base64 会静默损坏图片）
      if (p.kind === 'image' && data.length > 1_600_000) return { ok: false, reason: 'image too large (>1.2MB base64)' };
      if (p.kind === 'text' && data.length > 8_000) return { ok: false, reason: 'text too large (>8KB)' };
      if (p.kind === 'page' && data.length > 2_000_000) return { ok: false, reason: 'page too large (>2MB)' };
      const id = await fn({ ...p, data });
      return id ? { ok: true, id } : { ok: false, reason: 'upload failed' };
    },
  });
}
