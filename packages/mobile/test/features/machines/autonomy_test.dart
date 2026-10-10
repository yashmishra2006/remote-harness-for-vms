import 'dart:convert';
import 'dart:io';

import 'package:escanor/core/storage.dart';
import 'package:escanor/features/machines/autonomy.dart';
import 'package:escanor/features/machines/chat_choices.dart';
import 'package:escanor/features/machines/group_messages.dart';
import 'package:escanor/features/machines/hub_api.dart';
import 'package:escanor/features/machines/hub_socket.dart';
import 'package:escanor/features/machines/hub_state.dart';
import 'package:escanor/features/machines/hub_store.dart';
import 'package:escanor/features/machines/protocol.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fakes.dart';

MessageDto row(num id, Object? message) => MessageDto(id: id, sessionId: 's', vmId: 'v', message: message, createdAt: '2026-10-08T10:00:00.000Z');

Map<String, dynamic> prompt(String text) => {
      'type': 'user',
      'local': true,
      'message': {
        'role': 'user',
        'content': [
          {'type': 'text', 'text': text}
        ]
      }
    };

Map<String, dynamic> assistant({String? text, bool tool = false}) => {
      'type': 'assistant',
      'message': {
        'content': [
          if (text != null) {'type': 'text', 'text': text},
          if (tool) {'type': 'tool_use', 'id': 't1', 'name': 'Bash', 'input': {'command': 'npm test'}},
        ]
      }
    };

