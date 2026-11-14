/** API 客户端：better-auth + rooms/messages + SSE 流。同源 cookie 会话。 */

export type User = { id: string; email: string; name?: string };
export type Room = {
  id: string;
  name: string;
  created_by: string | null;
  updated_at: number;
  role?: string;
  last_message?: string | null;
  last_message_at?: number | null;
  is_main?: number;
  kind?: string;
  status?: string;
  summary?: string | null;
  last_topic_id?: string | null;
  last_read_at?: number | null;
};
export type Persona = {
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
  model_gateway: string;
  model_name: string;
  model_effort: string;
  updated_at: number;
  updated_by: string | null;
};
export type Member = { user_id: string; role: string; name?: string; email?: string };
export type Message = {
  id: string;
  room_id: string;
  user_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  credentials: 'same-origin',
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------- auth ----------

export async function getSession(): Promise<User | null> {
  try {
    // disableRefresh：跳过会话滚动续期写库（并发下会竞态出 500）；超时兜底避免卡死在加载态
    const r = await fetch('/auth/get-session?disableRefresh=true', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const s = await r.json();
    return s?.user?.id ? (s.user as User) : null;
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  const r = await fetch('/auth/sign-in/email', jsonInit('POST', { email, password }));
  const s = await j<{ user: User }>(r);
  return s.user;
}

export async function signUp(name: string, email: string, password: string, turnstileToken?: string): Promise<User> {
  const r = await fetch('/auth/sign-up/email', jsonInit('POST', { name, email, password, ...(turnstileToken ? { turnstileToken } : {}) }));
  const s = await j<{ user: User }>(r);
  return s.user;
}

export async function signOut(): Promise<void> {
  await fetch('/auth/sign-out', jsonInit('POST')).catch(() => {});
}

// ---------- rooms ----------

export async function listRooms(): Promise<Room[]> {
  const r = await fetch('/rooms', { credentials: 'same-origin' });
  return (await j<{ rooms: Room[] }>(r)).rooms;
}

export async function createRoom(name: string): Promise<Room> {
  const r = await fetch('/rooms', jsonInit('POST', { name }));
  return (await j<{ room: Room }>(r)).room;
}

export async function getRoom(id: string): Promise<{ room: Room; members: Member[] }> {
  const r = await fetch(`/rooms/${id}`, { credentials: 'same-origin' });
  return j(r);
}

export async function addMember(roomId: string, email: string): Promise<void> {
  const r = await fetch(`/rooms/${roomId}/members`, jsonInit('POST', { email }));
  await j(r);
}

export async function listMessages(roomId: string, after?: string): Promise<{ messages: Message[]; busy: boolean }> {
  const q = after ? `?after=${encodeURIComponent(after)}` : '';
  const r = await fetch(`/rooms/${roomId}/messages${q}`, { credentials: 'same-origin' });
  return j(r);
}

// ---------- 人格设置 ----------

/** 产品名（白牌化）：登录页/标题用，公开接口 */
export async function getBrand(): Promise<{ productName: string }> {
  const r = await fetch('/brand', { credentials: 'same-origin' });
  return j(r);
}

// ---------- 额度与订阅（saas S2.6） ----------
export type Quota = {
  planId: string;
  weekId: string;
  weekPool: { used: number; total: number };
  credits: { balance: number; expiresAt: number | null };
  cloud: { used: number; bought: number };
};

export async function getQuota(): Promise<Quota> {
  const r = await fetch('/quota', { credentials: 'same-origin' });
  return (await j<{ quota: Quota }>(r)).quota;
}

export async function createCheckout(priceKey: 'lite' | 'pro' | 'max' | 'credit_1000' | 'cloud_60'): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const r = await fetch('/billing/checkout', { ...jsonInit('POST', { priceKey }), credentials: 'same-origin' });
  return j(r);
}

export async function getPersona(): Promise<Persona> {
  const r = await fetch('/settings/persona', { credentials: 'same-origin' });
  return (await j<{ persona: Persona }>(r)).persona;
}

export async function updatePersona(patch: {
  product_name?: string;
  name?: string;
  role?: string;
  style?: string;
  main_room_name?: string;
  base_prompt?: string;
  tone_main?: string;
  tone_room?: string;
  om_observe?: string;
  om_reflect?: string;
  tool_dispatch?: string;
  model_gateway?: string;
  model_name?: string;
  model_effort?: string;
}): Promise<Persona> {
  const r = await fetch('/settings/persona', jsonInit('PUT', patch));
  return (await j<{ persona: Persona }>(r)).persona;
}

export async function getModels(): Promise<{ gateways: { gateway: string; models: string[] }[]; effortLevels: string[] }> {
  const r = await fetch('/settings/models', { credentials: 'same-origin' });
  return j(r);
}

// ---------- 聊天流 ----------

export type SseHandlers = {
  onDelta: (text: string) => void;
  onDone: (full: string) => void;
  onError: (err: string) => void;
};

/** POST 发消息并消费 SSE 流（自定义事件：delta / done）。 */
export async function sendMessage(roomId: string, text: string, h: SseHandlers): Promise<void> {
  const r = await fetch(`/rooms/${roomId}/messages`, {
    ...jsonInit('POST', { text }),
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
  });
  if (!r.ok || !r.body) {
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    h.onError(msg);
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '[DONE]') continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'delta') {
        full += ev.text ?? '';
        h.onDelta(ev.text ?? '');
      } else if (ev.type === 'done') {
        full = ev.text ?? full;
        h.onDone(full);
      } else if (ev.type === 'error') {
        h.onError(ev.message ?? 'error');
      }
    }
  }
}

