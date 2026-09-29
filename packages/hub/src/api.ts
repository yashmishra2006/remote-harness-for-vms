import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ImageAttachment } from '@remote-harness/shared';
import type { Db } from './db.js';
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

export function createApiRouter(db: Db, agentServer: AgentServer, browserServer: BrowserServer, appPassword: string,
  escanor: { escanorApiUrl: string; allowedEmails: string[] },
) {
  const router = Router();

  router.post('/login', (req: Request, res: Response) => {
    const { password } = req.body ?? {};
    if (password !== appPassword) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json({ token: db.createAuthToken() });
  });

  router.post('/login/escanor', async (req: Request, res: Response) => {
    const accessToken = String(req.body?.accessToken ?? '');
    if (!accessToken) {
      res.status(400).json({ error: 'accessToken required' });
      return;
    }
    let session: any;
    try {
      const r = await fetch(`${escanor.escanorApiUrl}/auth/session`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        res.status(401).json({ error: 'Escanor rejected the token' });
        return;
      }
      session = await r.json();
    } catch {
      res.status(502).json({ error: 'Could not reach Escanor to verify the token' });
      return;
    }
    const u = session?.user;
    if (!u?.id || !u?.email) {
      res.status(502).json({ error: 'Unexpected Escanor session response' });
      return;
    }
    const hubUser = db.upsertHubUser({ id: String(u.id), email: String(u.email), name: u.name ?? null }, escanor.allowedEmails);
    if (!hubUser) {
      res.status(403).json({ error: 'This hub already belongs to another account' });
      return;
    }
    res.json({ token: db.createAuthToken(), hubId: hubUser.hubId });
  });

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!db.isValidToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  router.use(requireAuth);

  router.get('/mcp', (_req, res) => {
    res.json({ servers: db.listMcpServers().map((s) => ({ name: s.name, url: s.url })) });
  });

  router.post('/mcp/escanor', (req, res) => {
    const { url, token } = req.body ?? {};
    if (typeof token !== 'string' || !token || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      res.status(400).json({ error: 'url (http/https) and token required' });
      return;
    }
    db.setMcpServer('escanor', url, token);
    res.json({ ok: true });
  });

  router.delete('/mcp/escanor', (_req, res) => {
    db.removeMcpServer('escanor');
    res.json({ ok: true });
  });

  router.get('/vms', (_req, res) => {
    const vms = db.listVms().map((v) => ({ ...v, connected: agentServer.isConnected(v.id) }));
    res.json(vms);
  });

  router.get('/vms/:vmId/sessions', (req, res) => {
    res.json(db.listSessionsByVm(req.params.vmId));
  });

  router.get('/vms/:vmId/projects', async (req, res) => {
    res.json(await agentServer.requestProjects(req.params.vmId));
  });

  router.get('/vms/:vmId/sessions/:sessionId/messages', (req, res) => {
    res.json(db.listMessages(req.params.sessionId));
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
    db.insertMessage({ sessionId: tempId, vmId, message: localMessage });
    browserServer.broadcast({
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
    const { vmId, sessionId } = req.params;
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
    db.insertMessage({ sessionId, vmId, message: localMessage });
    db.touchSession(sessionId, 'active');
    browserServer.broadcast({
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
    const delivered = agentServer.sendToVm(req.params.vmId, { type: 'interrupt', sessionId: req.params.sessionId });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/model', (req, res) => {
    const { model } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_model',
      sessionId: req.params.sessionId,
      model: model || undefined,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/effort', (req, res) => {
    const { effort } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_effort',
      sessionId: req.params.sessionId,
      effort: effort || null,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  router.post('/vms/:vmId/sessions/:sessionId/permission-mode', (req, res) => {
    const { mode } = req.body ?? {};
    const delivered = agentServer.sendToVm(req.params.vmId, {
      type: 'set_permission_mode',
      sessionId: req.params.sessionId,
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
    browserServer.broadcast({
      type: 'permission_resolved',
      vmId: req.params.vmId,
      sessionId: req.params.sessionId,
      requestId,
    });
    res.status(delivered ? 202 : 503).json({ ok: delivered });
  });

  return router;
}
