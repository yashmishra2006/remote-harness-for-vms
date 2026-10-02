// PKCE (RFC 7636, S256). The Android sign-in returns through a custom-scheme deep link that any installed
// app can also register, so the one-time login code is bound to a secret only this app holds.

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// null when Web Crypto's digest isn't available (plain-http pages are not secure contexts); the server
// still accepts a login without a challenge unless the operator has made PKCE mandatory.
export async function createPkcePair(): Promise<{ verifier: string; challenge: string } | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await challengeFor(verifier) };
}
