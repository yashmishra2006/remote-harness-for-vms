// Boots the real Node hub on a spare port and drives the MCP registry the way Escanor and an agent do.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const HUB = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let dataDir: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  // Spawned directly (not via npx) so that killing it in `after` kills the hub itself, not just a wrapper.
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HUB_AGENT_TOKEN: 'agent-secret-for-tests-only-123', APP_PASSWORD: 'password-for-tests-only-123456', DATA_DIR: dataDir, WEB_DIST: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${HUB}/api/vms`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const { token } = await (await fetch(`${HUB}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'password-for-tests-only-123456' }) })).json();
  auth = { authorization: `Bearer ${token}`, ...json };
});

after(() => {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

const put = (name: string, body: unknown, headers = auth) => fetch(`${HUB}/api/mcp-servers/${name}`, { method: 'PUT', headers, body: JSON.stringify(body) });

function connectAgent(vmName: string, agentVersion = '0.3.0') {
  const inbox: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`, { headers: { authorization: 'Bearer agent-secret-for-tests-only-123' } });
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const ready = new Promise<void>((res) => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', agentVersion, vmName, hostname: 'h', accounts: [], sessions: [] }));
    res();
  }));
  return { ws, inbox, ready };
}
const settle = () => new Promise((r) => setTimeout(r, 250));
const lastPush = (inbox: any[]) => [...inbox].reverse().find((m) => m.type === 'set_mcp_servers');

test('the registry requires the hub session token', async () => {
  assert.equal((await put('escanor', { url: 'https://x/' }, json)).status, 401);
  assert.equal((await fetch(`${HUB}/api/mcp-servers`)).status, 401);
});

test('invalid servers are refused', async () => {
  assert.equal((await put('Bad Name', { url: 'https://x/' })).status, 400);
  assert.equal((await put('escanor', { url: 'ftp://x/' })).status, 400);
  assert.equal((await put('escanor', { url: 'https://u:p@x/' })).status, 400);
  assert.equal((await put('escanor', { url: 'https://x/', headers: { A: 'b\r\nEvil: 1' } })).status, 400);
});

test('a server installed before any VM exists reaches a VM that connects later, credentials included', async () => {
  const r = await put('escanor', { url: 'https://mcp.escanor.in/', headers: { Authorization: 'Bearer secret' }, managedBy: 'escanor' });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(body.server.headerNames, ['Authorization']);
  assert.ok(!JSON.stringify(body).includes('secret'), 'the PUT response must not echo header values');

  const a = connectAgent('vm-a');
  await a.ready;
  await settle();
  const push = lastPush(a.inbox);
  assert.equal(push.servers[0].name, 'escanor');
  assert.equal(push.servers[0].headers.Authorization, 'Bearer secret');
  assert.equal(push.servers[0].autoAllow, true);
  assert.equal(push.servers[0].alwaysLoad, true);
  a.ws.close();
});

test('edits and removals are pushed live to every connected VM', async () => {
  const a = connectAgent('vm-b');
  const b = connectAgent('vm-c');
  await Promise.all([a.ready, b.ready]);
  await settle();

  const r = await put('escanor', { url: 'https://mcp2.escanor.in/', headers: { Authorization: 'Bearer new' }, autoAllow: false });
  assert.equal((await r.json()).vmsConnected >= 2, true);
  await settle();
  for (const agent of [a, b]) {
    const push = lastPush(agent.inbox);
    assert.equal(push.servers[0].url, 'https://mcp2.escanor.in/');
    assert.equal(push.servers[0].autoAllow, false);
  }

  assert.equal((await fetch(`${HUB}/api/mcp-servers/escanor`, { method: 'DELETE', headers: auth })).status, 200);
  await settle();
  for (const agent of [a, b]) assert.deepEqual(lastPush(agent.inbox).servers, []);
  assert.equal((await fetch(`${HUB}/api/mcp-servers/escanor`, { method: 'DELETE', headers: auth })).status, 404);
  a.ws.close();
  b.ws.close();
});

test('per-VM state reported by agents is served, without credentials', async () => {
  await put('escanor', { url: 'https://mcp.escanor.in/', headers: { Authorization: 'Bearer secret' } });
  const a = connectAgent('vm-d');
  await a.ready;
  a.ws.send(JSON.stringify({ type: 'mcp_status', servers: [{ name: 'escanor', status: 'connected' }], liveSessions: 2 }));
  await settle();
  const overview = await (await fetch(`${HUB}/api/mcp-servers`, { headers: auth })).json();
  const vm = overview.vms.find((v: any) => v.name === 'vm-d');
  assert.equal(vm.connected, true);
  assert.equal(vm.liveSessions, 2);
  assert.equal(vm.servers[0].status, 'connected');
  assert.ok(!JSON.stringify(overview).includes('secret'));
  a.ws.close();
});

test('CORS preflight allows PUT and DELETE for the browser and Android app', async () => {
  const r = await fetch(`${HUB}/api/mcp-servers/escanor`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  const methods = r.headers.get('access-control-allow-methods') ?? '';
  assert.ok(methods.includes('PUT') && methods.includes('DELETE'));
});

test('an agent too old to install MCP servers is reported as needing an update, not "installing"', async () => {
  const old = connectAgent('vm-old', '0.2.0');
  const current = connectAgent('vm-new', '0.3.0');
  await Promise.all([old.ready, current.ready]);
  await settle();
  const overview = await (await fetch(`${HUB}/api/mcp-servers`, { headers: auth })).json();
  const byName = (n: string) => overview.vms.find((v: any) => v.name === n);
  assert.deepEqual([byName('vm-old').mcpSupported, byName('vm-old').agentVersion], [false, '0.2.0']);
  assert.deepEqual([byName('vm-new').mcpSupported, byName('vm-new').agentVersion], [true, '0.3.0']);
  old.ws.close();
  current.ws.close();
});

const login = async () =>
  ({ authorization: `Bearer ${(await (await fetch(`${HUB}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'password-for-tests-only-123456' }) })).json()).token}`, ...json });

test('signing out revokes the token everywhere', async () => {
  const session = await login();
  assert.equal((await fetch(`${HUB}/api/vms`, { headers: session })).status, 200);
  assert.equal((await fetch(`${HUB}/api/logout`, { method: 'POST', headers: session })).status, 200);
  assert.equal((await fetch(`${HUB}/api/vms`, { headers: session })).status, 401, 'a copy of the token no longer works');
});

test('a dedicated token works, survives the browser signing out, and can be revoked on its own', async () => {
  const session = await login();
  const created = await (await fetch(`${HUB}/api/tokens`, { method: 'POST', headers: session, body: JSON.stringify({ label: 'Escanor' }) })).json();
  assert.ok(created.token && created.id);
  const escanor = { authorization: `Bearer ${created.token}`, ...json };

  assert.equal((await fetch(`${HUB}/api/mcp-servers`, { headers: escanor })).status, 200, 'it authenticates');
  const listed = await (await fetch(`${HUB}/api/tokens`, { headers: session })).json();
  assert.ok(listed.some((t: any) => t.id === created.id && t.label === 'Escanor'));
  assert.ok(!JSON.stringify(listed).includes(created.token), 'the value is never listed');

  await fetch(`${HUB}/api/logout`, { method: 'POST', headers: session });
  assert.equal((await fetch(`${HUB}/api/mcp-servers`, { headers: escanor })).status, 200, 'signing out of the browser does not break it');

  const fresh = await login();
  assert.equal((await fetch(`${HUB}/api/tokens/${created.id}`, { method: 'DELETE', headers: fresh })).status, 200);
  assert.equal((await fetch(`${HUB}/api/mcp-servers`, { headers: escanor })).status, 401, 'revoked');
  assert.equal((await fetch(`${HUB}/api/tokens/${created.id}`, { method: 'DELETE', headers: fresh })).status, 404);
});

test('tokens cannot be created or listed without authentication', async () => {
  assert.equal((await fetch(`${HUB}/api/tokens`, { method: 'POST', headers: json, body: '{}' })).status, 401);
  assert.equal((await fetch(`${HUB}/api/tokens`)).status, 401);
});
