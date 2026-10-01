// Multi-tenant hub: each tenant is a private hub. Boots the real hub and attacks the boundaries.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

const json = { 'content-type': 'application/json' };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function startHub(env: Record<string, string>, dataDir: string) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HUB_AGENT_TOKEN: 'legacy-agent-secret-for-tests-only', APP_PASSWORD: 'password-for-tests-only-123456', DATA_DIR: dataDir, WEB_DIST: dataDir, ...env },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${url}/api/vms`);
      break;
    } catch {
      await settle(200);
    }
  }
  return { url, port, stop: () => proc.kill() };
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hub-mt-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let hub: Awaited<ReturnType<typeof startHub>>;
const ADMIN = 'admin-secret';
const admin = { authorization: `Bearer ${ADMIN}`, ...json };
type Tenant = { id: string; agentToken: string; apiToken: string };
let A: Tenant, B: Tenant;
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, ...json });

function agent(port: number, token: string, vmName: string, version = '0.3.0') {
  const inbox: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { authorization: `Bearer ${token}` } });
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const ready = new Promise<boolean>((res) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', agentVersion: version, vmName, hostname: 'h', accounts: [], sessions: [] }));
      res(true);
    });
    ws.on('error', () => res(false));
    ws.on('unexpected-response', () => res(false));
  });
  return { ws, inbox, ready };
}

before(async () => {
  hub = await startHub({ HUB_ADMIN_TOKEN: ADMIN }, tmp());
  A = await (await fetch(`${hub.url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'A' }) })).json();
  B = await (await fetch(`${hub.url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'B' }) })).json();
});
after(() => hub?.stop());

test('the admin API needs the admin token, and no tenant credential opens it', async () => {
  const url = `${hub.url}/admin/tenants`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: bearer('wrong') })).status, 401);
  assert.equal((await fetch(url, { headers: bearer(A.apiToken) })).status, 401, 'a tenant API token is not an admin token');
  assert.equal((await fetch(url, { headers: bearer(A.agentToken) })).status, 401, 'nor is an agent token');
  assert.equal((await fetch(url, { headers: bearer('legacy-agent-secret-for-tests-only') })).status, 401);
  const list = await (await fetch(url, { headers: admin })).json();
  assert.deepEqual(list.map((t: any) => t.label).sort(), ['A', 'B']);
  assert.ok(!JSON.stringify(list).includes(A.agentToken), 'tokens are never listed');
});

test('a hub without HUB_ADMIN_TOKEN has no admin API at all', async () => {
  const plain = await startHub({ HUB_ADMIN_TOKEN: '' }, tmp());
  try {
    assert.equal((await fetch(`${plain.url}/admin/tenants`, { headers: admin })).status, 404);
    assert.equal((await fetch(`${plain.url}/admin/tenants`, { method: 'POST', headers: admin, body: '{}' })).status, 404);
  } finally {
    plain.stop();
  }
});

test('tenant credentials are not interchangeable and mean nothing outside their role', async () => {
  assert.equal((await fetch(`${hub.url}/api/vms`, { headers: bearer(A.apiToken) })).status, 200);
  assert.equal((await fetch(`${hub.url}/api/vms`, { headers: bearer(A.agentToken) })).status, 401, 'an agent token is not an API token');
  const asAgent = agent(hub.port, A.apiToken, 'x');
  assert.equal(await asAgent.ready, false, 'an API token is not an agent token');
  const bogus = agent(hub.port, 'not-a-token', 'x');
  assert.equal(await bogus.ready, false);
});

test('two tenants may use the same VM name and never see each other', async () => {
  const a = agent(hub.port, A.agentToken, 'workspace-vm');
  const b = agent(hub.port, B.agentToken, 'workspace-vm');
  const d = agent(hub.port, 'legacy-agent-secret-for-tests-only', 'workspace-vm');
  await Promise.all([a.ready, b.ready, d.ready]);
  await settle();

  const vmsOf = async (token: string) => (await (await fetch(`${hub.url}/api/vms`, { headers: bearer(token) })).json()) as any[];
  const [av, bv] = [await vmsOf(A.apiToken), await vmsOf(B.apiToken)];
  assert.equal(av.length, 1);
  assert.equal(bv.length, 1);
  assert.notEqual(av[0].id, bv[0].id, 'same name, different machines');
  assert.equal(av[0].connected && bv[0].connected, true);

  const login = await (await fetch(`${hub.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'password-for-tests-only-123456' }) })).json();
  const dv = await vmsOf(login.token);
  assert.equal(dv.length, 1, 'the classic password login is the default tenant, with only its own VM');
  assert.ok(![av[0].id, bv[0].id].includes(dv[0].id));
  a.ws.close();
  b.ws.close();
  d.ws.close();
});

