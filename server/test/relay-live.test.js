// Stage 3: relays' live connection (src/relay-ws.js), commands for screens, and the relay
// add-on pairing itself (src/relay.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp } = require('../src/app');
const { createRelay } = require('../src/relay');
const { createFakeGoogle } = require('./fake-google');

const BOSS = 'boss';
const PASSWORD = 'correct-horse-9';

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-live-'));
  const logs = [];
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: BOSS, password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: (...a) => logs.push(a.map(String).join(' ')),
  });
  const server = await listen(app);
  const sockets = [];
  t.after(async () => {
    app.locals.relayHub.close();
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = (method, url, { token, json, headers = {} } = {}) => {
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    return fetch(base + url, { method, headers, body });
  };
  const boss = (await (await call('POST', '/api/auth/login', { json: { username: BOSS, password: PASSWORD } })).json()).token;

  // A relay with both pieces paired, and a TV of its own at a location of the same name.
  const makeRelay = async (name) => {
    const made = await (await call('POST', '/api/relays', { token: boss, json: { name } })).json();
    const pair = (kind) => call('POST', '/api/relay/v1/pair', { json: { code: made.pairing_code, kind, client: { name: 'test' } } }).then((r) => r.json());
    const control = await pair('control');
    const proxy = await pair('proxy');
    return { id: made.relay.id, control: control.credential, controlId: control.credential_id, proxy: proxy.credential };
  };
  const addTv = async (relay, name, location) => {
    const tv = await (await call('POST', '/api/player/register', { json: { app_version: '0.6.0' }, headers: { 'x-kiosk-relay-auth': relay.proxy } })).json();
    const claimed = await (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name, location } })).json();
    return { id: claimed.id, token: tv.token, headers: { 'x-kiosk-relay-auth': relay.proxy } };
  };

  // A relay's Home Assistant connecting live. Collects what it is sent.
  const connect = (credential, query = '') => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/v1/ws${query}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    sockets.push(ws);
    const messages = [];
    const waiting = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      messages.push(msg);
      for (const w of [...waiting]) if (w.match(msg)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(msg); }
    });
    ws.closed = new Promise((r) => ws.on('close', (code) => r(code)));
    const next = (match, ms = 2000) => {
      const test_ = typeof match === 'string' ? (m) => m.type === match : match;
      const found = messages.find(test_);
      if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((res, rej) => {
        const w = { match: test_, resolve: (m) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); res(m); } };
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); rej(new Error(`no ${typeof match === 'string' ? match : 'matching'} message`)); }, ms);
        waiting.push(w);
      });
    };
    ws.on('unexpected-response', (req, res) => resolve({ refused: res.statusCode }));
    ws.on('error', (err) => { if (!ws.refused) reject(err); });
    ws.on('open', async () => resolve({ ws, messages, next, hello: await next('hello') }));
  });

  const hub = app.locals.relayHub;
  return { app, call, boss, makeRelay, addTv, connect, hub, logs, base };
}

test('the live connection needs a relay’s integration credential', async (t) => {
  const { call, boss, makeRelay, connect } = await startServer(t);
  const q = await makeRelay('Qoltured');
  assert.equal((await connect(null)).refused, 401);
  assert.equal((await connect('rk_nonsense')).refused, 401);
  assert.equal((await connect(boss)).refused, 401); // a person's session isn't a relay credential
  assert.equal((await connect(q.proxy)).refused, 403); // the add-on's credential is for passing TVs on only
  const live = await connect(q.control);
  assert.equal(live.hello.relay_id, q.id);
  assert.ok(Math.abs(live.hello.server_time - Date.now()) < 5000);
  // The admin page shows it connected.
  const view = await (await call('GET', `/api/relays/${q.id}`, { token: boss })).json();
  assert.equal(view.connected, true);
  // Any other address on the port doesn't upgrade.
  const other = new WebSocket(live.ws.url.replace('/api/relay/v1/ws', '/api/other'), { headers: { authorization: `Bearer ${q.control}` } });
  await new Promise((resolve) => { other.on('error', resolve); other.on('close', resolve); });
  assert.notEqual(other.readyState, WebSocket.OPEN);
});

