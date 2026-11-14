// The live connection from each relay's Home Assistant integration to this server.
//
// GET /api/relay/v1/ws with "Authorization: Bearer <control credential>" upgrades to a
// WebSocket. The credential is checked before the upgrade, exactly as for REST, and a
// relay only ever hears about its own screens.
//
// Server → relay messages (JSON, each with "type"):
//   hello            { relay_id, server_time, last_event }   on connect
//   resync           {}                                       too much was missed: GET /players again
//   player.updated   { player }                               something about a screen changed
//   player.online    { player_id, at }   player.offline { player_id, at }
//   player.removed   { player_id }                            no longer this relay's screen
//   command.updated  { command }
//   credential.rotate { credential_id, credential }           an admin asked for a new credential
//   relay.disabled / relay.deleted {}                         just before the server closes
//   ping             {}                                       every 25 s; answer with "pong"
// Relay → server: pong, resync (asks for a "resync"), credential.rotated (nothing to do here:
// the first use of the new credential retires the old one).
//
// Messages that report a change carry an increasing "event" number. A relay that reconnects
// with ?after=<event> gets what it missed in the last 10 minutes, or "resync" if that's not
// enough. Numbers start from the clock at start-up, so they keep increasing after a restart
// and a relay that was connected before the restart is told to resync.

const { WebSocketServer } = require('ws');

const PING_EVERY_MS = 25 * 1000;
const DEAD_AFTER_MS = 60 * 1000;
const KEEP_EVENTS_MS = 10 * 60 * 1000;
const KEEP_EVENTS_MAX = 500;
const DEBOUNCE_MS = 5 * 1000;
const SWEEP_EVERY_MS = 30 * 1000;
// Fields that change on every TV check-in; a change in them alone isn't news.
const NOISY = new Set(['last_seen', 'online']);

/**
 * listPlayers(relayId) → that relay's screens as the relay sees them (each with id and online).
 * ownerOf(deviceId) → the owning relay or null.
 */