test("a tenant cannot reach another tenant's VM, sessions, messages or controls", async () => {
  const a = agent(hub.port, A.agentToken, 'va');
  const b = agent(hub.port, B.agentToken, 'vb');
  await Promise.all([a.ready, b.ready]);
  await settle();
  const bVm = ((await (await fetch(`${hub.url}/api/vms`, { headers: bearer(B.apiToken) })).json()) as any[]).find((v) => v.name === 'vb');
  b.inbox.length = 0;

  const asA = (path: string, init: RequestInit = {}) => fetch(`${hub.url}/api${path}`, { headers: bearer(A.apiToken), ...init });
  assert.equal((await asA(`/vms/${bVm.id}/sessions`)).status, 404);
  assert.equal((await asA(`/vms/${bVm.id}/projects`)).status, 404);
  assert.equal((await asA(`/vms/${bVm.id}/sessions`, { method: 'POST', body: JSON.stringify({ text: 'run rm -rf' }) })).status, 404);
  assert.equal((await asA(`/vms/${bVm.id}/sessions/x/messages`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })).status, 404);
  assert.equal((await asA(`/vms/${bVm.id}/sessions/x/permission-response`, { method: 'POST', body: JSON.stringify({ requestId: 'r', behavior: 'allow' }) })).status, 404);
  assert.equal((await asA(`/vms/${bVm.id}/sessions/x/interrupt`, { method: 'POST' })).status, 404);
  await settle();
  assert.deepEqual(b.inbox.filter((m) => m.type !== 'set_mcp_servers'), [], "nothing was delivered to B's machine");

  // ...while the owner can.
  const ok = await fetch(`${hub.url}/api/vms/${bVm.id}/sessions`, { method: 'POST', headers: bearer(B.apiToken), body: JSON.stringify({ text: 'hello' }) });
  assert.equal(ok.status, 202);
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'user_input').length, 1);
  assert.equal(a.inbox.filter((m) => m.type === 'user_input').length, 0);
  a.ws.close();
  b.ws.close();
});

test("messages and sessions are private even when a session id is known", async () => {
  const b = agent(hub.port, B.agentToken, 'vb2');
  await b.ready;
  await settle();
  const bVm = ((await (await fetch(`${hub.url}/api/vms`, { headers: bearer(B.apiToken) })).json()) as any[]).find((v) => v.name === 'vb2');
  b.ws.send(JSON.stringify({ type: 'session_created', tempId: 't1', sessionId: 'sess-b', cwd: '.', title: 'secret plans', accountId: 'default' }));
  b.ws.send(JSON.stringify({ type: 'sdk_message', sessionId: 'sess-b', message: { type: 'assistant', text: 'the launch code is 1234' } }));
  await settle();
  const own = await (await fetch(`${hub.url}/api/vms/${bVm.id}/sessions/sess-b/messages`, { headers: bearer(B.apiToken) })).json();
  assert.equal(own.length, 1);
  const A_vm = agent(hub.port, A.agentToken, 'va2');
  await A_vm.ready;
  await settle();
  const aVm = ((await (await fetch(`${hub.url}/api/vms`, { headers: bearer(A.apiToken) })).json()) as any[]).find((v) => v.name === 'va2');
  // A asks for B's session id through A's own VM: the tenant filter still returns nothing.
  const leaked = await (await fetch(`${hub.url}/api/vms/${aVm.id}/sessions/sess-b/messages`, { headers: bearer(A.apiToken) })).json();
  assert.deepEqual(leaked, []);
  // ...and A's agent cannot poison or adopt B's session by reporting the same id.
  A_vm.ws.send(JSON.stringify({ type: 'session_created', tempId: 't2', sessionId: 'sess-b', cwd: '/evil', title: 'hijack', accountId: 'default' }));
  await settle();
  const sessions = (await (await fetch(`${hub.url}/api/vms/${bVm.id}/sessions`, { headers: bearer(B.apiToken) })).json()) as any[];
  assert.equal(sessions.find((s) => s.id === 'sess-b').title, 'secret plans');
  assert.equal(sessions.find((s) => s.id === 'sess-b').cwd, '.');
  b.ws.close();
  A_vm.ws.close();
});

