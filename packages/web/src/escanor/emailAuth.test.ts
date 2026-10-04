import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callbackWithCode, createEmailAuthApi, digitsOnly, EmailAuthError, isEmail, passwordProblem, passwordStrength } from './emailAuth';

test('passwords are judged the way the server judges them', () => {
  assert.match(passwordProblem('short') ?? '', /at least 8/);
  assert.match(passwordProblem('password') ?? '', /easy to guess/);
  assert.match(passwordProblem('aaaaaaaaaa') ?? '', /easy to guess/);
  assert.match(passwordProblem('ada@example.com', 'Ada@Example.com') ?? '', /easy to guess/);
  assert.equal(passwordProblem('correct horse battery'), null);
  assert.match(passwordProblem('x'.repeat(200)) ?? '', /at most 128/);
});

test('the strength meter rises with length and variety and is zero for nothing', () => {
  assert.equal(passwordStrength(''), 0);
  assert.equal(passwordStrength('abc'), 0);
  assert.equal(passwordStrength('password'), 1);
  assert.ok(passwordStrength('correct horse battery') > passwordStrength('hunter22x'));
  assert.equal(passwordStrength('Correct-Horse-9-Battery'), 4);
});

test('a pasted code keeps only its digits', () => {
  assert.equal(digitsOnly('123 456'), '123456');
  assert.equal(digitsOnly('12-34-56-78'), '123456');
  assert.equal(digitsOnly('abc'), '');
});

test('email shape', () => {
  assert.equal(isEmail(' ada@example.com '), true);
  for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com']) assert.equal(isEmail(bad), false, bad);
});

test('a finished sign-in goes back to the callback with its code, and the page that wanted the person back', () => {
  assert.equal(callbackWithCode('https://www.escanor.in/auth/callback', 'esc_code_x'), 'https://www.escanor.in/auth/callback?code=esc_code_x');
  assert.equal(callbackWithCode('http://localhost:3000/auth/callback', 'c', '/dashboard/billing'), 'http://localhost:3000/auth/callback?code=c&next=%2Fdashboard%2Fbilling');
});

test('the calls send what the server expects and surface its words and its wait', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith('/auth/email/login')) return new Response(JSON.stringify({ detail: 'Incorrect email or password.', code: 'bad_credentials' }), { status: 401 });
    if (url.endsWith('/auth/email/resend')) return new Response(JSON.stringify({ detail: 'Wait 30 seconds.', code: 'cooldown', retry_after: 30 }), { status: 429 });
    if (url.endsWith('/auth/email/status')) return new Response(JSON.stringify({ available: true }));
    return new Response(JSON.stringify({ status: 'verification_sent', resend_after: 45 }));
  }) as unknown as typeof fetch;
  const api = createEmailAuthApi('https://api.test/api/v1', fake);

  assert.equal(await api.available(), true);
  const sent = await api.register({ email: 'a@b.co', password: 'x', name: 'A', redirectUri: 'https://site/auth/callback' });
  assert.equal(sent.status, 'verification_sent');
  assert.deepEqual(seen[1], { url: 'https://api.test/api/v1/auth/email/register', body: { email: 'a@b.co', password: 'x', name: 'A', redirect_uri: 'https://site/auth/callback', platform: 'web' } });

  await assert.rejects(api.login({ email: 'a@b.co', password: 'no', redirectUri: 'https://site/auth/callback' }), (e: unknown) => e instanceof EmailAuthError && e.status === 401 && e.message === 'Incorrect email or password.');
  await assert.rejects(api.resend('a@b.co'), (e: unknown) => e instanceof EmailAuthError && e.retryAfter === 30);
});

test('an app sends its platform and PKCE challenge with the flow', async () => {
  let body: Record<string, unknown> = {};
  const fake = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ status: 'verification_sent', resend_after: 45 }));
  }) as unknown as typeof fetch;
  await createEmailAuthApi('https://api.test', fake).register({ email: 'a@b.co', password: 'x', name: 'A', redirectUri: 'https://www.escanor.in/auth/mobile/login', platform: 'mobile', challenge: 'abc' });
  assert.equal(body.platform, 'mobile');
  assert.equal(body.code_challenge, 'abc');
  assert.equal(body.code_challenge_method, 'S256');
});

test('an unreachable server reads as a connection problem, and "available" fails closed', async () => {
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const api = createEmailAuthApi('https://api.test', down);
  assert.equal(await api.available(), false);
  await assert.rejects(api.forgot('a@b.co'), (e: unknown) => e instanceof EmailAuthError && e.code === 'network');
});
