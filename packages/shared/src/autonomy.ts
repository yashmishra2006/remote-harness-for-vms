/**
 * What an Autonomous chat never does on its own: things that cannot be undone or that hand the machine to someone else.
 *
 * The phone answers an Autonomous chat's prompts with this (packages/mobile lib/features/machines/autonomy.dart keeps its own
 * copy, since Dart cannot import this). The agent applies it itself, in a PreToolUse hook, where an Autonomous chat runs in
 * bypass mode and so asks nobody. Only a chat explicitly set to "Bypass permissions" runs without it.
 *
 * Kept in step with the phone two ways (test/autonomy.test.ts): the regular expressions below are compared with the phone's
 * character for character, and test/autonomy-cases.json is run against both copies.
 *
 * Everything here is linear in the length of the command: the regular expressions have no nested or overlapping quantifiers,
 * and the rules that need to look along a command (rm, git push, dd, chmod) walk its words once instead of using a pattern
 * that can backtrack.
 */

export type Blocked = { source: string; ignoreCase?: boolean; why: string };

/** Longer commands are refused unchecked rather than checked slowly. */
export const MAX_COMMAND_CHARS = 100_000;

/** Matched against the whole (normalised) command. */
export const BLOCKED_COMMANDS: readonly Blocked[] = [
  { source: String.raw`\bmkfs(\.\w+)?\b`, why: 'formats a disk' },
  { source: String.raw`>\s?/dev/(?:sd|nvme|vd|xvd|hd)`, why: 'writes straight onto a disk' },
  { source: String.raw`:\(\)\s?\{\s?:\s?\|\s?:\s?&\s?\}\s?;\s?:`, why: 'a fork bomb' },
  { source: String.raw`\b(?:shutdown|poweroff|halt|reboot)\b`, why: 'turns the machine off' },
  { source: String.raw`\bdrop\s(?:database|schema)\b`, ignoreCase: true, why: 'drops a whole database' },
  { source: String.raw`\btruncate\stable\b`, ignoreCase: true, why: 'empties a table' },
  { source: String.raw`\b(?:userdel|deluser)\b|\bpasswd\s-d\b`, why: 'changes who can log in' },
  { source: String.raw`\biptables\s-F\b|\bufw\sdisable\b`, why: 'turns the firewall off' },
];

/** Matched against the path a file tool writes. */
export const BLOCKED_PATHS: readonly Blocked[] = [
  { source: String.raw`^/(?:etc/(?:shadow|sudoers|passwd|ssh/sshd_config)|boot/|dev/|proc/|sys/)`, why: 'a system file' },
  { source: String.raw`(?:^|/)\.ssh/(?:authorized_keys|id_[a-z0-9]+)$`, why: 'who can log in' },
];

/** Reasons of the word-by-word rules (same text on the phone). */
export const WHY = {
  wipe: 'wipes the machine or a home folder',
  forcePush: 'force-pushes over a main branch',
  disk: 'writes straight onto a disk',
  chmod: 'opens up every file on the machine',
  tooLong: `is too long to check (over ${MAX_COMMAND_CHARS} characters)`,
} as const;

const compile = (list: readonly Blocked[]) => list.map((b) => ({ re: new RegExp(b.source, b.ignoreCase ? 'i' : ''), why: b.why }));
const COMMANDS = compile(BLOCKED_COMMANDS);
const PATHS = compile(BLOCKED_PATHS);

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Any tool whose input has one of these as a string runs a command (Bash, Monitor, PowerShell, an MCP shell tool...). */
const COMMAND_FIELDS = ['command', 'cmd', 'script'] as const;

const RM_TARGETS = new Set(['/', '/*', '~', '~/', '$HOME', '$HOME/', '${HOME}', '${HOME}/']);
for (const d of ['home', 'root', 'etc', 'usr', 'var', 'boot', 'bin', 'lib', 'opt']) RM_TARGETS.add(`/${d}`).add(`/${d}/`);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod', 'release']);

/** A line continuation is a space, and any run of spaces or tabs one space (newlines stay: they separate commands). */
export function normalizeCommand(command: string): string {
  // Only what changes is replaced (other whitespace, then runs of spaces), so an ordinary long command is scanned, not rebuilt.
  const s = command.includes('\\') ? command.replace(/\\\r?\n/g, ' ') : command;
  return s.replace(/[^\S\n ]/g, ' ').replace(/  +/g, ' ');
}

