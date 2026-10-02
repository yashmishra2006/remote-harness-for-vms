// Runs the real Worker + Durable Object under `wrangler dev --local` (workerd) and attacks it like the Node hub's hardening tests do.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import WebSocket from 'ws';

const PASSWORD = 'correct-horse-battery-staple-1234';
const AGENT = 'agent-token-abcdefghijklmnopqrstuvwx';
const json = { 'content-type': 'application/json' };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, ...json });
const cwd = new URL('..', import.meta.url).pathname;
mkdirSync(new URL('../../web/dist', import.meta.url).pathname, { recursive: true }); // the assets directory wrangler.toml points at (git-ignored build output)

const procs: ChildProcess[] = [];
after(() => procs.forEach((p) => p.kill()));

const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => res(port));
  });
});

async function startWorker(vars: Record<string, string> = {}) {
  const port = await freePort();
  const all = { APP_PASSWORD: PASSWORD, HUB_AGENT_TOKEN: AGENT, ...vars };
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--persist-to', `/tmp/wrangler-test-${port}`];
  for (const [k, v] of Object.entries(all)) args.push('--var', `${k}:${v}`);
  const proc = spawn('npx', args, { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' });
  procs.push(proc);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${url}/api/vms`);
      break;
    } catch {
      await settle(500);
    }
  }
  return { url, port, stop: () => proc.kill() };
}
type Worker = Awaited<ReturnType<typeof startWorker>>;
const login = async (w: Worker, password = PASSWORD) => ((await (await fetch(`${w.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password }) })).json()) as { token: string }).token;

function agent(w: Worker, vmName: string, token = AGENT) {
  const ws = new WebSocket(`ws://127.0.0.1:${w.port}/agent`, { headers: { authorization: `Bearer ${token}` } });
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  const hello = (name = vmName) => ws.send(JSON.stringify({ type: 'hello', agentVersion: '0.5.0', vmName: name, hostname: 'h', accounts: [], sessions: [] }));
  const ready = new Promise<void>((res) => ws.on('open', () => { hello(); res(); }));
  return { ws, inbox, ready, closed, hello };
}
const browser = (w: Worker, token: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${w.port}/ws`, ['escanor.hub.v1', `escanor.auth.${token}`]);
  const inbox: any[] = [];
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())); } catch { /* pong */ } });
  ws.on('error', () => {});
  const ready = new Promise<boolean>((res) => { ws.on('open', () => res(true)); ws.on('unexpected-response', () => res(false)); ws.on('error', () => res(false)); });
  return { ws, inbox, ready };
};
const vmsOf = async (w: Worker, token: string) => (await (await fetch(`${w.url}/api/vms`, { headers: bearer(token) })).json()) as { id: string; name: string; connected: boolean }[];

test('secrets: unset, short or placeholder secrets fail closed; "Bearer undefined" gets nowhere', async () => {
  const weak = await startWorker({ APP_PASSWORD: 'change-me-change-me-change-me' });
  assert.equal((await fetch(`${weak.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'change-me-change-me-change-me' }) })).status, 503);
  weak.stop();

  const w = await startWorker();
  const status = await new Promise<number>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}/agent`, { headers: { authorization: 'Bearer undefined' } });
    ws.on('unexpected-response', (_req, r) => res(r.statusCode ?? 0));
    ws.on('open', () => res(101));
    ws.on('error', () => res(-1));
  });
  assert.equal(status, 401);
  for (const body of [{}, { password: null }, { password: ['x'] }]) {
    const l = await fetch(`${w.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(l.status, 401);
  }
  w.stop();
});

test('malformed agent frames are dropped, the socket survives, and one socket speaks for one VM', async () => {
  const w = await startWorker();
  const token = await login(w);
  const a = agent(w, 'vm-frames');
  await a.ready;
  for (const f of ['null', '42', '[]', '{"type":"hello"}', '{"type":"sdk_message"}', '{"type":"mcp_status","servers":5,"liveSessions":1}', '{"type":"nope"}']) a.ws.send(f);
  await settle(500);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.deepEqual((await vmsOf(w, token)).map((v) => [v.name, v.connected]), [['vm-frames', true]]);
  a.hello('vm-other');
  assert.equal(await a.closed, 1008);
  assert.deepEqual((await vmsOf(w, token)).map((v) => v.name), ['vm-frames']);
  w.stop();
});