test('MCP servers and tokens are per tenant, and pushes only reach that tenant', async () => {
  const a = agent(hub.port, A.agentToken, 'ma');
  const b = agent(hub.port, B.agentToken, 'mb');
  await Promise.all([a.ready, b.ready]);
  await settle();
  a.inbox.length = 0;
  b.inbox.length = 0;

  const put = await fetch(`${hub.url}/api/mcp-servers/escanor`, { method: 'PUT', headers: bearer(A.apiToken), body: JSON.stringify({ url: 'https://mcp.example/', headers: { Authorization: 'Bearer a-secret' } }) });
  assert.equal(put.status, 200);
  await settle();
  assert.equal(a.inbox.filter((m) => m.type === 'set_mcp_servers').at(-1).servers[0].headers.Authorization, 'Bearer a-secret');
  assert.equal(b.inbox.filter((m) => m.type === 'set_mcp_servers').length, 0, "B's machine heard nothing");

  const bOverview = await (await fetch(`${hub.url}/api/mcp-servers`, { headers: bearer(B.apiToken) })).json();
  assert.deepEqual(bOverview.servers, []);
  assert.ok(!JSON.stringify(bOverview).includes('a-secret'));

  const created = await (await fetch(`${hub.url}/api/tokens`, { method: 'POST', headers: bearer(A.apiToken), body: JSON.stringify({ label: 'extra' }) })).json();
  const aTokens = await (await fetch(`${hub.url}/api/tokens`, { headers: bearer(A.apiToken) })).json();
  const bTokens = await (await fetch(`${hub.url}/api/tokens`, { headers: bearer(B.apiToken) })).json();
  assert.ok(aTokens.some((t: any) => t.id === created.id));
  assert.ok(!bTokens.some((t: any) => t.id === created.id));
  assert.equal((await fetch(`${hub.url}/api/tokens/${created.id}`, { method: 'DELETE', headers: bearer(B.apiToken) })).status, 404, "B cannot revoke A's token");
  a.ws.close();
  b.ws.close();
});

test('a browser socket only hears about its own tenant', async () => {
  const heardA: any[] = [];
  const heardB: any[] = [];
  const wa = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?token=${A.apiToken}`);
  const wb = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?token=${B.apiToken}`);
  wa.on('message', (d) => heardA.push(JSON.parse(d.toString())));
  wb.on('message', (d) => heardB.push(JSON.parse(d.toString())));
  await Promise.all([new Promise((r) => wa.on('open', r)), new Promise((r) => wb.on('open', r))]);
  const b = agent(hub.port, B.agentToken, 'ws-b');
  await b.ready;
  await settle();
  assert.ok(heardB.some((m) => m.type === 'vm_status' && m.name === 'ws-b'));
  assert.deepEqual(heardA.filter((m) => m.name === 'ws-b'), [], 'A never heard about B');
  const bad = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?token=${A.agentToken}`);
  assert.equal(await new Promise((r) => { bad.on('error', () => r('refused')); bad.on('open', () => r('open')); }), 'refused');
  wa.close();
  wb.close();
  b.ws.close();
});

test('rotating an agent token cuts off the old one; deleting a tenant removes everything', async () => {
  const t: Tenant = await (await fetch(`${hub.url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'temp' }) })).json();
  const live = agent(hub.port, t.agentToken, 'tv');
  await live.ready;
  await settle();
  const closed = new Promise((r) => live.ws.on('close', () => r('closed')));
  const rotated = await (await fetch(`${hub.url}/admin/tenants/${t.id}/rotate-agent-token`, { method: 'POST', headers: admin })).json();
  assert.equal(await closed, 'closed', 'connected agents are dropped when the token rotates');
  assert.equal(await agent(hub.port, t.agentToken, 'tv').ready, false, 'the old token no longer works');
  const again = agent(hub.port, rotated.agentToken, 'tv');
  assert.equal(await again.ready, true, 'the new one does');
  await settle();

  assert.equal((await fetch(`${hub.url}/admin/tenants/${t.id}`, { method: 'DELETE', headers: admin })).status, 200);
  assert.equal((await fetch(`${hub.url}/api/vms`, { headers: bearer(t.apiToken) })).status, 401, 'its API tokens are gone');
  assert.equal(await agent(hub.port, rotated.agentToken, 'tv').ready, false, 'and its agent token');
  assert.equal((await fetch(`${hub.url}/admin/tenants/${t.id}`, { method: 'DELETE', headers: admin })).status, 404);
  assert.equal((await fetch(`${hub.url}/admin/tenants/default`, { method: 'DELETE', headers: admin })).status, 404, 'the default tenant cannot be deleted');
  assert.equal((await fetch(`${hub.url}/api/vms`, { headers: bearer(A.apiToken) })).status, 200, 'others are untouched');
});

