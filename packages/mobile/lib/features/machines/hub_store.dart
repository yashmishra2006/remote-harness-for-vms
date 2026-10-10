import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/prefs.dart' show currentPrefs;
import 'autonomy.dart';
import 'chat_choices.dart';
import 'group_messages.dart' show groupMessages;
import 'hub_api.dart';
import 'hub_socket.dart';
import 'hub_state.dart';
import 'local_overlay.dart';
import 'message_format.dart' show busySince, livePermissions;
import 'protocol.dart';
import 'session_search.dart';

/// A chat to open: from a notification, or the in-app banner.
typedef ChatTarget = ({String vmId, String sessionId});

/// Something on a machine the person should know about while the app is open (shown as a banner unless that chat is
/// already on screen).
class HubNotice {
  const HubNotice({required this.vmId, required this.sessionId, required this.title, required this.body, this.requestId});
  final String vmId;
  final String sessionId;
  final String title;
  final String body;
  final String? requestId;
}

/// A few words for what Claude wants to do ("Run: npm test"), as the push notification says it.
String describeTool(String toolName, Map<String, dynamic> input) {
  String one(Object? v, int max) {
    final line = '${v ?? ''}'.split('\n').map((l) => l.trim()).firstWhere((l) => l.isNotEmpty, orElse: () => '');
    return line.length > max ? '${line.substring(0, max - 1)}…' : line;
  }

  switch (toolName) {
    case 'Bash':
      return 'Run: ${one(input['command'], 100)}';
    case 'Edit' || 'MultiEdit' || 'Write' || 'NotebookEdit':
      final path = '${input['file_path'] ?? input['notebook_path'] ?? ''}'.split('/').where((p) => p.isNotEmpty);
      return 'Edit: ${path.isEmpty ? 'a file' : path.last}';
    case 'WebFetch':
      return 'Open: ${one(input['url'], 100)}';
    default:
      return 'Use $toolName';
  }
}

/// What a new chat should switch to once the machine has named it.
class ChatChoices {
  const ChatChoices({this.mode = 'default', this.model = '', this.effort = ''});
  final String mode;
  final String model;
  final String effort;
}

/// The Machines screen's state and everything it can do (store.tsx): one per app, shared by the hosted hub on the
/// Machines tab and the person's own hub.
class HubStore extends ChangeNotifier with WidgetsBindingObserver {
  HubStore({HubApi? api, HubSocket? socket, HubCredentials credentials = const HubCredentials(), this.choicesStore = const ChatChoicesStore(), this.overlay = const LocalOverlay()})
      : api = api ?? HubApi(credentials: credentials),
        _state = HubState(authed: credentials.signedIn) {
    this.socket = socket ?? HubSocket(token: () => this.api.credentials.token, hubUrl: () => this.api.credentials.hubUrl);
    this.socket.onReconnected = _caughtUp;
    this.api.onSignedOut = () => dispatch(const SetAuthed(false));
    this.api.onManagedUnauthorized = () => _managedUnauthorized.add(null);
    if (_state.authed) _start();
  }

  static HubStore? _instance;
  static HubStore get instance => _instance ??= HubStore();

  /// For tests.
  static set instance(HubStore s) => _instance = s;
  static bool get created => _instance != null;

  final HubApi api;
  final ChatChoicesStore choicesStore;
  final LocalOverlay overlay;
  late final HubSocket socket;
  HubState _state;
  HubState get state => _state;

  void Function()? _unsubscribe;
  bool _observing = false;
  num _localIds = 0;
  num _optimisticIds = 0;
  Timer? _poll;
  final Set<String> _loading = {};
  bool _catchingUp = false;

  // Autonomous chats: prompts already answered, results already looked at, how many times it went round again, and chats the person stopped.
  final Set<String> _autoAnswered = {};
  final Map<String, int> _resultsHandled = {};
  final Map<String, int> _rounds = {};
  final Set<String> _halted = {};
  final _managedUnauthorized = StreamController<void>.broadcast();
  final _notices = StreamController<HubNotice>.broadcast(sync: true);
  final _openRequests = StreamController<ChatTarget>.broadcast();
  ChatTarget? _pendingOpen;

  /// The chat a ChatView is showing right now (null when none is on screen).
  String? viewingSessionId;

  /// Permission prompts as they arrive, for the in-app banner.
  Stream<HubNotice> get notices => _notices.stream;

  /// "Show this chat": the Machines screen opens it (see [takePendingOpen] for a screen that was not built yet).
  Stream<ChatTarget> get openRequests => _openRequests.stream;