test('brute force is limited, bodies are capped before auth, and responses forbid framing', async () => {
  const w = await startWorker();
  const post = (password: string) => fetch(`${w.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password }) });
  const headers = (await fetch(`${w.url}/api/vms`)).headers;
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await fetch(`${w.url}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'x'.repeat(200_000) }) })).status, 413);
  assert.equal((await fetch(`${w.url}/api/vms/v/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'x'.repeat(2_000_000) }) })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await post('wrong')).status, 401);
  const locked = await post(PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  w.stop();
});

test('bodies are validated, offline VMs leave no ghost messages, "resolved" is only announced when delivered', async () => {
  const w = await startWorker();
  const token = await login(w);
  const a = agent(w, 'vm-val');
  await a.ready;
  const b = browser(w, token);
  await b.ready;
  await settle();
  const vmId = (await vmsOf(w, token))[0].id;
  const post = (path: string, body: unknown) => fetch(`${w.url}/api/vms/${vmId}${path}`, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) });

  for (const body of [{ images: 'abc' }, { text: { a: 1 } }, { text: 'hi', cwd: 5 }]) assert.equal((await post('/sessions', body)).status, 400, JSON.stringify(body));
  assert.equal((await post('/sessions/s1/permission-mode', { mode: 'rm' })).status, 400);
  assert.equal((await post('/sessions/s1/effort', { effort: 'extreme' })).status, 400);
  assert.equal((await post('/sessions/s1/permission-response', { requestId: 'r', behavior: 'yes' })).status, 400);

  assert.equal((await post('/sessions/s1/permission-response', { requestId: 'r1', behavior: 'allow' })).status, 202);
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'permission_resolved').length, 1);

  a.ws.close();
  await a.closed;
  await settle(600);
  b.inbox.length = 0;
  assert.equal((await post('/sessions/s1/permission-response', { requestId: 'r2', behavior: 'allow' })).status, 503);
  assert.equal((await post('/sessions/ghost/messages', { text: 'hello' })).status, 503);
  assert.equal((await post('/sessions', { text: 'hello' })).status, 503);
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'permission_resolved').length, 0);
  assert.deepEqual(await (await fetch(`${w.url}/api/vms/${vmId}/sessions/ghost/messages`, { headers: bearer(token) })).json(), []);
  w.stop();
});

test('a temporary session id keeps working after the real one exists (session_aliases, like the Node hub)', async () => {
  const w = await startWorker();
  const token = await login(w);
  const a = agent(w, 'vm-alias');
  await a.ready;
  await settle();
  const vmId = (await vmsOf(w, token))[0].id;
  const { tempId } = (await (await fetch(`${w.url}/api/vms/${vmId}/sessions`, { method: 'POST', headers: bearer(token), body: JSON.stringify({ text: 'first' }) })).json()) as { tempId: string };
  a.ws.send(JSON.stringify({ type: 'session_created', tempId, sessionId: 'real-1', cwd: '/w', title: 't', accountId: 'default' }));
  a.ws.send(JSON.stringify({ type: 'sdk_message', sessionId: 'real-1', message: { n: 1 } }));
  await settle(500);
  const viaTemp = await (await fetch(`${w.url}/api/vms/${vmId}/sessions/${tempId}/messages`, { headers: bearer(token) })).json() as any[];
  const viaReal = await (await fetch(`${w.url}/api/vms/${vmId}/sessions/real-1/messages`, { headers: bearer(token) })).json() as any[];
  assert.equal(viaTemp.length, 2, 'the alias resolves to the real session');
  assert.equal(viaReal.length, 2);
  await fetch(`${w.url}/api/vms/${vmId}/sessions/${tempId}/messages`, { method: 'POST', headers: bearer(token), body: JSON.stringify({ text: 'follow-up' }) });
  await settle();
  assert.ok(a.inbox.some((m) => m.type === 'user_input' && m.sessionId === 'real-1' && m.text === 'follow-up'), 'delivered to the real session id');
  w.stop();
});

test('history is capped and scoped; a malformed percent-escape is a 400, not a 500', async () => {
  const w = await startWorker();
  const token = await login(w);
  const a = agent(w, 'vm-hist');
  await a.ready;
  for (let i = 0; i < 5; i++) a.ws.send(JSON.stringify({ type: 'sdk_message', sessionId: 'sess', message: { i } }));
  await settle(600);
  const vmId = (await vmsOf(w, token))[0].id;
  const get = async (q = '') => (await (await fetch(`${w.url}/api/vms/${vmId}/sessions/sess/messages${q}`, { headers: bearer(token) })).json()) as any[];
  assert.equal((await get()).length, 5);
  assert.deepEqual((await get('?limit=2')).map((m) => m.message.i), [3, 4]);
  assert.equal((await fetch(`${w.url}/api/mcp-servers/%E0%A4%A`, { method: 'PUT', headers: bearer(token), body: JSON.stringify({ url: 'https://x.example/' }) })).status, 400);
  assert.equal((await fetch(`${w.url}/api/tokens/%E0%A4%A`, { method: 'DELETE', headers: bearer(token) })).status, 400);
  w.stop();
});

test('tokens: only a login mints one, tokens are scoped and expire, an MCP token can only manage MCP, ?token= is off', async () => {
  const w = await startWorker();
  const login1 = await login(w);
  const mint = (auth: string, body: unknown) => fetch(`${w.url}/api/tokens`, { method: 'POST', headers: bearer(auth), body: JSON.stringify(body) });
  const r = await mint(login1, { label: 'escanor', scope: 'mcp' });
  assert.equal(r.status, 201);
  const mcp = (await r.json()) as { token: string; scope: string; expiresAt: string };
  assert.equal(mcp.scope, 'mcp');
  assert.ok(Date.parse(mcp.expiresAt) > Date.now());
  assert.equal((await mint(mcp.token, { label: 'more' })).status, 403);
  assert.equal((await mint(login1, { label: 'x', scope: 'admin' })).status, 400);
  assert.equal((await mint(login1, { label: 'x', ttlSeconds: 5 })).status, 400);

  const asMcp = (path: string, init: RequestInit = {}) => fetch(`${w.url}/api${path}`, { ...init, headers: bearer(mcp.token) });
  assert.equal((await asMcp('/mcp-servers')).status, 200);
  assert.equal((await asMcp('/vms')).status, 403);
  assert.equal((await asMcp('/vms/x/sessions', { method: 'POST', body: JSON.stringify({ text: 'run' }) })).status, 403);
  assert.equal(await browser(w, mcp.token).ready, false, 'an MCP token must not stream transcripts');

  const viaQuery = await new Promise<boolean>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}/ws?token=${login1}`);
    ws.on('open', () => { ws.close(); res(true); });
    ws.on('error', () => res(false));
    ws.on('unexpected-response', () => res(false));
  });
  assert.equal(viaQuery, false);
  assert.equal(await browser(w, login1).ready, true);
  w.stop();
});