test('a hub database from before tenants becomes the default tenant, intact', async () => {
  const dir = tmp();
  const old = new DatabaseSync(join(dir, 'hub.sqlite'));
  old.exec(`
    CREATE TABLE vms (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, last_seen_at TEXT, accounts_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE sessions (id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL, status TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT 'default');
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, vm_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE auth_tokens (token TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE mcp_servers (name TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO vms VALUES ('vm-old', 'my-server', '2026-01-01T00:00:00Z', '[]');
    INSERT INTO sessions VALUES ('s-old', 'vm-old', '/home', 'old chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'idle', 'default');
    INSERT INTO messages (session_id, vm_id, payload, created_at) VALUES ('s-old', 'vm-old', '{"type":"assistant","text":"remembered"}', '2026-01-01T00:00:00Z');
    INSERT INTO auth_tokens VALUES ('old-login-token', '${new Date().toISOString()}');
    INSERT INTO mcp_servers VALUES ('escanor', '{"name":"escanor","url":"https://mcp.escanor.in/","updatedAt":"x"}', 'x');
  `);
  old.close();
  const migrated = await startHub({ HUB_ADMIN_TOKEN: ADMIN }, dir);
  try {
    const legacy = bearer('old-login-token');
    assert.equal((await fetch(`${migrated.url}/api/vms`, { headers: legacy })).status, 200, 'the existing login token still works');
    const vms = (await (await fetch(`${migrated.url}/api/vms`, { headers: legacy })).json()) as any[];
    assert.deepEqual(vms.map((v) => [v.id, v.name]), [['vm-old', 'my-server']]);
    const sessions = await (await fetch(`${migrated.url}/api/vms/vm-old/sessions`, { headers: legacy })).json();
    assert.equal(sessions[0].title, 'old chat');
    const messages = await (await fetch(`${migrated.url}/api/vms/vm-old/sessions/s-old/messages`, { headers: legacy })).json();
    assert.equal(messages[0].message.text, 'remembered');
    const mcp = await (await fetch(`${migrated.url}/api/mcp-servers`, { headers: legacy })).json();
    assert.equal(mcp.servers[0].name, 'escanor');
    // ...and the classic agent token still lands in the same tenant, with the same VM name.
    const ag = agent(migrated.port, 'legacy-agent-secret-for-tests-only', 'my-server');
    await ag.ready;
    await settle();
    const after = (await (await fetch(`${migrated.url}/api/vms`, { headers: legacy })).json()) as any[];
    assert.equal(after.length, 1);
    assert.equal(after[0].id, 'vm-old', 'reconnecting resumes the same machine');
    // A new tenant on the migrated hub is separate from it.
    const t = await (await fetch(`${migrated.url}/admin/tenants`, { method: 'POST', headers: admin, body: '{}' })).json();
    assert.deepEqual(await (await fetch(`${migrated.url}/api/vms`, { headers: bearer(t.apiToken) })).json(), []);
    ag.ws.close();
  } finally {
    migrated.stop();
  }
});

test('a chat started under a temporary id can still be addressed by it after Claude assigns the real one', async () => {
  const t: Tenant = await (await fetch(`${hub.url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'alias' }) })).json();
  const ag = agent(hub.port, t.agentToken, 'alias-vm');
  await ag.ready;
  await settle();
  const vm = ((await (await fetch(`${hub.url}/api/vms`, { headers: bearer(t.apiToken) })).json()) as any[])[0];
  const started = await (await fetch(`${hub.url}/api/vms/${vm.id}/sessions`, { method: 'POST', headers: bearer(t.apiToken), body: JSON.stringify({ text: 'first question' }) })).json();
  assert.ok(started.tempId);
  // Claude's real session appears; the hub re-keys the stored messages to it.
  ag.ws.send(JSON.stringify({ type: 'session_created', tempId: started.tempId, sessionId: 'real-1', cwd: '.', title: 'first question', accountId: 'default' }));
  ag.ws.send(JSON.stringify({ type: 'sdk_message', sessionId: 'real-1', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } } }));
  await settle();

  const viaTemp = await (await fetch(`${hub.url}/api/vms/${vm.id}/sessions/${started.tempId}/messages`, { headers: bearer(t.apiToken) })).json();
  const viaReal = await (await fetch(`${hub.url}/api/vms/${vm.id}/sessions/real-1/messages`, { headers: bearer(t.apiToken) })).json();
  assert.equal(viaTemp.length, 2, 'the question and the answer, found through the temporary id');
  assert.deepEqual(viaTemp, viaReal);

  ag.inbox.length = 0;
  const follow = await fetch(`${hub.url}/api/vms/${vm.id}/sessions/${started.tempId}/messages`, { method: 'POST', headers: bearer(t.apiToken), body: JSON.stringify({ text: 'and then?' }) });
  assert.equal(follow.status, 202);
  await settle();
  const delivered = ag.inbox.find((m) => m.type === 'user_input');
  assert.equal(delivered.sessionId, 'real-1', 'the agent is told the real id, so the follow-up continues the same chat');
  assert.equal(delivered.tempId, undefined);

  ag.inbox.length = 0;
  await fetch(`${hub.url}/api/vms/${vm.id}/sessions/${started.tempId}/interrupt`, { method: 'POST', headers: bearer(t.apiToken) });
  await settle();
  assert.equal(ag.inbox.find((m) => m.type === 'interrupt').sessionId, 'real-1');
  ag.ws.close();
});
