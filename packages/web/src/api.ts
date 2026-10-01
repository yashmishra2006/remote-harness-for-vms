import type { ApiTokenCreatedDto, ApiTokenDto, ImageAttachment, McpOverviewDto, MessageDto, SessionDto, VmDto } from '@remote-harness/shared';

const TOKEN_KEY = 'rh_token';
const HUB_URL_KEY = 'rh_hub_url';

// In the browser the hub serves this app, so calls are same-origin. In the native
// Android app there is no such origin, so the user enters the hub's address once.
export const isNative = (): boolean => Boolean((window as any).Capacitor?.isNativePlatform?.());

export function getHubUrl(): string {
  return (localStorage.getItem(HUB_URL_KEY) ?? '').replace(/\/+$/, '');
}

export function setHubUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem(HUB_URL_KEY, clean);
  else localStorage.removeItem(HUB_URL_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const requestToken = getToken();
  const requestHub = getHubUrl();
  const assertCurrentSession = () => {
    if (getToken() !== requestToken || getHubUrl() !== requestHub) throw new Error('Session changed; response discarded');
  };
  const res = await fetch(`${requestHub}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}),
      ...init?.headers,
    },
  });
  assertCurrentSession();
  if (res.status === 401) {
    // Hosted hubs refresh through Escanor; preserve that flow for the current session.
    if (localStorage.getItem('rh_managed') === '1') {
      window.dispatchEvent(new Event('rh-managed-unauthorized'));
      throw new Error('Reconnecting to your hub…');
    }
    setToken(null);
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    assertCurrentSession();
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const result = await res.json();
  assertCurrentSession();
  return result;
}

export const api = {
  login: (password: string) => request<{ token: string }>('/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/logout', { method: 'POST' }),
  listApiTokens: () => request<ApiTokenDto[]>('/tokens'),
  createApiToken: (label: string) => request<ApiTokenCreatedDto>('/tokens', { method: 'POST', body: JSON.stringify({ label }) }),
  deleteApiToken: (id: string) => request<{ ok: boolean }>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listVms: () => request<VmDto[]>('/vms'),
  getMcpOverview: () => request<McpOverviewDto>('/mcp-servers'),
  listSessions: (vmId: string) => request<SessionDto[]>(`/vms/${vmId}/sessions`),
  listProjects: (vmId: string) => request<string[]>(`/vms/${vmId}/projects`),
  listMessages: (vmId: string, sessionId: string) =>
    request<MessageDto[]>(`/vms/${vmId}/sessions/${sessionId}/messages`),
  createSession: (vmId: string, body: { cwd?: string; text: string; images?: ImageAttachment[]; accountId?: string }) =>
    request<{ tempId: string }>(`/vms/${vmId}/sessions`, { method: 'POST', body: JSON.stringify(body) }),
  sendMessage: (vmId: string, sessionId: string, body: { text: string; images?: ImageAttachment[] }) =>
    request(`/vms/${vmId}/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify(body) }),
  interrupt: (vmId: string, sessionId: string) =>
    request(`/vms/${vmId}/sessions/${sessionId}/interrupt`, { method: 'POST' }),
  setPermissionMode: (vmId: string, sessionId: string, mode: string) =>
    request(`/vms/${vmId}/sessions/${sessionId}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  setModel: (vmId: string, sessionId: string, model: string) =>
    request(`/vms/${vmId}/sessions/${sessionId}/model`, { method: 'POST', body: JSON.stringify({ model }) }),
  setEffort: (vmId: string, sessionId: string, effort: string) =>
    request(`/vms/${vmId}/sessions/${sessionId}/effort`, { method: 'POST', body: JSON.stringify({ effort }) }),
  resolvePermission: (vmId: string, sessionId: string, requestId: string, behavior: 'allow' | 'deny') =>
    request(`/vms/${vmId}/sessions/${sessionId}/permission-response`, {
      method: 'POST',
      body: JSON.stringify({ requestId, behavior }),
    }),
};
