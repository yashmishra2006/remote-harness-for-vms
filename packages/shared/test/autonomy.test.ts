import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autonomousBlockReason, BLOCKED_COMMANDS, BLOCKED_PATHS, MAX_COMMAND_CHARS, normalizeCommand, type Blocked } from '../src/autonomy.ts';

// The phone keeps its own copy (Dart cannot import this one). Its regular expressions are read out of its source and compared,
// and autonomy-cases.json is run against both copies (the phone's test reads the same file).
const dart = readFileSync(new URL('../../mobile/lib/features/machines/autonomy.dart', import.meta.url), 'utf8');
const cases: Array<{ tool: string; input: Record<string, unknown>; blocked: string | null }> = JSON.parse(
  readFileSync(new URL('./autonomy-cases.json', import.meta.url), 'utf8'),
);

function dartList(name: string): Blocked[] {
  const body = dart.split(`${name} = [`)[1]?.split('\n];')[0];
  assert.ok(body, `${name} not found in autonomy.dart`);
  const out: Blocked[] = [];
  for (const m of body.matchAll(/\(RegExp\(r'((?:[^'\\]|\\.)*)'(, caseSensitive: false)?\), '([^']*)'\)/g)) {
    out.push({ source: m[1], ...(m[2] ? { ignoreCase: true } : {}), why: m[3] });
  }
  // Every entry of the list was understood: one parsed per entry written.
  const written = body.split('\n').filter((line) => line.trim().startsWith('(')).length;
  assert.equal(out.length, written, `${name}: parsed ${out.length} of ${written} entries`);
  return out;
}

describe('the Autonomous blocklist', () => {
  it('has the same regular expressions as the phone', () => {
    assert.deepEqual(dartList('_blockedCommands'), BLOCKED_COMMANDS);
    assert.deepEqual(dartList('_blockedPaths'), BLOCKED_PATHS);
    assert.match(dart, new RegExp(`const maxCommandChars = ${MAX_COMMAND_CHARS.toString().replace(/\B(?=(\d{3})+$)/g, '_')};`));
  });

  it('answers every shared case (the phone runs the same file)', () => {
    assert.ok(cases.length > 50);
    for (const c of cases) {
      const why = autonomousBlockReason(c.tool, c.input);
      if (c.blocked === null) assert.equal(why, null, `${c.tool} ${JSON.stringify(c.input)} must be allowed (got ${why})`);
      else assert.ok(why?.includes(c.blocked), `${c.tool} ${JSON.stringify(c.input)} must be blocked for "${c.blocked}" (got ${why})`);
    }
  });

  it('reads a line continuation as a space and a run of spaces as one', () => {
    assert.equal(normalizeCommand('git push --force origin \\\n  main'), 'git push --force origin main');
    assert.equal(normalizeCommand('a\t\t b\nc'), 'a b\nc');
  });

  it('refuses a command too long to check, and stays fast on long ones it does check', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => `t${i}`).join(' '); // 100k words
    let t = performance.now();
    assert.match(autonomousBlockReason('Bash', { command: huge }) ?? '', /too long to check/);
    assert.ok(performance.now() - t < 50, 'a 100k-word command is answered at once');
    // Just under the limit, shaped to make a backtracking pattern blow up: answered in well under 50 ms each.
    const fill = (unit: string) => unit.repeat(Math.floor((MAX_COMMAND_CHARS - 10) / unit.length));
    for (const command of [fill('git push '), fill('rm -r '), fill('dd '), fill('chmod 7'), fill('git push -f '), fill('a\\\n'), fill(' '), fill('\t '), fill('>/dev/s'), fill(':(){ '), fill('drop '), fill('passwd ')]) {
      assert.ok(command.length <= MAX_COMMAND_CHARS);
      t = performance.now();
      autonomousBlockReason('Bash', { command });
      const took = performance.now() - t;
      assert.ok(took < 50, `${JSON.stringify(command.slice(0, 12))}... took ${took.toFixed(1)} ms`);
    }
  });
});
