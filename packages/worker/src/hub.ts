import { DurableObject } from 'cloudflare:workers';
import {
  agentSupportsMcp,
  parseMcpServerInput,
  toMcpServerDto,
  type AgentMcpStatus,
  type ApiTokenCreatedDto,
  type ApiTokenDto,
  type AgentToHubMessage,
  type ClaudeAccount,
  type HubToAgentMessage,
  type HubToBrowserMessage,
  type ImageAttachment,
  type ManagedMcpServer,
  type McpOverviewDto,
  type McpPutResultDto,
  type MessageDto,
  type SessionDto,
} from '@remote-harness/shared';
import type { Env } from './index';

const PROJECTS_REQUEST_TIMEOUT_MS = 5000;

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
async function sessionDigest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `sha256:${Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type AgentAttachment = { vmId?: string; vmName?: string };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

function contentBlocks(text: string, images: ImageAttachment[] | undefined) {
  const blocks: Record<string, unknown>[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const img of images ?? []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
  }
  return blocks;
}

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  private pendingProjects = new Map<string, (projects: string[]) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vms (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        last_seen_at TEXT,
        accounts_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        status TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        name TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vm_agent_version (
        vm_id TEXT PRIMARY KEY,
        version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vm_mcp_status (
        vm_id TEXT PRIMARY KEY,
        status_json TEXT NOT NULL,
        reported_at TEXT NOT NULL
      );
    `);
    // Answered by the runtime without waking the object, so idle browser tabs stay connected cheaply.
    ctx.blockConcurrencyWhile(async () => {
      for (const table of ['auth_tokens', 'api_tokens']) {
        for (const row of this.sql.exec(`SELECT token FROM ${table}`).toArray() as { token: string }[]) {
          if (!row.token.startsWith('sha256:')) this.sql.exec(`UPDATE ${table} SET token = ? WHERE token = ?`, await sessionDigest(row.token), row.token);
        }
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---------- database ----------

  private now = () => new Date().toISOString();

  private upsertVm(name: string): string {
    const existing = this.sql.exec('SELECT id FROM vms WHERE name = ?', name).toArray()[0] as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO vms (id, name, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      id,
      name,
      this.now(),
    );
    return id;
  }

  private touchVmSeen(id: string) {
    this.sql.exec('UPDATE vms SET last_seen_at = ? WHERE id = ?', this.now(), id);
  }

  private setVmAccounts(id: string, accounts: ClaudeAccount[]) {
    this.sql.exec('UPDATE vms SET accounts_json = ? WHERE id = ?', JSON.stringify(accounts), id);
  }

  private getVmAccounts(id: string): ClaudeAccount[] {
    const row = this.sql.exec('SELECT accounts_json FROM vms WHERE id = ?', id).toArray()[0] as
      | { accounts_json: string }
      | undefined;
    return row ? JSON.parse(row.accounts_json) : [];
  }

  private upsertSession(s: { id: string; vmId: string; cwd: string; title: string; status: string; accountId: string }) {
    const now = this.now();
    this.sql.exec(
      `INSERT INTO sessions (id, vm_id, cwd, title, created_at, last_message_at, status, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_message_at = excluded.last_message_at`,
      s.id,
      s.vmId,
      s.cwd,
      s.title,
      now,
      now,
      s.status,
      s.accountId,
    );
  }

  private touchSession(id: string, status?: string) {
    if (status) this.sql.exec('UPDATE sessions SET last_message_at = ?, status = ? WHERE id = ?', this.now(), status, id);
    else this.sql.exec('UPDATE sessions SET last_message_at = ? WHERE id = ?', this.now(), id);
  }

  private insertMessage(m: { sessionId: string; vmId: string; message: unknown }) {
    this.sql.exec(
      'INSERT INTO messages (session_id, vm_id, payload, created_at) VALUES (?, ?, ?, ?)',
      m.sessionId,
      m.vmId,
      JSON.stringify(m.message),
      this.now(),
    );
  }

  private listMessages(sessionId: string): MessageDto[] {
    const rows = this.sql
      .exec('SELECT id, session_id, vm_id, payload, created_at FROM messages WHERE session_id = ? ORDER BY id ASC', sessionId)
      .toArray() as { id: number; session_id: string; vm_id: string; payload: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      vmId: r.vm_id,
      createdAt: r.created_at,
      message: JSON.parse(r.payload),
    }));
  }

  private listMcpServers(): ManagedMcpServer[] {
    const rows = this.sql.exec('SELECT config_json FROM mcp_servers ORDER BY name').toArray() as { config_json: string }[];
    return rows.map((r) => JSON.parse(r.config_json) as ManagedMcpServer);
  }

  private putMcpServer(server: Omit<ManagedMcpServer, 'updatedAt'>): ManagedMcpServer {
    const stored: ManagedMcpServer = { ...server, updatedAt: this.now() };
    this.sql.exec(
      `INSERT INTO mcp_servers (name, config_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      stored.name,
      JSON.stringify(stored),
      stored.updatedAt,
    );
    return stored;
  }

  private deleteMcpServer(name: string): boolean {
    const exists = this.sql.exec('SELECT 1 FROM mcp_servers WHERE name = ?', name).toArray().length > 0;
    if (exists) this.sql.exec('DELETE FROM mcp_servers WHERE name = ?', name);
    return exists;
  }

  private setVmMcpStatus(vmId: string, status: Pick<AgentMcpStatus, 'servers' | 'liveSessions'>) {
    this.sql.exec(
      `INSERT INTO vm_mcp_status (vm_id, status_json, reported_at) VALUES (?, ?, ?)
       ON CONFLICT(vm_id) DO UPDATE SET status_json = excluded.status_json, reported_at = excluded.reported_at`,
      vmId,
      JSON.stringify(status),
      this.now(),
    );
  }

  private getVmMcpStatus(vmId: string): { servers: AgentMcpStatus['servers']; liveSessions: number; reportedAt: string } | null {
    const row = this.sql.exec('SELECT status_json, reported_at FROM vm_mcp_status WHERE vm_id = ?', vmId).toArray()[0] as
      | { status_json: string; reported_at: string }
      | undefined;
    return row ? { ...JSON.parse(row.status_json), reportedAt: row.reported_at } : null;
  }

  // Push the complete set to every connected agent; a VM that is offline converges on its next hello.
  private pushMcpServers() {
    const servers = this.listMcpServers();
    for (const { att } of this.agentSockets()) {
      if (att.vmId) this.sendToVm(att.vmId, { type: 'set_mcp_servers', servers });
    }
  }

  private async isValidToken(token: string): Promise<boolean> {
    return Boolean(token) && token.length <= 512 && this.isValidDigest(await sessionDigest(token));
  }
  private isValidDigest(digest: string): boolean {
    const row = this.sql.exec('SELECT created_at FROM auth_tokens WHERE token = ?', digest).toArray()[0] as { created_at: string } | undefined;
    const age = row ? Date.now() - Date.parse(row.created_at) : NaN;
    return (Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE_MS) || this.sql.exec('SELECT 1 FROM api_tokens WHERE token = ?', digest).toArray().length > 0;
  }
  private closeRevokedSessions() {
    for (const ws of this.ctx.getWebSockets('browser')) if (!this.isValidDigest(ws.deserializeAttachment()?.sessionDigest ?? '')) ws.close(1008, 'Session expired or revoked');
  }
  private async revokeToken(token: string) {
    const digest = await sessionDigest(token);
    this.sql.exec('DELETE FROM auth_tokens WHERE token = ?', digest);
    this.sql.exec('DELETE FROM api_tokens WHERE token = ?', digest);
    this.closeRevokedSessions();
  }

  private getVmAgentVersion(vmId: string): string | null {
    const row = this.sql.exec('SELECT version FROM vm_agent_version WHERE vm_id = ?', vmId).toArray()[0] as { version: string } | undefined;
    return row?.version ?? null;
  }

  // ---------- sockets ----------

  private agentSockets(): { ws: WebSocket; att: AgentAttachment }[] {
    return this.ctx.getWebSockets('agent').map((ws) => ({ ws, att: (ws.deserializeAttachment() ?? {}) as AgentAttachment }));
  }

  private agentFor(vmId: string): WebSocket | undefined {
    return this.agentSockets().find((a) => a.att.vmId === vmId)?.ws;
  }

  private sendToVm(vmId: string, msg: HubToAgentMessage): boolean {
    const ws = this.agentFor(vmId);
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private broadcast(msg: HubToBrowserMessage) {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets('browser')) {
      if (!this.isValidDigest(ws.deserializeAttachment()?.sessionDigest ?? '')) { ws.close(1008, 'Session expired or revoked'); continue; }
      try {
        ws.send(payload);
      } catch {
        // socket is closing; it will be dropped on its close event
      }
    }
  }

  private requestProjects(vmId: string): Promise<string[]> {
    const ws = this.agentFor(vmId);
    if (!ws) return Promise.resolve([]);
    const requestId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'list_projects', requestId }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProjects.delete(requestId);
        resolve([]);
      }, PROJECTS_REQUEST_TIMEOUT_MS);
      this.pendingProjects.set(requestId, (projects) => {
        clearTimeout(timer);
        resolve(projects);
      });
    });
  }

  // ---------- HTTP / upgrade entry ----------

  async fetch(request: Request): Promise<Response> {
    if (!this.env.APP_PASSWORD || this.env.APP_PASSWORD.length < 24 || !this.env.HUB_AGENT_TOKEN || this.env.HUB_AGENT_TOKEN.length < 24) return json({ error: 'Hub authentication is not securely configured' }, 503);
    const url = new URL(request.url);

    if (url.pathname === '/agent') {
      if (request.headers.get('authorization') !== `Bearer ${this.env.HUB_AGENT_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return this.acceptSocket('agent');
    }
    if (url.pathname === '/ws') {
      const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(v => v.trim());
      const credential = protocols.find(v => v.startsWith('escanor.auth.'));
      const token = credential ? credential.slice('escanor.auth.'.length) : url.searchParams.get('token') ?? '';
      if (!await this.isValidToken(token)) return new Response('Unauthorized', { status: 401 });
      return this.acceptSocket('browser', await sessionDigest(token), protocols.includes('escanor.hub.v1'));
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    return this.handleApi(request, url);
  }

  private acceptSocket(tag: 'agent' | 'browser', digest?: string, browserProtocol = false): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag]);
    if (digest) pair[1].serializeAttachment({ sessionDigest: digest });
    return new Response(null, { status: 101, webSocket: pair[0], headers: browserProtocol ? { 'Sec-WebSocket-Protocol': 'escanor.hub.v1' } : {} });
  }

  // ---------- agent -> hub ----------

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (!this.ctx.getTags(ws).includes('agent')) return; // browsers only send pings (auto-answered)
    let msg: AgentToHubMessage;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }

    const att = (ws.deserializeAttachment() ?? {}) as AgentAttachment;

    if (msg.type === 'hello') {
      const vmId = this.upsertVm(msg.vmName);
      for (const other of this.agentSockets()) {
        if (other.ws !== ws && other.att.vmId === vmId) other.ws.close(1000, 'replaced by newer connection');
      }
      ws.serializeAttachment({ vmId, vmName: msg.vmName } satisfies AgentAttachment);
      this.setVmAccounts(vmId, msg.accounts);
      this.sql.exec(
        `INSERT INTO vm_agent_version (vm_id, version) VALUES (?, ?)
         ON CONFLICT(vm_id) DO UPDATE SET version = excluded.version`,
        vmId,
        String(msg.agentVersion ?? ''),
      );
      for (const s of msg.sessions) {
        this.upsertSession({ id: s.sessionId, vmId, cwd: s.cwd, title: s.title, status: s.status, accountId: s.accountId });
      }
      this.touchVmSeen(vmId);
      this.broadcast({ type: 'vm_status', vmId, name: msg.vmName, connected: true, accounts: this.getVmAccounts(vmId) });
      this.sendToVm(vmId, { type: 'set_mcp_servers', servers: this.listMcpServers() });
      return;
    }

    const vmId = att.vmId;
    if (!vmId) return; // must hello first

    if (msg.type === 'projects_list') {
      const resolve = this.pendingProjects.get(msg.requestId);
      if (resolve) {
        this.pendingProjects.delete(msg.requestId);
        resolve(msg.projects);
      }
      return;
    }

    const now = this.now();
    switch (msg.type) {
      case 'mcp_status':
        this.setVmMcpStatus(vmId, { servers: msg.servers, liveSessions: msg.liveSessions });
        break;
      case 'sdk_message':
        this.insertMessage({ sessionId: msg.sessionId, vmId, message: msg.message });
        this.touchSession(msg.sessionId, 'active');
        this.broadcast({ type: 'sdk_message', vmId, sessionId: msg.sessionId, tempId: msg.tempId, message: msg.message, createdAt: now });
        break;
      case 'session_created':
        this.sql.exec('UPDATE messages SET session_id = ? WHERE session_id = ?', msg.sessionId, msg.tempId);
        this.upsertSession({ id: msg.sessionId, vmId, cwd: msg.cwd, title: msg.title, status: 'active', accountId: msg.accountId });
        this.broadcast({
          type: 'session_created',
          vmId,
          tempId: msg.tempId,
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          title: msg.title,
          accountId: msg.accountId,
        });
        break;
      case 'session_ended':
        this.touchSession(msg.sessionId, 'idle');
        this.broadcast({ type: 'session_ended', vmId, sessionId: msg.sessionId });
        break;
      case 'permission_request':
        this.insertMessage({
          sessionId: msg.sessionId,
          vmId,
          message: {
            type: 'permission_request',
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            blockedPath: msg.blockedPath,
          },
        });
        this.broadcast({
          type: 'permission_request',
          vmId,
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          toolName: msg.toolName,
          input: msg.input,
          blockedPath: msg.blockedPath,
        });
        break;
      case 'error': {
        const sessionId = msg.sessionId ?? msg.tempId ?? 'unknown';
        console.error(`[agent ${vmId}]`, msg.message);
        this.insertMessage({ sessionId, vmId, message: { type: 'error', message: msg.message } });
        this.broadcast({
          type: 'sdk_message',
          vmId,
          sessionId,
          tempId: msg.tempId,
          message: { type: 'error', message: msg.message },
          createdAt: now,
        });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onSocketGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    if (!this.ctx.getTags(ws).includes('agent')) return;
    const att = (ws.deserializeAttachment() ?? {}) as AgentAttachment;
    if (!att.vmId || !att.vmName) return;
    // A reconnect may already have replaced this socket; only report offline if no other one is live.
    const stillConnected = this.agentSockets().some((a) => a.ws !== ws && a.att.vmId === att.vmId);
    if (stillConnected) return;
    this.touchVmSeen(att.vmId);
    this.broadcast({ type: 'vm_status', vmId: att.vmId, name: att.vmName, connected: false, accounts: this.getVmAccounts(att.vmId) });
  }

  // ---------- REST API ----------

  private async handleApi(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;
    const body = method === 'POST' || method === 'PUT' ? await request.json().catch(() => ({})) : {};

    if (method === 'POST' && path === '/login') {
      if ((body as any)?.password !== this.env.APP_PASSWORD) return json({ error: 'Invalid password' }, 401);
      const token = crypto.randomUUID() + crypto.randomUUID();
      this.sql.exec('INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)', await sessionDigest(token), this.now());
      return json({ token });
    }

    const header = request.headers.get('authorization') ?? '';
    if (!await this.isValidToken(header.startsWith('Bearer ') ? header.slice(7) : '')) return json({ error: 'Unauthorized' }, 401);

    if (method === 'GET' && path === '/mcp-servers') {
      const overview: McpOverviewDto = {
        servers: this.listMcpServers().map(toMcpServerDto),
        vms: (this.sql.exec('SELECT id, name FROM vms ORDER BY name').toArray() as { id: string; name: string }[]).map((v) => {
          const status = this.getVmMcpStatus(v.id);
          return {
            vmId: v.id,
            name: v.name,
            connected: Boolean(this.agentFor(v.id)),
            agentVersion: this.getVmAgentVersion(v.id),
            mcpSupported: agentSupportsMcp(this.getVmAgentVersion(v.id)),
            reportedAt: status?.reportedAt ?? null,
            servers: status?.servers ?? [],
            liveSessions: status?.liveSessions ?? 0,
          };
        }),
      };
      return json(overview);
    }

    // ---- tokens (same behaviour as the Node hub) ----
    if (method === 'POST' && path === '/logout') {
      await this.revokeToken(header.startsWith('Bearer ') ? header.slice(7) : '');
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/tokens') {
      const label = String((body as any)?.label ?? '').trim().slice(0, 60) || 'API token';
      const created: ApiTokenCreatedDto = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID() + crypto.randomUUID(),
        label,
        createdAt: this.now(),
      };
      this.sql.exec('INSERT INTO api_tokens (id, token, label, created_at) VALUES (?, ?, ?, ?)', created.id, await sessionDigest(created.token), created.label, created.createdAt);
      return json(created, 201);
    }
    if (method === 'GET' && path === '/tokens') {
      const rows = this.sql.exec('SELECT id, label, created_at FROM api_tokens ORDER BY created_at DESC').toArray() as {
        id: string;
        label: string;
        created_at: string;
      }[];
      return json(rows.map((r): ApiTokenDto => ({ id: r.id, label: r.label, createdAt: r.created_at })));
    }
    let tok: RegExpMatchArray | null;
    if (method === 'DELETE' && (tok = path.match(/^\/tokens\/([^/]+)$/))) {
      const id = decodeURIComponent(tok[1]);
      const exists = this.sql.exec('SELECT 1 FROM api_tokens WHERE id = ?', id).toArray().length > 0;
      if (exists) this.sql.exec('DELETE FROM api_tokens WHERE id = ?', id);
      this.closeRevokedSessions();
      return json({ ok: exists }, exists ? 200 : 404);
    }

    let mcp: RegExpMatchArray | null;
    if ((mcp = path.match(/^\/mcp-servers\/([^/]+)$/))) {
      const name = decodeURIComponent(mcp[1]);
      if (method === 'PUT') {
        const parsed = parseMcpServerInput(name, body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const server = this.putMcpServer(parsed.server);
        this.pushMcpServers();
        const vmsTotal = (this.sql.exec('SELECT COUNT(*) AS n FROM vms').toArray()[0] as { n: number }).n;
        const result: McpPutResultDto = { server: toMcpServerDto(server), vmsConnected: new Set(this.agentSockets().map((a) => a.att.vmId).filter(Boolean)).size, vmsTotal };
        return json(result);
      }
      if (method === 'DELETE') {
        const removed = this.deleteMcpServer(name);
        if (removed) this.pushMcpServers();
        return json({ ok: removed }, removed ? 200 : 404);
      }
    }

    if (method === 'GET' && path === '/vms') {
      const rows = this.sql
        .exec('SELECT id, name, last_seen_at, accounts_json FROM vms ORDER BY name')
        .toArray() as { id: string; name: string; last_seen_at: string | null; accounts_json: string }[];
      return json(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          lastSeenAt: r.last_seen_at,
          accounts: JSON.parse(r.accounts_json),
          connected: Boolean(this.agentFor(r.id)),
        })),
      );
    }

    let m: RegExpMatchArray | null;

    if (method === 'GET' && (m = path.match(/^\/vms\/([^/]+)\/sessions$/))) {
      const rows = this.sql
        .exec(
          `SELECT id, vm_id, cwd, title, created_at, last_message_at, status, account_id
           FROM sessions WHERE vm_id = ? ORDER BY last_message_at DESC`,
          m[1],
        )
        .toArray() as any[];
      const sessions: SessionDto[] = rows.map((r) => ({
        id: r.id,
        vmId: r.vm_id,
        cwd: r.cwd,
        title: r.title,
        createdAt: r.created_at,
        lastMessageAt: r.last_message_at,
        status: r.status,
        accountId: r.account_id,
      }));
      return json(sessions);
    }

    if (method === 'GET' && (m = path.match(/^\/vms\/([^/]+)\/projects$/))) {
      return json(await this.requestProjects(m[1]));
    }

    if (method === 'GET' && (m = path.match(/^\/vms\/([^/]+)\/sessions\/([^/]+)\/messages$/))) {
      return json(this.listMessages(m[2]));
    }

    if (method === 'POST' && (m = path.match(/^\/vms\/([^/]+)\/sessions$/))) {
      const vmId = m[1];
      const { cwd, text, images, accountId } = body as any;
      if (!text && !(images?.length > 0)) return json({ error: 'text or images required' }, 400);
      const tempId = crypto.randomUUID();
      const localMessage = { type: 'user', local: true, message: { role: 'user', content: contentBlocks(text ?? '', images) } };
      this.insertMessage({ sessionId: tempId, vmId, message: localMessage });
      this.broadcast({ type: 'sdk_message', vmId, sessionId: tempId, message: localMessage, createdAt: this.now() });
      const delivered = this.sendToVm(vmId, { type: 'user_input', sessionId: tempId, tempId, cwd, accountId, text: text ?? '', images });
      if (!delivered) return json({ error: 'VM not connected' }, 503);
      return json({ tempId }, 202);
    }

    if ((m = path.match(/^\/vms\/([^/]+)\/sessions\/([^/]+)\/([a-z-]+)$/)) && method === 'POST') {
      const [, vmId, sessionId, action] = m;
      const b = body as any;
      switch (action) {
        case 'messages': {
          if (!b.text && !(b.images?.length > 0)) return json({ error: 'text or images required' }, 400);
          const localMessage = { type: 'user', local: true, message: { role: 'user', content: contentBlocks(b.text ?? '', b.images) } };
          this.insertMessage({ sessionId, vmId, message: localMessage });
          this.touchSession(sessionId, 'active');
          this.broadcast({ type: 'sdk_message', vmId, sessionId, message: localMessage, createdAt: this.now() });
          const delivered = this.sendToVm(vmId, { type: 'user_input', sessionId, text: b.text ?? '', images: b.images });
          return delivered ? json({ ok: true }, 202) : json({ error: 'VM not connected' }, 503);
        }
        case 'interrupt':
          return this.deliver(this.sendToVm(vmId, { type: 'interrupt', sessionId }));
        case 'model':
          return this.deliver(this.sendToVm(vmId, { type: 'set_model', sessionId, model: b.model || undefined }));
        case 'effort':
          return this.deliver(this.sendToVm(vmId, { type: 'set_effort', sessionId, effort: b.effort || null }));
        case 'permission-mode':
          return this.deliver(this.sendToVm(vmId, { type: 'set_permission_mode', sessionId, mode: b.mode }));
        case 'permission-response': {
          const delivered = this.sendToVm(vmId, {
            type: 'permission_response',
            requestId: b.requestId,
            behavior: b.behavior,
            message: b.message,
          });
          this.broadcast({ type: 'permission_resolved', vmId, sessionId, requestId: b.requestId });
          return this.deliver(delivered);
        }
      }
    }

    return json({ error: 'Not found' }, 404);
  }

  private deliver(delivered: boolean): Response {
    return json({ ok: delivered }, delivered ? 202 : 503);
  }
}