  /// The chat asked to be opened before anything could show it; null once taken.
  ChatTarget? takePendingOpen() {
    final t = _pendingOpen;
    _pendingOpen = null;
    return t;
  }

  /// Chats waiting for the person's OK, across every machine.
  int get waitingCount => _state.waiting.length;

  /// The hosted hub refused its token: whoever shows it asks Escanor for the current one.
  Stream<void> get managedUnauthorized => _managedUnauthorized.stream;

  /// New chats waiting for the machine to name them, with the mode/model/effort chosen for them.
  final Map<String, ChatChoices> _pendingChoices = {};

  /// What went with the request that started each of those chats (the machine starts the chat with it).
  final Map<String, ChatChoices> _sentWithCreate = {};

  /// Temporary ids the machine has already named (the event can beat the answer that started the chat).
  final Map<String, String> _named = {};

  /// New chats whose start request is still on its way (their first rows can arrive before its answer).
  int _creating = 0;

  /// Chats whose first page did not reach back to the start: the chat offers "Show earlier messages".
  final Set<String> _hasEarlier = {};

  /// How many messages a chat shows at first, and per "Show earlier messages". A long chat used to come whole, megabytes
  /// at a time, and again every few seconds while it ran.
  static const pageSize = 300;

  /// Does this chat have older messages than the ones shown?
  bool hasEarlier(String sessionId) => _hasEarlier.contains(sessionId);

  num _nextLocalId() => localRowBase + (++_localIds);
  num _nextOptimisticId() => optimisticRowBase + (++_optimisticIds);

  /// The newest socket-row id so far: rows after it arrived while a list was on its way.
  num get _localHorizon => localRowBase + _localIds;

  final Set<Timer> _timers = {};

  /// Run [work] shortly, unless the hub is signed out of before then.
  void _later(Duration after, Future<void> Function() work) {
    late final Timer t;
    t = Timer(after, () {
      _timers.remove(t);
      if (_state.authed) unawaited(work().catchError((_) {}));
    });
    _timers.add(t);
  }

  /// Is this chat's first list of messages still on its way?
  bool isLoading(String sessionId) => _loading.contains(sessionId);

  void dispatch(HubAction action) {
    final was = _state.authed;
    _state = reduceHub(_state, action);
    if (action is SessionCreated) _onSessionCreated(action);
    if (action is AppendMessage) _noticeTurnEnd(action);
    if (action is SetSessions) _adoptNamed(action.vmId, action.sessions);
    if (!was && _state.authed) _start();
    if (was && !_state.authed) _stop();
    _cancelBatchedNotify();
    notifyListeners();
  }

  /// A socket event: the state changes at once, but the screen is told at most once a frame, so a burst (a machine sending
  /// a long chat) does not rebuild every chat and list hundreds of times.
  void _dispatchBatched(HubAction action) {
    final was = _state.authed;
    _state = reduceHub(_state, action);
    if (action is SessionCreated) _onSessionCreated(action);
    if (action is AppendMessage) _noticeTurnEnd(action);
    if (was != _state.authed) {
      // never happens for socket events, but keep the sign-in rules in one place
      if (_state.authed) _start();
      if (!_state.authed) _stop();
      notifyListeners();
      return;
    }
    _batchedNotify ??= Timer(batchEvery, () {
      _batchedNotify = null;
      notifyListeners();
    });
  }

  static const batchEvery = Duration(milliseconds: 16);
  Timer? _batchedNotify;

  void _cancelBatchedNotify() {
    _batchedNotify?.cancel();
    _batchedNotify = null;
  }

  /// Rows for a chat nobody has open are not kept: the chat is fetched when it is opened. (Every chat a machine runs, its
  /// terminal ones included, streams through the same socket; keeping them all made the app slow down over time.)
  bool _wantsRows(String sessionId) =>
      _state.messagesBySession.containsKey(sessionId) || _state.selectedSessionId == sessionId || _pendingChoices.containsKey(sessionId) || _creating > 0;

  /// The machine named a new chat while this phone was not listening: the hub's list says which chat it became.
  void _adoptNamed(String vmId, List<SessionDto> sessions) {
    for (final s in sessions) {
      final t = s.tempId;
      if (t == null || t == s.id || _named.containsKey(t)) continue;
      if (_pendingChoices.containsKey(t) || _state.selectedSessionId == t) {
        dispatch(SessionCreated(vmId: vmId, tempId: t, sessionId: s.id, cwd: s.cwd, title: s.title, accountId: s.accountId));
      }
    }
  }

