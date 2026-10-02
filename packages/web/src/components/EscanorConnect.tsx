import { useEffect, useState } from 'react';
import type { ApiTokenCreatedDto, ApiTokenDto, McpOverviewDto } from '@remote-harness/shared';
import { api, getHubUrl } from '../api';

// Where the Escanor web app lives; the "Claude cloud sessions" card is on its Integrations page.
const ESCANOR_INTEGRATIONS_URL = 'https://www.escanor.in/dashboard/integrations';
const SERVER_NAME = 'escanor';

// The address people use for this hub. In a browser the hub serves this app, so it is the page's
// own origin; the Android app has no such origin and remembers what was typed at sign-in.
function hubAddress(): string {
  return getHubUrl() || window.location.origin;
}

// Escanor's servers dial the hub, so an address that only works on this machine or its LAN cannot work.
function isPrivateAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'localhost' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied (insecure origin, embedded webview); fall back to selecting the text.
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-muted">{label}</p>
      <div className="flex items-center gap-2 rounded-md border border-hairline bg-canvas px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
          {secret && !shown ? '•'.repeat(24) : value}
        </code>
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-muted transition hover:bg-surface-card hover:text-ink"
          >
            {shown ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md bg-surface-card px-2.5 py-1 text-[12px] font-medium text-ink transition hover:bg-surface-cream-strong"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// A dedicated token for Escanor rather than this browser's login: signing out here never breaks it,
// and it can be revoked on its own. The value is shown once, when it is created.
function TokenSection() {
  const [tokens, setTokens] = useState<ApiTokenDto[]>([]);
  const [created, setCreated] = useState<ApiTokenCreatedDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTokens(await api.listApiTokens());
    } catch {
      // An older hub has no /tokens; the rest of the dialog still works.
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      // Escanor only installs and reads MCP servers, so it gets a token that can do exactly that.
      setCreated(await api.createApiToken('Escanor', 'mcp'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.deleteApiToken(id);
      if (created?.id === id) setCreated(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the token');
    }
  }

  return (
    <div>
      {created ? (
        <>
          <CopyRow label="Hub token for Escanor (shown once)" value={created.token} secret />
          <p className="mt-1.5 text-[12px] text-muted-soft">Copy it now. It is not shown again, but you can always generate another.</p>
        </>
      ) : (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="w-full rounded-md border border-hairline bg-canvas px-3 py-2.5 text-[13px] font-medium text-ink transition hover:bg-surface-card disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate a token for Escanor'}
        </button>
      )}
      {error && <p className="mt-2 text-[12.5px] text-error">{error}</p>}
      {tokens.length > 0 && (
        <ul className="mt-3 space-y-1">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-[12.5px] text-body">
              <span className="min-w-0 flex-1 truncate">
                {t.label} <span className="text-muted-soft">· {new Date(t.createdAt).toLocaleDateString()}</span>
              </span>
              <button type="button" onClick={() => revoke(t.id)} className="shrink-0 rounded px-1.5 py-0.5 text-muted transition hover:bg-surface-card hover:text-error">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EscanorConnect() {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<McpOverviewDto | null>(null);
  const [failed, setFailed] = useState(false);

  async function refresh() {
    try {
      setOverview(await api.getMcpOverview());
      setFailed(false);
    } catch {
      // An older hub has no /mcp-servers; the dialog still works for copying the details.
      setFailed(true);
    }
  }

  // Poll only while the dialog is open: this is how the user sees Escanor land on their machines.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [open]);

  // The sidebar badge needs the state without opening the dialog.
  useEffect(() => {
    void refresh();
  }, []);

  const installed = Boolean(overview?.servers.some((s) => s.name === SERVER_NAME));
  const address = hubAddress();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-body transition hover:bg-surface-card"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${installed ? 'bg-success' : 'bg-hairline'}`} />
        <span className="flex-1 truncate">{installed ? 'Escanor connected' : 'Connect to Escanor'}</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect to Escanor"
            className="max-h-[92svh] w-full max-w-md overflow-y-auto rounded-t-xl bg-canvas p-5 shadow-panel sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-[22px] font-medium leading-tight text-ink">Connect to Escanor</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Escanor installs its tools into every Claude session on every machine here — running chats included —
                  and turns them on. New machines get it automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 rounded-md px-2 py-1 text-lg leading-none text-muted transition hover:bg-surface-card hover:text-ink"
              >
                ×
              </button>
            </div>

            {installed && overview ? (
              <div className="mt-4 rounded-md border border-success/30 bg-success/10 px-3.5 py-3">
                <p className="text-[13px] font-medium text-ink">Escanor is installed</p>
                <ul className="mt-1.5 space-y-1">
                  {overview.vms.map((vm) => {
                    const status = vm.servers.find((s) => s.name === SERVER_NAME)?.status;
                    const label = !vm.connected
                      ? 'offline — installs when it reconnects'
                      : !vm.mcpSupported
                        ? 'agent needs updating to receive it'
                        : status === 'connected'
                        ? 'connected'
                        : status === 'failed' || status === 'needs-auth'
                          ? `${status}${vm.servers.find((s) => s.name === SERVER_NAME)?.error ? `: ${vm.servers.find((s) => s.name === SERVER_NAME)?.error}` : ''}`
                          : 'installing…';
                    return (
                      <li key={vm.vmId} className="flex items-center gap-2 text-[12.5px] text-body">
                        <span className={`h-1.5 w-1.5 rounded-full ${vm.connected ? 'bg-success' : 'bg-hairline'}`} />
                        <span className="font-medium">{vm.name}</span>
                        <span className="text-muted">{label}</span>
                      </li>
                    );
                  })}
                  {overview.vms.length === 0 && <li className="text-[12.5px] text-muted">No machines have connected yet.</li>}
                </ul>
              </div>
            ) : (
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-[13px] text-body">
                <li>Copy your hub URL and generate a token below.</li>
                <li>
                  In Escanor, open <span className="font-medium">Integrations → Claude cloud sessions</span>.
                </li>
                <li>Paste them and press Connect. That's it.</li>
              </ol>
            )}

            <div className="mt-4 space-y-3">
              <CopyRow label="Hub URL" value={address} />
              <TokenSection />
            </div>

            {isPrivateAddress(address) && (
              <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] leading-relaxed text-body">
                This address only works on your own network. Escanor connects to your hub from the internet, so put the
                hub behind a public https:// address (a reverse proxy, a tunnel, or the Cloudflare Worker hub) and use
                that URL.
              </p>
            )}
            {failed && !overview && (
              <p className="mt-3 text-[12px] text-muted">
                Could not read the install status from this hub. If it is an older release, update it to let Escanor install.
              </p>
            )}

            <p className="mt-3 text-[12px] leading-relaxed text-muted-soft">
              A token gives full access to this hub. Only paste it into Escanor, which stores it encrypted and uses it
              solely to install and update the MCP. Revoke it here any time; signing out of this browser does not affect it.
            </p>

            <a
              href={ESCANOR_INTEGRATIONS_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-4 block w-full rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-on-primary transition hover:bg-primary-active"
            >
              Open Escanor
            </a>
          </div>
        </div>
      )}
    </>
  );
}