// ---------- MCP 市场 / 我的连接（web-mcp S2.2） ----------

export type McpCatalogEntry = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  note?: string;
  transport: { type: 'remote' | 'stdio'; url?: string; command?: string; args?: string[] };
  auth: { type: 'oauth2' | 'api_key' | 'none'; provider?: string; apiKeyName?: string; apiKeyHint?: string; scopes?: string[] };
};

export type McpConnection = {
  id: string;
  catalogId: string;
  name: string;
  account: string | null;
  status: string;
  createdAt: number;
  transport: Record<string, unknown> | null;
};

export async function getMcpCatalog(): Promise<McpCatalogEntry[]> {
  const r = await fetch('/mcp-catalog', { credentials: 'same-origin' });
  const b = await j<{ ok: boolean; entries: McpCatalogEntry[] }>(r);
  return b.entries ?? [];
}

export async function listMcpConnections(): Promise<McpConnection[]> {
  const r = await fetch('/mcp-connections', { credentials: 'same-origin' });
  const b = await j<{ ok: boolean; connections: McpConnection[] }>(r);
  return b.connections ?? [];
}

export async function deleteMcpConnection(id: string): Promise<void> {
  const r = await fetch(`/mcp-connections/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  await j(r);
}

export async function startMcpOAuth(catalogId: string, clientId?: string, clientSecret?: string): Promise<{ authUrl: string; provider?: string; hint?: string }> {
  const r = await fetch('/mcp-oauth/start', {
    ...jsonInit('POST', { catalogId, clientId, clientSecret, redirectBack: `${location.pathname}${location.search}` }),
  });
  const b = await j<{ ok: boolean; authUrl: string; provider?: string; hint?: string; error?: string }>(r).catch(async (e) => {
    // missing_client 等业务错也带 hint
    let msg = String(e?.message ?? e);
    let hint: string | undefined;
    try {
      const body = await r.json();
      msg = body?.error ?? msg;
      hint = body?.hint;
    } catch {}
    throw Object.assign(new Error(msg), { hint });
  });
  return b;
}

export async function connectMcpKey(catalogId: string, key: string): Promise<McpConnection> {
  const r = await fetch('/mcp-connections/key', { ...jsonInit('POST', { catalogId, key }) });
  const b = await j<{ ok: boolean; connection: McpConnection }>(r);
  return b.connection;
}

export async function connectMcpNone(catalogId: string): Promise<McpConnection> {
  const r = await fetch('/mcp-connections/none', { ...jsonInit('POST', { catalogId }) });
  const b = await j<{ ok: boolean; connection: McpConnection }>(r);
  return b.connection;
}

// ---------- OM 记忆管理（om-admin S2.2） ----------

export type OmProfile = {
  name?: string; preferredName?: string; timezone?: string;
  preferences?: string[]; ongoing?: string[]; facts?: string[];
};

export type OmRecord = {
  id: string; threadId: string; generationCount: number;
  activeObservations: string; bufferedObservationChunks?: string | null;
  bufferedReflection?: string | null; originType?: string | null;
  createdAt: number; updatedAt: number; supersededBy?: string | null;
};

export type OmOverview = {
  user: { id: string; name?: string; email?: string };
  profile: OmProfile | null; profileUpdatedAt: number | null;
  rooms: { thread: string; name: string; records: number; lastAt: number | null }[];
};

export async function getOmOverview(): Promise<OmOverview> {
  const r = await fetch('/om/overview', { credentials: 'same-origin' });
  return j(r);
}

export async function getOmObservationsAll(): Promise<{ rooms: { thread: string; records: OmRecord[] }[] }> {
  const r = await fetch('/om/observations?all=1', { credentials: 'same-origin' });
  return j(r);
}

export async function updateOmProfile(profile: OmProfile): Promise<OmProfile> {
  const r = await fetch('/om/profile', { ...jsonInit('PUT', profile) });
  const b = await j<{ ok: boolean; profile: OmProfile }>(r);
  return b.profile;
}

export async function updateOmObservation(id: string, patch: { activeObservations?: string; bufferedReflection?: string; expected?: string }): Promise<void> {
  const r = await fetch(`/om/observations/${id}`, { ...jsonInit('PUT', patch) });
  await j(r);
}

export async function deleteOmObservation(id: string): Promise<void> {
  const r = await fetch(`/om/observations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  await j(r);
}

export async function exportOmDownload(format: 'json' | 'md'): Promise<void> {
  const r = await fetch(`/om/export?format=${format}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`导出失败 HTTP ${r.status}`);
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `memory-${new Date().toISOString().slice(0, 10)}.${format === 'md' ? 'md' : 'json'}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 首跑引导（onboarding） ----------
export type OnboardingStatus = {
  needsSetup: boolean;
  signupsOpen: boolean;
  turnstileSitekey: string | null;
  checks: { deepseekKey: boolean; authSecret: boolean; l1PublicUrl: string; detectedOrigin: string; productName: string };
};

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const r = await fetch('/onboarding/status', { credentials: 'same-origin' });
  return j(r);
}

export async function completeSetup(input: { name?: string; email: string; password: string }): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch('/onboarding/setup', { ...jsonInit('POST', input), credentials: 'same-origin' });
  return j(r);
}

export async function setRegistration(open: boolean): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch('/settings/registration', { ...jsonInit('PUT', { open }), credentials: 'same-origin' });
  return j(r);
}