  void _start() {
    _unsubscribe?.call();
    socket.connect();
    _unsubscribe = socket.subscribe((msg) {
      final a = actionForEvent(msg, _nextLocalId);
      if (a is AppendMessage && !_wantsRows(a.sessionId) && msg is! PermissionRequestEvent) {
        // not open here: nothing to show (a permission prompt is still kept: it is something waiting for the person)
      } else if (a is SetPartial && !_wantsRows(a.sessionId)) {
        // nor its live text: the message that ends it would be dropped above, so it would flash stale when the chat is opened
      } else if (a is AppendMessage) {
        _dispatchBatched(a);
      } else if (a != null) {
        dispatch(a);
      }
      if (msg is PermissionRequestEvent) {
        _autoAnswer(msg.vmId, msg.sessionId, msg.requestId, msg.toolName, msg.input);
        if (!isAutonomous(msg.vmId, msg.sessionId)) _notifyPrompt(msg);
      }
    });
    if (!_observing) {
      try {
        WidgetsBinding.instance.addObserver(this);
        _observing = true;
      } catch (_) {}
    }
    _poll?.cancel();
    _poll = Timer.periodic(pollEvery, (_) => _pollBusy());
  }

  /// While a run is going, how often to ask the hub directly if the socket has gone quiet.
  static const pollEvery = Duration(seconds: 4);
  static const quietFor = Duration(seconds: 10);

  /// The socket is the fast path, but a phone's connection can die without saying so. While the open chat is running and
  /// nothing has arrived for a while, ask the hub for the chat itself so it never sits frozen.
  void _pollBusy() {
    if (!_state.authed || _catchingUp) return;
    final vm = _state.selectedVmId;
    final session = _state.selectedSessionId;
    if (vm == null || session == null || _pendingChoices.containsKey(session) || _loading.contains(session)) return;
    final rows = _state.messagesBySession[session];
    if (rows == null || busySince(rows) == null) return;
    if (socket.connected && socket.quietSince(DateTime.now()) < quietFor) return;
    unawaited(refreshSession(vm, session).catchError((_) {}));
  }

  void _notifyPrompt(PermissionRequestEvent e) {
    var machine = '';
    for (final v in _state.vms) {
      if (v.id == e.vmId) machine = nameOf(v);
    }
    var chat = '';
    for (final x in _state.sessionsByVm[e.vmId] ?? const <SessionDto>[]) {
      if (x.id == e.sessionId) chat = titleOf(x);
    }
    final where = [if (machine.isNotEmpty) machine, if (chat.isNotEmpty) chat].join(' · ');
    _notices.add(HubNotice(
      vmId: e.vmId,
      sessionId: e.sessionId,
      requestId: e.requestId,
      title: 'Claude needs your OK',
      body: [if (where.isNotEmpty) where, describeTool(e.toolName, e.input)].join(': '),
    ));
  }

  /// Open one chat (a tapped notification or banner): pick its machine and chat, then ask the Machines screen to show it.
  Future<void> openChat(String vmId, String sessionId) async {
    if (!_state.authed) return;
    SessionDto? find() {
      for (final x in _state.sessionsByVm[vmId] ?? const <SessionDto>[]) {
        if (x.id == sessionId) return x;
      }
      return null;
    }

    dispatch(Select(vmId: vmId, sessionId: sessionId, accountId: find()?.accountId));
    final target = (vmId: vmId, sessionId: sessionId);
    _pendingOpen = target;
    _openRequests.add(target);
    try {
      if (find() == null) dispatch(SetSessions(vmId, await api.listSessions(vmId)));
      final s = find();
      if (s != null) {
        await openSession(vmId, s);
      } else {
        await refreshSession(vmId, sessionId);
      }
    } catch (_) {
      // what is cached shows; the chat's own refresh tries again
    }
  }

  void _stop() {
    _unsubscribe?.call();
    _unsubscribe = null;
    _poll?.cancel();
    _poll = null;
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    socket.stop();
    _cancelBatchedNotify();
    _hasEarlier.clear();
    choicesStore.clear();
    overlay.clear();
    _autoAnswered.clear();
    _resultsHandled.clear();
    _rounds.clear();
    _halted.clear();
    _pendingChoices.clear();
    _sentWithCreate.clear();
    _named.clear();
    if (_observing) {
      WidgetsBinding.instance.removeObserver(this);
      _observing = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || !_state.authed) return;
    // Whatever the connection looked like before the phone slept, it cannot be trusted now: start it over, and fetch
    // what happened meanwhile.
    api.resetConnections();
    socket.reconnect();
    unawaited(_caughtUp());
  }

