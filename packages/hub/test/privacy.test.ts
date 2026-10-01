import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('session tokens are hashed, expire and can be revoked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'escanor-hub-privacy-'));
  const hub = openDb(dir);
  const token = hub.for('default').createAuthToken();
  const database = new DatabaseSync(join(dir, 'hub.sqlite'));
  const row = database.prepare('SELECT token FROM auth_tokens').get() as { token: string };
  assert.notEqual(row.token, token);
  assert.equal(Boolean(hub.tenantForApiToken(token)), true);
  assert.equal(Boolean(hub.tenantForApiToken(row.token)), false);
  database.prepare('UPDATE auth_tokens SET created_at = ?').run('2020-01-01T00:00:00.000Z');
  assert.equal(Boolean(hub.tenantForApiToken(token)), false);
  const current = hub.for('default').createAuthToken();
  hub.for('default').revokeToken(current);
  assert.equal(Boolean(hub.tenantForApiToken(current)), false);
  database.close();
});

test('legacy token records migrate without removing sessions or accepting digest replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'escanor-hub-migrate-'));
  const database = new DatabaseSync(join(dir, 'hub.sqlite'));
  database.exec('CREATE TABLE auth_tokens (token TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
  database.prepare('INSERT INTO auth_tokens VALUES (?, ?)').run('legacy-secret', new Date().toISOString());
  const hub = openDb(dir);
  assert.equal(Boolean(hub.tenantForApiToken('legacy-secret')), true);
  const row = database.prepare('SELECT token FROM auth_tokens').get() as { token: string };
  assert.notEqual(row.token, 'legacy-secret');
  assert.equal(Boolean(hub.tenantForApiToken(row.token)), false);
  database.close();
});

test('HTTP login/logout revokes a session and prevents cached API responses', async () => {
  const { default: express } = await import('express');
  const { createApiRouter } = await import('../src/api.js');
  const { createBrowserServer } = await import('../src/browserServer.js');
  const { createAgentServer } = await import('../src/agentServer.js');
  const { once } = await import('node:events');
  const { WebSocket } = await import('ws');
  const dir = mkdtempSync(join(tmpdir(), 'escanor-hub-http-'));
  const hub = openDb(dir);
  const browser = createBrowserServer(hub);
  const agent = createAgentServer(hub, 'a'.repeat(32), { onHello() {}, onStatusChange() {}, onEvent() {} });
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(hub, agent, browser, 'p'.repeat(32)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.on('upgrade', (req, socket, head) => {
    if (!browser.authorize(req)) { socket.destroy(); return; }
    browser.wss.handleUpgrade(req, socket, head, ws => browser.wss.emit('connection', ws, req));
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p'.repeat(32) }) });
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const { token } = await login.json() as { token: string };
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/mcp-servers`, { headers })).status, 200);
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, ['escanor.hub.v1', `escanor.auth.${token}`]);
    await once(socket, 'open');
    assert.equal(socket.protocol, 'escanor.hub.v1');
    const legacySocket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${token}`);
    await once(legacySocket, 'open');
    const closed = Promise.all([once(socket, 'close'), once(legacySocket, 'close')]);
    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers })).status, 200);
    await closed;
    assert.equal((await fetch(`${base}/api/mcp-servers`, { headers })).status, 401);
  } finally {
    browser.wss.close();
    agent.wss.close();
    server.close();
  }
});
