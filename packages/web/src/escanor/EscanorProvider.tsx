import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { api, getHubUrl, isNative } from '../api';
import { useStore } from '../store';
import {
  APP_SCHEME,
  escanor,
  setAuthFailureHandler,
  tokens,
  type CatalogCategory,
  type Connection,
  type EscanorSession,
} from './client';

const PENDING_KEY = 'rh_escanor_pending';
const HUB_ID_KEY = 'rh_hub_id';

type Ctx = {
  session: EscanorSession | null;
  hubId: string | null;
  catalog: CatalogCategory[] | null;
  connections: Connection[];
  catalogError: string | null;
  notice: string | null;
  dismissNotice: () => void;
  signInWithGoogle: () => Promise<void>;
  connectProvider: (providerId: string) => Promise<void>;
  connectWithSecret: (providerId: string, secret: { accessToken?: string; credentials?: Record<string, string> }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<void>;
  refreshIntegrations: () => Promise<void>;
  mcpConnected: boolean | null;
  connectMcp: () => Promise<void>;
  disconnectMcp: () => Promise<void>;
  signOut: () => void;
};

const EscanorContext = createContext<Ctx | null>(null);

export function useEscanor(): Ctx {
  const ctx = useContext(EscanorContext);
  if (!ctx) throw new Error('useEscanor must be used inside EscanorProvider');
  return ctx;
}

// Native: a deep link back into the app. Web: the page itself (the hub serves this app).
function returnUrl(kind: 'auth' | 'integration'): string {
  if (isNative()) return `${APP_SCHEME}://${kind === 'auth' ? 'auth/callback' : 'integrations/oauth/callback'}`;
  return `${window.location.origin}/`;
}

async function openExternal(url: string): Promise<void> {
  if (isNative()) await Browser.open({ url });
  else window.location.assign(url);
}

export function EscanorProvider({ children }: { children: ReactNode }) {
  const { state, actions } = useStore();
  const [session, setSession] = useState<EscanorSession | null>(null);
  const [hubId, setHubId] = useState<string | null>(() => localStorage.getItem(HUB_ID_KEY));
  const [catalog, setCatalog] = useState<CatalogCategory[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mcpConnected, setMcpConnected] = useState<boolean | null>(null);
  const handledUrls = useRef(new Set<string>());

  const signOut = useCallback(() => {
    tokens.clear();
    localStorage.removeItem(HUB_ID_KEY);
    setSession(null);
    setHubId(null);
    setCatalog(null);
    setConnections([]);
    setMcpConnected(null);
    actions.logout();
  }, [actions]);

  useEffect(() => {
    setAuthFailureHandler(() => {
      tokens.clear();
      setSession(null);
    });
    return () => setAuthFailureHandler(null);
  }, []);

  // Restore the Escanor identity for an already-signed-in hub session.
  useEffect(() => {
    if (!state.authed || !tokens.access()) return;
    escanor.getSession().then(setSession).catch((e) => setCatalogError(e instanceof Error ? `Escanor session: ${e.message}` : 'Could not reach Escanor'));
  }, [state.authed]);

  const refreshIntegrations = useCallback(async () => {
    setCatalogError(null);
    try {
      const [cat, conns] = await Promise.all([escanor.getCatalog(), escanor.listConnections()]);
      setCatalog(cat);
      setConnections(conns);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Could not load integrations');
    }
  }, []);

  const refreshMcp = useCallback(async () => {
    try {
      const r = await api.listMcp();
      setMcpConnected(r.servers.some((s) => s.name === 'escanor'));
    } catch {
      setMcpConnected(null);
    }
  }, []);

  const connectMcp = useCallback(async () => {
    const { endpoint, token } = await escanor.mintMcpToken();
    await api.setEscanorMcp(endpoint, token);
    setMcpConnected(true);
  }, []);

  const disconnectMcp = useCallback(async () => {
    await api.removeEscanorMcp();
    setMcpConnected(false);
  }, []);

  useEffect(() => {
    if (state.authed) void refreshMcp();
  }, [state.authed, refreshMcp]);

  const completeLogin = useCallback(async () => {
    const s = await escanor.getSession();
    setSession(s);
    const access = tokens.access();
    if (!access) throw new Error('Missing Escanor token');
    const res = await api.loginWithEscanor(access);
    localStorage.setItem(HUB_ID_KEY, res.hubId);
    setHubId(res.hubId);
    actions.loginWithToken(res.token);
    // Give this hub's Claude sessions the signed-in user's Escanor MCP, unless it is already attached.
    try {
      const existing = await api.listMcp();
      if (!existing.servers.some((x) => x.name === 'escanor')) await connectMcp();
      else setMcpConnected(true);
    } catch {
      setNotice('Signed in, but could not attach Escanor MCP. You can retry from Settings.');
    }
  }, [actions, connectMcp]);

  const handleReturn = useCallback(
    async (rawUrl: string) => {
      if (handledUrls.current.has(rawUrl)) return;
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return;
      }
      const params = url.searchParams;
      const pending = sessionStorage.getItem(PENDING_KEY) ?? localStorage.getItem(PENDING_KEY);
      const isDeepLinkIntegration = url.protocol === `${APP_SCHEME}:` && url.host === 'integrations';
      const isDeepLinkAuth = url.protocol === `${APP_SCHEME}:` && url.host === 'auth';
      const isLogin = isDeepLinkAuth || (!isDeepLinkIntegration && pending === 'login');
      const integrationId = isDeepLinkIntegration ? params.get('provider') : pending?.startsWith('integration:') ? pending.slice(12) : null;
      if (!isLogin && !integrationId) return;
      handledUrls.current.add(rawUrl);
      sessionStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(PENDING_KEY);
      if (isNative()) Browser.close().catch(() => {});
      else window.history.replaceState({}, '', '/');

      const oauthError = params.get('error');
      try {
        if (oauthError) throw new Error(decodeURIComponent(oauthError));
        if (isLogin) {
          const code = params.get('code');
          if (!code) throw new Error('Missing authorization code');
          await escanor.exchangeLoginCode(code, params.get('provider') ?? undefined);
          await completeLogin();
        } else if (integrationId) {
          const code = params.get('code');
          if (code && params.get('linked') !== '1') {
            const r = await escanor.exchangeIntegration(integrationId, code, params.get('state'), returnUrl('integration'));
            if (r.synced === false || r.success === false) throw new Error(r.message ?? 'Integration sync failed');
          }
          setNotice(`Connected ${integrationId}`);
          await refreshIntegrations();
        }
      } catch (err) {
        if (isLogin) tokens.clear();
        setNotice(err instanceof Error ? err.message : 'Sign-in failed');
      }
    },
    [completeLogin, refreshIntegrations],
  );

  useEffect(() => {
    if (isNative()) {
      const sub = CapApp.addListener('appUrlOpen', (e) => void handleReturn(e.url));
      CapApp.getLaunchUrl().then((l) => l?.url && void handleReturn(l.url)).catch(() => {});
      return () => void sub.then((s) => s.remove());
    }
    if (window.location.search) void handleReturn(window.location.href);
  }, [handleReturn]);

  const signInWithGoogle = useCallback(async () => {
    if (isNative() && !getHubUrl()) throw new Error('Enter your hub URL first');
    tokens.clear();
    localStorage.setItem(PENDING_KEY, 'login');
    sessionStorage.setItem(PENDING_KEY, 'login');
    const url = await escanor.googleAuthorizeUrl(isNative() ? 'mobile' : 'web', returnUrl('auth'));
    await openExternal(url);
  }, []);

  const connectProvider = useCallback(async (providerId: string) => {
    const marker = `integration:${providerId}`;
    localStorage.setItem(PENDING_KEY, marker);
    sessionStorage.setItem(PENDING_KEY, marker);
    const url = await escanor.integrationAuthorizeUrl(providerId, isNative() ? 'mobile' : 'web', returnUrl('integration'));
    await openExternal(url);
  }, []);

  const connectWithSecret = useCallback(
    async (providerId: string, secret: { accessToken?: string; credentials?: Record<string, string> }) => {
      const r = await escanor.connectWithSecret(providerId, secret);
      if (r.synced === false) throw new Error(r.message ?? 'Could not connect');
      setNotice(`Connected ${providerId}`);
      await refreshIntegrations();
    },
    [refreshIntegrations],
  );

  const disconnectProvider = useCallback(
    async (providerId: string) => {
      await escanor.disconnectIntegration(providerId);
      setNotice(`Disconnected ${providerId}`);
      await refreshIntegrations();
    },
    [refreshIntegrations],
  );

  const value = useMemo<Ctx>(
    () => ({
      session,
      hubId,
      catalog,
      connections,
      catalogError,
      notice,
      dismissNotice: () => setNotice(null),
      signInWithGoogle,
      connectProvider,
      connectWithSecret,
      disconnectProvider,
      refreshIntegrations,
      mcpConnected,
      connectMcp,
      disconnectMcp,
      signOut,
    }),
    [session, hubId, catalog, connections, catalogError, notice, signInWithGoogle, connectProvider, connectWithSecret, disconnectProvider, refreshIntegrations, mcpConnected, connectMcp, disconnectMcp, signOut],
  );

  return <EscanorContext.Provider value={value}>{children}</EscanorContext.Provider>;
}