  /// Back after the connection dropped (or the app came back): fetch what may have been missed.
  Future<void> _caughtUp() async {
    if (_catchingUp) return;
    _catchingUp = true;
    try {
      await refreshVms();
      final vm = _state.selectedVmId;
      if (vm != null) dispatch(SetSessions(vm, await api.listSessions(vm)));
      final session = _state.selectedSessionId;
      if (vm != null && session != null && !_pendingChoices.containsKey(session)) await refreshSession(vm, session);
    } catch (_) {
    } finally {
      _catchingUp = false;
    }
  }

  void _onSessionCreated(SessionCreated a) {
    _named[a.tempId] = a.sessionId;
    final choices = _pendingChoices.remove(a.tempId);
    final sent = _sentWithCreate.remove(a.tempId);
    if (choices != null) _applyChoices(a.vmId, a.sessionId, choices, sent: sent);
  }

  /// What was picked for a new chat is remembered for it once the machine has named it, and sent to it again.
  void _applyChoices(String vmId, String sessionId, ChatChoices c, {ChatChoices? sent}) {
    choicesStore.write(vmId, sessionId, SavedChoices(mode: c.mode, model: c.model, effort: c.effort));
    if (isPermissionMode(c.mode)) _keepModeForNewChats(vmId, c.mode);
    unawaited(_pushNamed(vmId, sessionId, c, sent).catchError((_) {}));
  }

  /// A new chat was just named. Every choice that is not the default goes again, though they went with the request that
  /// started the chat: agents from before the hub passed them on (most machines out there) ignore all three there. A choice
  /// changed back to the default since that request ([sent]) goes too.
  Future<void> _pushNamed(String vmId, String sessionId, ChatChoices c, ChatChoices? sent) async {
    final mode = isPermissionMode(c.mode) && (c.mode != 'default' || (sent != null && sent.mode != c.mode));
    final model = c.model.isNotEmpty || (sent != null && sent.model != c.model);
    final effort = (c.effort.isNotEmpty && isEffortLevel(c.effort)) || (c.effort.isEmpty && sent != null && sent.effort != c.effort);
    await Future.wait([
      if (mode) api.setPermissionMode(vmId, sessionId, c.mode),
      if (model) api.setModel(vmId, sessionId, c.model),
      if (effort) api.setEffort(vmId, sessionId, c.effort),
    ]);
  }

  /// Tell the machine what this chat is set to. A choice left at "default" needs no telling.
  Future<void> _pushChoices(String vmId, String sessionId, SavedChoices c) async {
    final sends = <Future<void>>[
      if (c.mode != 'default' && isPermissionMode(c.mode)) api.setPermissionMode(vmId, sessionId, c.mode),
      if (c.model.isNotEmpty) api.setModel(vmId, sessionId, c.model),
      if (c.effort.isNotEmpty && isEffortLevel(c.effort)) api.setEffort(vmId, sessionId, c.effort),
    ];
    await Future.wait(sends);
  }

  /// What was last chosen for a chat on this phone (null when nothing was).
  SavedChoices? savedChoices(String vmId, String sessionId) => choicesStore.read(vmId, sessionId);

  /// Remember a choice for a chat that exists, and send it to the machine.
  Future<void> saveChoices(String vmId, String sessionId, SavedChoices c, {bool send = true}) async {
    choicesStore.write(vmId, sessionId, c);
    if (send) await _pushChoices(vmId, sessionId, c);
  }

  // ---------- actions ----------

  Future<void> login(String password) async {
    final token = await api.login(password);
    api.credentials.token = token;
    dispatch(const SetAuthed(true));
  }

  void logout() {
    // Revoke it on the hub first, so a copy of this token stops working too. Best effort: being offline must never
    // leave the person unable to sign out of this device.
    unawaited(api.logout().catchError((_) {}));
    socket.stop();
    api.credentials.token = null;
    dispatch(const SetAuthed(false));
  }

  /// The hosted hub's token changed: the open connection is dead, so start it over.
  Future<void> restart() async {
    socket.stop();
    if (_state.authed) {
      _start();
      try {
        await refreshVms();
      } catch (_) {}
    } else {
      dispatch(const SetAuthed(true));
    }
  }

  Future<void> refreshVms() async => dispatch(SetVms(await api.listVms()));

  Future<void> selectVm(String vmId) async {
    dispatch(Select(vmId: vmId));
    dispatch(SetSessions(vmId, await api.listSessions(vmId)));
  }

  void selectSession(String vmId, String? sessionId, [String? accountId]) => dispatch(Select(vmId: vmId, sessionId: sessionId, accountId: accountId));

  /// Chats on [vmId] that match [query] by title or by what was said in them, best first. Empty when the hub cannot
  /// search (one from before search answers 404) or cannot be reached: the list then matches titles only.
  Future<List<SessionSearchHit>> searchSessions(String vmId, String query) async {
    try {
      return await api.searchSessions(vmId, query);
    } catch (_) {
      return const [];
    }
  }

