import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentMcpStatus, ApiTokenDto, ClaudeAccount, ManagedMcpServer, MessageDto, SessionDto, VmDto } from '@remote-harness/shared';

// Everything a hub stores belongs to a tenant. A hub run the classic way has exactly one, 'default',
// whose credentials are HUB_AGENT_TOKEN and APP_PASSWORD. A hub that also sets HUB_ADMIN_TOKEN can
// mint more: each gets its own agent token and API tokens, and can never see another's VMs, chats,
// MCP servers or tokens. Isolation is enforced here, in the queries, not left to callers to remember.
export const DEFAULT_TENANT = 'default';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sessionDigest = (s: string) => `sha256:${sha256(s)}`;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const newSecret = () => randomBytes(32).toString('base64url');

export type TenantDto = { id: string; label: string; createdAt: string };

/** What a machine-scoped credential is limited to. */
export type MachineScope = { tenantId: string; vmName: string; expiresAt: string };

/** A machine's name is an identifier, not free text: it ends up in URLs, log lines and prompts. */
export const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

function migrate(db: DatabaseSync) {
  // Databases from before tenants existed hold exactly one tenant's data: it becomes 'default'.
  if (hasColumn(db, 'vms', 'id') && !hasColumn(db, 'vms', 'tenant_id')) {
    db.exec(`
      CREATE TABLE vms_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        name TEXT NOT NULL,
        last_seen_at TEXT,
        accounts_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE (tenant_id, name)
      );
      INSERT INTO vms_new (id, name, last_seen_at, accounts_json) SELECT id, name, last_seen_at, accounts_json FROM vms;
      DROP TABLE vms;
      ALTER TABLE vms_new RENAME TO vms;
    `);
  }
  for (const table of ['sessions', 'messages', 'auth_tokens', 'api_tokens']) {
    if (hasColumn(db, table, 'created_at') && !hasColumn(db, table, 'tenant_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}'`);
    }
  }
  if (hasColumn(db, 'mcp_servers', 'name') && !hasColumn(db, 'mcp_servers', 'tenant_id')) {
    db.exec(`
      CREATE TABLE mcp_servers_new (
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );
      INSERT INTO mcp_servers_new (name, config_json, updated_at) SELECT name, config_json, updated_at FROM mcp_servers;
      DROP TABLE mcp_servers;
      ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
    `);
  }
}

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'hub.sqlite'));

  // Tables that predate tenants are created in their old shape first, so `migrate` has one path to handle.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      agent_token_hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_aliases (
      tenant_id TEXT NOT NULL,
      old_id TEXT NOT NULL,
      new_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, old_id)
    );
    CREATE TABLE IF NOT EXISTS vm_agent_version (
      vm_id TEXT PRIMARY KEY,
      version TEXT NOT NULL
    );
    -- Credentials for one machine of a tenant (an incident's), and nothing else. Only hashes are kept.
    CREATE TABLE IF NOT EXISTS machine_credentials (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      label TEXT NOT NULL,
      agent_hash TEXT UNIQUE NOT NULL,
      api_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, vm_name)
    );
    CREATE TABLE IF NOT EXISTS vm_mcp_status (
      vm_id TEXT PRIMARY KEY,
      status_json TEXT NOT NULL,
      reported_at TEXT NOT NULL
    );
  `);
  const hasOldVms = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vms'").get());
  if (!hasOldVms) {
    db.exec(`
      CREATE TABLE vms (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        name TEXT NOT NULL,
        last_seen_at TEXT,
        accounts_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE (tenant_id, name)
      );
    `);
  }
  const hasOldMcp = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_servers'").get());
  if (!hasOldMcp) {
    db.exec(`
      CREATE TABLE mcp_servers (
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );
    `);
  }
  migrate(db);
  for (const table of ['auth_tokens', 'api_tokens']) {
    for (const row of db.prepare(`SELECT token FROM ${table}`).all() as { token: string }[]) {
      if (!row.token.startsWith('sha256:')) db.prepare(`UPDATE ${table} SET token = ? WHERE token = ?`).run(sessionDigest(row.token), row.token);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_session ON messages(tenant_id, session_id, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_vm ON sessions(tenant_id, vm_id);
  `);

  /** The data of one tenant. Every statement is filtered by `t`; there is no unscoped read of tenant data. */
  function scoped(t: string) {
    return {
      tenantId: t,

      upsertVm(name: string): string {
        const existing = db.prepare('SELECT id FROM vms WHERE tenant_id = ? AND name = ?').get(t, name) as { id: string } | undefined;
        const id = existing?.id ?? randomUUID();
        db.prepare(
          `INSERT INTO vms (id, tenant_id, name, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id, name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        ).run(id, t, name, new Date().toISOString());
        return id;
      },

      hasVm(id: string): boolean {
        return Boolean(db.prepare('SELECT 1 FROM vms WHERE tenant_id = ? AND id = ?').get(t, id));
      },

      touchVmSeen(id: string): void {
        db.prepare('UPDATE vms SET last_seen_at = ? WHERE tenant_id = ? AND id = ?').run(new Date().toISOString(), t, id);
      },

      setVmAccounts(id: string, accounts: ClaudeAccount[]): void {
        db.prepare('UPDATE vms SET accounts_json = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(accounts), t, id);
      },

      listVms(): Omit<VmDto, 'connected'>[] {
        const rows = db
          .prepare('SELECT id, name, last_seen_at as lastSeenAt, accounts_json as accountsJson FROM vms WHERE tenant_id = ? ORDER BY name')
          .all(t) as { id: string; name: string; lastSeenAt: string | null; accountsJson: string }[];
        return rows.map((r) => ({ id: r.id, name: r.name, lastSeenAt: r.lastSeenAt, accounts: JSON.parse(r.accountsJson) }));
      },

      getVmName(id: string): string | undefined {
        const row = db.prepare('SELECT name FROM vms WHERE tenant_id = ? AND id = ?').get(t, id) as { name: string } | undefined;
        return row?.name;
      },

      getVmAccounts(id: string): ClaudeAccount[] {
        const row = db.prepare('SELECT accounts_json as accountsJson FROM vms WHERE tenant_id = ? AND id = ?').get(t, id) as
          | { accountsJson: string }
          | undefined;
        return row ? JSON.parse(row.accountsJson) : [];
      },

      upsertSession(s: { id: string; vmId: string; cwd: string; title: string; status: string; accountId: string }): void {
        const now = new Date().toISOString();
        // A session id belongs to the tenant that first recorded it. Another tenant reporting the same
        // id (they are random UUIDs, so this is a bug or an attack) must not overwrite or adopt it.
        db.prepare(
          `INSERT INTO sessions (id, tenant_id, vm_id, cwd, title, created_at, last_message_at, status, account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_message_at = excluded.last_message_at
           WHERE sessions.tenant_id = excluded.tenant_id`,
        ).run(s.id, t, s.vmId, s.cwd, s.title, now, now, s.status, s.accountId);
      },

      touchSession(id: string, status?: string): void {
        if (status) {
          db.prepare('UPDATE sessions SET last_message_at = ?, status = ? WHERE tenant_id = ? AND id = ?').run(new Date().toISOString(), status, t, id);
        } else {
          db.prepare('UPDATE sessions SET last_message_at = ? WHERE tenant_id = ? AND id = ?').run(new Date().toISOString(), t, id);
        }
      },

      listSessionsByVm(vmId: string): SessionDto[] {
        return db
          .prepare(
            `SELECT id, vm_id as vmId, cwd, title, created_at as createdAt, last_message_at as lastMessageAt, status, account_id as accountId
             FROM sessions WHERE tenant_id = ? AND vm_id = ? ORDER BY last_message_at DESC`,
          )
          .all(t, vmId) as never;
      },

      insertMessage(m: { sessionId: string; vmId: string; message: unknown }): MessageDto {
        const createdAt = new Date().toISOString();
        const result = db
          .prepare('INSERT INTO messages (tenant_id, session_id, vm_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(t, m.sessionId, m.vmId, JSON.stringify(m.message), createdAt);
        return { id: Number(result.lastInsertRowid), sessionId: m.sessionId, vmId: m.vmId, message: m.message, createdAt };
      },

      // A new chat starts under a temporary id and is re-keyed to Claude's real session id once it exists.
      // The alias is kept so a caller that only ever learned the temporary id (a backend, a script) can keep
      // using it: every session route resolves it.
      rekeySession(oldId: string, newId: string): void {
        db.prepare('UPDATE messages SET session_id = ? WHERE tenant_id = ? AND session_id = ?').run(newId, t, oldId);
        if (oldId !== newId) {
          db.prepare(
            `INSERT INTO session_aliases (tenant_id, old_id, new_id) VALUES (?, ?, ?)
             ON CONFLICT(tenant_id, old_id) DO UPDATE SET new_id = excluded.new_id`,
          ).run(t, oldId, newId);
        }
      },

      resolveSession(id: string): string {
        const row = db.prepare('SELECT new_id as newId FROM session_aliases WHERE tenant_id = ? AND old_id = ?').get(t, id) as { newId: string } | undefined;
        return row?.newId ?? id;
      },

      listMessages(sessionId: string): MessageDto[] {
        const rows = db
          .prepare(
            'SELECT id, session_id as sessionId, vm_id as vmId, payload, created_at as createdAt FROM messages WHERE tenant_id = ? AND session_id = ? ORDER BY id ASC',
          )
          .all(t, sessionId) as { id: number; sessionId: string; vmId: string; payload: string; createdAt: string }[];
        return rows.map((r) => ({ id: r.id, sessionId: r.sessionId, vmId: r.vmId, createdAt: r.createdAt, message: JSON.parse(r.payload) }));
      },

      createAuthToken(): string {
        const token = randomUUID() + randomUUID();
        db.prepare('INSERT INTO auth_tokens (token, created_at, tenant_id) VALUES (?, ?, ?)').run(sessionDigest(token), new Date().toISOString(), t);
        return token;
      },

      /** Sign out: the token stops working immediately, wherever it was copied to. */
      revokeToken(token: string): boolean {
        const a = Number(db.prepare('DELETE FROM auth_tokens WHERE tenant_id = ? AND token = ?').run(t, sessionDigest(token)).changes);
        const b = Number(db.prepare('DELETE FROM api_tokens WHERE tenant_id = ? AND token = ?').run(t, sessionDigest(token)).changes);
        return a + b > 0;
      },

      createApiToken(label: string): { id: string; token: string; label: string; createdAt: string } {
        const created = { id: randomUUID(), token: randomUUID() + randomUUID(), label, createdAt: new Date().toISOString() };
        db.prepare('INSERT INTO api_tokens (id, token, label, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)').run(
          created.id,
          sessionDigest(created.token),
          created.label,
          created.createdAt,
          t,
        );
        return created;
      },

      listApiTokens(): ApiTokenDto[] {
        return db.prepare('SELECT id, label, created_at as createdAt FROM api_tokens WHERE tenant_id = ? ORDER BY created_at DESC').all(t) as never;
      },

      deleteApiToken(id: string): boolean {
        return Number(db.prepare('DELETE FROM api_tokens WHERE tenant_id = ? AND id = ?').run(t, id).changes) > 0;
      },

      setVmAgentVersion(vmId: string, version: string): void {
        db.prepare(
          `INSERT INTO vm_agent_version (vm_id, version) VALUES (?, ?)
           ON CONFLICT(vm_id) DO UPDATE SET version = excluded.version`,
        ).run(vmId, version);
      },

      getVmAgentVersion(vmId: string): string | null {
        const row = db.prepare('SELECT version FROM vm_agent_version WHERE vm_id = ?').get(vmId) as { version: string } | undefined;
        return row?.version ?? null;
      },

      listMcpServers(): ManagedMcpServer[] {
        const rows = db.prepare('SELECT config_json as configJson FROM mcp_servers WHERE tenant_id = ? ORDER BY name').all(t) as { configJson: string }[];
        return rows.map((r) => JSON.parse(r.configJson) as ManagedMcpServer);
      },

      putMcpServer(server: Omit<ManagedMcpServer, 'updatedAt'>): ManagedMcpServer {
        const stored: ManagedMcpServer = { ...server, updatedAt: new Date().toISOString() };
        db.prepare(
          `INSERT INTO mcp_servers (tenant_id, name, config_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id, name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
        ).run(t, stored.name, JSON.stringify(stored), stored.updatedAt);
        return stored;
      },

      deleteMcpServer(name: string): boolean {
        return Number(db.prepare('DELETE FROM mcp_servers WHERE tenant_id = ? AND name = ?').run(t, name).changes) > 0;
      },

      setVmMcpStatus(vmId: string, status: Pick<AgentMcpStatus, 'servers' | 'liveSessions'>): void {
        // Only for a VM this tenant owns: a status row keyed by another tenant's VM id is refused.
        if (!db.prepare('SELECT 1 FROM vms WHERE tenant_id = ? AND id = ?').get(t, vmId)) return;
        db.prepare(
          `INSERT INTO vm_mcp_status (vm_id, status_json, reported_at) VALUES (?, ?, ?)
           ON CONFLICT(vm_id) DO UPDATE SET status_json = excluded.status_json, reported_at = excluded.reported_at`,
        ).run(vmId, JSON.stringify(status), new Date().toISOString());
      },

      getVmMcpStatus(vmId: string): { servers: AgentMcpStatus['servers']; liveSessions: number; reportedAt: string } | null {
        const row = db
          .prepare(
            `SELECT s.status_json as statusJson, s.reported_at as reportedAt FROM vm_mcp_status s
             JOIN vms v ON v.id = s.vm_id WHERE v.tenant_id = ? AND s.vm_id = ?`,
          )
          .get(t, vmId) as { statusJson: string; reportedAt: string } | undefined;
        if (!row) return null;
        return { ...JSON.parse(row.statusJson), reportedAt: row.reportedAt };
      },
    };
  }

  return {
    for: scoped,

    // ---- who does a credential belong to? ----

    tenantForApiToken(token: string): string | null {
      if (!token || token.length > 512) return null;
      const digest = sessionDigest(token);
      const a = db.prepare('SELECT tenant_id as t, created_at FROM auth_tokens WHERE token = ?').get(digest) as { t: string; created_at: string } | undefined;
      const age = a ? Date.now() - Date.parse(a.created_at) : NaN;
      if (a && Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE_MS) return a.t;
      const b = db.prepare('SELECT tenant_id as t FROM api_tokens WHERE token = ?').get(digest) as { t: string } | undefined;
      return b?.t ?? null;
    },

    // ---- credentials for one machine ----

    /**
     * Credentials that let a process register as `vmName` and nothing else, and let its holder see and drive that one
     * machine and nothing else. They expire by themselves. Issuing again for the same machine replaces the earlier pair.
     * The plaintext is returned once; only hashes are kept.
     */
    issueMachineCredentials(tenantId: string, vmName: string, ttlSeconds: number, label: string): { id: string; vmName: string; agentToken: string; apiToken: string; expiresAt: string } | null {
      if (!db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId) || !MACHINE_NAME.test(vmName)) return null;
      const now = Date.now();
      db.prepare('DELETE FROM machine_credentials WHERE expires_at < ?').run(new Date(now - 86_400_000).toISOString());
      db.prepare('DELETE FROM machine_credentials WHERE tenant_id = ? AND vm_name = ?').run(tenantId, vmName);
      const made = {
        id: randomUUID(),
        vmName,
        agentToken: newSecret(),
        apiToken: newSecret(),
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      };
      db.prepare('INSERT INTO machine_credentials (id, tenant_id, vm_name, label, agent_hash, api_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        made.id,
        tenantId,
        vmName,
        label.slice(0, 100),
        sha256(made.agentToken),
        sha256(made.apiToken),
        made.expiresAt,
        new Date(now).toISOString(),
      );
      return made;
    },

    revokeMachineCredentials(tenantId: string, vmName: string): boolean {
      return Number(db.prepare('DELETE FROM machine_credentials WHERE tenant_id = ? AND vm_name = ?').run(tenantId, vmName).changes) > 0;
    },

    machineForAgentToken(token: string): MachineScope | null {
      if (!token) return null;
      const row = db.prepare('SELECT tenant_id as tenantId, vm_name as vmName, expires_at as expiresAt FROM machine_credentials WHERE agent_hash = ?').get(sha256(token)) as MachineScope | undefined;
      return row && row.expiresAt > new Date().toISOString() ? row : null;
    },

    machineForApiToken(token: string): MachineScope | null {
      if (!token) return null;
      const row = db.prepare('SELECT tenant_id as tenantId, vm_name as vmName, expires_at as expiresAt FROM machine_credentials WHERE api_hash = ?').get(sha256(token)) as MachineScope | undefined;
      return row && row.expiresAt > new Date().toISOString() ? row : null;
    },

    tenantForAgentToken(token: string): string | null {
      if (!token) return null;
      const row = db.prepare('SELECT id FROM tenants WHERE agent_token_hash = ?').get(sha256(token)) as { id: string } | undefined;
      return row?.id ?? null;
    },

    // ---- tenants (the admin API) ----

    /** Mint a tenant with its own agent token and an API token. The plaintext is returned once; only a hash of the agent token is kept. */
    createTenant(label: string): { id: string; label: string; agentToken: string; apiToken: string } {
      const id = `t_${randomBytes(9).toString('base64url')}`;
      const agentToken = newSecret();
      db.prepare('INSERT INTO tenants (id, label, agent_token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, label, sha256(agentToken), new Date().toISOString());
      const apiToken = scoped(id).createApiToken('managed').token;
      return { id, label, agentToken, apiToken };
    },

    /** A new agent token; the old one stops working at once. */
    rotateAgentToken(id: string): string | null {
      if (!db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id)) return null;
      const agentToken = newSecret();
      db.prepare('UPDATE tenants SET agent_token_hash = ? WHERE id = ?').run(sha256(agentToken), id);
      return agentToken;
    },

    listTenants(): TenantDto[] {
      return db.prepare('SELECT id, label, created_at as createdAt FROM tenants ORDER BY created_at').all() as never;
    },

    hasTenant(id: string): boolean {
      return Boolean(db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id));
    },

    /** Remove a tenant and everything it owned. */
    deleteTenant(id: string): boolean {
      if (id === DEFAULT_TENANT || !db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id)) return false;
      db.prepare('DELETE FROM vm_mcp_status WHERE vm_id IN (SELECT id FROM vms WHERE tenant_id = ?)').run(id);
      db.prepare('DELETE FROM vm_agent_version WHERE vm_id IN (SELECT id FROM vms WHERE tenant_id = ?)').run(id);
      for (const table of ['messages', 'sessions', 'vms', 'mcp_servers', 'auth_tokens', 'api_tokens', 'session_aliases', 'machine_credentials']) {
        db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(id);
      }
      db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
      return true;
    },
  };
}

export type Db = ReturnType<typeof openDb>;
export type TenantDb = ReturnType<Db['for']>;
