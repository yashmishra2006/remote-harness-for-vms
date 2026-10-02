import type { AssistantCapabilities, AssistantConversation, AssistantMessages, AssistantStatus, AssistantUsage, MachineView } from '@remote-harness/shared/escanor';
import { escanorApiBase } from './config';
import type { ManagedHub } from './managed';

const ACCESS = 'escanor_access';
const REFRESH = 'escanor_refresh';

export class SessionEnded extends Error {
  constructor() {
    super('Your Escanor session ended. Please sign in again.');
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface EscanorUser {
  id: string;
  email: string;
  name: string;
  avatar_url?: string | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  description: string;
  category_label: string;
  connected: boolean;
  connect_via: 'oauth' | 'api_key' | 'credentials' | 'local_agent' | string;
  can_connect: boolean;
  oauth_available: boolean;
  credential_fields: string[];
  token_label: string;
  help_url: string;
}

export interface McpConnection {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  total_calls: number;
  managed_by?: string | null;
}

export interface McpInstall {
  endpoint: string;
  token: string;
  cli_command: string;
}

const tokens = {
  get access() {
    return localStorage.getItem(ACCESS);
  },
  get refresh() {
    return localStorage.getItem(REFRESH);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS, access);
    localStorage.setItem(REFRESH, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

export const hasStoredSession = (): boolean => Boolean(tokens.refresh || tokens.access);

/** The backend's error text, whatever shape it came in. */
export function messageOf(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  return fallback;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, however many requests found the token expired together. */
async function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const refresh = tokens.refresh;
    if (!refresh) return false;
    try {
      const res = await fetch(`${escanorApiBase()}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
      if (!res.ok) return false;
      const body = await res.json();
      tokens.set(body.access_token, body.refresh_token ?? refresh);
      return true;
    } catch {
      return false; // offline is not "signed out": keep the tokens and let the caller see the network error
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function request<T>(path: string, init: RequestInit = {}, opts: { auth?: boolean } = {}): Promise<T> {
  const auth = opts.auth !== false;
  const send = () =>
    fetch(`${escanorApiBase()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(auth && tokens.access ? { authorization: `Bearer ${tokens.access}` } : {}), ...init.headers },
    });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ApiError('Could not reach Escanor. Check your connection.', 0);
  }
  if (res.status === 401 && auth) {
    if (await refreshTokens()) res = await send();
    if (res.status === 401) {
      tokens.clear();
      throw new SessionEnded();
    }
  }
  if (!res.ok) throw new ApiError(messageOf(await res.json().catch(() => null), `Something went wrong (${res.status}).`), res.status);
  if (res.status === 204) return undefined as T;
  return res.json();
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const escanor = {
  // -- session
  async authorizeUrl(redirectUri: string, platform: 'web' | 'mobile'): Promise<string> {
    const r = await request<{ authorization_url: string }>(`/auth/oauth/google/authorize?platform=${platform}&redirect_uri=${enc(redirectUri)}`, {}, { auth: false });
    return r.authorization_url;
  },
  async exchangeCode(code: string): Promise<void> {
    const t = await request<{ access_token: string; refresh_token: string }>('/auth/oauth/exchange', json({ code, provider: 'google' }), { auth: false });
    tokens.set(t.access_token, t.refresh_token);
  },
  /** For development only: the backend refuses this unless ENABLE_DEV_AUTH is set. */
  async devLogin(email: string): Promise<void> {
    const t = await request<{ access_token: string; refresh_token: string }>('/auth/dev/login', json({ email, name: email.split('@')[0] }), { auth: false });
    tokens.set(t.access_token, t.refresh_token);
  },
  async me(): Promise<EscanorUser> {
    const s = await request<{ user: EscanorUser }>('/auth/session');
    return s.user;
  },
  async signOut(): Promise<void> {
    const refresh = tokens.refresh;
    tokens.clear();
    if (refresh) await request('/auth/logout', json({ refresh_token: refresh }), { auth: false }).catch(() => undefined);
  },

  // -- the hosted hub: the address and this person's tokens for their VMs
  managedHub: () => request<ManagedHub>('/agent/hub/managed'),

  // -- the assistant
  status: () => request<AssistantStatus>('/ai/status'),
  usage: () => request<AssistantUsage>('/ai/usage'),
  capabilities: (live = false) => request<AssistantCapabilities>(`/ai/capabilities${live ? '?live=true' : ''}`),
  machine: (logs = false) => request<MachineView>(`/ai/machine?logs=${logs}&tail=120`),
  conversations: () => request<{ conversations: AssistantConversation[] }>('/ai/conversations').then((r) => r.conversations),
  send: (text: string, conversationId?: string) => request<{ conversation_id: string }>('/ai/chat', json({ text, conversation_id: conversationId ?? null })),
  messages: (id: string, after: number) => request<AssistantMessages>(`/ai/conversations/${enc(id)}/messages?after=${after}`),
  answer: (id: string, requestId: string, allow: boolean) => request<{ status: string }>(`/ai/conversations/${enc(id)}/permissions/${enc(requestId)}`, json({ allow })),
  stop: (id: string) => request<{ ok: boolean }>(`/ai/conversations/${enc(id)}/stop`, { method: 'POST' }),
  remove: (id: string) => request<{ ok: boolean }>(`/ai/conversations/${enc(id)}`, { method: 'DELETE' }),

  // -- integrations (the same backend the web app uses, so the same truth)
  catalog: () => request<{ providers: CatalogProvider[] }>('/integrations/catalog').then((r) => r.providers),
  connectWithKey: (providerId: string, body: { access_token?: string; credentials?: Record<string, string> }) => request<{ synced?: boolean; message?: string }>(`/auth/integrations/${enc(providerId)}/connect`, json(body)),
  integrationAuthorizeUrl: (providerId: string) => request<{ authorization_url: string }>(`/auth/integrations/${enc(providerId)}/authorize?platform=mobile`).then((r) => r.authorization_url),
  disconnect: (providerId: string) => request<{ disconnected: boolean }>(`/auth/integrations/${enc(providerId)}`, { method: 'DELETE' }),

  // -- Escanor Desktop: a sealed (end-to-end encrypted) command for one of the person's own computers, answered when it next polls.
  async sendToComputer(agentId: string, deviceId: string, sealed: string): Promise<string> {
    type Cmd = { id: string; status: string; result?: { sealed?: string }; error?: string | null };
    let cmd = await request<Cmd>('/agents/commands', json({ agent_id: agentId, plugin: 'desktop', action: 'sealed', parameters: { dev: deviceId, sealed }, approve_immediately: true, wait_for_result: true }));
    const until = Date.now() + 120_000;
    while (cmd.status !== 'succeeded' && cmd.status !== 'failed' && cmd.status !== 'cancelled' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1200));
      cmd = await request<Cmd>(`/agents/commands/${enc(cmd.id)}`);
    }
    if (cmd.status !== 'succeeded' || !cmd.result?.sealed) throw new Error(cmd.status === 'failed' ? (cmd.error ?? 'The computer refused that.') : 'The computer did not answer. Is it on and online?');
    return cmd.result.sealed;
  },

  // -- other AI apps
  mcpConnections: () => request<McpConnection[]>('/agent/mcp/connections'),
  createMcpInstall: (name: string) => request<McpInstall>('/agent/mcp/install', json({ name })),
};
