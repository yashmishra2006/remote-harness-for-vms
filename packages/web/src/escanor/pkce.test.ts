import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { challengeFor, createPkcePair } from './pkce';

// RFC 7636 appendix B
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('pkce', () => {
  it('derives the S256 challenge from the RFC 7636 test vector', async () => {
    assert.equal(await challengeFor(RFC_VERIFIER), RFC_CHALLENGE);
  });

  it('creates a verifier of valid length/alphabet and a matching challenge', async () => {
    const pair = await createPkcePair();
    assert.ok(pair);
    assert.match(pair.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(pair.challenge, await challengeFor(pair.verifier));
    assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a verifier', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    assert.notEqual(a!.verifier, b!.verifier);
  });
});
