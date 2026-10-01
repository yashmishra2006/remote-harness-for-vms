import LegalLinks from './LegalLinks';
import { useState } from 'react';
import { useStore } from '../store';
import { getHubUrl, isNative, setHubUrl } from '../api';
import { AuthShell, Button, Notice } from '../escanor/ui';

const FIELD = 'w-full rounded-md border border-line-strong bg-surface-dark-soft px-4 py-3 text-base text-ink outline-none transition placeholder:text-muted-soft focus:border-primary focus:ring-4 focus:ring-primary/15';

/** Sign in to a hub you host yourself. Same frame as the Escanor sign-in, so the two never feel like different apps. */
export default function Login() {
  const { actions } = useStore();
  const native = isNative();
  const [hubUrl, setHubUrlInput] = useState(getHubUrl());
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (native) {
        const url = hubUrl.trim();
        if (!/^https?:\/\//.test(url)) throw new Error('Hub URL must start with http:// or https://');
        setHubUrl(url);
      }
      await actions.login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Your hub" subtitle="Sign in to the hub you run yourself.">
      <form onSubmit={submit} className="space-y-4">
        {native && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Hub URL</span>
            <input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" value={hubUrl} onChange={(e) => setHubUrlInput(e.target.value)} placeholder="https://hub.example.com" className={FIELD} />
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Password</span>
          <input type="password" autoFocus={!native} value={password} onChange={(e) => setPassword(e.target.value)} className={FIELD} />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy || !password || (native && !hubUrl)} className="w-full py-3">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <LegalLinks />
      </form>
    </AuthShell>
  );
}
