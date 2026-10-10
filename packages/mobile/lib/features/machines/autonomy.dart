import 'group_messages.dart' show asMap, normalizeBlocks;
import 'protocol.dart';

/// Autonomous chats: Escanor is told the work and does it. It answers its own permission prompts (except for a short list of things
/// that cannot be taken back), checks its own work, fixes what failed and goes again until the work is done, and only stops when it is
/// done, truly stuck, or the person says Stop.
///
/// Everything here is pure (no I/O, no Flutter), so what matters is tested: what is refused, and when it goes round again.

/// Marks the instructions Escanor adds to what you typed, and the nudges it sends itself. Chat hides both.
const autoMarker = '[escanor:auto]';

const doneMarker = 'ESCANOR_DONE';
const blockedMarker = 'ESCANOR_BLOCKED';

/// How many times Escanor goes round again by itself after one request.
const maxAutoRounds = 8;

/// The modes that work on their own. (Bypass asks for nothing either, so the loop applies there too.)
bool isAutonomousMode(String mode) => mode == 'auto' || mode == 'bypassPermissions';

const autonomyBrief = '''$autoMarker
You are working autonomously. Do not ask me questions or for permission: make sensible decisions yourself and carry on. Do the work, then check it yourself: run the tests, read the logs, look at the actual output. If anything fails or the goal is not fully met, fix it and check again, and repeat until it works. When the work is done and verified, end your final message with a line "$doneMarker: <one-line summary>". If it is truly impossible, end with "$blockedMarker: <why>". Never delete data, force-push, spend money or change who has access unless you were told to.''';

/// What the person typed, with the standing instructions added for the machine.
String withAutonomyBrief(String typed) => '${typed.trimRight()}\n\n$autonomyBrief';

/// What the person typed, without what was added to it (for showing in the chat). Null when the whole message was Escanor's own nudge.
String? shownUserText(String text) {
  final at = text.indexOf(autoMarker);
  if (at < 0) return text;
  final typed = text.substring(0, at).trim();
  return typed.isEmpty ? null : typed;
}

// ---------------------------------------------------------------------------------------------- answering prompts

class Verdict {
  const Verdict.allow() : allow = true, reason = '';
  const Verdict.deny(this.reason) : allow = false;
  final bool allow;
  final String reason;
}

// Kept in step with packages/shared/src/autonomy.ts (which the machine's agent applies itself): its test compares these regular
// expressions with that copy character for character, and both copies answer packages/shared/test/autonomy-cases.json.
//
// Everything is linear in the length of the command: the regular expressions have no nested or overlapping quantifiers, and
// the rules that look along a command (rm, git push, dd, chmod) walk its words once instead of using a pattern that can backtrack.

/// Longer commands are refused unchecked rather than checked slowly.
const maxCommandChars = 100_000;

/// Matched against the whole (normalised) command.
final List<(RegExp, String)> _blockedCommands = [
  (RegExp(r'\bmkfs(\.\w+)?\b'), 'formats a disk'),
  (RegExp(r'>\s?/dev/(?:sd|nvme|vd|xvd|hd)'), 'writes straight onto a disk'),
  (RegExp(r':\(\)\s?\{\s?:\s?\|\s?:\s?&\s?\}\s?;\s?:'), 'a fork bomb'),
  (RegExp(r'\b(?:shutdown|poweroff|halt|reboot)\b'), 'turns the machine off'),
  (RegExp(r'\bdrop\s(?:database|schema)\b', caseSensitive: false), 'drops a whole database'),
  (RegExp(r'\btruncate\stable\b', caseSensitive: false), 'empties a table'),
  (RegExp(r'\b(?:userdel|deluser)\b|\bpasswd\s-d\b'), 'changes who can log in'),
  (RegExp(r'\biptables\s-F\b|\bufw\sdisable\b'), 'turns the firewall off'),
];

/// Matched against the path a file tool writes.
final List<(RegExp, String)> _blockedPaths = [
  (RegExp(r'^/(?:etc/(?:shadow|sudoers|passwd|ssh/sshd_config)|boot/|dev/|proc/|sys/)'), 'a system file'),
  (RegExp(r'(?:^|/)\.ssh/(?:authorized_keys|id_[a-z0-9]+)$'), 'who can log in'),
];

const _whyWipe = 'wipes the machine or a home folder';
const _whyForcePush = 'force-pushes over a main branch';
const _whyDisk = 'writes straight onto a disk';
const _whyChmod = 'opens up every file on the machine';
const _whyTooLong = 'is too long to check (over $maxCommandChars characters)';

const _fileTools = {'Write', 'Edit', 'MultiEdit', 'NotebookEdit'};

/// Any tool whose input has one of these as a string runs a command (Bash, Monitor, PowerShell, an MCP shell tool...).
const _commandFields = ['command', 'cmd', 'script'];

final Set<String> _rmTargets = {
  '/', '/*', '~', '~/', r'$HOME', r'$HOME/', r'${HOME}', r'${HOME}/',
  for (final d in ['home', 'root', 'etc', 'usr', 'var', 'boot', 'bin', 'lib', 'opt']) ...['/$d', '/$d/'],
};
const _protectedBranches = {'main', 'master', 'production', 'prod', 'release'};

