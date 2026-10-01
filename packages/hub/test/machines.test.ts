// Credentials for one machine of a tenant: they see and drive that machine and nothing else, expire, and can be revoked.
// Boots the real hub and attacks the boundaries.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

const json = { 'content-type': 'application/json' };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'admin-secret';
const admin = { authorization: `Bearer ${ADMIN}`, ...json };
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, ...json });

let dir: string;
let proc: ChildProcess;
let url: string;
let port: number;
type Tenant = { id: string; agentToken: string; apiToken: string };
type Machine = { id: string; vmName: string; agentToken: string; apiToken: string; expiresAt: string };
let A: Tenant, B: Tenant;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-machines-'));
  port = 19000 + Math.floor(Math.random() * 900);
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HUB_AGENT_TOKEN: 'legacy-agent-secret-for-tests-only', APP_PASSWORD: 'password-for-tests-only-123456', DATA_DIR: dir, WEB_DIST: dir, HUB_ADMIN_TOKEN: ADMIN, HUB_MACHINE_MIN_TTL_SECONDS: '1' },
    stdio: ['ignore', 'ignore', process.env.HUB_TEST_STDERR ? 'inherit' : 'ignore'],
  });
  url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${url}/api/vms`);
      break;
    } catch {
      await settle(200);
    }
  }
  A = await (await fetch(`${url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'A' }) })).json();
  B = await (await fetch(`${url}/admin/tenants`, { method: 'POST', headers: admin, body: JSON.stringify({ label: 'B' }) })).json();
});
after(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const issue = (tenant: string, vmName: string, ttlSeconds = 3600) =>
  fetch(`${url}/admin/tenants/${tenant}/machines`, { method: 'POST', headers: admin, body: JSON.stringify({ vmName, ttlSeconds, label: `incident ${vmName}` }) });

function agent(token: string, vmName: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { authorization: `Bearer ${token}` } });
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  const ready = new Promise<boolean>((res) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', agentVersion: '0.3.0', vmName, hostname: 'h', accounts: [], sessions: [] }));
      res(true);
    });
    ws.on('error', () => res(false));
    ws.on('unexpected-response', () => res(false));
  });
  return { ws, ready, closed };
}

test('only the admin can issue machine credentials, and only with sane inputs', async () => {
  const post = (headers: Record<string, string>, body: unknown, tenant = A.id) => fetch(`${url}/admin/tenants/${tenant}/machines`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(json, { vmName: 'm1', ttlSeconds: 600 })).status, 401);
  assert.equal((await post(bearer(A.apiToken), { vmName: 'm1', ttlSeconds: 600 })).status, 401, 'a tenant token is not an admin token');
  assert.equal((await post(admin, { vmName: 'bad name; rm -rf /', ttlSeconds: 600 })).status, 400);
  assert.equal((await post(admin, { vmName: '../x', ttlSeconds: 600 })).status, 400);
  assert.equal((await post(admin, { vmName: 'm1', ttlSeconds: 0 })).status, 400);
  assert.equal((await post(admin, { vmName: 'm1', ttlSeconds: 10 ** 9 })).status, 400);
  assert.equal((await post(admin, { vmName: 'm1', ttlSeconds: 600 }, 't_nope')).status, 404);
  const ok = await post(admin, { vmName: 'm1', ttlSeconds: 600 });
  assert.equal(ok.status, 201);
  const body = (await ok.json()) as Machine;
  assert.ok(body.agentToken && body.apiToken && body.agentToken !== A.agentToken && body.apiToken !== A.apiToken);
  assert.ok(Date.parse(body.expiresAt) - Date.now() < 601_000);
});

test('a machine agent token registers as that machine only', async () => {
  const m = (await (await issue(A.id, 'inc-1')).json()) as Machine;
  const wrongName = agent(m.agentToken, 'some-other-machine');
  assert.equal(await wrongName.ready, true);
  assert.deepEqual(await wrongName.closed.then((c) => c.reason), 'wrong machine');

  const right = agent(m.agentToken, 'inc-1');
  assert.equal(await right.ready, true);
  await settle();
  const vms = await (await fetch(`${url}/api/vms`, { headers: bearer(A.apiToken) })).json();
  assert.deepEqual(vms.map((v: { name: string }) => v.name), ['inc-1']);
  right.ws.close();
});