  Future<void> loadMessages(String vmId, String sessionId) => refreshSession(vmId, sessionId);

  /// Ask the hub for the chat as it stands now, keeping what only this phone has seen. What is already on screen stays
  /// until the answer comes. A chat already here asks only for what is newer than its last row; [full] starts it over
  /// (its newest page).
  Future<void> refreshSession(String vmId, String sessionId, {bool full = false}) async {
    final existing = _state.messagesBySession[sessionId];
    if (existing == null) {
      _loading.add(sessionId);
      notifyListeners();
    }
    final horizon = _localHorizon;
    final tail = existing == null || full ? 0 : hubTail(existing);
    try {
      if (tail > 0) {
        final fetched = await api.listMessages(vmId, sessionId, after: tail);
        // A hub from before paging sends the whole chat: only what is newer counts.
        final newer = [for (final m in fetched) if (m.id > tail) m];
        final now = _state.messagesBySession[sessionId] ?? const <MessageDto>[];
        final kept = [for (final r in now) if (!isLocalRow(r) && r.id >= 0 && r.id <= tail) r];
        dispatch(SetMessages(sessionId, [...kept, ...newer], seenLocalUpTo: horizon, newSince: tail));
      } else {
        final rows = await api.listMessages(vmId, sessionId, limit: pageSize);
        // Exactly a page: there may be more before it. (A hub from before paging sends everything, so more than a page.)
        if (rows.length == pageSize) {
          _hasEarlier.add(sessionId);
        } else {
          _hasEarlier.remove(sessionId);
        }
        dispatch(SetMessages(sessionId, rows, seenLocalUpTo: horizon));
      }
      _afterRefresh(vmId, sessionId);
    } finally {
      if (_loading.remove(sessionId)) notifyListeners();
    }
  }

  /// The page of messages before the oldest one shown.
  Future<void> loadEarlier(String vmId, String sessionId) async {
    num? oldest;
    for (final r in _state.messagesBySession[sessionId] ?? const <MessageDto>[]) {
      if (!isLocalRow(r) && r.id >= 0 && (oldest == null || r.id < oldest)) oldest = r.id;
    }
    if (oldest == null) {
      _hasEarlier.remove(sessionId);
      notifyListeners();
      return;
    }
    final older = await api.listMessages(vmId, sessionId, limit: pageSize, before: oldest);
    // Fewer than a page means this reached the start; a row that is not older means the hub ignored `before` and sent it all.
    if (older.length < pageSize || older.any((m) => m.id >= oldest!)) _hasEarlier.remove(sessionId);
    final before = (_state.messagesBySession[sessionId] ?? const <MessageDto>[]).where(_isResult).length;
    dispatch(PrependMessages(sessionId, older));
    // Older turns that ended long ago are not a turn that just ended (an autonomous chat must not go round again for them).
    final added = (_state.messagesBySession[sessionId] ?? const <MessageDto>[]).where(_isResult).length - before;
    final handled = _resultsHandled[sessionId];
    if (handled != null && added > 0) _resultsHandled[sessionId] = handled + added;
  }

  /// Open a chat: show what is here, ask the hub for what is new, and make sure the machine runs it with the mode,
  /// model and effort chosen for it.
  Future<void> openSession(String vmId, SessionDto s) async {
    // What was chosen when it started (kept under its temporary id, in case the machine named it while this phone was
    // not listening), else a chat never given its own choices runs as new chats do on this machine, and keeps that.
    var saved = choicesStore.read(vmId, s.id);
    final t = s.tempId;
    if (saved == null && t != null) {
      saved = choicesStore.read(vmId, t);
      if (saved != null) choicesStore.write(vmId, s.id, saved);
    }
    if (saved == null) {
      // Not sent now (a chat started elsewhere may be running as it was told); they go with the next message.
      choicesStore.write(vmId, s.id, defaultChoicesFor(vmId));
    }
    // Selected once its choices are in place, so a chat already on screen (side by side) shows them straight away.
    dispatch(Select(vmId: vmId, sessionId: s.id, accountId: s.accountId));
    if (saved != null) unawaited(_pushChoices(vmId, s.id, saved).catchError((_) {}));
    await refreshSession(vmId, s.id);
  }

