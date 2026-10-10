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
  { source: String.raw`\bdrop\s+(?:database|schema)\b`, ignoreCase: true, why: 'drops a whole database' },
  { source: String.raw`\btruncate\s+table\b`, ignoreCase: true, why: 'empties a table' },
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
  forcePushNoBranch:
    'force-pushes without naming a branch, which could overwrite a main branch (name a non-protected branch explicitly, e.g. git push --force origin my-branch)',
  deleteBranch: 'deletes a main branch on the remote',
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

/** What `rm -r` must never be pointed at (compared, after canonPath, with the words of the command; the phone has the same list). */
export const RM_TARGETS: readonly string[] = [
  '/', '/*', '~', '~/', '$HOME', '$HOME/',
  '${HOME}', '${HOME}/', '/home', '/home/', '/root', '/root/',
  '/etc', '/etc/', '/usr', '/usr/', '/var', '/var/',
  '/boot', '/boot/', '/bin', '/bin/', '/lib', '/lib/',
  '/opt', '/opt/',
];
const RM_TARGET_SET = new Set(RM_TARGETS);
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'production', 'prod', 'release'];
const PROTECTED_SET = new Set(PROTECTED_BRANCHES);

/**
 * Deletes each line continuation, as bash does: a backslash-newline whose backslash is not itself escaped (an odd number of
 * backslashes in a row before the newline). `echo foo\\<newline>rm -rf /` is two commands, and stays two. Only before a newline
 * itself: bash reads backslash-CR-LF as an escaped CR, and the LF still ends the command. One pass, counting.
 */
export function joinContinuations(command: string): string {
  if (!command.includes('\\')) return command;
  const parts: string[] = [];
  let from = 0;
  let run = 0; // backslashes in a row just before i
  for (let i = 0; i < command.length; i++) {
    const c = command.charCodeAt(i);
    if (c === 0x5c) {
      run++;
      continue;
    }
    if (c === 0x0a && run % 2 === 1) {
      parts.push(command.slice(from, i - 1));
      from = i + 1;
    }
    run = 0;
  }
  if (from === 0) return command;
  parts.push(command.slice(from));
  return parts.join('');
}

/** A line continuation is deleted (as bash does), and any run of spaces or tabs is one space (newlines stay: they separate commands). */
export function normalizeCommand(command: string): string {
  // Only what changes is replaced (other whitespace, then runs of spaces), so an ordinary long command is scanned, not rebuilt.
  return joinContinuations(command).replace(/[^\S\n ]/g, ' ').replace(/  +/g, ' ');
}

