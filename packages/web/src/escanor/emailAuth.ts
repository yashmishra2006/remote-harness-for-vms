/**
 * Email and password sign-in, as the website talks to it. The server does the real checking (passwords are hashed there, codes are
 * mailed and limited there); what is here is the same set of rules in the form's own words, so a problem is shown before the
 * request, plus the calls themselves. A finished sign-in is handed back to /auth/callback exactly like a Google one.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const CODE_LENGTH = 6;

const COMMON = new Set(['password', '12345678', '123456789', '1234567890', 'qwertyuiop', 'iloveyou', '11111111', 'password1', 'abcd1234', 'letmein1', 'escanor123']);
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,}$/;

export const isEmail = (value: string): boolean => EMAIL.test(value.trim());

/** What is wrong with this password, in words for the person typing it, or null when it will be accepted. */
export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || (email && lowered === email.trim().toLowerCase()) || new Set(password).size < 4) return 'That password is too easy to guess.';
  return null;
}

/** 0 (nothing or refused) to 4. A guide for the meter only; the server's rules are the ones that count. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password || passwordProblem(password)) return password.length >= PASSWORD_MIN ? 1 : 0;
  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  else if (password.length >= 16) score += 1;
  return Math.min(4, score) as 1 | 2 | 3 | 4;
}

/** The digits of whatever was typed or pasted ("123 456", "123-456"), cut to one code's length. */
export const digitsOnly = (value: string): string => value.replace(/\D/g, '').slice(0, CODE_LENGTH);

/** Where a finished sign-in goes: the callback with the one-time code, and the page that wanted the person back. */
export function callbackWithCode(redirectUri: string, code: string, next?: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}

export class EmailAuthError extends Error {
  code: string;
  status: number;
  retryAfter: number | null;
  constructor(message: string, code: string, status: number, retryAfter: number | null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface Finished { status: 'ok'; code: string; redirect_uri: string }
export interface CodeSent { status: 'verification_sent' | 'sent'; email?: string; resend_after: number; expires_in?: number; dev_code?: string }

/**
 * Where a finished sign-in goes. The website only needs `redirectUri`. The apps also say which platform they are and send a PKCE
 * challenge, so the one-time code that comes back can only be redeemed by the app instance that asked for it.
 */
export interface Flow {
  redirectUri: string;
  platform?: 'web' | 'mobile';
  challenge?: string;
}

export interface EmailAuthApi {
  available(): Promise<boolean>;
  register(input: { email: string; password: string; name: string } & Flow): Promise<CodeSent>;
  verify(input: { email: string; code: string }): Promise<Finished>;
  login(input: { email: string; password: string } & Flow): Promise<Finished>;
  resend(email: string): Promise<CodeSent>;
  forgot(email: string): Promise<CodeSent>;
  reset(input: { email: string; code: string; password: string } & Flow): Promise<Finished>;
}

export function createEmailAuthApi(base: string, fetcher: typeof fetch = (...args) => fetch(...args)): EmailAuthApi {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new EmailAuthError('Could not reach Escanor. Check your connection and try again.', 'network', 0, null);
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : `Something went wrong (${response.status}).`;
      const retry = typeof data?.retry_after === 'number' ? data.retry_after : null;
      throw new EmailAuthError(detail, typeof data?.code === 'string' ? data.code : 'error', response.status, retry);
    }
    return data as T;
  }
  const flow = (f: Flow) => ({ redirect_uri: f.redirectUri, platform: f.platform ?? 'web', ...(f.challenge ? { code_challenge: f.challenge, code_challenge_method: 'S256' } : {}) });
  return {
    available: async () => (await call<{ available: boolean }>('/auth/email/status').catch(() => ({ available: false }))).available,
    register: ({ email, password, name, ...f }) => call('/auth/email/register', { email, password, name, ...flow(f) }),
    verify: ({ email, code }) => call('/auth/email/verify', { email, code }),
    login: ({ email, password, ...f }) => call('/auth/email/login', { email, password, ...flow(f) }),
    resend: (email) => call('/auth/email/resend', { email }),
    forgot: (email) => call('/auth/email/forgot', { email }),
    reset: ({ email, code, password, ...f }) => call('/auth/email/reset', { email, code, password, ...flow(f) }),
  };
}
