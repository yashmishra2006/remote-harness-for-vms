import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SafeMarkdown } from './SafeMarkdown';
import type { DisplayItem, Block, ToolItem, Todo } from '../groupMessages';
import { useStore } from '../store';
import { diffLines, diffStat } from '../diff';

// Session working directory, used to show paths relative to it like the CLI does.
export const CwdContext = createContext<string>('');

// ---------- formatting helpers (mirror the CLI's tool UI) ----------

function displayPath(p: unknown, cwd: string): string {
  if (typeof p !== 'string') return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

function toolName(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return input?.old_string === '' ? 'Create' : 'Update';
    case 'Glob':
    case 'Grep':
      return 'Search';
    case 'Task':
      return input?.subagent_type ?? 'Agent';
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp ? mcp[2] : name;
    }
  }
}

function toolArgs(name: string, input: Record<string, any>, cwd: string): string {
  input = input ?? {};
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command ?? '');
      const lines = cmd.split('\n');
      const shown = lines.slice(0, 2).join('\n');
      return shown.length > 160 || lines.length > 2 ? shown.slice(0, 160).trimEnd() + '…' : shown;
    }
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return displayPath(input.file_path, cwd);
    case 'NotebookEdit':
      return displayPath(input.notebook_path, cwd);
    case 'Glob':
    case 'Grep': {
      const parts = [`pattern: "${input.pattern}"`];
      if (input.path) parts.push(`path: "${displayPath(input.path, cwd)}"`);
      return parts.join(', ');
    }
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return `"${input.query}"`;
    case 'Task':
    case 'Agent':
      return String(input.description ?? '');
    default: {
      const first = Object.values(input)[0];
      return typeof first === 'string' ? first.slice(0, 80) : '';
    }
  }
}

function mcpServer(name: string): string | null {
  const m = /^mcp__(.+?)__/.exec(name);
  return m ? m[1] : null;
}

const nonEmptyLines = (t: string) => t.split('\n').filter((l) => l.trim()).length;

// ---------- small building blocks ----------

const MONO = 'font-mono text-[12.5px] leading-[1.55] [overflow-wrap:anywhere]';

