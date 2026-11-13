/**
 * harness id 校验（harness-registry S2.4）纯函数：零 node 依赖，L1 Worker 与测试共用。
 * 显式 id 只对照内置目录（未知/非 ACP 拒，防 typo 跑错）；自定义目录项走设备默认，由 L2 resolveHarness 裁决。
 */
export function checkHarnessId(id: unknown, catalog: { id: string; acp: string }[]): string | { error: string } {
  const hid = String(id ?? '').trim();
  if (!hid) return '';
  const def = catalog.find((h) => h.id === hid);
  if (!def) return { error: `unknown harness: ${hid}（内置：${catalog.map((h) => h.id).join('/')}；自定义项可在桌面端设为默认）` };
  if (def.acp === 'none') return { error: `harness ${hid} 不支持 ACP，请改用 CUA 通道（dispatch_to_sandbox runtime=cua 或专家 tools_json 挂 cua）` };
  return hid;
}

/** harness id 入库格式（PUT /harness-settings）：≤40，字母数字开头，允许 ._-（自定义 id 也放行）。 */
export function isValidHarnessId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(id);
}
