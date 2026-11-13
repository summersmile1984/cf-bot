/** 出口脱敏（公共）：抹掉内部路径/UUID/内部术语/密钥样式，凡进用户视野的文本先过这里。 */
export function sanitizeUserFacing(text: string): string {
  return String(text ?? '')
    .replace(/(?:\/[\w.-]+)*\/workspace-l2\/(?:cloud|local)\/?/g, '工作区/')
    .replace(/\/(?:home|workspace|tmp|root|Users)\/[\w./-]+/g, (m) => (m.split('/').pop() || '文件'))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '任务')
    .replace(/\bjob_[a-z0-9]+\b/gi, '任务')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\b(ACP|acp|harness|dsh|sandbox-result|l2-worker|A2A)\b/g, '后台')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
