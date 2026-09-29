import { useEffect, useMemo, useState } from 'react';
import { useEscanor } from '../escanor/EscanorProvider';
import { snapshotCatalog, type CatalogProvider } from '../escanor/client';
import PageShell from './PageShell';

export default function IntegrationsView({ className, onMenu }: { className: string; onMenu: () => void }) {
  const { session, catalog, connections, catalogError, notice, dismissNotice, signInWithGoogle, refreshIntegrations } = useEscanor();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session) void refreshIntegrations();
  }, [session]);

  const connected = useMemo(() => new Set(connections.filter((c) => c.isActive).map((c) => c.providerId)), [connections]);
  const q = query.trim().toLowerCase();
  const cats = useMemo(() => (session && catalog ? catalog : snapshotCatalog()), [session, catalog]);

  return (
    <PageShell title="Integrations" onMenu={onMenu} className={className}>
      <div className="mx-auto max-w-2xl px-4 py-5">
        {notice && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-hairline bg-surface-soft px-3 py-2 text-[13px] text-body">
            <span>{notice}</span>
            <button onClick={dismissNotice} className="text-muted-soft">×</button>
          </div>
        )}

        {!session && (
          <div className="mb-5 rounded-xl border border-hairline bg-surface-soft p-4">
            <p className="text-[14px] font-medium text-ink">Sign in to connect integrations</p>
            <p className="mt-0.5 text-[13px] text-muted">Integrations are tied to your Escanor account. Browse what's available below.</p>
            <button onClick={() => void signInWithGoogle().catch((e) => setError(e.message))} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-active">
              Continue with Google
            </button>
          </div>
        )}
        {(error || catalogError) && <p className="mb-4 text-sm text-error">{error ?? catalogError}</p>}
        <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search integrations"
              className="mb-5 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink outline-none placeholder:text-muted-soft focus:border-primary md:text-[13px]"
            />
            {session && !catalog && !catalogError && <p className="text-sm text-muted-soft">Loading…</p>}
            {cats.map((cat) => {
              const providers = cat.providers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
              if (providers.length === 0) return null;
              return (
                <section key={cat.id} className="mb-6">
                  <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-soft">{cat.label}</h3>
                  <div className="overflow-hidden rounded-xl border border-hairline">
                    {providers.map((p, i) => (
                      <ProviderRow key={p.id} p={p} first={i === 0} signedIn={!!session} isConnected={p.connected || connected.has(p.id)} />
                    ))}
                  </div>
                </section>
              );
            })}
        </>
      </div>
    </PageShell>
  );
}

function ProviderRow({ p, first, isConnected, signedIn }: { p: CatalogProvider; first: boolean; isConnected: boolean; signedIn: boolean }) {
  const { signInWithGoogle, connectProvider, connectWithSecret, disconnectProvider } = useEscanor();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const fields = p.mode === 'credentials' && p.credentialFields.length > 0 ? p.credentialFields : [p.tokenLabel ?? 'API token'];
  const ready = fields.every((f) => (values[f] ?? '').trim());

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setOpen(false);
      setValues({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    void run(() =>
      p.mode === 'credentials' && p.credentialFields.length > 0
        ? connectWithSecret(p.id, { credentials: Object.fromEntries(fields.map((f) => [f, values[f].trim()])) })
        : connectWithSecret(p.id, { accessToken: values[fields[0]].trim() }),
    );
  }

  const btn = 'rounded-md border border-hairline px-3 py-1.5 text-[13px] text-ink transition hover:bg-surface-card disabled:opacity-50';
  let action;
  if (isConnected) {
    action = (
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-success/15 px-2.5 py-1 text-[12px] font-medium text-success">Connected</span>
        <button disabled={busy} onClick={() => void run(() => disconnectProvider(p.id))} className="text-[12px] text-muted-soft hover:text-error">
          Disconnect
        </button>
      </div>
    );
  } else if (p.status !== 'live') {
    action = <span className="text-[12px] text-muted-soft">Planned</span>;
  } else if (!signedIn) {
    action = (
      <button onClick={() => void run(() => signInWithGoogle())} className={btn}>
        Connect
      </button>
    );
  } else if (p.mode === 'oauth') {
    action = (
      <button disabled={busy} onClick={() => void run(() => connectProvider(p.id))} className={btn}>
        {busy ? 'Opening…' : 'Connect'}
      </button>
    );
  } else if (p.mode === 'api_key' || p.mode === 'credentials') {
    action = (
      <div className="flex items-center gap-2">
        {p.mode === 'api_key' && p.oauthAvailable && (
          <button disabled={busy} onClick={() => void run(() => connectProvider(p.id))} className={btn}>
            OAuth
          </button>
        )}
        <button onClick={() => setOpen((o) => !o)} className={btn}>
          {open ? 'Cancel' : p.mode === 'api_key' ? 'Add key' : 'Add credentials'}
        </button>
      </div>
    );
  } else {
    action = <span className="text-[12px] text-muted-soft">Set up on web</span>;
  }

  return (
    <div className={`bg-canvas px-4 py-3 ${first ? '' : 'border-t border-hairline'}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{p.name}</p>
          <p className="truncate text-[12px] text-muted-soft">{p.description}</p>
        </div>
        {action}
      </div>
      {open && !isConnected && (
        <div className="mt-3 space-y-2">
          {fields.map((f) => (
            <input
              key={f}
              type="password"
              autoComplete="off"
              value={values[f] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              placeholder={f}
              className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink outline-none placeholder:text-muted-soft focus:border-primary md:text-[13px]"
            />
          ))}
          <div className="flex items-center gap-3">
            <button disabled={busy || !ready} onClick={save} className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-on-primary hover:bg-primary-active disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
            {p.helpUrl && (
              <a href={p.helpUrl} target="_blank" rel="noreferrer" className="text-[12px] text-muted hover:text-ink">
                Where do I find this?
              </a>
            )}
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-[12px] text-error">{err}</p>}
    </div>
  );
}