function createRelayHub({
  relays, listPlayers, log = () => {}, now = () => Date.now(),
  pingEveryMs = PING_EVERY_MS, debounceMs = DEBOUNCE_MS, sweepEveryMs = SWEEP_EVERY_MS,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const sockets = new Map(); // relay id -> Set of sockets
  const history = new Map(); // relay id -> [{ event, at, message }]
  const lastEvent = new Map(); // relay id -> number
  const known = new Map(); // relay id -> Map(player id -> { key, online })  what the relay was last told
  const lastConnected = new Map(); // relay id -> time its last connection closed (absent while connected)
  const lostTrack = new Set(); // relays we stopped following: they must resync
  const pending = new Map(); // relay id -> debounce timer
  const startedAt = now();
  let stopped = false;
  // History entries for connects and disconnects. Never allowed to break a connection
  // (e.g. while the server is shutting down and its database is already closed).
  const note = (relayId, kind, actor) => {
    if (stopped) return;
    try { relays.event(relayId, kind, { actor }); } catch (err) { log(err); }
  };

  // ----- events -----

  function publish(relayId, message) {
    const event = (lastEvent.get(relayId) || startedAt) + 1;
    lastEvent.set(relayId, event);
    const list = history.get(relayId) || [];
    list.push({ event, at: now(), message });
    while (list.length > KEEP_EVENTS_MAX || (list.length && list[0].at < now() - KEEP_EVENTS_MS)) list.shift();
    history.set(relayId, list);
    for (const ws of sockets.get(relayId) || []) send(ws, { ...message, event });
  }

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  // ----- following each relay's screens -----

  const keyOf = (player) => JSON.stringify(Object.entries(player).filter(([k]) => !NOISY.has(k)));

  /** Compares the relay's screens with what it was last told, and tells it the differences. */
  function sync(relayId) {
    const before = known.get(relayId);
    const now_ = new Map();
    for (const p of listPlayers(relayId)) now_.set(p.id, { key: keyOf(p), online: Boolean(p.online), player: p });
    if (before) {
      for (const [id, cur] of now_) {
        const old = before.get(id);
        if (!old || old.key !== cur.key) publish(relayId, { type: 'player.updated', player: cur.player });
        if (old && old.online !== cur.online) publish(relayId, { type: cur.online ? 'player.online' : 'player.offline', player_id: id, at: now() });
      }
      for (const id of before.keys()) if (!now_.has(id)) publish(relayId, { type: 'player.removed', player_id: id });
    }
    for (const v of now_.values()) delete v.player;
    known.set(relayId, now_);
  }

  /** Something about a screen may have changed: its relay hears about it within a few seconds. */
  function playerChanged(deviceId) {
    const owner = relays.ownerOf(deviceId);
    if (owner) relayChanged(owner.id);
  }

  function relayChanged(relayId) {
    if (!known.has(relayId) || pending.has(relayId)) return;
    const timer = setTimeout(() => {
      pending.delete(relayId);
      if (known.has(relayId)) sync(relayId);
    }, debounceMs);
    timer.unref();
    pending.set(relayId, timer);
  }

  /** Runs now and then: online/offline changes, and anything the hooks missed. */
  function sweep() {
    for (const relayId of [...known.keys()]) {
      // Not connected for longer than a reconnect can catch up on: stop following it.
      const gone = lastConnected.get(relayId);
      if (gone !== undefined && now() - gone > KEEP_EVENTS_MS) {
        known.delete(relayId);
        lastConnected.delete(relayId);
        lostTrack.add(relayId);
        continue;
      }
      try { sync(relayId); } catch (err) { log(err); }
    }
    for (const set of sockets.values()) {
      for (const ws of set) if (now() - ws.lastPong > DEAD_AFTER_MS) ws.terminate();
    }
  }

  // ----- connecting -----

  function handleUpgrade(req, socket, head) {
    const header = req.headers.authorization || '';
    const result = relays.authenticate(header.startsWith('Bearer ') ? header.slice(7) : '', ['control']);
    if (result.error) {
      const body = JSON.stringify({ error: result.error });
      socket.end(`HTTP/1.1 ${result.status} ${result.status === 403 ? 'Forbidden' : 'Unauthorized'}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const after = Number(new URLSearchParams(String(req.url || '').split('?')[1] || '').get('after'));
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, result.relay, result.credential, after));
  }

  function connected(ws, relay, credential, after) {
    ws.relayId = relay.id;
    ws.credentialId = credential.id;
    ws.lastPong = now();
    if (!sockets.has(relay.id)) sockets.set(relay.id, new Set());
    if (sockets.get(relay.id).size === 0) note(relay.id, 'connected', `relay:${relay.id}`);
    sockets.get(relay.id).add(ws);
    lastConnected.delete(relay.id);

    const last = lastEvent.get(relay.id) || startedAt;
    send(ws, { type: 'hello', relay_id: relay.id, server_time: now(), last_event: last });
    if (!known.has(relay.id)) sync(relay.id); // start following (sends nothing the first time)

    // Catching up after a reconnect.
    if (Number.isFinite(after) && after > 0) {
      const list = history.get(relay.id) || [];
      const complete = !lostTrack.has(relay.id) && after <= last
        && (after === last || (list.length > 0 && list[0].event <= after + 1));
      if (complete) for (const e of list) if (e.event > after) send(ws, { ...e.message, event: e.event });
      if (!complete) send(ws, { type: 'resync' });
    }
    lostTrack.delete(relay.id);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'pong') ws.lastPong = now();
      else if (msg.type === 'resync') send(ws, { type: 'resync' });
    });
    ws.on('close', () => {
      const set = sockets.get(relay.id);
      if (!set || !set.delete(ws) || set.size) return;
      sockets.delete(relay.id);
      lastConnected.set(relay.id, now());
      note(relay.id, 'disconnected', 'system');
    });
    ws.on('error', () => {});
  }

  const pinger = setInterval(() => {
    for (const set of sockets.values()) for (const ws of set) send(ws, { type: 'ping' });
  }, pingEveryMs);
  pinger.unref();
  const sweeper = sweepEveryMs > 0 ? setInterval(sweep, sweepEveryMs) : null;
  if (sweeper) sweeper.unref();

  // ----- for the admin routes -----

  /** Closes a relay's connections (it was disabled or deleted). */
  function closeRelay(relayId, type = 'relay.disabled') {
    for (const ws of sockets.get(relayId) || []) {
      send(ws, { type });
      ws.close(4003, type);
    }
    if (type === 'relay.deleted') {
      known.delete(relayId);
      history.delete(relayId);
    }
  }

  /** Closes the connections made with one credential (it was revoked). */
  function closeCredential(credentialId) {
    for (const set of sockets.values()) {
      for (const ws of set) if (ws.credentialId === credentialId) ws.close(4001, 'credential revoked');
    }
  }

  /** Hands a connected relay a new credential. Never kept for replay. False if not connected. */
  function pushCredential(relayId, credentialId, credential) {
    const set = sockets.get(relayId);
    if (!set || !set.size) return false;
    for (const ws of set) send(ws, { type: 'credential.rotate', credential_id: credentialId, credential });
    return true;
  }

  return {
    handleUpgrade,
    isConnected: (relayId) => Boolean(sockets.get(relayId) && sockets.get(relayId).size),
    playerChanged,
    relayChanged,
    commandUpdated: (relayId, command) => publish(relayId, { type: 'command.updated', command }),
    closeRelay,
    closeCredential,
    pushCredential,
    sweep,
    /** Sends any changes waiting for their few seconds now (for tests). */
    flush: () => {
      for (const [relayId, timer] of pending) { clearTimeout(timer); pending.delete(relayId); sync(relayId); }
    },
    close: () => {
      stopped = true;
      clearInterval(pinger);
      if (sweeper) clearInterval(sweeper);
      for (const t of pending.values()) clearTimeout(t);
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { createRelayHub };
