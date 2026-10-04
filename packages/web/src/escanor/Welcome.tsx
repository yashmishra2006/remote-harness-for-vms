import { useState } from 'react';
import { escanor } from './client';
import EmailAuth from './EmailAuth';
import { AuthShell, Button, GoogleIcon, Notice } from './ui';
import { useEscanorSession } from './session';

export default function Welcome({ onAdvanced }: { onAdvanced: () => void }) {
  const { signInWithGoogle, beginEmailSignIn, finishEmailSignIn, busy, error, canSignInHere } = useEscanorSession();
  const [emailBusy, setEmailBusy] = useState(false);
  const [devEmail, setDevEmail] = useState('');
  // The email-only sign-in exists for developing against a local backend. A release build never shows it (the Android app's address is
  // also "localhost", and the production backend refuses it, as it must: it signs in as any address without a password).
  const dev = import.meta.env.DEV && window.location.hostname === 'localhost';
  const [devError, setDevError] = useState<string | null>(null);

  return (
    <AuthShell
      title="Welcome to Escanor"
      subtitle="Sign in once. Your assistant, its machine and your hub are set up for you."
      footer={<button onClick={onAdvanced} className="text-[13px] text-muted transition hover:text-ink">I run my own Remote Harness hub</button>}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!canSignInHere && <Notice tone="warn">Sign-in from this address is not supported. Open Escanor at app.escanor.in, or use the Android app.</Notice>}
      {canSignInHere && <EmailAuth begin={beginEmailSignIn} onCode={(code) => void finishEmailSignIn(code)} onBusy={setEmailBusy} />}
      <div className="flex items-center gap-3 py-1" aria-hidden="true">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-[12px] text-muted">or</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>
      <Button kind="quiet" onClick={() => void signInWithGoogle()} disabled={busy || emailBusy || !canSignInHere} className="flex w-full items-center justify-center gap-2.5 py-3">
        {busy ? null : <GoogleIcon />}
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </Button>
      {dev && (
        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            setDevError(null);
            void escanor.devLogin(devEmail).then(() => window.location.reload()).catch((err) => setDevError(err instanceof Error ? err.message : 'Dev sign-in failed.'));
          }}
        >
          <input value={devEmail} onChange={(e) => setDevEmail(e.target.value)} placeholder="dev email" aria-label="Dev email" className="min-w-0 flex-1 rounded-pill border border-hairline bg-canvas px-4 py-2 text-sm outline-none focus:border-primary" />
          <Button type="submit">Dev</Button>
        </form>
      )}
      {dev && devError && <Notice tone="error">{devError}</Notice>}
    </AuthShell>
  );
}