/** A word as the shell would mostly see it: without quotes, and without $( ` ( { around it. */
function clean(word: string): string {
  let w = word.includes('"') || word.includes("'") ? word.replace(/["']/g, '') : word;
  while (w.startsWith('$(') || w.startsWith('(') || w.startsWith('`') || w.startsWith('{')) w = w.slice(w.startsWith('$(') ? 2 : 1);
  while (w.endsWith(')') || w.endsWith('`') || (w.endsWith('}') && !w.startsWith('${'))) w = w.slice(0, -1);
  return w;
}

/** The program a word runs: `/bin/rm`, `\rm` and `rm` are all rm. */
function program(word: string): string {
  const base = word.slice(word.lastIndexOf('/') + 1);
  return base.startsWith('\\') ? base.slice(1) : base;
}

const isOctal777 = (w: string) => w.length >= 3 && w.endsWith('777') && [...w].every((c) => c >= '0' && c <= '7');
const SHORT_FLAGS = /^-[A-Za-z]+$/;
const isForceFlag = (w: string) => w.startsWith('-') && (w.startsWith('--force') || (w.includes('f') && SHORT_FLAGS.test(w)));
const namesProtectedBranch = (w: string) => w.split(/[^A-Za-z0-9_]+/).some((p) => PROTECTED_BRANCHES.has(p));

/** The word-by-word rules, one pass over each command of the line. */
function wordRules(normalized: string): string | null {
  for (const segment of normalized.split(/[;&|\n]+/)) {
    let rm: { recursive: boolean } | null = null;
    let git: { push: boolean; force: boolean; branch: boolean } | null = null;
    let dd = false;
    let chmod: 'flags' | 'mode' | 'slash' | null = null;
    for (const raw of segment.split(' ')) {
      if (!raw) continue;
      const w = clean(raw);
      // Only a word that could name one of the four programs is looked at more closely.
      const name = w.endsWith('rm') || w.endsWith('git') || w.endsWith('dd') || w.endsWith('chmod') ? program(w) : '';
      if (name === 'rm') {
        rm = { recursive: false };
        continue;
      }
      if (name === 'git') {
        git = { push: false, force: false, branch: false };
        continue;
      }
      if (name === 'dd') {
        dd = true;
        continue;
      }
      if (name === 'chmod') {
        chmod = 'flags';
        continue;
      }
      if (rm) {
        if (w.startsWith('-')) {
          if (w === '--recursive' || w === '--force' || (!w.startsWith('--') && /[rRfF]/.test(w))) rm.recursive = true;
        } else if (rm.recursive && RM_TARGETS.has(w)) {
          return WHY.wipe;
        }
      }
      if (git) {
        if (!git.push) {
          if (w === 'push') git.push = true;
        } else {
          if (isForceFlag(w) || (w.startsWith('+') && namesProtectedBranch(w))) git.force = true;
          if (!w.startsWith('-') || w.includes('=')) git.branch ||= namesProtectedBranch(w);
          if (git.force && git.branch) return WHY.forcePush;
        }
      }
      if (dd && w.startsWith('of=/dev/')) return WHY.disk;
      if (chmod === 'flags' && !w.startsWith('-')) chmod = isOctal777(w) ? 'slash' : null;
      else if (chmod === 'slash') {
        if (w === '/') return WHY.chmod;
        chmod = null;
      }
    }
  }
  return null;
}

/** Why a command must not run on its own, or null. */
export function commandBlockReason(command: string): string | null {
  if (command.length > MAX_COMMAND_CHARS) return WHY.tooLong;
  const normalized = normalizeCommand(command);
  for (const { re, why } of COMMANDS) if (re.test(normalized)) return why;
  return wordRules(normalized);
}

/**
 * Why an Autonomous chat must not do this on its own, or null when it may. Mirrors the phone's decideAutonomously for the tools
 * that change the machine (a question for the person is handled where the prompt is answered).
 */
export function autonomousBlockReason(toolName: string, input: unknown): string | null {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const key of COMMAND_FIELDS) {
    const value = fields[key];
    if (typeof value !== 'string') continue;
    const why = commandBlockReason(value);
    if (why) return `That ${why}.`;
  }
  if (FILE_TOOLS.has(toolName)) {
    const path = String(fields.file_path ?? fields.notebook_path ?? '');
    for (const { re, why } of PATHS) if (re.test(path)) return `That changes ${why}.`;
  }
  return null;
}
