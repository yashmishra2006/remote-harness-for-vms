import { CaretLeft, Eye, EyeSlash, EnvelopeSimple } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { escanorApiBase, loginRedirect } from './config';
import { CODE_LENGTH, createEmailAuthApi, digitsOnly, EmailAuthError, isEmail, passwordProblem, passwordStrength, type CodeSent, type Flow } from './emailAuth';
import { Button, Notice } from './ui';

type Step = 'signin' | 'signup' | 'verify' | 'forgot' | 'reset';

const METER = ['bg-hairline', 'bg-error', 'bg-warning', 'bg-primary/70', 'bg-primary'];
const METER_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong'];

const inputClass = 'w-full rounded-pill border border-hairline bg-canvas px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-muted focus:border-primary';

function Labelled({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] text-body">{label}</label>
      {children}
    </div>
  );
}

/** Six boxes drawn over one real input, so fast typing, pasting and the keyboard's one-time-code suggestion all work. */
function CodeBoxes({ value, onChange, onComplete, disabled }: { value: string; onChange: (next: string) => void; onComplete: (code: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => input.current?.focus(), []);
  const set = (next: string) => {
    const clean = digitsOnly(next);
    onChange(clean);
    if (clean.length === CODE_LENGTH && clean !== value) onComplete(clean);
  };
  const cursor = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <div className="relative" onClick={() => input.current?.focus()}>
      <input
        ref={input}
        value={value}
        onChange={(e) => set(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH * 2}
        disabled={disabled}
        aria-label="Six digit verification code"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 z-10 h-full w-full bg-transparent text-transparent opacity-0 outline-none"
      />
      <div className="flex justify-between gap-2" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <div key={i} className={`flex h-14 w-full min-w-0 items-center justify-center rounded-md border bg-canvas font-mono text-2xl text-ink transition ${focused && i === cursor ? 'border-primary ring-2 ring-primary/30' : value[i] ? 'border-primary/50' : 'border-hairline'} ${disabled ? 'opacity-50' : ''}`}>
            {value[i] ?? ''}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Email and password in the app: sign in, create an account (a six-digit code mailed to the address proves it), reset a forgotten
 * password. `begin` binds this attempt to this app instance (PKCE) and returns the challenge; `onCode` gets the finished sign-in's
 * one-time code, which the session trades for tokens exactly as it does after Google.
 */
export default function EmailAuth({ begin, onCode, onBusy }: { begin: () => Promise<string | undefined>; onCode: (code: string) => void; onBusy?: (busy: boolean) => void }) {
  const api = useMemo(() => createEmailAuthApi(escanorApiBase()), []);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    let live = true;
    void api.available().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const go = (to: Step) => {
    setStep(to);
    setError(null);
    setNotice(null);
    setCode('');
  };

  const run = useCallback(async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await job();
    } catch (e) {
      if (e instanceof EmailAuthError) {
        setError(e.message);
        if (e.code === 'cooldown' && e.retryAfter) setWait(e.retryAfter);
      } else setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const flow = async (): Promise<Flow> => ({ redirectUri: loginRedirect().uri, platform: 'mobile', challenge: await begin() });
  const sent = (result: CodeSent, message?: string) => {
    setWait(result.resend_after);
    setNotice(result.dev_code ? `Email is not configured on this server. Development code: ${result.dev_code}` : (message ?? null));
  };
  const need = (ok: boolean, message: string, code = 'invalid') => {
    if (!ok) throw new EmailAuthError(message, code, 400, null);
  };

  const submitSignIn = () =>
    run(async () => {
      need(isEmail(email), 'Enter a valid email address.');
      onCode((await api.login({ email: email.trim(), password, ...(await flow()) })).code);
    });
  const submitSignUp = () =>
    run(async () => {
      need(isEmail(email), 'Enter a valid email address.');
      const problem = passwordProblem(password, email);
      need(!problem, problem ?? '', 'weak_password');
      const result = await api.register({ email: email.trim(), password, name: name.trim(), ...(await flow()) });
      setStep('verify');
      sent(result);
    });
  const submitVerify = (digits: string) =>
    run(async () => {
      onCode((await api.verify({ email: email.trim(), code: digits })).code);
    });
  const submitForgot = () =>
    run(async () => {
      need(isEmail(email), 'Enter a valid email address.');
      const result = await api.forgot(email.trim());
      setStep('reset');
      sent(result);
    });
  const submitReset = () =>
    run(async () => {
      const problem = passwordProblem(password, email);
      need(!problem, problem ?? '', 'weak_password');
      need(code.length === CODE_LENGTH, 'Enter the six-digit code from the email.', 'bad_code');
      onCode((await api.reset({ email: email.trim(), code, password, ...(await flow()) })).code);
    });
  const resend = () => run(async () => sent(step === 'reset' ? await api.forgot(email.trim()) : await api.resend(email.trim()), 'A new code is on its way.'));

  if (available === false) return null; // the server cannot send mail: Google stays the one way in, with no dead form
  if (available === null) return <div className="h-40" aria-hidden="true" />;

  const strength = passwordStrength(password);
  const passwordField = (label: string, autoComplete: string, meter: boolean) => (
    <Labelled label={label} htmlFor="auth-password">
      <div className="relative">
        <input id="auth-password" type={show ? 'text' : 'password'} autoComplete={autoComplete} placeholder={meter ? 'At least 8 characters' : 'Your password'} value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClass} pr-12`} />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-4 top-1/2 -translate-y-1/2 text-muted">
          {show ? <EyeSlash size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {meter && password ? (
        <div className="mt-2 flex items-center gap-2" aria-live="polite">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => (
              <span key={n} className={`h-1 flex-1 rounded-pill transition ${strength >= n ? METER[strength] : 'bg-hairline'}`} />
            ))}
          </div>
          <span className="w-12 text-right text-[11px] text-muted">{METER_LABEL[strength]}</span>
        </div>
      ) : null}
    </Labelled>
  );
  const banner = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
    </>
  );
  const back = (to: Step, text: string) => (
    <button type="button" onClick={() => go(to)} className="flex items-center gap-1 text-[13px] text-muted transition hover:text-ink">
      <CaretLeft size={14} /> {text}
    </button>
  );

  if (step === 'verify' || step === 'reset') {
    const resetting = step === 'reset';
    return (
      <div className="space-y-4">
        {back(resetting ? 'forgot' : 'signup', 'Back')}
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-primary">
            <EnvelopeSimple size={20} />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-ink">Check your email</h2>
            <p className="mt-1 text-sm leading-relaxed text-body">We sent a six-digit code to <span className="font-medium text-ink">{email.trim()}</span>. It works for 10 minutes.</p>
          </div>
        </div>
        {banner}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (resetting) void submitReset();
            else if (code.length === CODE_LENGTH) void submitVerify(code);
          }}
        >
          <CodeBoxes value={code} onChange={setCode} onComplete={(digits) => !resetting && void submitVerify(digits)} disabled={busy} />
          {resetting && passwordField('New password', 'new-password', true)}
          <Button type="submit" disabled={busy || code.length !== CODE_LENGTH} className="w-full py-3">{busy ? 'Please wait…' : resetting ? 'Set password and sign in' : 'Verify and continue'}</Button>
        </form>
        <p className="text-center text-[13px] text-muted">
          Didn’t get it? Check spam, or{' '}
          <button type="button" disabled={busy || wait > 0} onClick={() => void resend()} className="text-primary underline disabled:text-muted disabled:no-underline">{wait > 0 ? `resend in ${wait}s` : 'send a new code'}</button>
        </p>
      </div>
    );
  }

  if (step === 'forgot') {
    return (
      <div className="space-y-3">
        {back('signin', 'Back to sign in')}
        <h2 className="text-lg font-semibold text-ink">Reset your password</h2>
        <p className="text-sm leading-relaxed text-body">Enter your email and we’ll send a code to choose a new one.</p>
        {banner}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitForgot();
          }}
        >
          <Labelled label="Email" htmlFor="auth-email">
            <input id="auth-email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </Labelled>
          <Button type="submit" disabled={busy} className="w-full py-3">{busy ? 'Sending…' : 'Send reset code'}</Button>
        </form>
      </div>
    );
  }

  const signingUp = step === 'signup';
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 rounded-pill border border-hairline p-1">
        {(['signin', 'signup'] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={step === tab} onClick={() => go(tab)} className={`rounded-pill py-2 text-[13px] font-medium transition ${step === tab ? 'bg-primary text-on-primary' : 'text-muted'}`}>
            {tab === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>
      {banner}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void (signingUp ? submitSignUp() : submitSignIn());
        }}
      >
        {signingUp && (
          <Labelled label="Name" htmlFor="auth-name">
            <input id="auth-name" type="text" autoComplete="name" placeholder="Alex Rivera" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Labelled>
        )}
        <Labelled label="Email" htmlFor="auth-email">
          <input id="auth-email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Labelled>
        {passwordField('Password', signingUp ? 'new-password' : 'current-password', signingUp)}
        {!signingUp && (
          <div className="text-right">
            <button type="button" onClick={() => go('forgot')} className="text-[12.5px] text-muted underline-offset-4 transition hover:text-ink hover:underline">Forgot password?</button>
          </div>
        )}
        <Button type="submit" disabled={busy} className="w-full py-3">{busy ? 'Please wait…' : signingUp ? 'Create account' : 'Sign in'}</Button>
      </form>
    </div>
  );
}