test('a machine API token sees and drives its own machine, and nothing else of the tenant', async () => {
  const other = agent(A.agentToken, 'workspace-vm'); // the tenant's own machine, on the tenant's own token
  assert.equal(await other.ready, true);
  const m = (await (await issue(A.id, 'inc-2')).json()) as Machine;
  const mine = agent(m.agentToken, 'inc-2');
  await mine.ready;
  await settle(400);

  const tenantView = await (await fetch(`${url}/api/vms`, { headers: bearer(A.apiToken) })).json();
  const names = tenantView.map((v: { name: string }) => v.name);
  assert.ok(names.includes('inc-2') && names.includes('workspace-vm'), 'the tenant sees every machine it has ever had');
  const scoped = await (await fetch(`${url}/api/vms`, { headers: bearer(m.apiToken) })).json();
  assert.deepEqual(scoped.map((v: { name: string }) => v.name), ['inc-2']);
  const ownId = scoped[0].id as string;
  const otherId = tenantView.find((v: { name: string }) => v.name === 'workspace-vm').id as string;

  // its own machine: sessions, messages, interrupt
  assert.equal((await fetch(`${url}/api/vms/${ownId}/sessions`, { headers: bearer(m.apiToken) })).status, 200);
  assert.equal((await fetch(`${url}/api/vms/${ownId}/sessions`, { method: 'POST', headers: bearer(m.apiToken), body: JSON.stringify({ cwd: '.', text: 'hello' }) })).status, 202);
  // the tenant's other machine looks like it does not exist, for reading and for driving
  for (const [method, path] of [['GET', `/api/vms/${otherId}/sessions`], ['POST', `/api/vms/${otherId}/sessions`], ['POST', `/api/vms/${otherId}/sessions/x/interrupt`], ['GET', `/api/vms/${otherId}/projects`]] as const) {
    const r = await fetch(`${url}${path}`, { method, headers: bearer(m.apiToken), body: method === 'POST' ? JSON.stringify({ text: 'x' }) : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  // nothing tenant-wide
  assert.equal((await fetch(`${url}/api/tokens`, { headers: bearer(m.apiToken) })).status, 403);
  assert.equal((await fetch(`${url}/api/tokens`, { method: 'POST', headers: bearer(m.apiToken), body: '{}' })).status, 403);
  assert.equal((await fetch(`${url}/api/mcp-servers/evil`, { method: 'PUT', headers: bearer(m.apiToken), body: JSON.stringify({ url: 'https://evil.example/' }) })).status, 403);
  assert.equal((await fetch(`${url}/api/mcp-servers/escanor`, { method: 'DELETE', headers: bearer(m.apiToken) })).status, 403);
  assert.equal((await fetch(`${url}/api/logout`, { method: 'POST', headers: bearer(m.apiToken) })).status, 403);
  const overview = await (await fetch(`${url}/api/mcp-servers`, { headers: bearer(m.apiToken) })).json();
  assert.deepEqual(overview.vms.map((v: { name: string }) => v.name), ['inc-2'], 'the MCP overview lists only its own machine');
  other.ws.close();
  mine.ws.close();
});

test("another tenant's machine credentials and the tenant's own tokens do not cross", async () => {
  const mA = (await (await issue(A.id, 'inc-3')).json()) as Machine;
  const mB = (await (await issue(B.id, 'inc-3')).json()) as Machine; // the same name in another tenant is a different machine
  assert.notEqual(mA.agentToken, mB.agentToken);
  const a = agent(mA.agentToken, 'inc-3');
  await a.ready;
  await settle();
  assert.deepEqual((await (await fetch(`${url}/api/vms`, { headers: bearer(mB.apiToken) })).json()), [], 'B cannot see A\'s machine');
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(mA.agentToken) })).status, 401, 'an agent token is not an API token');
  assert.equal((await fetch(`${url}/admin/tenants`, { headers: bearer(mA.apiToken) })).status, 401);
  a.ws.close();
});

test('revoking a machine cuts its agent connection and its API token at once, and can be repeated', async () => {
  const m = (await (await issue(A.id, 'inc-4')).json()) as Machine;
  const live = agent(m.agentToken, 'inc-4');
  await live.ready;
  await settle();
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(m.apiToken) })).status, 200);

  const del = await fetch(`${url}/admin/tenants/${A.id}/machines/inc-4`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  assert.equal((await live.closed).reason, 'credential revoked');
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(m.apiToken) })).status, 401);
  assert.equal(await agent(m.agentToken, 'inc-4').ready, false, 'the agent token no longer opens a socket');
  assert.equal((await fetch(`${url}/admin/tenants/${A.id}/machines/inc-4`, { method: 'DELETE', headers: admin })).status, 404);
  assert.equal((await fetch(`${url}/admin/tenants/${A.id}/machines/inc-4`, { method: 'DELETE', headers: bearer(A.apiToken) })).status, 401);
});

test('issuing again for the same machine replaces the first pair and hangs up whoever held it', async () => {
  const first = (await (await issue(A.id, 'inc-5')).json()) as Machine;
  const a = agent(first.agentToken, 'inc-5');
  await a.ready;
  const second = (await (await issue(A.id, 'inc-5')).json()) as Machine;
  assert.equal((await a.closed).reason, 'credential revoked');
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(first.apiToken) })).status, 401);
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(second.apiToken) })).status, 200);
});

test('a credential stops working when it expires, and an open connection is closed when it does', async () => {
  const m = (await (await issue(A.id, 'inc-6', 1)).json()) as Machine;
  const live = agent(m.agentToken, 'inc-6');
  assert.equal(await live.ready, true);
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(m.apiToken) })).status, 200);
  assert.equal((await live.closed).reason, 'credential expired', 'the hub hangs up when the credential ends');
  assert.equal((await fetch(`${url}/api/vms`, { headers: bearer(m.apiToken) })).status, 401);
  assert.equal(await agent(m.agentToken, 'inc-6').ready, false);
});

test('the browser channel gives a machine token only its own machine\'s events', async () => {
  const other = agent(A.agentToken, 'workspace-vm-2');
  await other.ready;
  const m = (await (await issue(A.id, 'inc-7')).json()) as Machine;
  const mine = agent(m.agentToken, 'inc-7');
  await mine.ready;
  await settle(300);

  const heard: Array<{ type: string; name?: string }> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${m.apiToken}`);
  ws.on('message', (d) => heard.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  // Both machines connect/disconnect; the scoped listener must hear only inc-7.
  other.ws.close();
  mine.ws.close();
  await settle(400);
  assert.ok(heard.some((h) => h.type === 'vm_status' && h.name === 'inc-7'));
  assert.ok(!heard.some((h) => h.name === 'workspace-vm-2'), 'nothing about the tenant\'s other machine');
  ws.close();
  assert.equal(await new Promise((res) => { const bad = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${m.agentToken}`); bad.on('error', () => res('refused')); bad.on('unexpected-response', () => res('refused')); bad.on('open', () => res('open')); }), 'refused');
});