  /// Start a chat: the hub answers with a temporary id until the machine names the session.
  Future<String> startNewChat(String vmId, NewSessionInput input, {ChatChoices choices = const ChatChoices()}) async {
    final picked = SavedChoices(mode: choices.mode, model: choices.model, effort: choices.effort);
    final String tempId;
    _creating++;
    try {
      tempId = await api.createSession(vmId, input, choices: picked);
    } finally {
      _creating--;
    }
    // Kept under the temporary id too: if the app is closed before the machine names the chat, the list still links them.
    choicesStore.write(vmId, tempId, picked);
    final named = _named[tempId];
    if (named != null) {
      _applyChoices(vmId, named, choices, sent: choices);
    } else {
      _pendingChoices[tempId] = choices;
      _sentWithCreate[tempId] = choices;
    }
    dispatch(Select(vmId: vmId, sessionId: named ?? tempId, accountId: input.accountId));
    return tempId;
  }

  /// Send a message: it shows at once, then the hub's echo takes its place. If it does not reach the hub it is taken back.
  Future<void> sendMessage(String vmId, String sessionId, UserInput input, {bool auto = false}) async {
    if (!auto) {
      _rounds[sessionId] = 0; // a new request from the person starts the count again
      _halted.remove(sessionId);
    }
    final rows = _state.messagesBySession[sessionId] ?? const <MessageDto>[];
    final shown = optimisticPrompt(_nextOptimisticId(), sessionId, vmId, input.text, rows);
    dispatch(AppendMessage(sessionId, shown));
    // The mode, model and effort chosen for the chat go with it, so a chat the machine has to resume runs with them.
    final saved = choicesStore.read(vmId, sessionId) ?? defaultChoicesFor(vmId);
    try {
      await api.sendMessage(vmId, sessionId, input, choices: saved);
    } catch (_) {
      dispatch(RemoveMessage(sessionId, shown.id));
      rethrow;
    }
  }

  /// Stop the run. The chat stops spinning at once; if the hub could not be told, the chat shows what is really going on.
  Future<void> interrupt(String vmId, String sessionId) async {
    _halted.add(sessionId); // the person said stop: it does not go round again by itself
    dispatch(ResolveAllPermissions(sessionId));
    dispatch(SessionWentIdle(vmId, sessionId));
    try {
      await api.interrupt(vmId, sessionId);
    } catch (_) {
      unawaited(refreshSession(vmId, sessionId).catchError((_) {}));
      rethrow;
    }
    // Settle with the hub's own account of how the run ended.
    _later(const Duration(milliseconds: 1500), () => refreshSession(vmId, sessionId));
  }

  Future<void> setPermissionMode(String vmId, String sessionId, String mode) async {
    final saved = choicesStore.read(vmId, sessionId) ?? const SavedChoices();
    choicesStore.write(vmId, sessionId, SavedChoices(mode: mode, model: saved.model, effort: saved.effort));
    _keepModeForNewChats(vmId, mode);
    await api.setPermissionMode(vmId, sessionId, mode);
  }

  /// A mode picked in a chat is what the person wants on this machine: new chats here start in it too, instead of
  /// making them pick it again every time (Settings for this machine shows it, and can go back to the app's default).
  void _keepModeForNewChats(String vmId, String mode) {
    final d = defaultChoicesFor(vmId);
    if (d.mode == mode) return;
    final o = overlay.machine(vmId);
    setMachineSettings(vmId, o.copyWith(defaults: () => SavedChoices(mode: mode, model: d.model, effort: d.effort)));
  }

  Future<void> setModel(String vmId, String sessionId, String model) async {
    final saved = choicesStore.read(vmId, sessionId) ?? const SavedChoices();
    choicesStore.write(vmId, sessionId, SavedChoices(mode: saved.mode, model: model, effort: saved.effort));
    await api.setModel(vmId, sessionId, model);
  }

  Future<void> setEffort(String vmId, String sessionId, String effort) async {
    final saved = choicesStore.read(vmId, sessionId) ?? const SavedChoices();
    choicesStore.write(vmId, sessionId, SavedChoices(mode: saved.mode, model: saved.model, effort: effort));
    await api.setEffort(vmId, sessionId, effort);
  }

  /// Answer a permission prompt (and its identical retries). If the answer does not reach the machine, the prompt
  /// comes back so it can be answered again.
  Future<void> resolvePermission(String vmId, String sessionId, String requestId, String behavior, {List<String> twins = const []}) async {
    final others = [for (final id in twins) if (id != requestId) id];
    for (final id in others) {
      dispatch(PermissionResolved(id));
    }
    dispatch(PermissionResolved(requestId, sessionId: sessionId));
    try {
      await api.resolvePermission(vmId, sessionId, requestId, behavior);
    } catch (_) {
      dispatch(PermissionReopened([requestId, ...others]));
      rethrow;
    }
    // The run carries on from here: if the socket is slow to say so, the next poll picks it up, and this makes sure of it.
    _later(const Duration(seconds: 2), () => refreshSession(vmId, sessionId));
  }