/** A word as the shell would mostly see it: without quotes, and without { around its start or } at its end. */
function clean(word: string): string {
  const w = word.includes('"') || word.includes("'") ? word.replace(/["']/g, '') : word;
  let start = 0;
  let end = w.length;
  while (start < end && w.charCodeAt(start) === 0x7b) start++; // {
  if (!w.startsWith('${')) while (end > start && w.charCodeAt(end - 1) === 0x7d) end--; // }
  return start === 0 && end === w.length ? w : w.slice(start, end);
}

/** `$(`, backticks and parentheses separate words wherever they stand (`x=$(rm -rf /)`, `"a$(rm -rf /)"`). */
const SUBSHELL = /\$\(|[`()]/g;
/**
 * A path glued to the end of a substitution (`$(pwd)/*`, `"$(mktemp -d)/"`, `` `pwd`/x ``) is relative to what the substitution
 * printed, not the root: the `)` or backtick becomes ` .`, so the path that follows reads `./*`. (A backtick that opens a
 * substitution and is followed by `/` only gains a `./` in front of a program path, which still names the same program.)
 */
const AFTER_SUBSTITUTION = /[)`](?=["']*\/)/g;

/** `~`, `$HOME` and `${HOME}` stand for a folder in /home (or /root): `~/..` is /home. */
const HOME_ALIASES = new Set(['~', '$HOME', '${HOME}']);
const isGlobAll = (seg: string) => seg.length > 0 && [...seg].every((c) => c === '*');

/**
 * A path as the shell would resolve it, for comparing with RM_TARGETS: repeated and `/./` slashes collapse, `..` goes up (above
 * `~` too: `~/..` is /home), and trailing `/*` (`/*\/*`...) or `/.` means the folder itself (`~/*`, `~/*\/*`, `/home/*`, `//`,
 * `~/.` are the roots they glob or alias).
 */
export function canonPath(w: string): string {
  if (!w.includes('/') && w !== '*') return w;
  const segs = w.split('/');
  const home = HOME_ALIASES.has(segs[0]);
  const absolute = home || w.startsWith('/');
  // A home alias starts as /home/<it>, and is written back as the alias if the path stays inside it.
  const stack: string[] = home ? ['home', segs[0]] : [];
  for (let i = home ? 1 : 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop();
      else if (!absolute) stack.push(seg);
    } else stack.push(seg);
  }
  while (stack.length && isGlobAll(stack[stack.length - 1])) stack.pop();
  if (home && stack.length >= 2 && stack[0] === 'home' && stack[1] === segs[0]) return [segs[0], ...stack.slice(2)].join('/');
  return (absolute ? '/' : '') + stack.join('/');
}

/** The program a word runs: `/bin/rm`, `\rm` and `rm` are all rm. */
function program(word: string): string {
  const base = word.slice(word.lastIndexOf('/') + 1);
  return base.startsWith('\\') ? base.slice(1) : base;
}

const isOctal777 = (w: string) => w.length >= 3 && w.endsWith('777') && [...w].every((c) => c >= '0' && c <= '7');
const SHORT_FLAGS = /^-[A-Za-z]+$/;
const isForceFlag = (w: string) => w.startsWith('-') && (w.startsWith('--force') || (w.includes('f') && SHORT_FLAGS.test(w)));
const namesProtectedBranch = (w: string) => w.split(/[^A-Za-z0-9_]+/).some((p) => PROTECTED_SET.has(p));
/** `HEAD` and `@` push the current branch, which may be main: no branch is named. */
const isCurrentBranch = (w: string) => w === 'HEAD' || w === '@' || w === '+HEAD' || w === '+@';
/** `-o X` / `--push-option X` (and `-fo X`): X is a push option, not a refspec. */
const takesPushOption = (w: string) => w === '--push-option' || (SHORT_FLAGS.test(w) && w.endsWith('o'));

/** The word-by-word rules, one pass over each command of the line. */
function wordRules(normalized: string): string | null {
  for (const segment of normalized.replace(AFTER_SUBSTITUTION, ' .').replace(SUBSHELL, ' ').split(/[;&|\n]+/)) {
    let rm: { recursive: boolean; wipe: boolean } | null = null;
    let git: { push: boolean; force: boolean; branch: boolean; del: boolean; skip: boolean; args: string[] } | null = null;
    let dd = false;
    let chmod: 'flags' | 'mode' | 'slash' | null = null;
    for (const raw of segment.split(/ +/)) {
      if (!raw) continue;
      const w = clean(raw);
      // Only a word that could name one of the four programs is looked at more closely.
      const name = w.endsWith('rm') || w.endsWith('git') || w.endsWith('dd') || w.endsWith('chmod') ? program(w) : '';
      if (name === 'rm') {
        rm = { recursive: false, wipe: false };
        continue;
      }
      if (name === 'git') {
        git = { push: false, force: false, branch: false, del: false, skip: false, args: [] };
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
        // Options may come after the target (`rm ~ -rf`), so both are remembered and either order blocks.
        if (w.startsWith('-')) {
          if (w === '--recursive' || w === '--force' || (!w.startsWith('--') && /[rRfF]/.test(w))) rm.recursive = true;
        } else if (RM_TARGET_SET.has(w) || RM_TARGET_SET.has(canonPath(w))) {
          rm.wipe = true;
        }
        if (rm.recursive && rm.wipe) return WHY.wipe;
      }
      if (git) {
        if (!git.push) {
          if (w === 'push') git.push = true;
        } else if (git.skip) {
          git.skip = false; // the value of -o / --push-option
        } else {
          if (takesPushOption(w)) git.skip = true;
          if (isForceFlag(w) || (w.startsWith('+') && (namesProtectedBranch(w) || isCurrentBranch(w)))) git.force = true;
          if (w === '--delete' || (SHORT_FLAGS.test(w) && w.includes('d'))) git.del = true;
          if (!w.startsWith('-')) git.args.push(w);
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
    if (git?.push) {
      // `git push origin :main` and `git push --delete origin main` remove a main branch from the remote.
      if (git.args.some((a) => a.startsWith(':') && namesProtectedBranch(a)) || (git.del && git.args.some(namesProtectedBranch))) {
        return WHY.deleteBranch;
      }
      // A force push that names no branch goes wherever the push default points, which can be main (the first word is the
      // remote); so does one that pushes HEAD or @, the current branch.
      if (git.force && (git.args.length < 2 || git.args.slice(1).some(isCurrentBranch))) return WHY.forcePushNoBranch;
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