test('each relay hears only about its own screens, with two relays connected at once', async (t) => {
  const { app, call, boss, makeRelay, addTv, connect, hub } = await startServer(t);
  const q = await makeRelay('Qoltured');
  const l = await makeRelay('Linsy');
  const cafe = await addTv(q, 'Cafe wall', 'Qoltured');
  const counter = await addTv(l, 'Counter', 'Linsy');
  const ql = await connect(q.control);
  const ll = await connect(l.control);

  // Renaming Qoltured's screen reaches Qoltured only.
  await call('PATCH', `/api/devices/${cafe.id}`, { token: boss, json: { name: 'Cafe wall 2' } });
  hub.flush();
  const updated = await ql.next('player.updated');
  assert.equal(updated.player.id, cafe.id);
  assert.equal(updated.player.name, 'Cafe wall 2');
  assert.ok(Number.isInteger(updated.event));
  assert.equal('token' in updated.player, false);
  await assert.rejects(ll.next('player.updated', 300));

  // A plain check-in that changes nothing visible isn't news.
  await call('POST', '/api/player/heartbeat', { token: counter.token, json: { app_version: '0.6.0' }, headers: counter.headers });
  hub.flush();
  await assert.rejects(ll.next('player.updated', 300));

  // Going offline is news: the TV was last seen long ago, and the regular check notices.
  app.locals.db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(Date.now() - 10 * 60 * 1000, counter.id);
  hub.sweep();
  assert.equal((await ll.next('player.offline')).player_id, counter.id);
  await assert.rejects(ql.next('player.offline', 300));
  await call('POST', '/api/player/heartbeat', { token: counter.token, json: { app_version: '0.6.0' }, headers: counter.headers });
  hub.sweep();
  assert.equal((await ll.next('player.online')).player_id, counter.id);

  // Moving Counter to Qoltured: Linsy hears it's gone, Qoltured hears about a new screen.
  await call('PUT', `/api/devices/${counter.id}/relay`, { token: boss, json: { relay_id: q.id } });
  hub.flush();
  assert.equal((await ll.next('player.removed')).player_id, counter.id);
  assert.equal((await ql.next((m) => m.type === 'player.updated' && m.player.id === counter.id)).player.name, 'Counter');
});