// The ⎿ connector: dim, non-selectable, content hangs to its right.
function Response({ children }: { children: ReactNode }) {
  return (
    <div className={`flex ${MONO} text-muted`}>
      <span className="w-6 shrink-0 select-none whitespace-pre text-muted-soft">{' ⎿ '}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Dot({ state }: { state: 'pending' | 'ok' | 'error' | 'plain' }) {
  const cls =
    state === 'ok' ? 'text-success' : state === 'error' ? 'text-error' : state === 'plain' ? 'text-ink' : 'animate-blink text-muted';
  return <span className={`w-5 shrink-0 select-none ${cls}`}>●</span>;
}

function Expandable({ text, error, limit = 3 }: { text: string; error?: boolean; limit?: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.replace(/\s+$/, '').split('\n');
  const hidden = lines.length - limit;
  const shown = open || hidden <= 0 ? lines : lines.slice(0, limit);
  return (
    <div>
      <pre className={`whitespace-pre-wrap break-words ${error ? 'text-error' : 'text-body'}`}>{shown.join('\n')}</pre>
      {hidden > 0 && (
        <button onClick={() => setOpen((o) => !o)} className="text-muted-soft hover:text-muted">
          {open ? 'collapse' : `… +${hidden} ${hidden === 1 ? 'line' : 'lines'} (tap to expand)`}
        </button>
      )}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown min-w-0 flex-1 [overflow-wrap:anywhere] text-[14px] leading-relaxed text-ink">
      <SafeMarkdown text={text} />
    </div>
  );
}

function ImageBlock({ block }: { block: Block }) {
  const src = block.source?.data ? `data:${block.source.media_type};base64,${block.source.data}` : undefined;
  if (!src) return null;
  return <img src={src} className="mt-1.5 max-h-64 rounded-md border border-hairline object-cover" />;
}

// ---------- diff ----------

function Diff({ block }: { block: Block }) {
  const input = block.input ?? {};
  const pairs: { o: string; n: string }[] =
    block.name === 'MultiEdit' && Array.isArray(input.edits)
      ? input.edits.map((e: any) => ({ o: e.old_string ?? '', n: e.new_string ?? '' }))
      : [{ o: String(input.old_string ?? ''), n: String(input.new_string ?? input.content ?? '') }];
  const lines = pairs.flatMap((p) => diffLines(p.o, p.n));
  return (
    <div className="mt-0.5 overflow-x-auto rounded-sm border border-hairline-soft bg-surface-soft">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex whitespace-pre px-2 ${
            l.type === 'add' ? 'bg-success/20 text-body-strong' : l.type === 'del' ? 'bg-error/15 text-body-strong' : 'text-muted'
          }`}
        >
          <span className="w-4 shrink-0 select-none text-muted-soft">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}

function editSummary(block: Block): { additions: number; removals: number } {
  const input = block.input ?? {};
  const pairs =
    block.name === 'MultiEdit' && Array.isArray(input.edits)
      ? input.edits
      : [{ old_string: input.old_string ?? '', new_string: input.new_string ?? input.content ?? '' }];
  return diffStat(pairs.flatMap((p: any) => diffLines(p.old_string ?? '', p.new_string ?? '')));
}

// ---------- tool result ----------

function isRejected(text: string): boolean {
  return /^(The user doesn't want|Denied by user|\[Request interrupted)/.test(text.trim());
}

function ToolResultBody({ tool }: { tool: ToolItem }) {
  const cwd = useContext(CwdContext);
  const { block, result } = tool;
  const input = block.input ?? {};
  const name: string = block.name;
  if (!result) return null;
  const text = result.text;

  if (isRejected(text)) {
    return (
      <Response>
        <span className="text-muted-soft">Interrupted · What should Claude do instead?</span>
      </Response>
    );
  }
  if (result.isError) {
    const clean = text.replace(/<\/?tool_use_error>/g, '').trim();
    return (
      <Response>
        <Expandable text={/^(Error|Cancelled):/.test(clean) ? clean : `Error: ${clean}`} error limit={10} />
      </Response>
    );
  }

  const b = (n: number | string) => <span className="font-semibold text-body-strong">{n}</span>;

  switch (name) {
    case 'Read': {
      const n = nonEmptyLines(text);
      return <Response>Read {b(n)} {n === 1 ? 'line' : 'lines'}</Response>;
    }
    case 'Edit':
    case 'MultiEdit': {
      const { additions, removals } = editSummary(block);
      const parts: ReactNode[] = [];
      if (additions) parts.push(<span key="a">Added {b(additions)} {additions === 1 ? 'line' : 'lines'}</span>);
      if (removals) parts.push(<span key="r">{parts.length ? 'removed' : 'Removed'} {b(removals)} {removals === 1 ? 'line' : 'lines'}</span>);
      return (
        <Response>
          {parts.length ? parts.reduce<ReactNode[]>((acc, p, i) => (i ? [...acc, ', ', p] : [p]), []) : 'Updated'}
          <Diff block={block} />
        </Response>
      );
    }
    case 'Write': {
      const n = String(input.content ?? '').split('\n').length;
      return (
        <Response>
          Wrote {b(n)} {n === 1 ? 'line' : 'lines'} to {b(displayPath(input.file_path, cwd))}
          <WritePreview content={String(input.content ?? '')} />
        </Response>
      );
    }
    case 'Glob': {
      const n = nonEmptyLines(text.startsWith('No files') ? '' : text);
      return (
        <Response>
          Found {b(n)} {n === 1 ? 'file' : 'files'}
          {n > 0 && <ExpandInline text={text} />}
        </Response>
      );
    }
    case 'Grep': {
      const mode = input.output_mode ?? 'files_with_matches';
      const empty = /^No (files|matches)/.test(text.trim());
      const n = empty ? 0 : nonEmptyLines(text);
      return (
        <Response>
          Found {b(n)} {mode === 'content' ? (n === 1 ? 'line' : 'lines') : n === 1 ? 'file' : 'files'}
          {n > 0 && <ExpandInline text={text} />}
        </Response>
      );
    }
    case 'WebSearch':
      return <Response><Expandable text={text} /></Response>;
    case 'Task':
    case 'Agent':
      return (
        <Response>
          Done ({plural(tool.sub.length, 'tool use')})
          {text && <ExpandInline text={text} label="response" />}
        </Response>
      );
    default:
      if (!text.trim()) return <Response><span className="text-muted-soft">{name === 'Bash' ? '(No output)' : 'Done'}</span></Response>;
      return <Response><Expandable text={text} /></Response>;
  }
}

function ExpandInline({ text, label = 'output' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((o) => !o)} className="ml-1.5 text-muted-soft hover:text-muted">
        ({open ? 'collapse' : `tap to expand ${label}`})
      </button>
      {open && <pre className="mt-0.5 whitespace-pre-wrap break-words text-body">{text.trim()}</pre>}
    </>
  );
}

function WritePreview({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const lines = content.split('\n');
  const shown = open ? lines : lines.slice(0, 10);
  return (
    <div className="mt-0.5 overflow-x-auto rounded-sm border border-hairline-soft bg-surface-soft px-2 py-1 text-body">
      <pre>{shown.join('\n')}</pre>
      {lines.length > 10 && (
        <button onClick={() => setOpen((o) => !o)} className="text-muted-soft hover:text-muted">
          {open ? 'collapse' : `… +${lines.length - 10} lines (tap to expand)`}
        </button>
      )}
    </div>
  );
}

// ---------- tool use ----------

function SubActivity({ tool }: { tool: ToolItem }) {
  const cwd = useContext(CwdContext);
  const running = !tool.result;
  if (!tool.sub.length) return running ? <Response><span className="text-muted-soft">Initializing…</span></Response> : null;
  if (!running) return null;
  const shown = tool.sub.slice(-3);
  const hidden = tool.sub.length - shown.length;
  return (
    <Response>
      {shown.map((s, i) => (
        <div key={s.id ?? i} className="truncate">
          <span className="font-semibold text-body-strong">{toolName(s.name, s.input)}</span>
          <span className="text-muted">({toolArgs(s.name, s.input, cwd)})</span>
        </div>
      ))}
      {hidden > 0 && <div className="text-muted-soft">+{hidden} more tool uses</div>}
    </Response>
  );
}

export function ToolUse({ tool, waitingForPermission, live }: { tool: ToolItem; waitingForPermission?: boolean; live?: boolean }) {
  const cwd = useContext(CwdContext);
  const { block, result } = tool;
  const input = block.input ?? {};
  const state = result ? (result.isError || isRejected(result.text) ? 'error' : 'ok') : 'pending';
  const server = mcpServer(block.name);
  const args = toolArgs(block.name, input, cwd);
  return (
    <div className="mt-2.5">
      <div className={`flex ${MONO}`}>
        <Dot state={state === 'pending' && !live ? 'plain' : state} />
        <div className="min-w-0 flex-1 break-words">
          <span className="font-semibold text-ink">{toolName(block.name, input)}</span>
          {args && <span className="whitespace-pre-wrap text-body">({args})</span>}
          {server && <span className="ml-1 text-muted-soft">({server} MCP)</span>}
        </div>
      </div>
      {!result && waitingForPermission && <Response><span className="text-muted-soft">Waiting for permission…</span></Response>}
      {!result && !waitingForPermission && block.name === 'Bash' && live && <Response><span className="text-muted-soft">Running…</span></Response>}
      {(block.name === 'Task' || block.name === 'Agent') && <SubActivity tool={tool} />}
      <ToolResultBody tool={tool} />
    </div>
  );
}

// Consecutive Read/Grep/Glob calls: "Searched for 2 patterns, read 3 files".
function CollapsedGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const cwd = useContext(CwdContext);
  const active = live && tools.some((t) => !t.result);
  const reads = new Set(tools.filter((t) => t.block.name === 'Read').map((t) => t.block.input?.file_path)).size;
  const searches = tools.filter((t) => t.block.name !== 'Read').length;
  const parts: string[] = [];
  if (searches) parts.push(`${active ? 'searching for' : 'searched for'} ${plural(searches, 'pattern')}`);
  if (reads) parts.push(`${active ? 'reading' : 'read'} ${plural(reads, 'file')}`);
  const summary = parts.join(', ').replace(/^./, (c) => c.toUpperCase()) + (active ? '…' : '');
  const last = tools[tools.length - 1];
  return (
    <div className="mt-2.5">
      <button onClick={() => setOpen((o) => !o)} className={`flex w-full text-left ${MONO} ${active ? 'text-ink' : 'text-muted'}`}>
        {active ? <Dot state="pending" /> : <span className="w-5 shrink-0" />}
        <span className="min-w-0 flex-1">
          {summary} <span className="text-muted-soft">({open ? 'tap to collapse' : 'tap to expand'})</span>
        </span>
      </button>
      {active && !open && (
        <Response>
          <span className="block truncate text-muted-soft">
            {last.block.name === 'Read' ? displayPath(last.block.input?.file_path, cwd) : `"${last.block.input?.pattern}"`}
          </span>
        </Response>
      )}
      {open && tools.map((t) => <ToolUse key={t.key} tool={t} live={live} />)}
    </div>
  );
}

// ---------- thinking ----------

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`mt-2.5 ${MONO} italic text-muted-soft`}>
      <button onClick={() => setOpen((o) => !o)} className="text-left italic hover:text-muted">
        ∴ Thinking{open ? '…' : ' (tap to expand)'}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap pl-4 not-italic leading-relaxed text-muted">{text}</div>}
    </div>
  );
}

// ---------- spinner + todos ----------

const SPINNER_FRAMES = ['·', '✢', '*', '✶', '✻', '✽'];
const PINGPONG = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];
const VERBS = [
  'Accomplishing', 'Architecting', 'Brewing', 'Calculating', 'Cerebrating', 'Cogitating', 'Computing', 'Concocting',
  'Crafting', 'Deliberating', 'Elucidating', 'Finagling', 'Forging', 'Hatching', 'Ideating', 'Manifesting', 'Marinating',
  'Musing', 'Noodling', 'Percolating', 'Pondering', 'Processing', 'Puzzling', 'Ruminating', 'Simmering', 'Synthesizing',
  'Thinking', 'Tinkering', 'Working', 'Wrangling',
];

export function Spinner({ startedAt, thinking, task }: { startedAt: number; thinking: boolean; task?: string }) {
  const [tick, setTick] = useState(0);
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const status = [fmtDuration(secs * 1000), thinking ? 'thinking' : ''].filter(Boolean).join(' · ');
  return (
    <div className={`mt-3 flex ${MONO} text-primary`}>
      <span className="w-5 shrink-0 select-none">{PINGPONG[tick % PINGPONG.length]}</span>
      <span>
        {task ?? verb}…<span className="ml-1.5 text-muted-soft">({status})</span>
      </span>
    </div>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const doing = todos.filter((t) => t.status === 'in_progress').length;
  return (
    <div className={`mt-2 ${MONO}`}>
      <Response>
        <div className="mb-0.5 text-muted-soft">
          {plural(todos.length, 'task')} ({done} done, {doing} in progress, {todos.length - done - doing} open)
        </div>
        {todos.map((t, i) => (
          <div key={i} className={t.status === 'completed' ? 'text-muted-soft line-through' : t.status === 'in_progress' ? 'font-semibold text-ink' : 'text-body'}>
            <span className={`mr-1.5 no-underline ${t.status === 'completed' ? 'text-success' : t.status === 'in_progress' ? 'text-primary' : ''}`}>
              {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◼' : '◻'}
            </span>
            {t.content}
          </div>
        ))}
      </Response>
    </div>
  );
}

// ---------- permission prompt ----------

const PERMISSION_TITLES: Record<string, string> = {
  Bash: 'Bash command',
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  Write: 'Create file',
  NotebookEdit: 'Edit notebook',
  WebFetch: 'Fetch',
  Read: 'Read file',
  Task: 'Launch agent',
  Agent: 'Launch agent',
};

// Floating panel pinned above the composer (see ChatView), like the CLI's bottom-of-terminal dialog.
export function PermissionRequest({ vmId, sessionId, data, twins = [], resolved }: { vmId: string; sessionId: string; data: any; twins?: string[]; resolved: boolean }) {
  const { actions } = useStore();
  const cwd = useContext(CwdContext);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const name: string = data.toolName;
  const input = data.input ?? {};
  const isEdit = name === 'Edit' || name === 'MultiEdit';
  const target = displayPath(input.file_path ?? input.notebook_path, cwd);

  async function respond(behavior: 'allow' | 'deny') {
    setBusy(behavior);
    for (const id of twins) if (id !== data.requestId) actions.dispatch({ type: 'permission_resolved', requestId: id });
    await actions.resolvePermission(vmId, sessionId, data.requestId, behavior);
  }

  const question =
    isEdit ? `Do you want to make this edit to ${target}?`
    : name === 'Write' ? `Do you want to create ${target}?`
    : name === 'WebFetch' ? 'Do you want to allow Claude to fetch this content?'
    : 'Do you want to proceed?';

  return (
    <div className={`max-h-[55vh] overflow-y-auto rounded-md border-t-2 border-permission bg-surface-soft px-3 py-2.5 shadow-elevated ${MONO}`}>
      <p className="font-semibold text-permission">{PERMISSION_TITLES[name] ?? 'Tool use'}{mcpServer(name) ? ` (${mcpServer(name)} MCP)` : ''}</p>
      {target && <p className="truncate text-muted-soft">{target}</p>}
      <div className="my-2 text-body">
        {isEdit ? (
          <Diff block={{ name, input }} />
        ) : name === 'Bash' ? (
          <>
            <pre className="whitespace-pre-wrap break-words text-ink">{String(input.command ?? '')}</pre>
            {input.description && <p className="text-muted-soft">{String(input.description)}</p>}
          </>
        ) : name === 'Write' ? (
          <WritePreview content={String(input.content ?? '')} />
        ) : (
          <pre className="whitespace-pre-wrap break-words">{toolName(name, input)}({toolArgs(name, input, cwd) || JSON.stringify(input)})</pre>
        )}
      </div>
      {resolved ? (
        <p className="text-muted-soft">Resolved</p>
      ) : (
        <>
          <p className="mb-1 text-ink">{question}</p>
          <button disabled={busy !== null} onClick={() => respond('allow')} className="block w-full rounded-sm px-1.5 py-1 text-left text-ink hover:bg-surface-card disabled:opacity-40">
            <span className="text-permission">❯ </span>1. Yes
          </button>
          <button disabled={busy !== null} onClick={() => respond('deny')} className="block w-full rounded-sm px-1.5 py-1 text-left text-body hover:bg-surface-card disabled:opacity-40">
            <span className="opacity-0">❯ </span>2. No
          </button>
        </>
      )}
    </div>
  );
}

// ---------- item dispatcher ----------

const TURN_VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'];

export default function Message({ item, live, waitingForPermission }: { item: DisplayItem; live: boolean; waitingForPermission: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`mt-3 rounded-sm bg-surface-card px-2.5 py-1.5 ${MONO} text-ink`}>
          {item.blocks.map((b, i) =>
            b.type === 'text' ? (
              <div key={i} className="flex">
                <span className="w-5 shrink-0 select-none text-muted-soft">❯</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{b.text}</span>
              </div>
            ) : (
              <ImageBlock key={i} block={b} />
            ),
          )}
        </div>
      );
    case 'text':
      return (
        <div className="mt-2.5 flex">
          <span className={`w-5 shrink-0 select-none pt-[1px] ${MONO} text-ink`}>●</span>
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolUse tool={item} live={live} waitingForPermission={waitingForPermission && !item.result} />;
    case 'group':
      return <CollapsedGroup tools={item.tools} live={live} />;
    case 'turn_end': {
      const d = item.data;
      if (d.subtype === 'error_during_execution' || d.is_error) {
        return (
          <div className="mt-2.5">
            <Response>
              <span className="text-muted-soft">
                {d.subtype === 'error_during_execution' ? 'Interrupted · What should Claude do instead?' : 'Turn ended with an error'}
              </span>
            </Response>
          </div>
        );
      }
      if (!d.duration_ms || d.duration_ms < 1000) return null;
      const verb = TURN_VERBS[Math.abs(Number(d.duration_ms) | 0) % TURN_VERBS.length];
      return <p className={`mt-2.5 ${MONO} text-muted-soft`}>✻ {verb} for {fmtDuration(d.duration_ms)}</p>;
    }
    case 'system':
      return <p className={`mt-2.5 text-center ${MONO} text-[11px] text-muted-soft`}>✻ {item.text}</p>;
    case 'error':
      return (
        <div className="mt-2.5">
          <Response><span className="text-error">{item.text}</span></Response>
        </div>
      );
    case 'permission_request':
      // Rendered as the floating panel above the composer instead.
      return null;
  }
}
