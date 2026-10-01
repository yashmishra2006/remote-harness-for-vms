import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, getToken, setToken } from '../src/api';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
}, configurable: true });
let reloads = 0;
Object.defineProperty(globalThis, 'window', { value: { location: { reload: () => reloads++ } }, configurable: true });

test('a previous session response cannot populate the next session', async () => {
  setToken('old-session');
  const original = globalThis.fetch;
  globalThis.fetch = async () => { setToken('new-session'); return new Response(JSON.stringify([{ id: 'private-old-vm' }])); };
  try {
    await assert.rejects(api.listVms(), /Session changed/);
    assert.equal(getToken(), 'new-session');
  } finally { globalThis.fetch = original; }
});

test('a late 401 cannot log out a new session', async () => {
  setToken('old-session'); reloads = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { setToken('new-session'); return new Response('', { status: 401 }); };
  try {
    await assert.rejects(api.listVms(), /Session changed/);
    assert.equal(getToken(), 'new-session');
    assert.equal(reloads, 0);
  } finally { globalThis.fetch = original; }
});

test('stopped sockets cannot deliver private events after a new connection starts', async () => {
  const { HubSocket } = await import('../src/ws');
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    closed = false;
    constructor(public url: string, public protocols: string[]) { sockets.push(this); }
    close() { this.closed = true; this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  values.set('rh_hub_url', 'https://hub.example.test');
  setToken('first-session');
  const client = new HubSocket();
  let delivered = 0;
  const unsubscribe = client.subscribe(() => delivered++);
  try {
    client.connect();
    const first = sockets[0];
    assert.equal(first.url, 'wss://hub.example.test/ws');
    assert.deepEqual(first.protocols, ['escanor.hub.v1', 'escanor.auth.first-session']);
    client.stop();
    assert.equal(first.closed, true);
    setToken('second-session');
    client.connect();
    assert.equal(sockets.length, 2);
    first.onmessage?.({ data: '{"type":"vm_status"}' });
    first.onclose?.();
    assert.equal(delivered, 0);
    sockets[1].onmessage?.({ data: '{"type":"vm_status"}' });
    assert.equal(delivered, 1);
  } finally {
    unsubscribe(); client.stop(); globalThis.WebSocket = original; values.delete('rh_hub_url');
  }
});
