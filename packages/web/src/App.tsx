import { useEffect, useState } from 'react';
import { useStore } from './store';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import IntegrationsView from './components/IntegrationsView';
import SettingsView from './components/SettingsView';

type View = 'chat' | 'integrations' | 'settings';

export default function App() {
  const { state } = useStore();
  const [view, setView] = useState<View>('chat');
  const [drawerOpen, setDrawerOpen] = useState(true);

  useEffect(() => {
    if (!state.authed) {
      setView('chat');
      setDrawerOpen(true);
    }
  }, [state.authed]);

  if (!state.authed) return <Login />;

  const show = (v: View) => (view === v ? 'flex' : 'hidden');

  return (
    <div className="relative flex h-[100svh] overflow-hidden bg-canvas text-ink">
      {drawerOpen && <div onClick={() => setDrawerOpen(false)} className="fixed inset-0 z-30 bg-black/30 md:hidden" />}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-[85%] max-w-xs transition-transform duration-200 md:static md:z-auto md:w-80 md:max-w-none md:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          className="flex"
          view={view}
          onSelectSession={() => {
            setView('chat');
            setDrawerOpen(false);
          }}
          onOpenIntegrations={() => {
            setView('integrations');
            setDrawerOpen(false);
          }}
          onOpenSettings={() => {
            setView('settings');
            setDrawerOpen(false);
          }}
        />
      </div>

      <ChatView className={show('chat')} onBack={() => setDrawerOpen(true)} />
      <IntegrationsView className={show('integrations')} onMenu={() => setDrawerOpen(true)} />
      <SettingsView className={show('settings')} onMenu={() => setDrawerOpen(true)} />

      {view === 'chat' && !state.selectedVmId && !drawerOpen && (
        <button onClick={() => setDrawerOpen(true)} aria-label="Open menu" className="safe-top fixed left-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-md bg-surface-card text-muted md:hidden">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}
