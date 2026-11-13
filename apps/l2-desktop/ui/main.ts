import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

type DeviceSettings = {
  l1Url: string;
  token: string;
  intervalMs: number;
  harness?: string | null;
};

type HarnessStatus = {
  id: string; name: string; vendor?: string; acp: string;
  installed: boolean; path?: string; version?: string; error?: string;
  install?: { cmd?: string; note?: string };
  note?: string;
};

type LoopStatus = {
  running: boolean;
  online: boolean;
  lastClaimAt: string | null;
  lastTaskId: string | null;
  lastKind: string | null;
  lastState: string | null;
  lastSummary: string | null;
  lastProgress: string | null;
  queueHint: string | null;
  harness?: string | null;
  error: string | null;
  pid: number | null;
};

const DEFAULT_L1 = 'http://localhost:4120';

const app = document.querySelector('#app')!;
app.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="dot" id="dot"></span><span>Mastra Desktop</span></div>
      <span class="pill" id="runtimePill">L2 idle</span>
      <div class="spacer"></div>
      <span class="pill" id="l1Pill">L1</span>
    </header>
    <div class="main">
      <section class="chat-shell">
        <iframe class="chat-frame" id="chatFrame" title="L1 chat" allow="clipboard-read; clipboard-write"></iframe>
      </section>
      <aside class="side">
        <div class="card">
          <h2>L2 Runtime</h2>
          <div class="row"><span class="k">Status</span><span class="v" id="stRunning">—</span></div>
          <div class="row"><span class="k">Last claim</span><span class="v" id="stClaim">—</span></div>
          <div class="row"><span class="k">Runtime</span><span class="v" id="stKind">—</span></div>
          <div class="row"><span class="k">Result</span><span class="v" id="stState">—</span></div>
          <div class="row"><span class="k">Queue</span><span class="v" id="stQueue">—</span></div>
          <div class="actions">
            <button class="primary" id="btnStart">Start claim</button>
            <button class="danger" id="btnStop" disabled>Stop</button>
          </div>
          <div class="hint" id="stSummary"></div>
        </div>
        <div class="card">
          <h2>Settings</h2>
          <label class="field">L1 URL
            <input id="inpL1" type="url" placeholder="${DEFAULT_L1}" />
          </label>
          <label class="field">Device / PUSH token
            <input id="inpToken" type="password" autocomplete="off" placeholder="device pairing token" />
          </label>
          <label class="field">Poll interval (ms)
            <input id="inpInterval" type="number" min="1000" step="500" value="2000" />
          </label>
          <div class="actions">
            <button id="btnSave">Save</button>
            <button id="btnReloadChat">Reload chat</button>
          </div>
          <div class="hint">
            Token is stored in <code>~/.config/mastra-l2/device.json</code> (never shown in docs/shots).
            macOS CUA needs Screen Recording + Accessibility for <code>cua-spacesd</code>.
            <br />
            <a href="#" id="linkScreen">Screen Recording help</a> ·
            <a href="#" id="linkAccess">Accessibility help</a>
          </div>
        </div>
        <div class="card">
          <h2>Harness</h2>
          <div class="hint">ACP harness 目录（本机检测 · 一键安装 · 设为默认）</div>
          <div id="harnessList"></div>
          <div class="actions">
            <button id="btnHarnessRefresh">重新检测</button>
          </div>
        </div>
        <div class="card">
          <h2>MCP 库</h2>
          <div class="hint">集成目录：选一个 → 授权/填 Key → 秘书与专家即可调用（凭证入密钥库，可随时断开）</div>
          <div id="mcpCatalog"></div>
          <div class="actions">
            <button id="btnCatalogRefresh">刷新</button>
          </div>
        </div>
        <div class="card">
          <h2>MCP</h2>
          <div class="hint">MCP 服务器注册表（本机 ~/.config/mastra-l2/mcp.json · 真连接测试 · 专家经 use 引用）</div>
          <div id="mcpList"></div>
          <div id="mcpForm">
            <div class="row"><span class="k">id</span><input id="mcpId" placeholder="fs" /></div>
            <div class="row"><span class="k">name</span><input id="mcpName" placeholder="Filesystem" /></div>
            <div class="row"><span class="k">command</span><input id="mcpCmd" placeholder="npx" /></div>
            <div class="row"><span class="k">args</span><input id="mcpArgs" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" /></div>
            <div class="row"><span class="k">url</span><input id="mcpUrl" placeholder="http://…（与 command 二选一）" /></div>
            <div class="row"><span class="k">env</span><textarea id="mcpEnv" rows="2" placeholder="每行一条 K=V 或 K=secret:v1（秘钥必须用 secret: 引用）"></textarea></div>
            <div class="row"><span class="k">审批</span><label><input type="checkbox" id="mcpApproval" /> requireToolApproval（工具调用须审批）</label></div>
            <div class="actions">
              <button id="btnMcpSave" class="primary">保存</button>
              <button id="btnMcpClear">清空表单</button>
            </div>
          </div>
          <div class="actions">
            <button id="btnMcpRefresh">刷新</button>
          </div>
        </div>
        <div class="card">
          <h2>Log</h2>
          <div class="log" id="log"></div>
        </div>
      </aside>
    </div>
  </div>