test('MCP registry: partial updates keep headers and flags, "false" strings and SSRF targets are refused', async () => {
  const w = await startWorker();
  const token = await login(w);
  const put = (name: string, body: unknown) => fetch(`${w.url}/api/mcp-servers/${name}`, { method: 'PUT', headers: bearer(token), body: JSON.stringify(body) });
  assert.equal((await put('escanor', { url: 'https://old.example/', headers: { Authorization: 'Bearer keep-me' }, autoAllow: false, autoAllowReads: true })).status, 200);
  assert.equal((await put('escanor', { url: 'https://new.example/' })).status, 200);
  const [s] = ((await (await fetch(`${w.url}/api/mcp-servers`, { headers: bearer(token) })).json()) as any).servers;
  assert.equal(s.url, 'https://new.example/');
  assert.deepEqual(s.headerNames, ['Authorization']);
  assert.equal(s.autoAllow, false);
  assert.equal(s.autoAllowReads, true);
  assert.equal((await put('o', { url: 'https://x.example/', autoAllow: 'false' })).status, 400);
  assert.equal((await put('a__b', { url: 'https://x.example/' })).status, 400);
  for (const url of ['http://169.254.169.254/', 'http://localhost:9/', 'http://10.0.0.1/']) assert.equal((await put('ssrf', { url })).status, 400, url);
  w.stop();
});
