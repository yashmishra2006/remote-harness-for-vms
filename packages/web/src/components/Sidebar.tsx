import { useEffect, useMemo, useState } from 'react';
import type { ClaudeAccount, SessionDto } from '@remote-harness/shared';
import { useStore } from '../store';
import { useEscanor } from '../escanor/EscanorProvider';
import UserMenu from './UserMenu';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const PersonIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
    <path d="M4 20c0-4 3.5-6 8-6s8 2 8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

function SessionRow({ s, active, onClick }: { s: SessionDto; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition hover:bg-surface-card ${active ? 'bg-surface-card' : ''}`}
    >
      <span className={`flex items-center gap-1.5 truncate text-[13px] ${active ? 'font-medium text-ink' : 'text-body'}`}>
        {s.status === 'active' && <span className="h-1.5 w-1.5 shrink-0 animate-pulseDot rounded-full bg-primary" />}
        <span className="truncate">{s.title}</span>
      </span>
      <span className="truncate text-[11px] text-muted-soft">{relativeTime(s.lastMessageAt)} ago · {s.cwd}</span>
    </button>
  );
}

function NewChatRow({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-primary transition hover:bg-primary/10">
      <span className="text-base leading-none">+</span> New chat
    </button>
  );
}

const NavRow = ({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition hover:bg-surface-card ${active ? 'bg-surface-card font-medium text-ink' : 'text-body'}`}
  >
    <span className="flex h-4 w-4 items-center justify-center text-muted">{icon}</span>
    {label}
  </button>
);

export default function Sidebar({
  className,
  view,
  onSelectSession,
  onOpenIntegrations,
  onOpenSettings,
}: {
  className: string;
  view: 'chat' | 'integrations' | 'settings';
  onSelectSession: () => void;
  onOpenIntegrations: () => void;
  onOpenSettings: () => void;
}) {
  const { state, actions } = useStore();
  const [expandedVmId, setExpandedVmId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const { session } = useEscanor();

  useEffect(() => {
    actions.refreshVms();
  }, []);

  useEffect(() => {
    if (!expandedVmId && state.vms.length > 0) {
      const vmId = state.vms[0].id;
      setExpandedVmId(vmId);
      actions.selectVm(vmId);
    }
  }, [state.vms]);

  function toggleVm(vmId: string) {
    const opening = expandedVmId !== vmId;
    setExpandedVmId(opening ? vmId : null);
    if (opening) actions.selectVm(vmId);
  }

  function pickSession(vmId: string, session: SessionDto) {
    actions.selectSession(vmId, session.id, session.accountId);
    if (!state.messagesBySession[session.id]) actions.loadMessages(vmId, session.id);
    onSelectSession();
  }

  function newChat(vmId: string, accountId: string) {
    actions.selectSession(vmId, null, accountId);
    onSelectSession();
  }

  function startNewChat() {
    const vm = state.vms.find((v) => v.id === state.selectedVmId) ?? state.vms[0];
    if (!vm) return;
    newChat(vm.id, vm.accounts?.[0]?.id ?? 'default');
  }

  const q = query.trim().toLowerCase();
  function matchSession(s: SessionDto): boolean {
    return !q || s.title.toLowerCase().includes(q);
  }

  return (
    <div className={`${className} safe-top h-full w-full flex-col border-r border-hairline bg-surface-soft`}>
      <div className="flex items-center gap-2.5 px-5 pb-3 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-dark text-primary">
          <svg width="14" height="14" viewBox="0 0 100 100" fill="none">
            <path d="M35 22 L60 50 L35 78" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="60" y="66" width="10" height="20" rx="5" fill="currentColor" />
          </svg>
        </div>
        <h1 className="text-[15px] font-semibold tracking-tight text-ink">Remote Harness</h1>
      </div>

      <div className="space-y-0.5 px-3 pb-2">
        <NavRow
          active={view === 'chat' && !state.selectedSessionId}
          onClick={startNewChat}
          label="New chat"
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>}
        />
        <NavRow
          active={view === 'integrations'}
          onClick={onOpenIntegrations}
          label="Integrations"
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 01-10 0V8zM12 17v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        />
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-hairline bg-canvas px-3 py-2 transition focus-within:border-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-muted-soft">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M21 21l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted-soft md:text-[13px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        {state.vms.length === 0 && (
          <p className="px-3 py-6 text-sm text-muted-soft">No VMs connected yet. Install the agent on a server to see it here.</p>
        )}
        {state.vms.map((vm) => {
          const sessions = state.sessionsByVm[vm.id] ?? [];
          const expanded = expandedVmId === vm.id;
          const accounts: ClaudeAccount[] = vm.accounts?.length ? vm.accounts : [{ id: 'default', label: 'default' }];
          const multiAccount = accounts.length > 1;

          return (
            <div key={vm.id} className="mb-1">
              <button
                onClick={() => toggleVm(vm.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition hover:bg-surface-card"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${vm.connected ? 'bg-success' : 'bg-hairline'}`} />
                <span className="flex-1 truncate text-sm font-medium text-ink">{vm.name}</span>
                <svg className={`h-3.5 w-3.5 text-muted-soft transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none">
                  <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {expanded && !multiAccount && (
                <div className="ml-3.5 border-l border-hairline pl-2.5">
                  {!q && <NewChatRow onClick={() => newChat(vm.id, accounts[0].id)} />}
                  {sessions.filter(matchSession).map((s) => (
                    <SessionRow key={s.id} s={s} active={state.selectedSessionId === s.id} onClick={() => pickSession(vm.id, s)} />
                  ))}
                  {sessions.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted-soft">No sessions yet</p>}
                </div>
              )}

              {expanded && multiAccount && (
                <div className="ml-3.5 space-y-2 border-l border-hairline pl-2.5">
                  {accounts.map((account) => {
                    const accountSessions = sessions.filter((s) => s.accountId === account.id).filter(matchSession);
                    return (
                      <div key={account.id}>
                        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-soft">
                          <PersonIcon />
                          {account.label}
                        </div>
                        {!q && <NewChatRow onClick={() => newChat(vm.id, account.id)} />}
                        {accountSessions.map((s) => (
                          <SessionRow key={s.id} s={s} active={state.selectedSessionId === s.id} onClick={() => pickSession(vm.id, s)} />
                        ))}
                        {accountSessions.length === 0 && !q && <p className="px-2.5 py-1.5 text-[12px] text-muted-soft">No sessions yet</p>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <UserMenu session={session} onOpenSettings={onOpenSettings} />
    </div>
  );
}
