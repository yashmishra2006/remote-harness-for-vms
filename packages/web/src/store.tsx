import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ClaudeAccount, ImageAttachment, MessageDto, SessionDto, VmDto } from '@remote-harness/shared';
import { api, getToken, setToken } from './api';
import { hubSocket } from './ws';

type State = {
  authed: boolean;
  vms: VmDto[];
  sessionsByVm: Record<string, SessionDto[]>;
  messagesBySession: Record<string, MessageDto[]>;
  resolvedPermissionIds: Set<string>;
  selectedVmId: string | null;
  selectedSessionId: string | null;
  selectedAccountId: string | null;
};

type Action =
  | { type: 'set_authed'; authed: boolean }
  | { type: 'set_vms'; vms: VmDto[] }
  | { type: 'vm_status'; vmId: string; name: string; connected: boolean; accounts: ClaudeAccount[] }
  | { type: 'set_sessions'; vmId: string; sessions: SessionDto[] }
  | { type: 'set_messages'; sessionId: string; messages: MessageDto[] }
  | { type: 'append_message'; sessionId: string; message: MessageDto }
  | { type: 'session_created'; vmId: string; tempId: string; sessionId: string; cwd: string; title: string; accountId: string }
  | { type: 'session_ended'; vmId: string; sessionId: string }
  | { type: 'permission_resolved'; requestId: string }
  | { type: 'select'; vmId: string | null; sessionId: string | null; accountId: string | null };

const initialState: State = {
  authed: Boolean(getToken()),
  vms: [],
  sessionsByVm: {},
  messagesBySession: {},
  resolvedPermissionIds: new Set(),
  selectedVmId: null,
  selectedSessionId: null,
  selectedAccountId: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set_authed':
      return { ...state, authed: action.authed };
    case 'set_vms':
      return { ...state, vms: action.vms };
    case 'vm_status': {
      const exists = state.vms.some((v) => v.id === action.vmId);
      const vms = exists
        ? state.vms.map((v) => (v.id === action.vmId ? { ...v, connected: action.connected, accounts: action.accounts } : v))
        : [...state.vms, { id: action.vmId, name: action.name, connected: action.connected, lastSeenAt: null, accounts: action.accounts }];
      return { ...state, vms };
    }
    case 'set_sessions':
      return { ...state, sessionsByVm: { ...state.sessionsByVm, [action.vmId]: action.sessions } };
    case 'set_messages':
      return { ...state, messagesBySession: { ...state.messagesBySession, [action.sessionId]: action.messages } };
    case 'append_message': {
      const existing = state.messagesBySession[action.sessionId] ?? [];
      return {
        ...state,
        messagesBySession: { ...state.messagesBySession, [action.sessionId]: [...existing, action.message] },
      };
    }
    case 'session_created': {
      const merged = [
        ...(state.messagesBySession[action.tempId] ?? []),
        ...(state.messagesBySession[action.sessionId] ?? []),
      ];
      const messagesBySession = { ...state.messagesBySession, [action.sessionId]: merged };
      delete messagesBySession[action.tempId];

      const existingList = state.sessionsByVm[action.vmId] ?? [];
      const withoutTemp = existingList.filter((s) => s.id !== action.tempId && s.id !== action.sessionId);
      const now = new Date().toISOString();
      const sessionsByVm = {
        ...state.sessionsByVm,
        [action.vmId]: [
          { id: action.sessionId, vmId: action.vmId, cwd: action.cwd, title: action.title, createdAt: now, lastMessageAt: now, status: 'active' as const, accountId: action.accountId },
          ...withoutTemp,
        ],
      };

      const selectedSessionId = state.selectedSessionId === action.tempId ? action.sessionId : state.selectedSessionId;
      return { ...state, messagesBySession, sessionsByVm, selectedSessionId };
    }
    case 'session_ended': {
      const list = state.sessionsByVm[action.vmId];
      if (!list) return state;
      return {
        ...state,
        sessionsByVm: {
          ...state.sessionsByVm,
          [action.vmId]: list.map((s) => (s.id === action.sessionId ? { ...s, status: 'idle' } : s)),
        },
      };
    }
    case 'permission_resolved':
      return { ...state, resolvedPermissionIds: new Set(state.resolvedPermissionIds).add(action.requestId) };
    case 'select':
      return { ...state, selectedVmId: action.vmId, selectedSessionId: action.sessionId, selectedAccountId: action.accountId };
    default:
      return state;
  }
}

