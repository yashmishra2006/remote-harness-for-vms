import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { agentSupportsMcp, parseMcpServerInput, toMcpServerDto, type ApiTokenCreatedDto, type ImageAttachment, type McpOverviewDto, type McpPutResultDto } from '@remote-harness/shared';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_TENANT, type Db } from './db.js';
import type { AgentServer } from './agentServer.js';
import type { BrowserServer } from './browserServer.js';

function contentBlocks(text: string, images: ImageAttachment[] | undefined) {
  const blocks: Record<string, unknown>[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const img of images ?? []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
  }
  return blocks;
}

const passwordMatches = (given: unknown, expected: string) => {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createApiRouter(db: Db, agentServer: AgentServer, browserServer: BrowserServer, appPassword: string) {
  const router = Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });

  // Password login is the classic single-tenant hub's front door: it signs in to the default tenant.
  // Other tenants have no password; they hold API tokens issued by the admin API.
  router.post('/login', (req: Request, res: Response) => {
    if (!passwordMatches(req.body?.password, appPassword)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json({ token: db.for(DEFAULT_TENANT).createAuthToken() });
  });

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const tenantId = db.tenantForApiToken(token);
    if (tenantId) {
      res.locals.tenantId = tenantId;
      next();
      return;
    }
    // A token issued for one machine: it may see and drive that machine, and nothing else of the tenant's.
    const machine = db.machineForApiToken(token);
    if (!machine) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.tenantId = machine.tenantId;
    res.locals.machine = machine;
    next();
  }

  router.use(requireAuth);

  // What a machine-scoped token may reach: the machine list (filtered to itself), the MCP overview, and the routes under
  // its own machine. Never tokens, logout, or changes to the tenant's MCP servers.
  router.use((req, res, next) => {
    if (!res.locals.machine) {
      next();
      return;
    }
    const readOnlyOk = req.method === 'GET' && (req.path === '/vms' || req.path === '/mcp-servers');
    if (readOnlyOk || req.path.startsWith('/vms/')) {
      next();
      return;
    }
    res.status(403).json({ error: 'This credential is limited to one machine.' });
  });

  // Everything below acts for the caller's tenant only.
  const T = (res: Response) => db.for(res.locals.tenantId as string);
  const tenantOf = (res: Response) => res.locals.tenantId as string;

  // A VM id in a URL must be one of the caller's. Without this, knowing (or guessing) another tenant's
  // VM id would be enough to message its machine, since sockets are looked up by VM id alone.
  router.param('vmId', (_req, res, next, vmId) => {
    const own = T(res).listVms().find((v) => v.id === vmId);
    // A machine-scoped token reaches its own machine only; another one of the tenant's looks like it does not exist.
    if (!own || (res.locals.machine && own.name !== (res.locals.machine as { vmName: string }).vmName)) {
      res.status(404).json({ error: 'Unknown VM' });
      return;
    }
    next();
  });

  // ---- tokens ----
  // Signing out really signs out: the token is deleted, so a copy of it stops working too.
  router.post('/logout', (req, res) => {
    const header = req.header('authorization') ?? '';
    T(res).revokeToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    browserServer.closeRevokedSessions();
    res.json({ ok: true });
  });

  // A token for one purpose, e.g. Escanor. Unlike a login it survives signing out, and it can be
  // revoked on its own. The value is returned once and never listed again.
  router.post('/tokens', (req, res) => {
    const label = String(req.body?.label ?? '').trim().slice(0, 60) || 'API token';
    const created: ApiTokenCreatedDto = T(res).createApiToken(label);
    res.status(201).json(created);
  });
  router.get('/tokens', (_req, res) => res.json(T(res).listApiTokens()));
  router.delete('/tokens/:id', (req, res) => {
    const removed = T(res).deleteApiToken(req.params.id);
    browserServer.closeRevokedSessions();
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  router.get('/vms', (_req, res) => {
    const only = (res.locals.machine as { vmName: string } | undefined)?.vmName;
    const vms = T(res)
      .listVms()
      .filter((v) => !only || v.name === only)
      .map((v) => ({ ...v, connected: agentServer.isConnected(v.id) }));
    res.json(vms);
  });

  // ---- MCP servers installed on every VM ----
  //
  // Declarative and hub-owned: whatever is stored here is pushed to every agent when it
  // connects and whenever it changes, so a VM that was offline or is brand new converges on
  // its own. Header values (credentials) go in but are never returned.

  const pushMcpServers = (tenantId: string) => {
    const servers = db.for(tenantId).listMcpServers();
    let delivered = 0;
    for (const vmId of agentServer.connectedVmIds(tenantId)) {
      if (agentServer.sendToVm(vmId, { type: 'set_mcp_servers', servers })) delivered++;
    }
    return delivered;
  };

  router.get('/mcp-servers', (_req, res) => {
    const overview: McpOverviewDto = {
      servers: T(res).listMcpServers().map(toMcpServerDto),
      vms: T(res).listVms().filter((v) => !res.locals.machine || v.name === (res.locals.machine as { vmName: string }).vmName).map((v) => {
        const status = T(res).getVmMcpStatus(v.id);
        return {
          vmId: v.id,
          name: v.name,
          connected: agentServer.isConnected(v.id),
          agentVersion: T(res).getVmAgentVersion(v.id),
          mcpSupported: agentSupportsMcp(T(res).getVmAgentVersion(v.id)),
          reportedAt: status?.reportedAt ?? null,
          servers: status?.servers ?? [],
          liveSessions: status?.liveSessions ?? 0,
        };
      }),
    };
    res.json(overview);
  });

  router.put('/mcp-servers/:name', (req, res) => {
    const parsed = parseMcpServerInput(req.params.name, req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const server = T(res).putMcpServer(parsed.server);
    pushMcpServers(tenantOf(res));
    const vms = T(res).listVms();
    const result: McpPutResultDto = {
      server: toMcpServerDto(server),
      vmsConnected: vms.filter((v) => agentServer.isConnected(v.id)).length,
      vmsTotal: vms.length,
    };
    res.json(result);
  });

  router.delete('/mcp-servers/:name', (req, res) => {
    const removed = T(res).deleteMcpServer(req.params.name);
    if (removed) pushMcpServers(tenantOf(res));
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  router.get('/vms/:vmId/sessions', (req, res) => {
    res.json(T(res).listSessionsByVm(req.params.vmId));
  });

  router.get('/vms/:vmId/projects', async (req, res) => {
    res.json(await agentServer.requestProjects(req.params.vmId));
  });

  router.get('/vms/:vmId/sessions/:sessionId/messages', (req, res) => {
    res.json(T(res).listMessages(T(res).resolveSession(req.params.sessionId)));
  });

  router.post('/vms/:vmId/sessions', (req, res) => {
    const { vmId } = req.params;
    const { cwd, text, images, accountId } = req.body ?? {};
    if (!text && !(images?.length > 0)) {
      res.status(400).json({ error: 'text or images required' });
      return;
    }
    const tempId = randomUUID();
    const localMessage = {
      type: 'user',
      local: true,
      message: { role: 'user', content: contentBlocks(text ?? '', images) },
    };
    T(res).insertMessage({ sessionId: tempId, vmId, message: localMessage });
    browserServer.broadcast(tenantOf(res), {
      type: 'sdk_message',
      vmId,
      sessionId: tempId,
      message: localMessage,
      createdAt: new Date().toISOString(),
    });

    const delivered = agentServer.sendToVm(vmId, {
      type: 'user_input',
      sessionId: tempId,
      tempId,
      cwd,
      accountId,
      text: text ?? '',
      images,
    });
    if (!delivered) {
      res.status(503).json({ error: 'VM not connected' });
      return;
    }
    res.status(202).json({ tempId });
  });

  router.post('/vms/:vmId/sessions/:sessionId/messages', (req, res) => {
    const { vmId } = req.params;
    const sessionId = T(res).resolveSession(req.params.sessionId);
    const { text, images } = req.body ?? {};
    if (!text && !(images?.length > 0)) {
      res.status(400).json({ error: 'text or images required' });
      return;
    }
    const localMessage = {
      type: 'user',
      local: true,
      message: { role: 'user', content: contentBlocks(text ?? '', images) },
    };
    T(res).insertMessage({ sessionId, vmId, message: localMessage });
    T(res).touchSession(sessionId, 'active');
    browserServer.broadcast(tenantOf(res), {
      type: 'sdk_message',
      vmId,
      sessionId,
      message: localMessage,
      createdAt: new Date().toISOString(),
    });

    const delivered = agentServer.sendToVm(vmId, { type: 'user_input', sessionId, text: text ?? '', images });
    if (!delivered) {
      res.status(503).json({ error: 'VM not connected' });
      return;
    }
    res.status(202).json({ ok: true });
  });

  router.post('/vms/:vmId/sessions/:sessionId/interrupt', (req, res) => {
    const delivered = agentServer.sendToVm(req.params.vmId, { type: 'interrupt', sessionId: T(res).resolveSession(req.params.sessionId) });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/model', (req, res) => {
    const { model } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_model',
      sessionId: T(res).resolveSession(req.params.sessionId),
      model: model || undefined,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/effort', (req, res) => {
    const { effort } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_effort',
      sessionId: T(res).resolveSession(req.params.sessionId),
      effort: effort || null,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/permission-mode', (req, res) => {
    const { mode } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_permission_mode',
      sessionId: T(res).resolveSession(req.params.sessionId),
      mode,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/permission-response', (req, res) => {
    const { requestId, behavior, message } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'permission_response',
      requestId,
      behavior,
      message,
    });
    browserServer.broadcast(tenantOf(res), {
      type: 'permission_resolved',
      vmId: req.params.vmId,
      sessionId: T(res).resolveSession(req.params.sessionId),
      requestId,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  return router;
}
