import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentSessionSummary,
  AgentToHubMessage,
  EffortLevel,
  HubUserInput,
  ImageAttachment,
  PermissionDecision,
  PermissionMode,
} from '@remote-harness/shared';
import { AsyncMessageQueue } from './queue.js';
import { SessionRegistry } from './registry.js';
import type { ClaudeProfile } from './profiles.js';

type LiveSession = {
  queue: AsyncMessageQueue<SDKUserMessage>;
  cwd: string;
  interrupt: () => Promise<unknown>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setModel: (model?: string) => Promise<void>;
  setEffort: (effort: EffortLevel | null) => Promise<void>;
};

type PendingPermission = {
  resolve: (decision: { behavior: PermissionDecision; message?: string }) => void;
};

function toUserMessage(text: string, images: ImageAttachment[] | undefined): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: 'text', text });
  for (const img of images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
    });
  }
  return {
    type: 'user',
    message: { role: 'user', content: content as never },
    parent_tool_use_id: null,
  };
}

function titleFrom(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine || 'New session';
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private registry: SessionRegistry;

  constructor(
    private workspaceRoot: string,
    dataDir: string,
    private profiles: ClaudeProfile[],
    private send: (msg: AgentToHubMessage) => void,
  ) {
    this.registry = new SessionRegistry(dataDir);
  }

  private resolveProfile(accountId: string | undefined): ClaudeProfile {
    return this.profiles.find((p) => p.id === accountId) ?? this.profiles[0];
  }

  summaries(): AgentSessionSummary[] {
    return this.registry.all().map((e) => ({
      sessionId: e.sessionId,
      cwd: e.cwd,
      title: e.title,
      createdAt: e.createdAt,
      status: this.live.has(e.sessionId) ? 'active' : 'idle',
      accountId: e.accountId,
    }));
  }

  private resolveCwd(requested: string | undefined): string {
    const candidate = resolve(this.workspaceRoot, requested || '.');
    const rel = relative(this.workspaceRoot, candidate);
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    return inside ? candidate : this.workspaceRoot;
  }

  handleUserInput(input: HubUserInput): void {
    const live = this.live.get(input.sessionId);
    if (live) {
      live.queue.push(toUserMessage(input.text, input.images));
      return;
    }
    this.startSession(input);
  }

  private startSession(input: HubUserInput): void {
    const tempId = input.tempId;
    const existingEntry = this.registry.get(input.sessionId);
    const isResume = Boolean(existingEntry) && !tempId;
    const cwd = this.resolveCwd(input.cwd ?? existingEntry?.cwd);
    const profile = this.resolveProfile(isResume ? existingEntry?.accountId : input.accountId);

    let resolvedSessionId = isResume ? input.sessionId : '';
    const queue = new AsyncMessageQueue<SDKUserMessage>();
    const options: Options = {
      cwd,
      permissionMode: 'default',
      // Ask for summarized thinking so the web UI can show it like the CLI's transcript view.
      thinking: { type: 'adaptive', display: 'summarized' },
      canUseTool: async (toolName, toolInput, opts) => {
        const decision = await this.requestPermission(
          () => resolvedSessionId,
          toolName,
          toolInput,
          opts.blockedPath,
          opts.signal,
        );
        return decision.behavior === 'allow'
          ? { behavior: 'allow' as const, updatedInput: toolInput }
          : { behavior: 'deny' as const, message: decision.message ?? 'Denied by user' };
      },
    };
    if (isResume) options.resume = input.sessionId;
    if (input.mcpServers) options.mcpServers = input.mcpServers;
    if (profile.configDir) options.env = { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir };

    const q = query({ prompt: queue, options });
    queue.push(toUserMessage(input.text, input.images));

    const liveKey = tempId ?? input.sessionId;
    this.live.set(liveKey, {
      queue,
      cwd,
      interrupt: () => q.interrupt(),
      setPermissionMode: (mode) => q.setPermissionMode(mode),
      setModel: (model) => q.setModel(model),
      setEffort: (effort) => q.applyFlagSettings({ effortLevel: effort }),
    });

    void this.pump(q, {
      tempId,
      cwd,
      accountId: profile.id,
      seedTitle: input.text,
      liveKey,
      getSessionId: () => resolvedSessionId,
      setSessionId: (id) => (resolvedSessionId = id),
    });
  }

  private async pump(
    q: AsyncIterable<unknown>,
    ctx: {
      tempId?: string;
      cwd: string;
      accountId: string;
      seedTitle: string;
      liveKey: string;
      getSessionId: () => string;
      setSessionId: (id: string) => void;
    },
  ): Promise<void> {
    try {
      for await (const message of q) {
        const msg = message as { type?: string; subtype?: string; session_id?: string };
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id && !ctx.getSessionId()) {
          const sessionId = msg.session_id;
          ctx.setSessionId(sessionId);
          const title = titleFrom(ctx.seedTitle);
          this.registry.upsert({ sessionId, cwd: ctx.cwd, title, createdAt: new Date().toISOString(), accountId: ctx.accountId });
          if (ctx.liveKey !== sessionId) {
            const entry = this.live.get(ctx.liveKey);
            if (entry) {
              this.live.delete(ctx.liveKey);
              this.live.set(sessionId, entry);
            }
          }
          if (ctx.tempId) {
            this.send({ type: 'session_created', tempId: ctx.tempId, sessionId, cwd: ctx.cwd, title, accountId: ctx.accountId });
          }
        }
        this.send({
          type: 'sdk_message',
          sessionId: ctx.getSessionId() || ctx.tempId || ctx.liveKey,
          tempId: ctx.tempId,
          message,
        });
      }
    } catch (err) {
      this.send({
        type: 'error',
        sessionId: ctx.getSessionId() || undefined,
        tempId: ctx.tempId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const sessionId = ctx.getSessionId();
      this.live.delete(ctx.liveKey);
      if (sessionId) this.live.delete(sessionId);
      this.send({ type: 'session_ended', sessionId: sessionId || ctx.tempId || ctx.liveKey });
    }
  }

  private requestPermission(
    getSessionId: () => string,
    toolName: string,
    input: Record<string, unknown>,
    blockedPath: string | undefined,
    signal: AbortSignal,
  ): Promise<{ behavior: PermissionDecision; message?: string }> {
    const requestId = randomUUID();
    const sessionId = getSessionId();
    this.send({ type: 'permission_request', sessionId, requestId, toolName, input, blockedPath });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve });
      signal.addEventListener('abort', () => {
        if (this.pendingPermissions.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'Interrupted' });
        }
      });
    });
  }

  resolvePermission(requestId: string, behavior: PermissionDecision, message?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ behavior, message });
  }

  interrupt(sessionId: string): void {
    void this.live.get(sessionId)?.interrupt();
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    void this.live.get(sessionId)?.setPermissionMode(mode);
  }

  setModel(sessionId: string, model: string | undefined): void {
    void this.live.get(sessionId)?.setModel(model);
  }

  setEffort(sessionId: string, effort: EffortLevel | null): void {
    void this.live.get(sessionId)?.setEffort(effort);
  }
}