const StoreContext = createContext<{ state: State; actions: ReturnType<typeof buildActions> } | null>(null);

function buildActions(dispatch: React.Dispatch<Action>) {
  return {
    async login(password: string) {
      const { token } = await api.login(password);
      setToken(token);
      dispatch({ type: 'set_authed', authed: true });
    },
    loginWithToken(token: string) {
      setToken(token);
      dispatch({ type: 'set_authed', authed: true });
    },
    logout() {
      setToken(null);
      dispatch({ type: 'set_authed', authed: false });
    },
    async refreshVms() {
      dispatch({ type: 'set_vms', vms: await api.listVms() });
    },
    async selectVm(vmId: string) {
      dispatch({ type: 'select', vmId, sessionId: null, accountId: null });
      dispatch({ type: 'set_sessions', vmId, sessions: await api.listSessions(vmId) });
    },
    selectSession(vmId: string, sessionId: string | null, accountId: string | null = null) {
      dispatch({ type: 'select', vmId, sessionId, accountId });
    },
    async loadMessages(vmId: string, sessionId: string) {
      dispatch({ type: 'set_messages', sessionId, messages: await api.listMessages(vmId, sessionId) });
    },
    async startNewChat(vmId: string, cwd: string | undefined, text: string, images: ImageAttachment[] | undefined, accountId: string | undefined) {
      const { tempId } = await api.createSession(vmId, { cwd, text, images, accountId });
      dispatch({ type: 'select', vmId, sessionId: tempId, accountId: accountId ?? null });
      return tempId;
    },
    sendMessage(vmId: string, sessionId: string, text: string, images?: ImageAttachment[]) {
      return api.sendMessage(vmId, sessionId, { text, images });
    },
    interrupt(vmId: string, sessionId: string) {
      return api.interrupt(vmId, sessionId);
    },
    setPermissionMode(vmId: string, sessionId: string, mode: string) {
      return api.setPermissionMode(vmId, sessionId, mode);
    },
    setModel(vmId: string, sessionId: string, model: string) {
      return api.setModel(vmId, sessionId, model);
    },
    setEffort(vmId: string, sessionId: string, effort: string) {
      return api.setEffort(vmId, sessionId, effort);
    },
    async resolvePermission(vmId: string, sessionId: string, requestId: string, behavior: 'allow' | 'deny') {
      dispatch({ type: 'permission_resolved', requestId });
      await api.resolvePermission(vmId, sessionId, requestId, behavior);
    },
    dispatch,
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const actions = useMemo(() => buildActions(dispatch), []);

  useEffect(() => {
    if (!state.authed) return;
    hubSocket.connect();
    const unsubscribe = hubSocket.subscribe((msg) => {
      switch (msg.type) {
        case 'vm_status':
          dispatch({ type: 'vm_status', vmId: msg.vmId, name: msg.name, connected: msg.connected, accounts: msg.accounts });
          break;
        case 'sdk_message':
          dispatch({
            type: 'append_message',
            sessionId: msg.sessionId,
            message: { id: Date.now() + Math.random(), sessionId: msg.sessionId, vmId: msg.vmId, message: msg.message, createdAt: msg.createdAt },
          });
          break;
        case 'session_created':
          dispatch({ type: 'session_created', vmId: msg.vmId, tempId: msg.tempId, sessionId: msg.sessionId, cwd: msg.cwd, title: msg.title, accountId: msg.accountId });
          break;
        case 'session_ended':
          dispatch({ type: 'session_ended', vmId: msg.vmId, sessionId: msg.sessionId });
          break;
        case 'permission_request':
          dispatch({
            type: 'append_message',
            sessionId: msg.sessionId,
            message: {
              id: Date.now() + Math.random(),
              sessionId: msg.sessionId,
              vmId: msg.vmId,
              createdAt: new Date().toISOString(),
              message: { type: 'permission_request', requestId: msg.requestId, toolName: msg.toolName, input: msg.input, blockedPath: msg.blockedPath },
            },
          });
          break;
        case 'permission_resolved':
          dispatch({ type: 'permission_resolved', requestId: msg.requestId });
          break;
      }
    });
    return unsubscribe;
  }, [state.authed]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
