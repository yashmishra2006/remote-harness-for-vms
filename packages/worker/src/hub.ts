import { DurableObject } from 'cloudflare:workers';
import {
  agentSupportsMcp,
  parseMcpServerInput,
  toMcpServerDto,
  type AgentMcpStatus,
  type ApiTokenCreatedDto,
  type ApiTokenDto,
  type ApiTokenScope,
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
import {
  RateLimiter,
  clampLimit,
  isEffortLevel,
  isIdString,
  isPermissionBehavior,
  isPermissionMode,
  isWeakSecret,
  parseAgentFrame,
  parseNewSession,
  parseUserInput,
  redactSecrets,
  safeEqual,
} from '@remote-harness/shared/validate';
import type { Env } from './index';

const PROJECTS_REQUEST_TIMEOUT_MS = 5000;

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY_UNAUTHENTICATED = 16 * 1024;
const MAX_BODY_AUTHENTICATED = 20 * 1024 * 1024;
const DEFAULT_MESSAGE_LIMIT = 2000;
const MAX_MESSAGE_LIMIT = 10_000;
// A token minted for an integration is long-lived on purpose, but not forever.
const DEFAULT_API_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const MIN_TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
const SWEEP_INTERVAL_MS = 60_000;
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
  // Stops the approval card being framed (clickjacking) and blocks the markdown-image exfiltration channel.
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'; img-src 'self' data: blob: https://*.googleusercontent.com",
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
  private loginLimiter = new RateLimiter({ maxFailures: 10, windowMs: LOGIN_WINDOW_MS });

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
      -- A new chat starts under a temporary id and is re-keyed to Claude's real session id once it exists. The alias
      -- lets a caller that only ever learned the temporary id keep using it (same contract as the Node hub).
      CREATE TABLE IF NOT EXISTS session_aliases (
        old_id TEXT PRIMARY KEY,
        new_id TEXT NOT NULL
      );
    `);
    const cols = (this.sql.exec('PRAGMA table_info(api_tokens)').toArray() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('scope')) this.sql.exec("ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'");
    // NULL = no expiry: tokens issued before expiry existed keep working until revoked.
    if (!cols.includes('expires_at')) this.sql.exec('ALTER TABLE api_tokens ADD COLUMN expires_at TEXT');
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
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_message_at = excluded.last_message_at
       WHERE sessions.vm_id = excluded.vm_id`,
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

  // vmId scopes the update to the owning VM, so one agent can't touch another VM's session.
  private touchSession(id: string, status: string | undefined, vmId: string) {
    if (status) this.sql.exec('UPDATE sessions SET last_message_at = ?, status = ? WHERE id = ? AND vm_id = ?', this.now(), status, id, vmId);
    else this.sql.exec('UPDATE sessions SET last_message_at = ? WHERE id = ? AND vm_id = ?', this.now(), id, vmId);
  }

  private rekeySession(oldId: string, newId: string, vmId: string) {
    this.sql.exec('UPDATE messages SET session_id = ? WHERE session_id = ? AND vm_id = ?', newId, oldId, vmId);
    if (oldId !== newId) {
      this.sql.exec('INSERT INTO session_aliases (old_id, new_id) VALUES (?, ?) ON CONFLICT(old_id) DO UPDATE SET new_id = excluded.new_id', oldId, newId);
    }
  }

  private resolveSession(id: string): string {
    const row = this.sql.exec('SELECT new_id FROM session_aliases WHERE old_id = ?', id).toArray()[0] as { new_id: string } | undefined;
    return row?.new_id ?? id;
  }

  private insertMessage(m: { sessionId: string; vmId: string; message: unknown }) {
    this.sql.exec(
      'INSERT INTO messages (session_id, vm_id, payload, created_at) VALUES (?, ?, ?, ?)',
      m.sessionId,
      m.vmId,
      JSON.stringify(redactSecrets(m.message)),
      this.now(),
    );
  }

  // The most recent `limit` messages, oldest first, scoped to the VM.
  private listMessages(sessionId: string, vmId: string, limit: number): MessageDto[] {
    const rows = this.sql
      .exec(
        `SELECT id, session_id, vm_id, payload, created_at FROM (
           SELECT * FROM messages WHERE session_id = ? AND vm_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
        sessionId, vmId, limit,
      )
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

  /** What a bearer token is and may do, or null when it is unknown, expired or revoked. */
  private credentialForDigest(digest: string): { kind: 'login' | 'api'; scope: ApiTokenScope } | null {
    const a = this.sql.exec('SELECT created_at FROM auth_tokens WHERE token = ?', digest).toArray()[0] as { created_at: string } | undefined;
    const age = a ? Date.now() - Date.parse(a.created_at) : NaN;
    if (Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE_MS) return { kind: 'login', scope: 'full' };
    const b = this.sql.exec('SELECT scope, expires_at FROM api_tokens WHERE token = ?', digest).toArray()[0] as { scope: string; expires_at: string | null } | undefined;
    if (!b || (b.expires_at && b.expires_at <= this.now())) return null;
    return { kind: 'api', scope: b.scope === 'mcp' ? 'mcp' : 'full' };
  }
  private async credentialFor(token: string) {
    return token && token.length <= 512 ? this.credentialForDigest(await sessionDigest(token)) : null;
  }
  // A token limited to MCP management has no business receiving every transcript the hub broadcasts.
  private isStreamable(digest: string): boolean {
    return this.credentialForDigest(digest)?.scope === 'full';
  }
  private closeRevokedSessions() {
    for (const ws of this.ctx.getWebSockets('browser')) if (!this.isStreamable(ws.deserializeAttachment()?.sessionDigest ?? '')) ws.close(1008, 'Session expired or revoked');
  }
  private async revokeToken(token: string) {
    const digest = await sessionDigest(token);
    this.sql.exec('DELETE FROM auth_tokens WHERE token = ?', digest);
    this.sql.exec('DELETE FROM api_tokens WHERE token = ?', digest);
    this.closeRevokedSessions();
  }

  // Close sockets whose session expired even when nothing is being broadcast to them.
  async alarm(): Promise<void> {
    this.closeRevokedSessions();
    if (this.ctx.getWebSockets('browser').length > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
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
      if (!this.isStreamable(ws.deserializeAttachment()?.sessionDigest ?? '')) { ws.close(1008, 'Session expired or revoked'); continue; }
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
    // Fail closed: an unset, short or placeholder secret must never be satisfiable (`Bearer undefined`, an empty password).
    if (isWeakSecret(this.env.APP_PASSWORD) || isWeakSecret(this.env.HUB_AGENT_TOKEN)) return json({ error: 'Hub authentication is not securely configured' }, 503);
    const url = new URL(request.url);

    if (url.pathname === '/agent') {
      if (!safeEqual(request.headers.get('authorization'), `Bearer ${this.env.HUB_AGENT_TOKEN}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return this.acceptSocket('agent');
    }
    if (url.pathname === '/ws') {
      const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(v => v.trim());
      const credential = protocols.find(v => v.startsWith('escanor.auth.'));
      // The ?token= form puts the credential in the URL, where proxies and CDNs log it: only when the operator re-enables it.
      const token = credential ? credential.slice('escanor.auth.'.length) : this.env.HUB_ALLOW_QUERY_TOKEN === '1' ? url.searchParams.get('token') ?? '' : '';
      const cred = await this.credentialFor(token);
      if (!cred || cred.scope !== 'full') return new Response('Unauthorized', { status: 401 });
      void this.ctx.storage.getAlarm().then((at) => (at ? undefined : this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)));
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
    const msg = parseAgentFrame(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (!msg) return; // not JSON, not an object, or not a frame we know
    try {
      this.handleAgentFrame(ws, msg);
    } catch (err) {
      // One bad frame (or a storage failure) must not take the hub down.
      console.error('[agent] dropped frame after handler error:', err);
    }
  }

  private handleAgentFrame(ws: WebSocket, msg: AgentToHubMessage): void {
    const att = (ws.deserializeAttachment() ?? {}) as AgentAttachment;

    if (msg.type === 'hello') {
      // One socket speaks for exactly one VM.
      if (att.vmName && att.vmName !== msg.vmName) {
        ws.close(1008, 'hello identity changed');
        return;
      }
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
        this.touchSession(msg.sessionId, 'active', vmId);
        this.broadcast({ type: 'sdk_message', vmId, sessionId: msg.sessionId, tempId: msg.tempId, message: msg.message, createdAt: now });
        break;
      case 'session_created':
        this.rekeySession(msg.tempId, msg.sessionId, vmId);
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
        this.touchSession(msg.sessionId, 'idle', vmId);
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

  // Reads a JSON body with a hard size cap (Content-Length is advisory, so the text length is checked too).
  private async readJson(request: Request, limit: number): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > limit) {
      await request.body?.cancel().catch(() => undefined);
      return { ok: false, res: json({ error: 'Request body too large' }, 413) };
    }
    const text = await request.text();
    if (text.length > limit) return { ok: false, res: json({ error: 'Request body too large' }, 413) };
    try {
      return { ok: true, body: text ? JSON.parse(text) : {} };
    } catch {
      return { ok: false, res: json({ error: 'Bad request' }, 400) };
    }
  }

  private async handleApi(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;

    // ---- unauthenticated: a tiny body, and rate limited ----
    if (method === 'POST' && path === '/login') {
      // Cloudflare sets CF-Connecting-IP itself, so unlike X-Forwarded-For a client cannot spoof it.
      const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
      if (this.loginLimiter.blocked(key)) {
        return new Response(JSON.stringify({ error: 'Too many failed sign-in attempts. Try again later.' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': String(LOGIN_WINDOW_MS / 1000), ...CORS },
        });
      }
      const parsed = await this.readJson(request, MAX_BODY_UNAUTHENTICATED);
      if (!parsed.ok) return parsed.res;
      if (!safeEqual((parsed.body as any)?.password, this.env.APP_PASSWORD)) {
        this.loginLimiter.fail(key);
        return json({ error: 'Invalid password' }, 401);
      }
      this.loginLimiter.succeed(key);
      const token = crypto.randomUUID() + crypto.randomUUID();
      this.sql.exec('INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)', await sessionDigest(token), this.now());
      return json({ token });
    }

    // ---- everything else needs a valid credential before any body is read ----
    const header = request.headers.get('authorization') ?? '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    const cred = await this.credentialFor(bearerToken);
    if (!cred) {
      // Never read an unauthenticated body, but do release it: answering while a large upload is still streaming in makes the runtime fail the request.
      await request.body?.cancel().catch(() => undefined);
      return json({ error: 'Unauthorized' }, 401);
    }

    // A token issued for MCP management (what Escanor gets) can manage the MCP registry and nothing else: it cannot start sessions,
    // answer permission cards or change a permission mode. A leak of it must not be code execution on every VM.
    if (cred.scope === 'mcp' && !(path === '/mcp-servers' || path.startsWith('/mcp-servers/'))) {
      await request.body?.cancel().catch(() => undefined);
      return json({ error: 'This token is limited to managing MCP servers.' }, 403);
    }

    let body: unknown = {};
    if (method === 'POST' || method === 'PUT') {
      const parsed = await this.readJson(request, MAX_BODY_AUTHENTICATED);
      if (!parsed.ok) return parsed.res;
      body = parsed.body;
    }

    // %-escapes in a path segment are untrusted input: a malformed one is a bad request, not a 500.
    const decode = (v: string): string | null => {
      try {
        return decodeURIComponent(v);
      } catch {
        return null;
      }
    };

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
      await this.revokeToken(bearerToken);
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/tokens') {
      // Only a signed-in browser session can mint one: a token that could mint more would let a leaked integration token keep
      // itself alive forever.
      if (cred.kind !== 'login') return json({ error: 'Only a signed-in session can create tokens.' }, 403);
      const b = (body ?? {}) as { label?: unknown; scope?: unknown; ttlSeconds?: unknown };
      const label = String(b.label ?? '').trim().slice(0, 60) || 'API token';
      const scope = b.scope ?? 'full';
      if (scope !== 'full' && scope !== 'mcp') return json({ error: 'scope must be "full" or "mcp"' }, 400);
      const ttl = b.ttlSeconds;
      if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < MIN_TOKEN_TTL_SECONDS || ttl > MAX_TOKEN_TTL_SECONDS)) {
        return json({ error: `ttlSeconds must be between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}` }, 400);
      }
      const expiresAt = new Date(Date.now() + (ttl ?? DEFAULT_API_TOKEN_TTL_SECONDS) * 1000).toISOString();
      const created: ApiTokenCreatedDto = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID() + crypto.randomUUID(),
        label,
        createdAt: this.now(),
        scope: scope as ApiTokenScope,
        expiresAt,
      };
      this.sql.exec('INSERT INTO api_tokens (id, token, label, created_at, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)', created.id, await sessionDigest(created.token), created.label, created.createdAt, scope, expiresAt);
      return json(created, 201);
    }
    if (method === 'GET' && path === '/tokens') {
      const rows = this.sql.exec('SELECT id, label, created_at, scope, expires_at FROM api_tokens ORDER BY created_at DESC').toArray() as {
        id: string;
        label: string;
        created_at: string;
        scope: string;
        expires_at: string | null;
      }[];
      return json(rows.map((r): ApiTokenDto => ({ id: r.id, label: r.label, createdAt: r.created_at, scope: r.scope === 'mcp' ? 'mcp' : 'full', expiresAt: r.expires_at })));
    }
    let tok: RegExpMatchArray | null;
    if (method === 'DELETE' && (tok = path.match(/^\/tokens\/([^/]+)$/))) {
      const id = decode(tok[1]);
      if (id === null) return json({ error: 'Bad request' }, 400);
      const exists = this.sql.exec('SELECT 1 FROM api_tokens WHERE id = ?', id).toArray().length > 0;
      if (exists) this.sql.exec('DELETE FROM api_tokens WHERE id = ?', id);
      this.closeRevokedSessions();
      return json({ ok: exists }, exists ? 200 : 404);
    }

    let mcp: RegExpMatchArray | null;
    if ((mcp = path.match(/^\/mcp-servers\/([^/]+)$/))) {
      const name = decode(mcp[1]);
      if (name === null) return json({ error: 'Bad request' }, 400);
      if (method === 'PUT') {
        const existing = this.listMcpServers().find((x) => x.name === name);
        const parsed = parseMcpServerInput(name, body, { existing, allowPrivate: this.env.HUB_MCP_ALLOW_PRIVATE === '1' });
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
      const limit = clampLimit(url.searchParams.get('limit') ?? undefined, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
      return json(this.listMessages(this.resolveSession(m[2]), m[1], limit));
    }

    // Refuse before storing or broadcasting anything, so an offline VM can't leave a message in the history that was never delivered.
    const notConnected = (vmId: string) => (this.agentFor(vmId) ? null : json({ error: 'VM not connected' }, 503));
    const userMessage = (text: string, images: ImageAttachment[] | undefined) => ({ type: 'user', local: true, message: { role: 'user', content: contentBlocks(text, images) } });

    if (method === 'POST' && (m = path.match(/^\/vms\/([^/]+)\/sessions$/))) {
      const vmId = m[1];
      const parsed = parseNewSession(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const offline = notConnected(vmId);
      if (offline) return offline;
      const { text, images, cwd, accountId } = parsed.value;
      const tempId = crypto.randomUUID();
      const localMessage = userMessage(text, images);
      this.insertMessage({ sessionId: tempId, vmId, message: localMessage });
      this.broadcast({ type: 'sdk_message', vmId, sessionId: tempId, message: localMessage, createdAt: this.now() });
      const delivered = this.sendToVm(vmId, { type: 'user_input', sessionId: tempId, tempId, cwd, accountId, text, images });
      if (!delivered) return json({ error: 'VM not connected' }, 503);
      return json({ tempId }, 202);
    }

    if ((m = path.match(/^\/vms\/([^/]+)\/sessions\/([^/]+)\/([a-z-]+)$/)) && method === 'POST') {
      const vmId = m[1];
      const sessionId = this.resolveSession(m[2]);
      const action = m[3];
      const b = (body ?? {}) as any;
      switch (action) {
        case 'messages': {
          const parsed = parseUserInput(body);
          if (!parsed.ok) return json({ error: parsed.error }, 400);
          const offline = notConnected(vmId);
          if (offline) return offline;
          const { text, images } = parsed.value;
          const localMessage = userMessage(text, images);
          this.insertMessage({ sessionId, vmId, message: localMessage });
          this.touchSession(sessionId, 'active', vmId);
          this.broadcast({ type: 'sdk_message', vmId, sessionId, message: localMessage, createdAt: this.now() });
          const delivered = this.sendToVm(vmId, { type: 'user_input', sessionId, text, images });
          return delivered ? json({ ok: true }, 202) : json({ error: 'VM not connected' }, 503);
        }
        case 'interrupt':
          return this.deliver(this.sendToVm(vmId, { type: 'interrupt', sessionId }));
        case 'model':
          if (b.model !== undefined && b.model !== null && (typeof b.model !== 'string' || b.model.length > 200)) return json({ error: 'model must be a string' }, 400);
          return this.deliver(this.sendToVm(vmId, { type: 'set_model', sessionId, model: b.model || undefined }));
        case 'effort':
          if (b.effort !== undefined && b.effort !== null && b.effort !== '' && !isEffortLevel(b.effort)) return json({ error: 'invalid effort level' }, 400);
          return this.deliver(this.sendToVm(vmId, { type: 'set_effort', sessionId, effort: b.effort || null }));
        case 'permission-mode':
          if (!isPermissionMode(b.mode)) return json({ error: 'invalid permission mode' }, 400);
          return this.deliver(this.sendToVm(vmId, { type: 'set_permission_mode', sessionId, mode: b.mode }));
        case 'permission-response': {
          if (!isIdString(b.requestId) || !isPermissionBehavior(b.behavior) || (b.message !== undefined && (typeof b.message !== 'string' || b.message.length > 4000))) {
            return json({ error: 'requestId and behavior (allow|deny) required' }, 400);
          }
          const delivered = this.sendToVm(vmId, { type: 'permission_response', requestId: b.requestId, behavior: b.behavior, message: b.message });
          // Only announce "resolved" if the agent actually received the answer.
          if (delivered) this.broadcast({ type: 'permission_resolved', vmId, sessionId, requestId: b.requestId });
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
