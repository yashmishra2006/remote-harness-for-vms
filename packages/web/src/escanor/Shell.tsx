import { Desktop, Laptop, PencilSimpleLine, PlugsConnected, Trash, UserCircle, X, type Icon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import AccountView from './AccountView';
import AssistantView from './AssistantView';
import ComputersView from './computer/ComputersView';
import { escanor } from './client';
import { useLoad } from './hooks';
import IntegrationsView from './IntegrationsView';
import { useEscanorSession } from './session';
import { Logo, NavContext } from './ui';

export type Tab = 'assistant' | 'connections' | 'computers' | 'machines' | 'account';

const PAGES: Array<{ id: Exclude<Tab, 'assistant'>; label: string; Icon: Icon }> = [
  { id: 'connections', label: 'Connections', Icon: PlugsConnected },
  { id: 'computers', label: 'Computers', Icon: Laptop },
  { id: 'machines', label: 'Machines', Icon: Desktop },
  { id: 'account', label: 'Account', Icon: UserCircle },
];

interface NavProps {
  tab: Tab;
  conversationId: string | null;
  conversations: Array<{ id: string; title: string }>;
  onPick: (t: Tab) => void;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  /** Icons only (tablets) or icons with names and the chat list (desktop, phone drawer). */
  expanded: boolean;
}

/** The navigation, laid out like the Claude app: new chat, the places, then your recent chats, then you. */
function Nav({ tab, conversationId, conversations, onPick, onNewChat, onOpenChat, onDeleteChat, expanded }: NavProps) {
  const { user } = useEscanorSession();
  const hide = expanded ? '' : 'md:hidden';
  const center = expanded ? '' : 'md:justify-center md:px-0';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex items-center gap-3 px-5 pb-4 pt-5 ${expanded ? '' : 'md:justify-center md:px-0'}`}>
        <Logo size={34} />
        <span className={`text-[17px] font-semibold tracking-tight text-ink ${hide}`}>Escanor</span>
      </div>

      <div className="px-3">
        <button onClick={onNewChat} title="New chat" className={`group flex w-full items-center gap-3 rounded-pill px-3.5 py-2.5 text-[15px] font-medium text-ink outline-none transition hover:bg-surface-card focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-[0.98] ${center}`}>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-on-primary"><PencilSimpleLine size={14} weight="bold" /></span>
          <span className={hide}>New chat</span>
        </button>
      </div>

      <nav aria-label="Main" className="mt-1 flex flex-col gap-0.5 px-3">
        {PAGES.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button key={id} onClick={() => onPick(id)} aria-current={active ? 'page' : undefined} title={label} className={`flex items-center gap-3 rounded-pill px-3.5 py-2.5 text-[15px] outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-[0.98] ${center} ${active ? 'bg-surface-card font-medium text-ink' : 'text-body hover:bg-surface-card/60 hover:text-ink'}`}>
              <Icon size={22} weight={active ? 'fill' : 'regular'} aria-hidden className={active ? 'text-primary' : ''} />
              <span className={hide}>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className={`mt-4 min-h-0 flex-1 overflow-y-auto px-3 ${hide}`}>
        {conversations.length > 0 && <h2 className="px-3.5 pb-1.5 text-[12px] font-medium text-muted">Recents</h2>}
        <ul className="space-y-0.5 pb-2">
          {conversations.map((c) => {
            const active = tab === 'assistant' && c.id === conversationId;
            return (
              <li key={c.id} className={`group relative rounded-pill transition ${active ? 'bg-surface-card' : 'hover:bg-surface-card/60'}`}>
                <button onClick={() => onOpenChat(c.id)} className={`block w-full truncate rounded-pill py-2 pl-3.5 pr-10 text-left text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${active ? 'text-ink' : 'text-body group-hover:text-ink'}`}>{c.title}</button>
                <button onClick={() => onDeleteChat(c.id)} aria-label={`Delete ${c.title}`} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted opacity-100 transition hover:bg-surface-cream-strong hover:text-error focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"><Trash size={16} /></button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-auto border-t border-hairline px-3 py-3">
        <button onClick={() => onPick('account')} className={`flex w-full items-center gap-3 rounded-pill p-2 text-left transition hover:bg-surface-card ${expanded ? '' : 'md:justify-center'}`} title={user?.email}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-card text-sm font-semibold text-ink">{(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}</span>
          <span className={`min-w-0 ${hide}`}>
            <span className="block truncate text-sm font-medium text-ink">{user?.name}</span>
            <span className="block truncate text-[12px] text-muted">{user?.email}</span>
          </span>
        </button>
      </div>
    </div>
  );
}

/** The signed-in app: a sidebar on wide screens, a drawer on phones. `machines` is the Remote Harness (hub) view. */
export default function Shell({ machines }: { machines: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>('assistant');
  // Screens stay mounted once opened, so going back to one is instant and keeps its place.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['assistant']));
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const chats = useLoad(() => escanor.conversations().catch(() => []), 30000);
  const list = chats.data ?? [];

  const show = useCallback((t: Tab) => { setTab(t); setVisited((v) => (v.has(t) ? v : new Set(v).add(t))); setDrawer(false); }, []);
  const openChat = useCallback((id: string | null) => { setConversationId(id); show('assistant'); }, [show]);
  const removeChat = useCallback((id: string) => {
    const title = list.find((c) => c.id === id)?.title ?? 'this chat';
    if (!window.confirm(`Delete “${title}”?`)) return;
    void escanor.remove(id).then(() => { if (id === conversationId) setConversationId(null); chats.reload(); });
  }, [list, conversationId, chats]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const nav = (expanded: boolean) => (
    <Nav tab={tab} conversationId={conversationId} conversations={list} onPick={show} onNewChat={() => openChat(null)} onOpenChat={openChat} onDeleteChat={removeChat} expanded={expanded} />
  );
  const screen = (id: Tab, node: React.ReactNode) => visited.has(id) && <div className={tab === id ? 'h-full' : 'hidden'}>{node}</div>;

  return (
    <NavContext.Provider value={{ open: () => setDrawer(true) }}>
      <div className="flex h-[100svh] overflow-hidden bg-canvas text-ink">
        <aside className="safe-top hidden w-[76px] shrink-0 border-r border-hairline bg-surface-soft md:block lg:w-72">
          <div className="hidden h-full lg:block">{nav(true)}</div>
          <div className="h-full lg:hidden">{nav(false)}</div>
        </aside>

        <main className="safe-top min-h-0 min-w-0 flex-1">
          {screen('assistant', <AssistantView conversationId={conversationId} title={list.find((c) => c.id === conversationId)?.title} onConversation={setConversationId} onCreated={chats.reload} onOpenIntegrations={() => show('connections')} />)}
          {screen('connections', <IntegrationsView />)}
          {screen('computers', <ComputersView />)}
          {screen('machines', machines)}
          {screen('account', <AccountView onOpenMachines={() => show('machines')} />)}
        </main>

        {/* Phones: the same navigation, sliding in from the left. */}
        <div className={`fixed inset-0 z-50 md:hidden ${drawer ? '' : 'pointer-events-none'}`} aria-hidden={!drawer}>
          <div onClick={() => setDrawer(false)} className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${drawer ? 'opacity-100' : 'opacity-0'}`} />
          <div className={`safe-top absolute inset-y-0 left-0 w-[320px] max-w-[88vw] border-r border-hairline bg-surface-soft shadow-elevated transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
            <button onClick={() => setDrawer(false)} aria-label="Close menu" className="absolute right-3 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-pill text-muted transition hover:bg-surface-card hover:text-ink"><X size={20} /></button>
            {nav(true)}
          </div>
        </div>
      </div>
    </NavContext.Provider>
  );
}