  /// Is this a new chat still waiting for its machine to name it?
  bool isTemporary(String sessionId) => _pendingChoices.containsKey(sessionId);

  /// A choice changed on a new chat the machine has not named yet: send it once it has.
  void updatePendingChoices(String tempId, ChatChoices choices) {
    if (!_pendingChoices.containsKey(tempId)) return;
    _pendingChoices[tempId] = choices;
    final vm = _state.selectedVmId;
    if (vm != null) choicesStore.write(vm, tempId, SavedChoices(mode: choices.mode, model: choices.model, effort: choices.effort));
  }

  /// The real id a new chat's temporary id became, once the machine named it.
  String? namedAs(String tempId) => _named[tempId];

  // ---------- autonomous chats ----------

  /// What a chat on this machine starts with when nothing was chosen for it: the machine's own choice, else the app-wide one.
  SavedChoices defaultChoicesFor(String vmId) {
    final own = overlay.machine(vmId).defaults;
    if (own != null) return own;
    final p = currentPrefs();
    return SavedChoices(mode: p.defaultMode, model: p.defaultModel, effort: p.defaultEffort);
  }

  /// Does this chat work on its own (answer its own prompts, check its work, go round again)?
  bool isAutonomous(String vmId, String sessionId) => isAutonomousMode((choicesStore.read(vmId, sessionId) ?? defaultChoicesFor(vmId)).mode);

  /// How many times it has gone round again on its own since the person's last message.
  int roundsFor(String sessionId) => _rounds[sessionId] ?? 0;

  void _autoAnswer(String vmId, String sessionId, String requestId, String tool, Map<String, dynamic> input) {
    if (!isAutonomous(vmId, sessionId) || _autoAnswered.contains(requestId)) return;
    _autoAnswered.add(requestId);
    final v = decideAutonomously(tool, input);
    unawaited(resolvePermission(vmId, sessionId, requestId, v.allow ? 'allow' : 'deny').catchError((Object _) {
      _autoAnswered.remove(requestId); // it did not reach the machine: the next look tries again
    }));
  }

  /// After a fresh list from the hub: answer prompts that came while the app was not listening, and look at turns that ended.
  void _afterRefresh(String vmId, String sessionId) {
    final rows = _state.messagesBySession[sessionId];
    if (rows == null || !isAutonomous(vmId, sessionId)) {
      if (rows != null) _resultsHandled[sessionId] = rows.where(_isResult).length;
      return;
    }
    if (rows.any((r) => r.message is Map && (r.message as Map)['type'] == 'permission_request')) {
      for (final p in livePermissions(groupMessages(rows), _state.resolvedPermissionIds)) {
        _autoAnswer(vmId, sessionId, p.requestId, p.toolName, p.input);
      }
    }
    final n = rows.where(_isResult).length;
    final seen = _resultsHandled[sessionId];
    _resultsHandled[sessionId] = n;
    // The first look at a chat is not a turn that just ended: only a result newer than the last look is.
    if (seen != null && n > seen) _scheduleNudge(vmId, sessionId);
  }

  static bool _isResult(MessageDto r) => r.message is Map && (r.message as Map)['type'] == 'result';

  void _noticeTurnEnd(AppendMessage a) {
    if (!_isResult(a.message) || !isAutonomous(a.message.vmId, a.sessionId)) return;
    final n = (_state.messagesBySession[a.sessionId] ?? const <MessageDto>[]).where(_isResult).length;
    final seen = _resultsHandled[a.sessionId] ?? n - 1;
    _resultsHandled[a.sessionId] = n;
    if (n > seen) _scheduleNudge(a.message.vmId, a.sessionId);
  }

  void _scheduleNudge(String vmId, String sessionId) {
    _later(const Duration(milliseconds: 1200), () async {
      final rows = _state.messagesBySession[sessionId];
      if (rows == null || !isAutonomous(vmId, sessionId)) return;
      final rounds = _rounds[sessionId] ?? 0;
      final nudge = nextNudge(rows, rounds: rounds, halted: _halted.contains(sessionId));
      if (nudge == null) return;
      _rounds[sessionId] = rounds + 1;
      notifyListeners();
      await sendMessage(vmId, sessionId, UserInput(text: nudge.text), auto: true);
    });
  }

  // ---------- per-chat and per-machine settings ----------

  /// How a chat is called here: the name chosen on this phone, else the hub's.
  String titleOf(SessionDto s) {
    final t = overlay.session(s.vmId.isEmpty ? (_state.selectedVmId ?? '') : s.vmId, s.id).title;
    return t.isNotEmpty ? t : s.title;
  }