Map<String, dynamic> result({String subtype = 'success', bool isError = false}) => {'type': 'result', 'subtype': subtype, 'is_error': isError, 'duration_ms': 4000};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('what an autonomous chat refuses', () {
    Verdict bash(String c) => decideAutonomously('Bash', {'command': c});

    test('ordinary work is allowed, including risky-looking but normal things', () {
      for (final c in ['npm test', 'rm -rf build', 'rm -rf node_modules && npm ci', 'git push origin feature', 'git push --force origin feature', 'docker compose up -d', 'sudo apt-get install -y jq', 'curl -s localhost:3000/health', 'systemctl restart app']) {
        expect(bash(c).allow, isTrue, reason: c);
      }
      expect(decideAutonomously('Edit', {'file_path': '/w/app/main.ts'}).allow, isTrue);
      expect(decideAutonomously('Write', {'file_path': '/home/u/.config/app.json'}).allow, isTrue);
      expect(decideAutonomously('WebFetch', {'url': 'https://example.com'}).allow, isTrue);
    });

    test('what cannot be taken back, or hands the machine over, is refused', () {
      for (final c in [
        'rm -rf /',
        'rm -rf / --no-preserve-root',
        'sudo rm -rf /*',
        'rm -rf ~',
        'rm -rf \$HOME',
        'rm -fr /home',
        'mkfs.ext4 /dev/sda1',
        'dd if=/dev/zero of=/dev/sda bs=1M',
        'echo x > /dev/sda',
        ':(){ :|:& };:',
        'chmod -R 777 /',
        'shutdown -h now',
        'sudo reboot',
        'git push --force origin main',
        'git push origin main --force',
        'git push -f origin master',
        'psql -c "DROP DATABASE prod"',
        'userdel -r alice',
        'ufw disable',
      ]) {
        expect(bash(c).allow, isFalse, reason: c);
      }
      expect(decideAutonomously('Write', {'file_path': '/etc/sudoers'}).allow, isFalse);
      expect(decideAutonomously('Edit', {'file_path': '/home/u/.ssh/authorized_keys'}).allow, isFalse);
    });

    test('answers every case the machine\'s agent answers (packages/shared/test/autonomy-cases.json)', () {
      final cases = jsonDecode(File('../shared/test/autonomy-cases.json').readAsStringSync()) as List;
      expect(cases.length, greaterThan(50));
      for (final c in cases.cast<Map<String, dynamic>>()) {
        final v = decideAutonomously(c['tool'] as String, Map<String, dynamic>.from(c['input'] as Map));
        final blocked = c['blocked'] as String?;
        if (blocked == null) {
          expect(v.allow, isTrue, reason: '${c['tool']} ${c['input']} must be allowed (got ${v.reason})');
        } else {
          expect(v.allow, isFalse, reason: '${c['tool']} ${c['input']} must be blocked');
          expect(v.reason, contains(blocked), reason: '${c['tool']} ${c['input']}');
        }
      }
    });

    test('a line continuation or extra spaces do not hide a command', () {
      expect(bash('git push --force origin \\\n main').allow, isFalse);
      expect(bash('git push origin main \\\n --force').allow, isFalse);
      expect(bash('rm -rf \\\n /').allow, isFalse);
      expect(normalizeCommand('a\t\t b\nc'), 'a b\nc');
    });

    test('a command too long to check is refused, and long ones are checked fast', () {
      final huge = List.generate(100000, (i) => 't$i').join(' ');
      final sw = Stopwatch()..start();
      expect(bash(huge).reason, contains('too long to check'));
      expect(sw.elapsedMilliseconds, lessThan(50));
      String fill(String unit) => unit * ((maxCommandChars - 10) ~/ unit.length);
      // Just under the limit, shaped to make a backtracking pattern blow up. The best of three, since this runs in the debug VM
      // (the app itself is compiled ahead of time, several times faster).
      for (final c in [fill('git push '), fill('rm -r '), fill('dd '), fill('chmod 7'), fill('git push -f '), fill('a\\\n'), fill(' '), fill('\t '), fill('>/dev/s'), fill(':(){ ')]) {
        var best = 1 << 30;
        for (var i = 0; i < 3; i++) {
          sw
            ..reset()
            ..start();
          bash(c);
          if (sw.elapsedMilliseconds < best) best = sw.elapsedMilliseconds;
        }
        expect(best, lessThan(50), reason: '${c.substring(0, 12)}...');
      }
    });

    test('one huge word of brackets, quotes or backticks is cut once, not over and over (it runs on the UI isolate)', () {
      // The word is cleaned of its wrapping characters; that used to copy the rest of the word once per character.
      final sw = Stopwatch();
      for (final unit in ['(', '`', '{', '}', ')', r'$(', '"', "'", '{}', '()']) {
        final c = unit * ((maxCommandChars - 10) ~/ unit.length);
        var best = 1 << 30;
        for (var i = 0; i < 3; i++) {
          sw
            ..reset()
            ..start();
          bash(c);
          bash('rm $c');
          bash('x$c');
          if (sw.elapsedMilliseconds < best) best = sw.elapsedMilliseconds;
        }
        // JIT, three commands per round: a generous bound that the old quadratic loop (over a second) broke by a wide margin.
        expect(best, lessThan(200), reason: 'a 100k run of $unit took $best ms');
      }
    });

    test('a question for the person is turned back into the chat’s own decision', () {
      final v = decideAutonomously('AskUserQuestion', {});
      expect(v.allow, isFalse);
      expect(v.reason, contains('Decide yourself'));
    });
  });

  group('going round again', () {
    List<MessageDto> turn(List<Object> messages, {String asked = 'fix the build'}) => [row(1, prompt(asked)), for (var i = 0; i < messages.length; i++) row(2 + i, messages[i])];

    test('done is done: it says so, or it is stuck, or it was stopped', () {
      expect(nextNudge(turn([assistant(text: 'Fixed.\n$doneMarker: tests pass', tool: true), result()]), rounds: 0, halted: false), isNull);
      expect(nextNudge(turn([assistant(text: '$blockedMarker: no network', tool: true), result()]), rounds: 0, halted: false), isNull);
      expect(nextNudge(turn([assistant(text: 'partial', tool: true), result()]), rounds: 0, halted: true), isNull);
      expect(nextNudge(turn([assistant(tool: true), result(subtype: 'error_during_execution', isError: true)]), rounds: 0, halted: false), isNull,
          reason: 'an interruption means stop');
    });

    test('a turn still running is left alone', () {
      expect(nextNudge(turn([assistant(text: 'working', tool: true)]), rounds: 0, halted: false), isNull);
    });

    test('work with no word that it is finished goes round once more, and the nudge asks it to check itself', () {
      final n = nextNudge(turn([assistant(text: 'I changed the config.', tool: true), result()]), rounds: 0, halted: false)!;
      expect(n.reason, 'unfinished');
      expect(n.text, startsWith(autoMarker));
      expect(n.text, contains(doneMarker));
      expect(n.text, contains('Do not ask me'));
    });

    test('an error goes round again; a question nobody can answer does too; plain chat does not', () {
      expect(nextNudge(turn([assistant(text: 'x'), result(subtype: 'error_max_turns', isError: true)]), rounds: 1, halted: false)!.reason, 'error');
      const task = 'Set up the database for the new service and deploy it';
      expect(nextNudge(turn([assistant(text: 'Which database do you want?'), result()], asked: task), rounds: 0, halted: false)!.reason, 'asked');
      expect(nextNudge(turn([assistant(text: 'Which database do you want?'), result()], asked: task), rounds: 1, halted: false), isNull, reason: 'asks once, not forever');
      expect(nextNudge(turn([assistant(text: 'Hello! How can I help?'), result()], asked: 'hi'), rounds: 0, halted: false), isNull, reason: 'a greeting is just a chat');
      expect(nextNudge(turn([assistant(text: 'Paris is the capital of France.'), result()]), rounds: 0, halted: false), isNull);
    });

    test('it stops after a few rounds however it went', () {
      final rows = turn([assistant(text: 'still going', tool: true), result()]);
      expect(nextNudge(rows, rounds: maxAutoRounds - 1, halted: false), isNotNull);
      expect(nextNudge(rows, rounds: maxAutoRounds, halted: false), isNull);
    });

    test('only the latest turn counts', () {
      final rows = [
        row(1, prompt('first')),
        row(2, assistant(text: '$doneMarker: ok', tool: true)),
        row(3, result()),
        row(4, prompt('second')),
        row(5, assistant(text: 'did it', tool: true)),
        row(6, result()),
      ];
      expect(nextNudge(rows, rounds: 0, halted: false)!.reason, 'unfinished');
    });
  });

  group('what the chat shows', () {
    test('the standing instructions and the nudges are not shown as the person’s words', () {
      expect(shownUserText('fix it'), 'fix it');
      expect(shownUserText(withAutonomyBrief('fix it')), 'fix it');
      expect(shownUserText('$autoMarker\nKeep going.'), isNull);
      final items = groupMessages([row(1, prompt(withAutonomyBrief('fix the build'))), row(2, prompt('$autoMarker\nKeep going.'))]);
      expect((items[0] as UserItem).blocks.single['text'], 'fix the build');
      expect(items[1], isA<SystemItem>());
    });
  });

  group('in a chat', () {
    const creds = HubCredentials();
    late List<http.Request> sent;
    late List<FakeSocket> sockets;
    late HubStore store;

    setUp(() async {
      await Storage.initForTest();
      creds.hubUrl = 'https://hub.example.test';
      creds.token = 'tok';
      sent = [];
      sockets = [];
      store = HubStore(
        api: HubApi(credentials: creds, client: MockClient((req) async {
          sent.add(req);
          return req.method == 'GET' ? http.Response('[]', 200) : http.Response('{}', 200);
        })),
        socket: HubSocket(connector: (u, p) => (sockets..add(FakeSocket(u, p))).last, token: () => creds.token, hubUrl: () => creds.hubUrl),
        credentials: creds,
      );
      sockets[0].open();
    });

    tearDown(() => store.logout());

    void event(Map<String, Object?> e) => sockets[0].message(jsonEncode({'vmId': 'v', 'sessionId': 's', ...e}));

    test('an autonomous chat answers its own prompts: yes to work, no to the unrecoverable', () async {
      const ChatChoicesStore().write('v', 's', const SavedChoices(mode: 'auto'));
      event({'type': 'permission_request', 'requestId': 'r1', 'toolName': 'Bash', 'input': {'command': 'npm test'}});
      event({'type': 'permission_request', 'requestId': 'r2', 'toolName': 'Bash', 'input': {'command': 'rm -rf /'}});
      await pumpEventQueue();
      final answers = {for (final r in sent.where((r) => r.url.path.endsWith('/permission-response'))) jsonDecode(r.body)['requestId']: jsonDecode(r.body)['behavior']};
      expect(answers, {'r1': 'allow', 'r2': 'deny'});
      expect(store.state.resolvedPermissionIds, containsAll(['r1', 'r2']));
    });

    test('a chat that asks first is left for the person', () async {
      const ChatChoicesStore().write('v', 's', const SavedChoices(mode: 'default'));
      event({'type': 'permission_request', 'requestId': 'r1', 'toolName': 'Bash', 'input': {'command': 'npm test'}});
      await pumpEventQueue();
      expect(sent.where((r) => r.url.path.endsWith('/permission-response')), isEmpty);
    });

    test('after a turn that ended without saying it is finished, it goes round again by itself, and Stop ends that', () async {
      const ChatChoicesStore().write('v', 's', const SavedChoices(mode: 'auto'));
      store.dispatch(AppendMessage('s', row(localRowBase + 1, prompt(withAutonomyBrief('fix the build')))));
      event({'type': 'sdk_message', 'message': assistant(text: 'I changed the config.', tool: true), 'createdAt': 't'});
      event({'type': 'sdk_message', 'message': result(), 'createdAt': 't'});
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      final nudges = sent.where((r) => r.method == 'POST' && r.url.path.endsWith('/messages')).toList();
      expect(nudges.length, 1);
      expect(jsonDecode(nudges.single.body)['text'], startsWith(autoMarker));
      expect(store.roundsFor('s'), 1);
      store.logout();
    });

    test('a turn the person stopped does not go round again', () async {
      const ChatChoicesStore().write('v', 's', const SavedChoices(mode: 'auto'));
      store.dispatch(AppendMessage('s', row(localRowBase + 1, prompt('fix the build'))));
      await store.interrupt('v', 's');
      sent.clear();
      event({'type': 'sdk_message', 'message': assistant(text: 'half done', tool: true), 'createdAt': 't'});
      event({'type': 'sdk_message', 'message': result(), 'createdAt': 't'});
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      expect(sent.where((r) => r.url.path.endsWith('/messages') && r.method == 'POST'), isEmpty);
    });
  });
}
