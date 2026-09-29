import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentToHubMessage, AgentSessionSummary, ClaudeAccount, HubToAgentMessage, HubUserInput, McpServerConfig } from '@remote-harness/shared';
import type { Db } from './db.js';

const PROJECTS_REQUEST_TIMEOUT_MS = 5000;

export type AgentEventHandlers = {
  onHello: (vmId: string, vmName: string, accounts: ClaudeAccount[], sessions: AgentSessionSummary[]) => void;
  onEvent: (vmId: string, msg: AgentToHubMessage) => void;
  onStatusChange: (vmId: string, vmName: string, connected: boolean) => void;
};

function withMcpServers(db: Db, msg: HubUserInput): HubUserInput {
  const servers = db.listMcpServers();
  if (servers.length === 0) return msg;
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const s of servers) mcpServers[s.name] = { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } };
  return { ...msg, mcpServers };
}

export function createAgentServer(db: Db, token: string, handlers: AgentEventHandlers) {
  const wss = new WebSocketServer({ noServer: true });

  function authorize(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${token}`;
  }

  const byVmId = new Map<string, WebSocket>();
  const pendingProjectRequests = new Map<string, { resolve: (projects: string[]) => void }>();

  wss.on('connection', (ws) => {
    let vmId: string | null = null;
    let vmName: string | null = null;

    ws.on('message', (data) => {
      let msg: AgentToHubMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        vmName = msg.vmName;
        vmId = db.upsertVm(vmName);
        const previous = byVmId.get(vmId);
        if (previous && previous !== ws) previous.close();
        byVmId.set(vmId, ws);
        handlers.onHello(vmId, vmName, msg.accounts, msg.sessions);
        handlers.onStatusChange(vmId, vmName, true);
        return;
      }

      if (!vmId) return; // must hello first

      if (msg.type === 'projects_list') {
        const pending = pendingProjectRequests.get(msg.requestId);
        if (pending) {
          pendingProjectRequests.delete(msg.requestId);
          pending.resolve(msg.projects);
        }
        return;
      }

      handlers.onEvent(vmId, msg);
    });

    ws.on('close', () => {
      if (vmId && vmName) {
        if (byVmId.get(vmId) === ws) byVmId.delete(vmId);
        handlers.onStatusChange(vmId, vmName, false);
      }
    });
  });

  return {
    wss,
    authorize,
    isConnected(vmId: string): boolean {
      return byVmId.has(vmId);
    },
    sendToVm(vmId: string, msg: HubToAgentMessage): boolean {
      const ws = byVmId.get(vmId);
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg.type === 'user_input' ? withMcpServers(db, msg) : msg));
      return true;
    },
    connectedVmIds(): string[] {
      return [...byVmId.keys()];
    },
    requestProjects(vmId: string): Promise<string[]> {
      const ws = byVmId.get(vmId);
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve([]);
      const requestId = randomUUID();
      ws.send(JSON.stringify({ type: 'list_projects', requestId }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingProjectRequests.delete(requestId);
          resolve([]);
        }, PROJECTS_REQUEST_TIMEOUT_MS);
        pendingProjectRequests.set(requestId, {
          resolve: (projects) => {
            clearTimeout(timer);
            resolve(projects);
          },
        });
      });
    },
  };
}

export type AgentServer = ReturnType<typeof createAgentServer>;