`;

const el = {
  dot: document.querySelector('#dot') as HTMLElement,
  runtimePill: document.querySelector('#runtimePill') as HTMLElement,
  l1Pill: document.querySelector('#l1Pill') as HTMLElement,
  chatFrame: document.querySelector('#chatFrame') as HTMLIFrameElement,
  stRunning: document.querySelector('#stRunning') as HTMLElement,
  stClaim: document.querySelector('#stClaim') as HTMLElement,
  stKind: document.querySelector('#stKind') as HTMLElement,
  stState: document.querySelector('#stState') as HTMLElement,
  stQueue: document.querySelector('#stQueue') as HTMLElement,
  stSummary: document.querySelector('#stSummary') as HTMLElement,
  btnStart: document.querySelector('#btnStart') as HTMLButtonElement,
  btnStop: document.querySelector('#btnStop') as HTMLButtonElement,
  btnSave: document.querySelector('#btnSave') as HTMLButtonElement,
  btnReloadChat: document.querySelector('#btnReloadChat') as HTMLButtonElement,
  inpL1: document.querySelector('#inpL1') as HTMLInputElement,
  inpToken: document.querySelector('#inpToken') as HTMLInputElement,
  inpInterval: document.querySelector('#inpInterval') as HTMLInputElement,
  log: document.querySelector('#log') as HTMLElement,
  harnessList: document.querySelector('#harnessList') as HTMLElement,
  btnHarnessRefresh: document.querySelector('#btnHarnessRefresh') as HTMLButtonElement,
  mcpList: document.querySelector('#mcpList') as HTMLElement,
  mcpCatalog: document.querySelector('#mcpCatalog') as HTMLElement,
  btnCatalogRefresh: document.querySelector('#btnCatalogRefresh') as HTMLButtonElement,
  mcpId: document.querySelector('#mcpId') as HTMLInputElement,
  mcpName: document.querySelector('#mcpName') as HTMLInputElement,
  mcpCmd: document.querySelector('#mcpCmd') as HTMLInputElement,
  mcpArgs: document.querySelector('#mcpArgs') as HTMLInputElement,
  mcpUrl: document.querySelector('#mcpUrl') as HTMLInputElement,
  mcpEnv: document.querySelector('#mcpEnv') as HTMLTextAreaElement,
  mcpApproval: document.querySelector('#mcpApproval') as HTMLInputElement,
  btnMcpSave: document.querySelector('#btnMcpSave') as HTMLButtonElement,
  btnMcpClear: document.querySelector('#btnMcpClear') as HTMLButtonElement,
  btnMcpRefresh: document.querySelector('#btnMcpRefresh') as HTMLButtonElement,
  linkScreen: document.querySelector('#linkScreen') as HTMLAnchorElement,
  linkAccess: document.querySelector('#linkAccess') as HTMLAnchorElement,
};

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.log.textContent = `${line}\n${el.log.textContent || ''}`.slice(0, 4000);
}

function chatUrl(l1: string) {
  const base = l1.replace(/\/$/, '');
  return `${base}/app`;
}

function applySettings(s: DeviceSettings) {
  currentHarness = s.harness ?? null;
  el.inpL1.value = s.l1Url || DEFAULT_L1;
  el.inpToken.value = s.token || '';
  el.inpInterval.value = String(s.intervalMs || 2000);
  el.l1Pill.textContent = new URL(s.l1Url || DEFAULT_L1).host;
  el.chatFrame.src = chatUrl(s.l1Url || DEFAULT_L1);
}

function renderStatus(st: LoopStatus) {
  el.btnStart.disabled = st.running;
  el.btnStop.disabled = !st.running;
  el.stRunning.textContent = st.running ? (st.online ? 'online' : 'starting…') : 'stopped';
  el.stClaim.textContent = st.lastClaimAt || '—';
  el.stKind.textContent = st.lastKind || '—';
  el.stState.textContent = st.lastState || '—';
  el.stQueue.textContent = st.queueHint || '—';
  el.stSummary.textContent = st.error
    ? `Error: ${st.error}`
    : st.lastProgress
      ? `进度：${st.lastProgress}`
      : st.lastSummary
        ? st.lastSummary
        : 'Claim loop idle. Start to pull sandbox tasks from L1.';
  el.dot.className = `dot ${st.running ? (st.lastState === 'working' || st.lastKind ? 'working' : 'online') : 'offline'}`;
  el.runtimePill.textContent = st.running
    ? `L2 ${st.lastKind || 'polling'}${st.pid ? ` · pid ${st.pid}` : ''}`
    : 'L2 idle';
}

async function loadSettings() {
  const s = await invoke<DeviceSettings>('get_settings');
  applySettings(s);
  log('settings loaded');
  void refreshHarness();
  void refreshMcp();
  void refreshCatalog();
}

async function saveSettings() {
  const s: DeviceSettings = {
    l1Url: (el.inpL1.value || DEFAULT_L1).replace(/\/$/, ''),
    token: el.inpToken.value.trim(),
    intervalMs: Math.max(1000, Number(el.inpInterval.value) || 2000),
    harness: currentHarness,
  };
  await invoke('save_settings', { settings: s });
  applySettings(s);
  log('settings saved');
}

async function refreshStatus() {
  try {
    const st = await invoke<LoopStatus>('get_loop_status');
    renderStatus(st);
  } catch (e) {
    log(`status error: ${e}`);
  }
}

let currentHarness: string | null = null;

async function refreshHarness() {
  try {
    const raw = await invoke<string>('harness_detect');
    const list = JSON.parse(raw) as HarnessStatus[];
    el.harnessList.innerHTML = list.map((h) => `
      <div class="row" data-hid="${h.id}">
        <span class="k"><input type="radio" name="hdef" ${h.id === currentHarness ? 'checked' : ''} ${h.installed ? '' : 'disabled'} /> ${h.name}</span>
        <span class="v">${h.installed ? `✓ ${h.version || 'installed'}` : '✗ 未安装'}
          ${h.installed ? '' : (h.install?.cmd ? `<button data-inst="${h.id}">一键安装</button>` : '')}
        </span>
      </div>`).join('');
    el.harnessList.querySelectorAll<HTMLButtonElement>('button[data-inst]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '安装中…';
        try {
          const out = await invoke<string>('harness_install', { id: b.dataset.inst });
          const r = JSON.parse(out);
          log(`install ${b.dataset.inst}: ${r.ok ? 'ok' : 'fail'} ${String(r.output || '').slice(-400)}`);
        } catch (e) { log(`install error: ${e}`); }
        await refreshHarness();
      });
    });
    el.harnessList.querySelectorAll<HTMLInputElement>('input[name="hdef"]').forEach((r) => {
      r.addEventListener('change', async () => {
        const row = r.closest('[data-hid]') as HTMLElement;
        currentHarness = row?.dataset.hid ?? null;
        await saveSettings();
        log(`default harness → ${currentHarness}`);
      });
    });
    log(`harness detect: ${list.filter((h) => h.installed).length}/${list.length} installed`);
  } catch (e) { log(`harness detect error: ${e}`); }
}

el.btnHarnessRefresh.addEventListener('click', () => { refreshHarness(); });

// ---------- MCP 库（mcp-library S2.1/S2.3） ----------
type CatalogEntry = {
  id: string; name: string; vendor: string; category: string; description: string;
  note?: string;
  transport: { type: string; url?: string; command?: string; args?: string[] };
  auth: { type: 'oauth2' | 'api_key' | 'none' | string; provider?: string; apiKeyName?: string; apiKeyHint?: string };
  connected?: boolean;
  connection?: { endpoint?: string; enabled?: boolean; hasAuthHeader?: boolean } | null;
};
const AUTH_BADGE: Record<string, string> = { oauth2: '🔐 OAuth', api_key: '🔑 API Key', none: '免认证', custom: '自定义' };

function renderCatalog(entries: CatalogEntry[], custom: CatalogEntry[]) {
  const card = (e: CatalogEntry, isCustom: boolean) => {
    const on = Boolean(e.connected) && e.connection?.enabled !== false;
    const status = e.connected ? (on ? '✓ 已连接' : '⏸ 已停用') : '未连接';
    const endpoint = e.connection?.endpoint ?? (e.transport.type === 'remote' ? e.transport.url : `${e.transport.command ?? ''} ${(e.transport.args ?? []).join(' ')}`);
    return `
      <div class="row" data-cid="${esc(e.id)}">
        <span class="k">
          <b>${esc(e.name)}</b> <span class="hint">${esc(e.vendor)} · ${esc(e.category)} · ${AUTH_BADGE[e.auth.type] ?? esc(e.auth.type)}</span><br />
          <span class="hint">${esc(e.description)}</span><br />
          <span class="hint">${esc(String(endpoint ?? '').slice(0, 60))} · ${status}</span>
        </span>
        <span class="v">
          ${e.connected
            ? `<button data-ctest="${esc(e.id)}">测试</button><button data-cdisc="${esc(e.id)}">断开</button>`
            : isCustom
              ? ''
              : e.auth.type === 'api_key'
                ? `<button data-ckey="${esc(e.id)}">填 Key 连接</button>`
                : `<button data-cconn="${esc(e.id)}">${e.auth.type === 'oauth2' ? '连接（授权）' : '连接'}</button>`}
        </span>
      </div>`;
  };
  el.mcpCatalog.innerHTML =
    entries.map((e) => card(e, false)).join('') +
    (custom.length ? `<div class="hint" style="margin-top:6px">自定义条目</div>` + custom.map((e) => card(e, true)).join('') : '');
  el.mcpCatalog.querySelectorAll<HTMLButtonElement>('button[data-cconn]').forEach((b) => b.addEventListener('click', () => void catalogConnect(b.dataset.cconn!, b)));
  el.mcpCatalog.querySelectorAll<HTMLButtonElement>('button[data-ckey]').forEach((b) => b.addEventListener('click', () => void catalogConnectKey(b.dataset.ckey!)));
  el.mcpCatalog.querySelectorAll<HTMLButtonElement>('button[data-cdisc]').forEach((b) => b.addEventListener('click', () => void catalogDisconnect(b.dataset.cdisc!)));
  el.mcpCatalog.querySelectorAll<HTMLButtonElement>('button[data-ctest]').forEach((b) => b.addEventListener('click', () => void mcpTest(b.dataset.ctest!)));
}

async function refreshCatalog() {
  try {
    const j = JSON.parse(await mcpInvoke(['catalog'])) as { ok: boolean; entries: CatalogEntry[]; custom: CatalogEntry[] };
    if (!j.ok) { log(`catalog error: ${String((j as any).error ?? '')}`); return; }
    renderCatalog(j.entries ?? [], j.custom ?? []);
    log(`mcp catalog: ${(j.entries ?? []).length} 项，已连接 ${(j.entries ?? []).filter((e) => e.connected).length}`);
  } catch (e) { log(`catalog error: ${e}`); }
}

async function catalogConnect(id: string, btn: HTMLButtonElement) {
  btn.disabled = true; btn.textContent = '连接中…浏览器授权';
  log(`mcp connect ${id} …（请在浏览器完成授权）`);
  try {
    const r = JSON.parse(await mcpInvoke(['connect', id]));
    if (r.ok) log(`mcp ${id} 已连接${r.account ? `：${r.account}` : ''}`);
    else log(`mcp connect 失败：${String(r.error ?? '').slice(0, 140)}`);
  } catch (e) { log(`mcp connect error: ${String(e).slice(0, 140)}`); }
  await refreshCatalog().catch(() => {});
  await refreshMcp().catch(() => {});
}

async function catalogConnectKey(id: string) {
  const key = window.prompt(`输入 ${id} 的 API Key（只入密钥库，不落注册表）：`);
  if (!key) return;
  log(`mcp connect-key ${id} …`);
  try {
    // key 经 stdin 下发（评审 MINOR：不进 argv/ps）
    const r = JSON.parse(await mcpInvoke(['connect-key', id], key));
    log(r.ok ? `mcp ${id} 已连接` : `mcp connect-key 失败：${String(r.error ?? '').slice(0, 140)}`);
  } catch (e) { log(`mcp connect-key error: ${String(e).slice(0, 140)}`); }
  await refreshCatalog().catch(() => {});
  await refreshMcp().catch(() => {});
}

async function catalogDisconnect(id: string) {
  if (!window.confirm(`确认断开「${id}」？将移除连接并删除已存凭证。`)) return;
  try {
    const r = JSON.parse(await mcpInvoke(['disconnect', id]));
    log(r.ok ? `mcp ${id} 已断开` : `mcp disconnect 失败：${String(r.error ?? '').slice(0, 140)}`);
  } catch (e) { log(`mcp disconnect error: ${String(e).slice(0, 140)}`); }
  await refreshCatalog().catch(() => {});
  await refreshMcp().catch(() => {});
}

el.btnCatalogRefresh.addEventListener('click', () => void refreshCatalog());

// ---------- MCP 注册表（mcp-connections S2.3） ----------
type McpRow = {
  id: string; name?: string; command?: string; url?: string; args?: string[];
  env?: Record<string, string>; requireToolApproval?: boolean; enabled?: boolean; note?: string;
  endpoint?: string; envVars?: string[];
};
type McpTestState = { ok: boolean; tools: string[]; ms: number; error?: string };
const mcpTests = new Map<string, McpTestState>();
let mcpEditingId: string | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function mcpInvoke(args: string[], stdin?: string): Promise<string> {
  return invoke<string>('mcp_cli', { args, stdin: stdin ?? null });
}

function renderMcp(rows: McpRow[]) {
  el.mcpList.innerHTML = rows.map((s) => {
    const t = mcpTests.get(s.id);
    const status = t ? (t.ok ? `✓ ${t.tools.length} 工具 · ${(t.ms / 1000).toFixed(1)}s` : `✗ ${esc(String(t.error ?? '失败').slice(0, 40))}`) : '—';
    const on = s.enabled !== false;
    return `
      <div class="row" data-mid="${esc(s.id)}">
        <span class="k">${on ? '' : '⏸'} ${esc(s.name || s.id)}<br /><span class="hint">${esc(s.endpoint ?? '')}</span></span>
        <span class="v">${status}
          <button data-test="${esc(s.id)}">测试</button>
          <button data-edit="${esc(s.id)}">编辑</button>
          <button data-toggle="${esc(s.id)}">${on ? '停用' : '启用'}</button>
          <button data-del="${esc(s.id)}">删除</button>
        </span>
      </div>`;
  }).join('') || '<div class="hint">注册表为空 — 用下方表单新增</div>';
  el.mcpList.querySelectorAll<HTMLButtonElement>('button[data-test]').forEach((b) => b.addEventListener('click', () => void mcpTest(b.dataset.test!)));
  el.mcpList.querySelectorAll<HTMLButtonElement>('button[data-edit]').forEach((b) => b.addEventListener('click', () => void mcpFillForm(b.dataset.edit!)));
  el.mcpList.querySelectorAll<HTMLButtonElement>('button[data-toggle]').forEach((b) => b.addEventListener('click', () => void mcpToggle(b.dataset.toggle!)));
  el.mcpList.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach((b) => b.addEventListener('click', () => void mcpDelete(b.dataset.del!)));
}

async function refreshMcp() {
  try {
    const raw = await mcpInvoke(['list']);
    const j = JSON.parse(raw) as { ok: boolean; servers: McpRow[] };
    if (!j.ok) { log(`mcp list error: ${String((j as any).error ?? '').slice(0, 120)}`); return; }
    renderMcp(j.servers ?? []);
    log(`mcp registry: ${(j.servers ?? []).length} servers`);
  } catch (e) { log(`mcp list error: ${e}`); }
}

async function mcpTest(id: string) {
  log(`mcp test ${id} …`);
  try {
    const raw = await mcpInvoke(['test', id]);
    const r = JSON.parse(raw) as McpTestState & { id: string };
    mcpTests.set(id, r);
    log(r.ok ? `mcp ${id}: ✓ ${r.tools.length} tools (${r.ms}ms)` : `mcp ${id}: ✗ ${r.error}`);
    await refreshMcp();
  } catch (e) {
    // 失败也要在行内可见（评审 MAJOR：不能只进 LOG）
    mcpTests.set(id, { ok: false, tools: [], ms: 0, error: String(e).slice(0, 80) });
    log(`mcp test error: ${e}`);
    await refreshMcp().catch(() => {});
  }
}

/** 取原始 def（含 env 值/requireToolApproval/note）：list 不回显 env，编辑/切换须走 show。 */
async function mcpShow(id: string): Promise<Record<string, any> | null> {
  try {
    const j = JSON.parse(await mcpInvoke(['show', id])) as { ok: boolean; def?: Record<string, any> };
    return j.ok ? (j.def ?? null) : null;
  } catch { return null; }
}

async function mcpFillForm(id: string) {
  const s = await mcpShow(id);
  if (!s) { log(`mcp show ${id} 失败`); return; }
  mcpEditingId = id;
  el.mcpId.value = id; el.mcpName.value = s.name ?? ''; el.mcpCmd.value = s.command ?? '';
  el.mcpArgs.value = (s.args ?? []).join(' '); el.mcpUrl.value = s.url ?? '';
  // 每行一条 K=V（评审 MINOR）：逗号分隔会截断含逗号的值
  el.mcpEnv.value = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  el.mcpApproval.checked = Boolean(s.requireToolApproval);
  log(`form ← ${id}`);
}

function mcpClearForm() {
  mcpEditingId = null;
  for (const i of [el.mcpId, el.mcpName, el.mcpCmd, el.mcpArgs, el.mcpUrl, el.mcpEnv]) i.value = '';
  el.mcpApproval.checked = false;
}

async function mcpSave() {
  const id = el.mcpId.value.trim();
  if (!id) { log('mcp id 必填'); return; }
  const env: Record<string, string> = {};
  for (const line of el.mcpEnv.value.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  // 合并已有 def（评审 MAJOR）：表单没覆盖的 note/enabled 等字段不丢
  const existing = (await mcpShow(id)) ?? {};
  const def: Record<string, unknown> = {
    ...existing,
    name: el.mcpName.value.trim() || undefined,
    env: Object.keys(env).length ? env : undefined,
    // 复选框仅在「编辑同一 id」时是权威；直接敲入已有 id 不经编辑时保留存量值（评审 MINOR）
    requireToolApproval: el.mcpApproval.checked ? true : (mcpEditingId === id ? undefined : existing.requireToolApproval),
  };
  if (el.mcpCmd.value.trim()) {
    def.command = el.mcpCmd.value.trim();
    def.url = undefined;
    if (el.mcpArgs.value.trim()) def.args = el.mcpArgs.value.trim().match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
    else def.args = undefined;
  } else if (el.mcpUrl.value.trim()) {
    def.url = el.mcpUrl.value.trim();
    def.command = undefined;
    def.args = undefined;
  } else { log('mcp 需要 command 或 url'); return; }
  for (const k of Object.keys(def)) if (def[k] === undefined) delete def[k];
  try {
    const j = JSON.parse(await mcpInvoke(['set', id, JSON.stringify(def)]));
    if (!j.ok) { log(`mcp save error: ${String(j.error ?? '').slice(0, 120)}`); return; }
    log(`mcp saved: ${id}`);
    await refreshMcp();
  } catch (e) { log(`mcp save error: ${e}`); }
}

async function mcpToggle(id: string) {
  const s = await mcpShow(id);
  if (!s) { log(`mcp show ${id} 失败`); return; }
  try {
    const def = { ...s, enabled: s.enabled === false ? true : false };
    const j = JSON.parse(await mcpInvoke(['set', id, JSON.stringify(def)]));
    if (!j.ok) { log(`mcp toggle error: ${String(j.error ?? '').slice(0, 120)}`); return; }
    log(`mcp ${id} → ${def.enabled ? '启用' : '停用'}`);
    await refreshMcp();
  } catch (e) { log(`mcp toggle error: ${e}`); }
}

async function mcpDelete(id: string) {
  // 二次确认（S2.3）
  if (!window.confirm(`确认删除 MCP 服务器「${id}」？此操作不可恢复。`)) return;
  try {
    await mcpInvoke(['remove', id]);
    mcpTests.delete(id);
    if (mcpEditingId === id) mcpClearForm();
    log(`mcp removed: ${id}`);
    await refreshMcp();
  } catch (e) { log(`mcp delete error: ${e}`); }
}

el.btnMcpSave.addEventListener('click', () => void mcpSave());
el.btnMcpClear.addEventListener('click', () => mcpClearForm());
el.btnMcpRefresh.addEventListener('click', () => void refreshMcp());

el.btnSave.addEventListener('click', () => {
  saveSettings().catch((e) => log(String(e)));
});
el.btnReloadChat.addEventListener('click', () => {
  el.chatFrame.src = chatUrl(el.inpL1.value || DEFAULT_L1);
  log('chat reloaded');
});
el.btnStart.addEventListener('click', async () => {
  try {
    await saveSettings();
    await invoke('start_claim_loop');
    log('claim loop start requested');
    await refreshStatus();
  } catch (e) {
    log(String(e));
  }
});
el.btnStop.addEventListener('click', async () => {
  try {
    await invoke('stop_claim_loop');
    log('claim loop stop requested');
    await refreshStatus();
  } catch (e) {
    log(String(e));
  }
});

el.linkScreen.addEventListener('click', async (e) => {
  e.preventDefault();
  await openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});
el.linkAccess.addEventListener('click', async (e) => {
  e.preventDefault();
  await openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

const inTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
if (inTauri) {
  loadSettings()
    .then(refreshStatus)
    .catch((e) => {
      log(String(e));
      applySettings({ l1Url: DEFAULT_L1, token: '', intervalMs: 2000 });
    });
  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 1500);
} else {
  applySettings({ l1Url: DEFAULT_L1, token: '', intervalMs: 2000 });
  renderStatus({
    running: false,
    online: false,
    lastClaimAt: null,
    lastTaskId: null,
    lastKind: null,
    lastProgress: null,
    lastState: null,
    lastSummary: null,
    queueHint: 'browser preview',
    error: null,
    pid: null,
  });
  log('Vite preview (no Tauri bridge)');
}