test('commands: play a playlist or refresh; acknowledged when the TV fetches it, else expired', async (t) => {
  const { app, call, boss, makeRelay, addTv, connect } = await startServer(t);
  const q = await makeRelay('Qoltured');
  const l = await makeRelay('Linsy');
  const cafe = await addTv(q, 'Cafe wall', 'Qoltured');
  const counter = await addTv(l, 'Counter', 'Linsy');
  const live = await connect(q.control);
  const { locations } = await (await call('GET', '/api/locations', { token: boss })).json();
  const locId = (name) => locations.find((x) => x.name === name).id;
  const promo = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Promo', orientation: 'landscape', location_id: locId('Qoltured') } })).json();
  const linsyPromo = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Linsy promo', orientation: 'landscape', location_id: locId('Linsy') } })).json();
  const command = (player, body, token = q.control) => call('POST', `/api/relay/v1/players/${player}/commands`, { token, json: body });
  const versionOf = async (tv) => (await (await call('POST', '/api/player/heartbeat', { token: tv.token, json: {}, headers: tv.headers })).json()).version;

  // Only the relay's integration, only for its own screens, only known kinds.
  assert.equal((await command(counter.id, { kind: 'refresh' })).status, 404);
  assert.equal((await command(cafe.id, { kind: 'refresh' }, q.proxy)).status, 403);
  assert.equal((await command(cafe.id, { kind: 'reboot' })).status, 400);
  assert.equal((await command(cafe.id, { kind: 'play_playlist', payload: {} })).status, 400);
  assert.equal((await command(cafe.id, { kind: 'refresh', ttl_s: 5 })).status, 400);
  assert.equal((await command(cafe.id, { kind: 'refresh', id: 'bad id' })).status, 400);

  // Another location's playlist is refused, and the refusal is kept.
  const refused = await command(cafe.id, { kind: 'play_playlist', payload: { playlist_id: linsyPromo.id } });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).status, 'rejected');
  assert.equal((await live.next('command.updated')).command.status, 'rejected');

  // Play "Promo": applied now, the TV's version changes, and fetching the playlist acknowledges it.
  const before = await versionOf(cafe);
  const res = await command(cafe.id, { id: 'cmd_promo_0001', kind: 'play_playlist', payload: { playlist_id: promo.id } });
  assert.equal(res.status, 201);
  const applied = await res.json();
  assert.deepEqual([applied.id, applied.status, applied.player_id], ['cmd_promo_0001', 'applied', cafe.id]);
  assert.ok(Math.abs(applied.expires_at - (Date.now() + 300 * 1000)) < 5000);
  assert.equal((await live.next('command.updated')).command.status, 'applied');
  assert.notEqual(await versionOf(cafe), before);
  const device = await (await call('GET', `/api/relay/v1/players/${cafe.id}`, { token: q.control })).json();
  assert.deepEqual([device.playlist_id, device.playlist_name, device.playlist_auto], [promo.id, 'Promo', false]);
  // Sending the same command again (a retry) changes nothing and gives the same answer.
  const retry = await command(cafe.id, { id: 'cmd_promo_0001', kind: 'play_playlist', payload: { playlist_id: promo.id } });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, 'applied');
  // ...and another relay can't use or read that id.
  const lc = await command(counter.id, { id: 'cmd_promo_0001', kind: 'refresh' }, l.control);
  assert.equal(lc.status, 409);
  assert.equal((await call('GET', '/api/relay/v1/commands/cmd_promo_0001', { token: l.control })).status, 404);

  const playlist = await call('GET', '/api/player/playlist', { token: cafe.token, headers: cafe.headers });
  assert.equal(playlist.status, 200);
  const acked = await live.next((m) => m.type === 'command.updated' && m.command.status === 'acknowledged');
  assert.equal(acked.command.id, 'cmd_promo_0001');
  assert.ok(acked.command.acknowledged_at);
  assert.equal((await (await call('GET', '/api/relay/v1/commands/cmd_promo_0001', { token: q.control })).json()).status, 'acknowledged');

  // A newer playlist choice replaces one the TV hasn't picked up yet.
  const first = await (await command(cafe.id, { kind: 'play_playlist', payload: { playlist_id: promo.id } })).json();
  const second = await (await command(cafe.id, { kind: 'play_playlist', payload: { automatic: true } })).json();
  assert.equal((await (await call('GET', `/api/relay/v1/commands/${first.id}`, { token: q.control })).json()).status, 'superseded');
  assert.equal((await (await call('GET', `/api/relay/v1/players/${cafe.id}`, { token: q.control })).json()).playlist_auto, true);

  // Not picked up in time: expired. The change itself stays.
  app.locals.db.prepare(`UPDATE relay_commands SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, second.id);
  app.locals.expireRelayCommands();
  const expired = await (await call('GET', `/api/relay/v1/commands/${second.id}`, { token: q.control })).json();
  assert.equal(expired.status, 'expired');
  assert.match(expired.reason, /didn’t check in/);

  // Refresh only makes the TV fetch again.
  const v1 = await versionOf(cafe);
  const refresh = await (await command(cafe.id, { kind: 'refresh', ttl_s: 60 })).json();
  assert.equal(refresh.status, 'applied');
  assert.notEqual(await versionOf(cafe), v1);

  // Commands are in the relay's history.
  const events = await (await call('GET', `/api/relays/${q.id}/events`, { token: boss })).json();
  assert.ok(events.some((e) => e.kind === 'command' && e.detail.id === 'cmd_promo_0001'));
});

test('a relay that reconnects gets what it missed, or is told to resync', async (t) => {
  const { call, boss, makeRelay, addTv, connect, hub } = await startServer(t);
  const q = await makeRelay('Qoltured');
  const cafe = await addTv(q, 'Cafe wall', 'Qoltured');
  const first = await connect(q.control);
  await call('PATCH', `/api/devices/${cafe.id}`, { token: boss, json: { name: 'A' } });
  hub.flush();
  const seen = await first.next('player.updated');
  first.ws.close();
  await first.ws.closed;
  // While it's away, two more changes.
  await call('PATCH', `/api/devices/${cafe.id}`, { token: boss, json: { name: 'B' } });
  hub.sweep();
  await call('PATCH', `/api/devices/${cafe.id}`, { token: boss, json: { name: 'C' } });
  hub.sweep();
  const back = await connect(q.control, `?after=${seen.event}`);
  assert.equal((await back.next('player.updated')).player.name, 'B');
  assert.equal((await back.next('player.updated')).player.name, 'C');
  await assert.rejects(back.next('resync', 200));
  // Up to date: nothing to replay.
  const current = await connect(q.control, `?after=${back.hello.last_event}`);
  await assert.rejects(current.next((m) => m.type === 'player.updated' || m.type === 'resync', 200));
  // An event number from before a restart (or nonsense) means: fetch everything again.
  assert.ok(await (await connect(q.control, '?after=5')).next('resync'));
  assert.ok(await (await connect(q.control, `?after=${back.hello.last_event + 1000}`)).next('resync'));
});

test('disabling, deleting or revoking closes the connection; a new credential can be handed over', async (t) => {
  const { call, boss, makeRelay, connect } = await startServer(t);
  const q = await makeRelay('Qoltured');

  // Rotation, pushed to the connected integration. The old credential works until the new one is used.
  const live = await connect(q.control);
  assert.equal((await call('POST', `/api/relays/${q.id}/rotate`, { token: boss, json: { kind: 'proxy' } })).status, 400);
  const rotated = await call('POST', `/api/relays/${q.id}/rotate`, { token: boss, json: { kind: 'control' } });
  assert.equal(rotated.status, 201);
  const pushed = await live.next('credential.rotate');
  assert.match(pushed.credential, /^rk_/);
  assert.equal(pushed.credential_id, (await rotated.json()).credential_id);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: q.control })).status, 200);
  const renewed = await connect(pushed.credential); // first use retires the old one...
  assert.equal(await live.ws.closed, 4001); // ...which closes the connection made with it
  assert.equal((await call('GET', '/api/relay/v1/me', { token: q.control })).status, 401);
  // History shows the hand-over without the secret.
  const events = await (await call('GET', `/api/relays/${q.id}/events`, { token: boss })).json();
  assert.ok(events.some((e) => e.kind === 'credential_rotation_sent'));
  assert.doesNotMatch(JSON.stringify(events), /rk_/);

  // Revoking the credential in use closes its connection.
  await call('POST', `/api/relays/${q.id}/credentials/${pushed.credential_id}/revoke`, { token: boss });
  assert.equal(await renewed.ws.closed, 4001);
  // Not connected: nothing to hand a new credential to.
  assert.equal((await call('POST', `/api/relays/${q.id}/rotate`, { token: boss, json: { kind: 'control' } })).status, 409);

  // Disabling: told first, then closed, and it can't come back while disabled.
  const l = await makeRelay('Linsy');
  const ll = await connect(l.control);
  await call('PATCH', `/api/relays/${l.id}`, { token: boss, json: { status: 'disabled' } });
  assert.ok(await ll.next('relay.disabled'));
  assert.equal(await ll.ws.closed, 4003);
  assert.equal((await connect(l.control)).refused, 403);
  const view = await (await call('GET', `/api/relays/${l.id}`, { token: boss })).json();
  assert.equal(view.connected, false);

  // Deleting (it has no screens).
  const x = await makeRelay('Relay 003');
  const xl = await connect(x.control);
  assert.equal((await call('DELETE', `/api/relays/${x.id}`, { token: boss, json: { confirm_name: 'Relay 003' } })).status, 200);
  assert.ok(await xl.next('relay.deleted'));
  assert.equal(await xl.ws.closed, 4003);
});

test('the relay add-on pairs with its code, sends its credential, and keeps TVs safe when refused', async (t) => {
  const { call, boss, base } = await startServer(t);
  const made = await (await call('POST', '/api/relays', { token: boss, json: { name: 'Qoltured' } })).json();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-relay-addon-'));
  const started = [];
  t.after(async () => {
    for (const s of started) await new Promise((r) => s.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const startRelay = async (pairingCode) => {
    const relay = createRelay({ mainUrl: base, siteName: 'Qoltured', dataDir, pairingCode, log: () => {}, heartbeatMs: 0, pruneIntervalMs: 0 });
    await relay.locals.ready;
    const server = await listen(relay);
    started.push(server);
    const rbase = `http://127.0.0.1:${server.address().port}`;
    const status = async () => (await (await fetch(`${rbase}/api/relay/status`)).json()).pairing;
    return { relay, rbase, status };
  };

  // No code yet: not paired, and the status page says what to do.
  const none = await startRelay('');
  assert.equal((await none.status()).state, 'not_paired');
  // A wrong code: refused once, not retried over and over.
  const wrong = await startRelay('ABCDE-FGHJK');
  assert.equal((await wrong.status()).state, 'code_invalid');
  assert.match((await wrong.status()).message, /new code/);

  // The right code (typed loosely): paired. The credential is kept privately; the code isn't kept.
  const first = await startRelay(made.pairing_code.toLowerCase());
  assert.deepEqual([(await first.status()).state, (await first.status()).relay_name], ['paired', 'Qoltured']);
  const file = path.join(dataDir, 'relay-credential.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /rk_/);
  assert.equal(saved.includes(made.pairing_code.replace('-', '')), false);
  const view = await (await call('GET', `/api/relays/${made.relay.id}`, { token: boss })).json();
  assert.deepEqual(view.paired, { control: false, proxy: true });

  // A TV through the add-on belongs to this relay, proven by the credential.
  const tv = await (await fetch(`${first.rbase}/api/player/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const claimed = await (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Cafe wall', location: 'Qoltured' } })).json();
  assert.equal(claimed.relay.id, made.relay.id);

  // Restarting with the same (now used) code doesn't pair again: the saved credential is used.
  const again = await startRelay(made.pairing_code);
  assert.equal((await again.status()).state, 'paired');
  const playlist = await fetch(`${again.rbase}/api/player/playlist`, { headers: { authorization: `Bearer ${tv.token}` } });
  assert.equal(playlist.status, 200);

  // The credential is revoked: the add-on says so, and TVs get 503 ("try later"), never 401,
  // which would make them forget their pairing and files.
  const cred = view.credentials.find((c) => c.kind === 'proxy');
  await call('POST', `/api/relays/${made.relay.id}/credentials/${cred.id}/revoke`, { token: boss });
  await again.relay.locals.heartbeat();
  assert.equal((await again.status()).state, 'revoked');
  assert.equal((await fetch(`${again.rbase}/api/player/playlist`, { headers: { authorization: `Bearer ${tv.token}` } })).status, 503);
  assert.notEqual((await fetch(`${again.rbase}/media/1`, { headers: { authorization: `Bearer ${tv.token}` } })).status, 401);

  // A new code from the main server pairs it again.
  const code2 = (await (await call('POST', `/api/relays/${made.relay.id}/pairing-code`, { token: boss })).json()).pairing_code;
  const third = await startRelay(code2);
  assert.equal((await third.status()).state, 'paired');
  assert.equal((await fetch(`${third.rbase}/api/player/playlist`, { headers: { authorization: `Bearer ${tv.token}` } })).status, 200);
});
