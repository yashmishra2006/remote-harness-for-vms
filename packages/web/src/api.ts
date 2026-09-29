import type { ImageAttachment, MessageDto, SessionDto, VmDto } from '@remote-harness/shared';

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

// Empty means "this server" (the browser case, where the hub serves the app).
export function normalizeHubUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('Hub URL must start with http:// or https://');
  return url;
}

// Any HTTP answer (even 401) proves a hub is there; only a network failure means it isn't.
export async function checkHubReachable(url: string): Promise<void> {
  try {
    await fetch(`${url}/api/mcp`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error('Could not reach a hub at that address.');
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getHubUrl()}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    setToken(null);
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  login: (password: string) => request<{ token: string }>('/login', { method: 'POST', body: JSON.stringify({ password }) }),
  loginWithEscanor: (accessToken: string) =>
    request<{ token: string; hubId: string }>('/login/escanor', { method: 'POST', body: JSON.stringify({ accessToken }) }),
  listMcp: () => request<{ servers: { name: string; url: string }[] }>('/mcp'),
  setEscanorMcp: (url: string, token: string) => request<{ ok: true }>('/mcp/escanor', { method: 'POST', body: JSON.stringify({ url, token }) }),
  removeEscanorMcp: () => request<{ ok: true }>('/mcp/escanor', { method: 'DELETE' }),
  listVms: () => request<VmDto[]>('/vms'),
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
