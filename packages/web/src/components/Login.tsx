import { useState } from 'react';
import { useStore } from '../store';
import { checkHubReachable, getHubUrl, isNative, normalizeHubUrl, setHubUrl } from '../api';
import { useEscanor } from '../escanor/EscanorProvider';

export default function Login() {
  const { actions } = useStore();
  const { signInWithGoogle, notice, dismissNotice } = useEscanor();
  const [showPassword, setShowPassword] = useState(false);
  const native = isNative();
  const [hubUrl, setHubUrlInput] = useState(getHubUrl());
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function applyHubUrl() {
    const url = normalizeHubUrl(hubUrl);
    if (native && !url) throw new Error('Enter your hub URL first');
    if (url && url !== getHubUrl()) await checkHubReachable(url);
    setHubUrl(url);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await applyHubUrl();
      await actions.login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError(null);
    try {
      await applyHubUrl();
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[100svh] items-center justify-center bg-canvas px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-hairline bg-canvas p-8 shadow-panel">
        <div className="mb-7 flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-dark text-primary">
            <svg width="18" height="18" viewBox="0 0 100 100" fill="none">
              <path d="M35 22 L60 50 L35 78" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="60" y="66" width="10" height="20" rx="5" fill="currentColor" />
            </svg>
          </div>
          <div>
            <h1 className="font-display text-[28px] font-medium leading-tight tracking-[-0.01em] text-ink">Remote Harness</h1>
            <p className="text-sm text-muted">Sign in to control your sessions</p>
          </div>
        </div>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          value={hubUrl}
          onChange={(e) => setHubUrlInput(e.target.value)}
          placeholder={native ? 'Hub URL (https://hub.example.com)' : 'Hub URL (leave empty to use this server)'}
          className="mb-3 w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-base text-ink outline-none transition placeholder:text-muted-soft focus:border-primary focus:ring-4 focus:ring-primary/15"
        />
        <button
          type="button"
          onClick={() => void google()}
          disabled={busy || (native && !hubUrl)}
          className="mb-3 flex w-full items-center justify-center gap-2.5 rounded-md bg-primary px-4 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-active disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#fff" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 12.9 2 4 10.9 4 22s8.9 20 20 20c11 0 19.7-7.7 19.7-20 0-1.3-.1-2.7-.2-2z" /></svg>
          Continue with Google
        </button>
        {error && <p className="mb-3 text-sm text-error">{error}</p>}
        {notice && (
          <p className="mb-3 text-sm text-error" onClick={dismissNotice}>{notice}</p>
        )}
        {!showPassword && (
          <button type="button" onClick={() => setShowPassword(true)} className="mb-1 w-full text-center text-[13px] text-muted hover:text-ink">
            Use hub password instead
          </button>
        )}
        {showPassword && (<>
        <input
          type="password"
          autoFocus={!native}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mb-3 w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-base text-ink outline-none transition placeholder:text-muted-soft focus:border-primary focus:ring-4 focus:ring-primary/15"
        />
        <button
          type="submit"
          disabled={busy || !password || (native && !hubUrl)}
          className="w-full rounded-md bg-primary px-4 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-active disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        </>)}
      </form>
    </div>
  );
}
