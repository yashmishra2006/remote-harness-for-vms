import 'dart:convert';

import 'package:escanor/core/storage.dart';
import 'package:escanor/features/machines/chat_choices.dart';
import 'package:escanor/features/machines/hub_api.dart';
import 'package:escanor/features/machines/hub_socket.dart';
import 'package:escanor/features/machines/hub_state.dart';
import 'package:escanor/features/machines/hub_store.dart';
import 'package:escanor/features/machines/protocol.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const creds = HubCredentials();
  late List<http.Request> sent;
  late List<FakeSocket> sockets;
  late http.Response Function(http.Request) answer;

  HubStore make() {
    final api = HubApi(credentials: creds, client: MockClient((req) async {
      sent.add(req);
      return answer(req);
    }));
    final socket = HubSocket(
      connector: (u, p) => (sockets..add(FakeSocket(u, p))).last,
      token: () => creds.token,
      hubUrl: () => creds.hubUrl,
    );
    return HubStore(api: api, socket: socket, credentials: creds);
  }

  setUp(() async {
    await Storage.initForTest();
    creds.hubUrl = 'https://hub.example.test';
    creds.token = 'tok';
    sent = [];
    sockets = [];
    answer = (_) => http.Response('{}', 200);
  });

  const input = NewSessionInput(text: 'hi', accountId: 'a');

  test('signed in at start: the socket opens and its events reach the state', () async {
    final store = make();
    expect(store.state.authed, isTrue);
    expect(sockets.length, 1);
    sockets[0].open();
    sockets[0].message(jsonEncode({'type': 'vm_status', 'vmId': 'v', 'name': 'box', 'connected': true, 'accounts': []}));
    await pumpEventQueue();
    expect(store.state.vms.single.name, 'box');
    store.logout();
    expect(store.state.authed, isFalse);
    expect(store.state.vms, isEmpty);
    expect(creds.token, isNull);
    expect(sockets[0].closed, isTrue);
  });

  test('what was picked for a new chat goes with the request that starts it; once named, every choice that is not the default goes again', () async {
    answer = (req) => req.url.path.endsWith('/sessions') ? http.Response(jsonEncode({'tempId': 't1'}), 202) : http.Response('{"ok":true}', 202);
    final store = make();
    await store.startNewChat('v', input, choices: const ChatChoices(mode: 'plan', model: 'claude-opus-5-5', effort: 'high'));
    expect(store.state.selectedSessionId, 't1');
    expect(store.isTemporary('t1'), isTrue);
    expect(sent.length, 1);
    expect(jsonDecode(sent.single.body), {'text': 'hi', 'accountId': 'a', 'permissionMode': 'plan', 'model': 'claude-opus-5-5', 'effort': 'high'});
    store.dispatch(const SessionCreated(vmId: 'v', tempId: 't1', sessionId: 's1', cwd: '/w', title: 'T', accountId: 'a'));
    await pumpEventQueue();
    expect(store.state.selectedSessionId, 's1');
    expect(store.namedAs('t1'), 's1');
    // Agents from before the hub passed them on ignore all three in the request.
    expect(sent.skip(1).map((r) => '${r.url.path} ${r.body}'), [
      '/api/vms/v/sessions/s1/permission-mode {"mode":"plan"}',
      '/api/vms/v/sessions/s1/model {"model":"claude-opus-5-5"}',
      '/api/vms/v/sessions/s1/effort {"effort":"high"}',
    ]);
    expect(store.savedChoices('v', 's1'), const SavedChoices(mode: 'plan', model: 'claude-opus-5-5', effort: 'high'));
  });

  test('a choice changed back to the default while the chat was being named is sent too', () async {
    answer = (req) => req.url.path.endsWith('/sessions') ? http.Response(jsonEncode({'tempId': 't1'}), 202) : http.Response('{}', 202);
    final store = make();
    await store.startNewChat('v', input, choices: const ChatChoices(mode: 'plan', model: 'claude-opus-5-5', effort: 'high'));
    store.updatePendingChoices('t1', const ChatChoices());
    store.dispatch(const SessionCreated(vmId: 'v', tempId: 't1', sessionId: 's1', cwd: '', title: '', accountId: 'a'));
    await pumpEventQueue();
    expect(sent.skip(1).map((r) => '${r.url.path} ${r.body}'), [
      '/api/vms/v/sessions/s1/permission-mode {"mode":"default"}',
      '/api/vms/v/sessions/s1/model {"model":""}',
      '/api/vms/v/sessions/s1/effort {"effort":""}',
    ]);
  });

  test('defaults are not sent; a choice changed while waiting is', () async {
    answer = (req) => req.url.path.endsWith('/sessions') ? http.Response(jsonEncode({'tempId': 't1'}), 202) : http.Response('{}', 202);
    final store = make();
    await store.startNewChat('v', input);
    store.updatePendingChoices('t1', const ChatChoices(effort: 'low'));
    store.dispatch(const SessionCreated(vmId: 'v', tempId: 't1', sessionId: 's1', cwd: '', title: '', accountId: 'a'));
    await pumpEventQueue();
    expect(sent.skip(1).map((r) => r.url.path), ['/api/vms/v/sessions/s1/effort']);
  });

  test('the machine naming the chat before the hub answers still lands on the real chat', () async {
    late HubStore store;
    answer = (req) {
      store.dispatch(const SessionCreated(vmId: 'v', tempId: 't1', sessionId: 's1', cwd: '', title: '', accountId: 'a'));
      return http.Response(jsonEncode({'tempId': 't1'}), 202);
    };
    store = make();
    await store.startNewChat('v', input, choices: const ChatChoices(mode: 'acceptEdits'));
    await pumpEventQueue();
    expect(store.state.selectedSessionId, 's1');
    expect(sent.last.url.path, '/api/vms/v/sessions/s1/permission-mode');
    expect(store.savedChoices('v', 's1')!.mode, 'acceptEdits');
  });

  test('live text from a chat nobody has open is not kept, so it cannot flash stale when the chat is opened', () async {
    final store = make();
    sockets[0].open();
    store.dispatch(const Select(vmId: 'v', sessionId: 'open'));
    sockets[0].message(jsonEncode({'type': 'sdk_partial', 'vmId': 'v', 'sessionId': 'elsewhere', 'text': 'Half a sente'}));
    sockets[0].message(jsonEncode({'type': 'sdk_partial', 'vmId': 'v', 'sessionId': 'open', 'text': 'Writing'}));
    await pumpEventQueue();
    expect(store.state.partialBySession, {'open': 'Writing'});
  });

  test('an answer that does not reach the machine brings the prompt back', () async {
    answer = (_) => http.Response(jsonEncode({'error': 'VM not connected'}), 503);
    final store = make();
    await expectLater(store.resolvePermission('v', 's', 'r1', 'allow', twins: ['r1', 'r2']), throwsA(isA<HubError>()));
    expect(store.state.resolvedPermissionIds, isEmpty);
    answer = (_) => http.Response('{"ok":true}', 202);
    await store.resolvePermission('v', 's', 'r1', 'deny', twins: ['r1', 'r2']);
    expect(store.state.resolvedPermissionIds, {'r1', 'r2'});
    expect(jsonDecode(sent.last.body), {'requestId': 'r1', 'behavior': 'deny'});
  });

  test('a self-hosted hub refusing the token goes back to its sign-in', () async {
    answer = (_) => http.Response('', 401);
    final store = make();
    await expectLater(store.refreshVms(), throwsA(isA<HubError>()));
    expect(store.state.authed, isFalse);
  });

  test('the hosted hub refusing the token asks for a new one and stays signed in', () async {
    creds.managed = true;
    answer = (_) => http.Response('', 401);
    final store = make();
    var asked = 0;
    final sub = store.managedUnauthorized.listen((_) => asked++);
    await expectLater(store.refreshVms(), throwsA(isA<HubError>()));
    await pumpEventQueue();
    expect(asked, 1);
    expect(store.state.authed, isTrue);
    await sub.cancel();
  });

  test('signing in to a hub', () async {
    creds.token = null;
    answer = (req) => http.Response(jsonEncode({'token': 'fresh'}), 200);
    final store = make();
    expect(store.state.authed, isFalse);
    await store.login('pw');
    expect(sent.single.headers['authorization'], isNull);
    expect(jsonDecode(sent.single.body), {'password': 'pw'});
    expect(creds.token, 'fresh');
    expect(store.state.authed, isTrue);
    expect(sockets.single.protocols.last, 'escanor.auth.fresh');
  });
}