  /// How a machine is called here.
  String nameOf(VmDto vm) {
    final n = overlay.machine(vm.id).name;
    return n.isNotEmpty ? n : vm.name;
  }

  bool isSessionHidden(String vmId, String sessionId) => overlay.session(vmId, sessionId).hidden;
  bool isVmHidden(String vmId) => overlay.machine(vmId).hidden;
  int hiddenSessionCount(String vmId) => overlay.hiddenSessions(vmId).length;
  MachineOverlay machineSettings(String vmId) => overlay.machine(vmId);

  void setMachineSettings(String vmId, MachineOverlay o) {
    overlay.setMachine(vmId, o);
    notifyListeners();
  }

  /// What a new chat on this machine starts with: the machine's own choice, else the person's app-wide one.
  SavedChoices? machineDefaults(String vmId) => overlay.machine(vmId).defaults;

  /// Rename a chat. Returns true when the hub took the new name too; otherwise it is the name on this phone.
  Future<bool> renameSession(String vmId, SessionDto s, String title) async {
    final clean = title.trim();
    final onHub = clean.isNotEmpty && await _tryHub(() => api.renameSession(vmId, s.id, clean));
    overlay.setSession(vmId, s.id, SessionOverlay(title: onHub || clean == s.title ? '' : clean, hidden: overlay.session(vmId, s.id).hidden));
    if (onHub) {
      final list = _state.sessionsByVm[vmId];
      if (list != null) dispatch(SetSessions(vmId, [for (final x in list) x.id == s.id ? x.copyWith(title: clean) : x]));
    }
    notifyListeners();
    return onHub;
  }

  /// Delete a chat. Returns true when the hub deleted it; otherwise it is only hidden on this phone.
  Future<bool> deleteSession(String vmId, SessionDto s) async {
    final onHub = await _tryHub(() => api.deleteSession(vmId, s.id));
    if (onHub) {
      final list = _state.sessionsByVm[vmId] ?? const <SessionDto>[];
      dispatch(SetSessions(vmId, [for (final x in list) if (x.id != s.id) x]));
    } else {
      overlay.setSession(vmId, s.id, SessionOverlay(title: overlay.session(vmId, s.id).title, hidden: true));
    }
    if (_state.selectedSessionId == s.id) dispatch(Select(vmId: vmId, accountId: _state.selectedAccountId));
    notifyListeners();
    return onHub;
  }

  void showHiddenSessions(String vmId) {
    for (final id in overlay.hiddenSessions(vmId)) {
      overlay.setSession(vmId, id, SessionOverlay(title: overlay.session(vmId, id).title));
    }
    notifyListeners();
  }

  /// Rename a machine. Returns true when the hub took the new name too.
  Future<bool> renameVm(VmDto vm, String name) async {
    final clean = name.trim();
    final onHub = clean.isNotEmpty && await _tryHub(() => api.renameVm(vm.id, clean));
    overlay.setMachine(vm.id, overlay.machine(vm.id).copyWith(name: onHub || clean == vm.name ? '' : clean));
    if (onHub) dispatch(SetVms([for (final v in _state.vms) v.id == vm.id ? v.copyWith(name: clean) : v]));
    notifyListeners();
    return onHub;
  }

  /// Remove a machine. Returns true when the hub removed it; otherwise it is only hidden on this phone (a machine whose
  /// agent is still running reconnects, so the hub may refuse).
  Future<bool> deleteVm(VmDto vm) async {
    final onHub = await _tryHub(() => api.deleteVm(vm.id));
    if (onHub) {
      dispatch(SetVms([for (final v in _state.vms) if (v.id != vm.id) v]));
    } else {
      overlay.setMachine(vm.id, overlay.machine(vm.id).copyWith(hidden: true));
    }
    if (_state.selectedVmId == vm.id) dispatch(const Select());
    notifyListeners();
    return onHub;
  }

  void showHiddenMachines() {
    for (final v in _state.vms) {
      if (overlay.machine(v.id).hidden) overlay.setMachine(v.id, overlay.machine(v.id).copyWith(hidden: false));
    }
    notifyListeners();
  }

  int get hiddenMachineCount => _state.vms.where((v) => overlay.machine(v.id).hidden).length;

  /// Did the hub do it? A hub that has no such request (404/405/501) or refuses it just says no; the phone then keeps the
  /// change itself. A broken connection is the person's to see, so it is rethrown.
  Future<bool> _tryHub(Future<void> Function() call) async {
    try {
      await call();
      return true;
    } on HubError catch (e) {
      if (e.unreachable || e.status == 401) rethrow;
      return false;
    }
  }
}