/// A line continuation is a space, and any run of spaces or tabs one space (newlines stay: they separate commands).
/// Only what changes is replaced (other whitespace, then runs of spaces), so an ordinary long command is scanned, not rebuilt.
String normalizeCommand(String command) {
  var s = command.contains('\\') ? command.replaceAll(_continuation, ' ') : command;
  s = s.replaceAll(_otherSpace, ' ');
  return s.replaceAll(_spaceRun, ' ');
}

final _continuation = RegExp(r'\\\r?\n');
final _otherSpace = RegExp(r'[^\S\n ]');
final _spaceRun = RegExp(r'  +');

/// A word as the shell would mostly see it: without quotes, and without $( ` ( { around it.
final _quotes = RegExp('["\']');

String _clean(String word) {
  if (word.isEmpty) return word;
  final first = word.codeUnitAt(0), last = word.codeUnitAt(word.length - 1);
  const wrap = {0x22, 0x27, 0x24, 0x28, 0x60, 0x7b, 0x29, 0x7d}; // " ' $ ( ` { ) }
  if (!wrap.contains(first) && !wrap.contains(last) && !word.contains('"') && !word.contains("'")) return word;
  var w = word.contains('"') || word.contains("'") ? word.replaceAll(_quotes, '') : word;
  while (w.startsWith(r'$(') || w.startsWith('(') || w.startsWith('`') || w.startsWith('{')) {
    w = w.substring(w.startsWith(r'$(') ? 2 : 1);
  }
  while (w.endsWith(')') || w.endsWith('`') || (w.endsWith('}') && !w.startsWith(r'${'))) {
    w = w.substring(0, w.length - 1);
  }
  return w;
}