// ---------- L2 控制台（l2-console） ----------
export type AgentDef = {
  id: string; name: string; description?: string | null; instructions: string; model?: string | null;
  tools_json?: string | null; mcp_json?: string | null; skills_json?: string | null; memory_json?: string | null;
  updated_at?: number;
};
export type PermRule = { category_or_tool: string; policy: string; updated_at?: number };
export type Schedule = {
  id: string; name: string; prompt: string; cron: string; timezone?: string | null;
  target_type?: string; target_id?: string | null; enabled: boolean; next_run_at?: number | null; last_run_at?: number | null;
};
export type HarnessInfo = { id: string; name: string; description?: string; command?: string };

export async function listAgentDefs(): Promise<AgentDef[]> {
  const r = await fetch('/agent-defs', { credentials: 'same-origin' });
  const j = await r.json();
  return j.experts ?? j.defs ?? j.agentDefs ?? (Array.isArray(j) ? j : []);
}
export async function createAgentDef(body: Partial<AgentDef>): Promise<AgentDef> {
  const r = await fetch('/agent-defs', { ...jsonInit('POST', body), credentials: 'same-origin' });
  const j = await r.json();
  return j.expert ?? j;
}
export async function updateAgentDef(id: string, body: Partial<AgentDef>): Promise<AgentDef> {
  const r = await fetch(`/agent-defs/${id}`, { ...jsonInit('PUT', body), credentials: 'same-origin' });
  const j = await r.json();
  return j.expert ?? j;
}
export async function deleteAgentDef(id: string): Promise<void> {
  await fetch(`/agent-defs/${id}`, { ...jsonInit('DELETE'), credentials: 'same-origin' });
}

