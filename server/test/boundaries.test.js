// Stage 5, handover cases 13–15: what existed before relays keeps working, and the
// new relay credentials, people's sign-ins and Home Assistant's sidebar stay separate.
// (Cases 1–12 run with every piece for real in homeassistant/integration/tests/test_end_to_end.py.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp, createIngressServer } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-bounds-'));
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {},
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { token, json, headers = {} } = {}) => fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const login = (username, password) => call('POST', '/api/auth/login', { json: { username, password } });
  const boss = (await (await login('boss', PASSWORD)).json()).token;
  // A paired relay (both pieces) and one of its TVs.
  const made = await (await call('POST', '/api/relays', { token: boss, json: { name: 'Qoltured' } })).json();
  const pair = async (kind) => (await (await call('POST', '/api/relay/v1/pair', { json: { code: made.pairing_code, kind } })).json()).credential;
  const control = await pair('control');
  const proxy = await pair('proxy');
  return { app, call, login, boss, base, relayId: made.relay.id, control, proxy };
}

test('13: the Android app’s username and password sign-in is unchanged', async (t) => {
  const { call, login, boss } = await startServer(t);
  const made = await call('POST', '/api/users', { token: boss, json: { username: 'patrick', role: 'system_manager', password: PASSWORD } });
  assert.equal(made.status, 201);
  // Sign in, use the session, as Kiosk Admin does.
  const res = await login('patrick', PASSWORD);
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const me = await (await call('GET', '/api/me', { token })).json();
  assert.deepEqual([me.username, me.role], ['patrick', 'system_manager']);
  assert.equal((await call('GET', '/api/devices', { token })).status, 200);
  // Wrong passwords are refused; after five, even the right one waits five minutes.
  for (let i = 0; i < 5; i++) assert.equal((await login('patrick', 'wrong-password')).status, 401);
  assert.equal((await login('patrick', PASSWORD)).status, 429);
  // The phone app's public config still says "password" sign-in.
  assert.equal((await (await call('GET', '/api/config')).json()).sign_in, 'password');
});

test('14: TVs keep their tokens, directly, through an old relay, and through a paired one', async (t) => {
  const { call, boss, proxy } = await startServer(t);
  const tvVia = async (headers) => {
    const tv = await (await call('POST', '/api/player/register', { json: { app_version: '0.5.0' }, headers })).json();
    await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: `TV ${tv.pairing_code}`, location: 'Lobby' } });
    return tv.token;
  };
  const direct = await tvVia({});
  const legacy = await tvVia({ 'x-kiosk-site': 'Old branch' }); // a relay add-on from before 0.7.0
  const paired = await tvVia({ 'x-kiosk-relay-auth': proxy });
  for (const [token, headers] of [[direct, {}], [legacy, { 'x-kiosk-site': 'Old branch' }], [paired, { 'x-kiosk-relay-auth': proxy }]]) {
    assert.equal((await call('POST', '/api/player/heartbeat', { token, json: {}, headers })).status, 200);
    assert.equal((await call('GET', '/api/player/playlist', { token, headers })).status, 200);
  }
  // A TV token is only a TV token: not a person, not a relay.
  assert.equal((await call('GET', '/api/me', { token: direct })).status, 401);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: direct })).status, 401);
  // A removed TV still gets 401 (so it shows a new code); a refused relay never does.
  assert.equal((await call('POST', '/api/player/heartbeat', { token: 'not-a-tv', json: {} })).status, 401);
  assert.equal((await call('POST', '/api/player/heartbeat', { token: paired, json: {}, headers: { 'x-kiosk-relay-auth': 'rk_revoked' } })).status, 503);
});

test('15: people, relays and Home Assistant’s sidebar each stay on their own side', async (t) => {
  const { app, call, boss, base, control, proxy } = await startServer(t);
  // Relay credentials don't open anything meant for people.
  for (const credential of [control, proxy]) {
    assert.equal((await call('GET', '/api/me', { token: credential })).status, 401);
    assert.equal((await call('GET', '/api/devices', { token: credential })).status, 401);
    assert.equal((await call('GET', '/api/relays', { token: credential })).status, 401);
  }
  // A person's session doesn't open the relay API, even a superadmin's.
  assert.equal((await call('GET', '/api/relay/v1/players', { token: boss })).status, 401);
  // Only superadmins manage relays.
  await call('POST', '/api/users', { token: boss, json: { username: 'squid', role: 'content_uploader', password: PASSWORD } });
  await call('POST', '/api/users', { token: boss, json: { username: 'patrick', role: 'system_manager', password: PASSWORD } });
  for (const username of ['squid', 'patrick']) {
    const token = (await (await call('POST', '/api/auth/login', { json: { username, password: PASSWORD } })).json()).token;
    assert.equal((await call('GET', '/api/relays', { token })).status, 403, username);
  }
  // Home Assistant's sidebar headers mean nothing on the normal port (the one Funnel would expose)...
  const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'owner' };
  assert.equal((await call('GET', '/api/relays', { headers: ha })).status, 401);
  // ...and on the sidebar port only Home Assistant's own address is let in (D2: it is the superadmin path).
  const ingress = createIngressServer(app, '127.0.0.1');
  await new Promise((r) => ingress.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => ingress.close(r)));
  const sidebar = `http://127.0.0.1:${ingress.address().port}`;
  assert.equal((await fetch(`${sidebar}/api/relays`, { headers: ha })).status, 200);
  const stranger = createIngressServer(app, '10.9.9.9');
  await new Promise((r) => stranger.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stranger.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${stranger.address().port}/api/relays`, { headers: ha })).status, 403);
  // The relays' live connection exists only on the main port, never through the sidebar.
  const opened = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${control}` } });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  assert.equal(await opened(`${base.replace('http', 'ws')}/api/relay/v1/ws`), true);
  assert.equal(await opened(`${sidebar.replace('http', 'ws')}/api/relay/v1/ws`), false);
});