/// The program a word runs: `/bin/rm`, `\rm` and `rm` are all rm.
String _program(String word) {
  final base = word.substring(word.lastIndexOf('/') + 1);
  return base.startsWith(r'\') ? base.substring(1) : base;
}

final _shortFlags = RegExp(r'^-[A-Za-z]+$');
final _rmRecursive = RegExp('[rRfF]');
final _nonWord = RegExp(r'[^A-Za-z0-9_]+');
final _segmentBreak = RegExp(r'[;&|\n]+');

bool _isOctal777(String w) => w.length >= 3 && w.endsWith('777') && w.codeUnits.every((c) => c >= 0x30 && c <= 0x37);
bool _isForceFlag(String w) => w.startsWith('-') && (w.startsWith('--force') || (w.contains('f') && _shortFlags.hasMatch(w)));
bool _namesProtectedBranch(String w) => w.split(_nonWord).any(_protectedBranches.contains);

/// The word-by-word rules, one pass over each command of the line.
String? _wordRules(String normalized) {
  for (final segment in normalized.split(_segmentBreak)) {
    bool? rmRecursive; // null: no rm seen
    ({bool push, bool force, bool branch})? git;
    var dd = false;
    String? chmod; // 'flags' | 'slash'
    for (final raw in segment.split(' ')) {
      if (raw.isEmpty) continue;
      final w = _clean(raw);
      // Only a word that could name one of the four programs is looked at more closely.
      final name = w.endsWith('rm') || w.endsWith('git') || w.endsWith('dd') || w.endsWith('chmod') ? _program(w) : '';
      if (name == 'rm') {
        rmRecursive = false;
        continue;
      }
      if (name == 'git') {
        git = (push: false, force: false, branch: false);
        continue;
      }
      if (name == 'dd') {
        dd = true;
        continue;
      }
      if (name == 'chmod') {
        chmod = 'flags';
        continue;
      }
      if (rmRecursive != null) {
        if (w.startsWith('-')) {
          if (w == '--recursive' || w == '--force' || (!w.startsWith('--') && _rmRecursive.hasMatch(w))) rmRecursive = true;
        } else if (rmRecursive && _rmTargets.contains(w)) {
          return _whyWipe;
        }
      }
      final g = git;
      if (g != null) {
        if (!g.push) {
          if (w == 'push') git = (push: true, force: false, branch: false);
        } else {
          final force = g.force || _isForceFlag(w) || (w.startsWith('+') && _namesProtectedBranch(w));
          final branch = g.branch || ((!w.startsWith('-') || w.contains('=')) && _namesProtectedBranch(w));
          if (force && branch) return _whyForcePush;
          git = (push: true, force: force, branch: branch);
        }
      }
      if (dd && w.startsWith('of=/dev/')) return _whyDisk;
      if (chmod == 'flags' && !w.startsWith('-')) {
        chmod = _isOctal777(w) ? 'slash' : null;
      } else if (chmod == 'slash') {
        if (w == '/') return _whyChmod;
        chmod = null;
      }
    }
  }
  return null;
}

/// Why a command must not run on its own, or null.
String? commandBlockReason(String command) {
  if (command.length > maxCommandChars) return _whyTooLong;
  final normalized = normalizeCommand(command);
  for (final (re, why) in _blockedCommands) {
    if (re.hasMatch(normalized)) return why;
  }
  return _wordRules(normalized);
}

/// Would an autonomous chat say yes to this? Almost always: the work is what it is there for. The exceptions are things that
/// cannot be undone or that hand the machine to someone else. A "no" is passed to Claude, which then finds another way.
Verdict decideAutonomously(String tool, Map<String, dynamic> input) {
  if (tool == 'AskUserQuestion') {
    // Nobody is there to answer: turn it back into Claude's own decision.
    return const Verdict.deny('Do not ask. Decide yourself and carry on.');
  }
  for (final key in _commandFields) {
    final value = input[key];
    if (value is! String) continue;
    final why = commandBlockReason(value);
    if (why != null) return Verdict.deny('That $why.');
  }
  if (_fileTools.contains(tool)) {
    final path = '${input['file_path'] ?? input['notebook_path'] ?? ''}';
    for (final (re, why) in _blockedPaths) {
      if (re.hasMatch(path)) return Verdict.deny('That changes $why.');
    }
  }
  return const Verdict.allow();
}

/// The same question for an approval the assistant on the Chat tab shows as text (its title, detail and the raw command), where there
/// is no tool name to look at. [risk] is what the server itself called it: anything it marks high waits for the person.
Verdict decideApprovalText(String text, {String risk = 'normal'}) {
  if (risk == 'high') return const Verdict.deny('The server marked this as high risk.');
  final why = commandBlockReason(text);
  return why == null ? const Verdict.allow() : Verdict.deny('That $why.');
}

// ---------------------------------------------------------------------------------------------- going round again

class Nudge {
  const Nudge(this.reason, this.text);

  /// error | unfinished | asked
  final String reason;
  final String text;
}

String _nudgeText(String lead) =>
    '$autoMarker\n$lead Check the logs and the actual results yourself. If anything failed or the goal is not fully met, fix it and try again. '
    'Do not ask me anything: decide yourself. When it is done and verified, end with "$doneMarker: <summary>"; if it is truly impossible, end with "$blockedMarker: <why>".';

bool _truthy(Object? v) => v != null && v != false && v != '' && v != 0;

/// Look at the chat after a turn ended and say whether Escanor should go round once more by itself. Null: it is done, stuck, stopped,
/// or has gone round enough. [halted] is set when the person pressed Stop.
Nudge? nextNudge(List<MessageDto> rows, {required int rounds, required bool halted, int maxRounds = maxAutoRounds}) {
  if (halted || rounds >= maxRounds || rows.isEmpty) return null;

  // The turn is whatever came after the latest prompt (typed by the person, or one of our own nudges).
  var start = -1;
  for (var i = rows.length - 1; i >= 0; i--) {
    final m = rows[i].message;
    if (m is Map && m['type'] == 'user' && _truthy(m['local'])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  final turn = rows.sublist(start + 1);
  if (turn.isEmpty) return null;

  // The turn has ended only if its last row is the result (a still-running turn is not ours to judge).
  final last = turn.last.message;
  if (last is! Map || last['type'] != 'result') return null;
  final result = asMap(last);
  final subtype = '${result['subtype'] ?? ''}';

  var toolsUsed = false;
  String lastText = '';
  for (final row in turn) {
    final m = row.message;
    if (m is! Map || m['type'] != 'assistant' || _truthy(m['parent_tool_use_id'])) continue;
    final inner = m['message'];
    for (final b in normalizeBlocks(inner is Map ? inner['content'] : null)) {
      if (b['type'] == 'tool_use') toolsUsed = true;
      if (b['type'] == 'text' && '${b['text'] ?? ''}'.trim().isNotEmpty) lastText = '${b['text']}';
    }
  }
  final said = '$lastText\n${result['result'] ?? ''}';
  if (said.contains(doneMarker) || said.contains(blockedMarker)) return null;

  // Interrupted (here or elsewhere): the person wants it to stop.
  if (subtype == 'error_during_execution') return null;
  final failed = _truthy(result['is_error']) || subtype.startsWith('error');
  if (failed) return Nudge('error', _nudgeText('That stopped with an error.'));
  if (toolsUsed) return Nudge('unfinished', _nudgeText('You did some work but have not said it is finished.'));
  // A task that was answered with a question gets one nudge to decide for itself. A greeting or a short question is just a chat.
  var typed = '';
  final promptMessage = rows[start].message;
  if (promptMessage is Map) {
    final inner = promptMessage['message'];
    for (final b in normalizeBlocks(inner is Map ? inner['content'] : null)) {
      if (b['type'] == 'text' && b['text'] is String) typed += shownUserText(b['text'] as String) ?? '';
    }
  }
  if (rounds == 0 && typed.trim().length >= 25 && lastText.trimRight().endsWith('?')) {
    return Nudge('asked', _nudgeText('You asked me something; I am not available, so decide yourself.'));
  }
  return null;
}

/// "Round 2 of 8" for the chat header.
String roundsText(int rounds) => rounds <= 0 ? '' : 'Checking its work · round ${rounds + 1} of ${maxAutoRounds + 1}';