export async function getPermissions(): Promise<{ rules: PermRule[]; settings: { auto_review: number } }> {
  const r = await fetch('/permissions', { credentials: 'same-origin' });
  return j(r);
}
export async function putPermissions(rules: PermRule[], autoReview: boolean): Promise<{ rules: PermRule[] }> {
  const r = await fetch('/permissions', { ...jsonInit('PUT', { rules, auto_review: autoReview ? 1 : 0 }), credentials: 'same-origin' });
  return j(r);
}
export async function deletePermission(tool: string): Promise<{ ok: boolean }> {
  const r = await fetch(`/permissions/${encodeURIComponent(tool)}`, { ...jsonInit('DELETE'), credentials: 'same-origin' });
  return j(r);
}

export async function listSchedules(): Promise<Schedule[]> {
  const r = await fetch('/schedules', { credentials: 'same-origin' });
  const jj = await r.json();
  return jj.schedules ?? jj;
}
export async function createSchedule(body: Partial<Schedule>): Promise<Schedule> {
  const r = await fetch('/schedules', { ...jsonInit('POST', body), credentials: 'same-origin' });
  const jj = await r.json();
  return jj.schedule ?? jj;
}
export async function updateSchedule(id: string, body: Partial<Schedule>): Promise<Schedule> {
  const r = await fetch(`/schedules/${id}`, { ...jsonInit('PUT', body), credentials: 'same-origin' });
  const jj = await r.json();
  return jj.schedule ?? jj;
}
export async function deleteSchedule(id: string): Promise<void> {
  await fetch(`/schedules/${id}`, { ...jsonInit('DELETE'), credentials: 'same-origin' });
}
export async function runScheduleNow(id: string): Promise<{ ok: boolean; note?: string; error?: string }> {
  const r = await fetch(`/schedules/${id}/run`, { ...jsonInit('POST', {}), credentials: 'same-origin' });
  return j(r);
}
export async function listScheduleRuns(id: string): Promise<{ runs: Array<{ id?: string; status: string; detail?: string; created_at?: number }> }> {
  const r = await fetch(`/schedules/${id}/runs`, { credentials: 'same-origin' });
  return j(r);
}

export async function getHarnessSettings(): Promise<{ harness: string | null; catalog: HarnessInfo[] }> {
  const r = await fetch('/harness-settings', { credentials: 'same-origin' });
  return j(r);
}
export async function setHarnessDefault(harness: string | null): Promise<{ ok?: boolean; harness?: string | null; error?: string }> {
  const r = await fetch('/harness-settings', { ...jsonInit('PUT', { harness }), credentials: 'same-origin' });
  return j(r);
}

export type DeviceInfo = {
  id: string; name: string; capabilities: Record<string, unknown>;
  lastSeenAt: number | null; status: string; isDefault: boolean; createdAt: number;
};
export async function listDevices(): Promise<DeviceInfo[]> {
  const r = await fetch('/devices', { credentials: 'same-origin' });
  const jj = await r.json();
  return jj.devices ?? [];
}
export async function createPairingCode(): Promise<{ code: string; expiresAt: number }> {
  const r = await fetch('/devices/pairing-code', { ...jsonInit('POST', {}), credentials: 'same-origin' });
  return j(r);
}
export async function renameDevice(id: string, name: string): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch(`/devices/${encodeURIComponent(id)}`, { ...jsonInit('PUT', { name }), credentials: 'same-origin' });
  return j(r);
}
export async function revokeDevice(id: string): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch(`/devices/${encodeURIComponent(id)}`, { ...jsonInit('DELETE'), credentials: 'same-origin' });
  return j(r);
}
export async function setDefaultDevice(deviceId: string | null): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/devices/default', { ...jsonInit('POST', { deviceId }), credentials: 'same-origin' });
  return j(r);
}
