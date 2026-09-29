import { useState } from 'react';
import { checkHubReachable, getHubUrl, isNative, normalizeHubUrl, setHubUrl } from '../api';
import { useEscanor } from '../escanor/EscanorProvider';
import PageShell from './PageShell';

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-start justify-between gap-4 border-t border-hairline px-4 py-3 first:border-t-0">
    <span className="text-[13px] text-muted">{label}</span>
    <span className="min-w-0 break-all text-right text-[13px] text-ink">{value}</span>
  </div>
);

function normalizeHubUrlSafe(v: string): string {
  try {
    return normalizeHubUrl(v);
  } catch {
    return v;
  }
}

export default function SettingsView({ className, onMenu }: { className: string; onMenu: () => void }) {
  const { session, hubId, signOut, mcpConnected, connectMcp, disconnectMcp } = useEscanor();
  const [hubInput, setHubInput] = useState(getHubUrl());
  const [hubBusy, setHubBusy] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const hubDirty = normalizeHubUrlSafe(hubInput) !== getHubUrl();

  // The sign-in belongs to the old hub, so switching hubs signs out and returns to the login screen.
  async function saveHub() {
    setHubBusy(true);
    setHubError(null);
    try {
      const url = normalizeHubUrl(hubInput);
      if (isNative() && !url) throw new Error('Enter your hub URL');
      if (url) await checkHubReachable(url);
      setHubUrl(url);
      signOut();
      window.location.reload();
    } catch (e) {
      setHubError(e instanceof Error ? e.message : 'Could not change hub');
    } finally {
      setHubBusy(false);
    }
  }

  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  async function toggleMcp() {
    setMcpBusy(true);
    setMcpError(null);
    try {
      await (mcpConnected ? disconnectMcp() : connectMcp());
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setMcpBusy(false);
    }
  }

  return (
    <PageShell title="Settings" onMenu={onMenu} className={className}>
      <div className="mx-auto max-w-2xl px-4 py-5">
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-soft">Account</h3>
        <div className="mb-6 overflow-hidden rounded-xl border border-hairline bg-canvas">
          <Row label="Name" value={session?.user.name ?? '—'} />
          <Row label="Email" value={session?.user.email ?? 'Signed in with hub password'} />
          <Row label="Hub ID" value={hubId ?? '—'} />
        </div>

        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-soft">Hub</h3>
        <div className="mb-6 rounded-xl border border-hairline bg-canvas px-4 py-3">
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            value={hubInput}
            onChange={(e) => setHubInput(e.target.value)}
            placeholder={`Empty = this server (${window.location.origin})`}
            className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink outline-none placeholder:text-muted-soft focus:border-primary md:text-[13px]"
          />
          <p className="mt-1.5 text-[12px] text-muted-soft">Changing the hub signs you out.</p>
          <div className="mt-2 flex items-center gap-3">
            <button
              disabled={hubBusy || !hubDirty}
              onClick={() => void saveHub()}
              className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-on-primary hover:bg-primary-active disabled:opacity-40"
            >
              {hubBusy ? 'Checking…' : 'Save'}
            </button>
            {getHubUrl() && !isNative() && (
              <button onClick={() => setHubInput('')} className="text-[12px] text-muted hover:text-ink">
                Use this server
              </button>
            )}
          </div>
          {hubError && <p className="mt-2 text-[12px] text-error">{hubError}</p>}
        </div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-soft">Escanor MCP</h3>
        <div className="mb-6 rounded-xl border border-hairline bg-canvas px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-ink">{mcpConnected ? 'Attached to Claude sessions' : 'Not attached'}</p>
              <p className="text-[12px] text-muted-soft">
                {session ? 'Claude sessions on this hub can use your Escanor integrations. Applies to new or resumed chats.' : 'Sign in with Google to attach your Escanor MCP.'}
              </p>
            </div>
            {(session || mcpConnected) && (
              <button
                disabled={mcpBusy || mcpConnected === null}
                onClick={() => void toggleMcp()}
                className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-[13px] text-ink hover:bg-surface-card disabled:opacity-50"
              >
                {mcpBusy ? 'Working…' : mcpConnected ? 'Disconnect' : 'Connect'}
              </button>
            )}
          </div>
          {mcpError && <p className="mt-2 text-[12px] text-error">{mcpError}</p>}
        </div>
        <button onClick={signOut} className="rounded-md border border-hairline px-4 py-2.5 text-sm text-error hover:bg-surface-card">
          Sign out
        </button>
      </div>
    </PageShell>
  );
}
