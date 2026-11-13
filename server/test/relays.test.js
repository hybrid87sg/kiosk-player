// Relays: pairing, credentials, ownership, and what admins can do (see src/relays.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, createIngressServer } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const BOSS = 'boss';
const PASSWORD = 'correct-horse-9';

async function startServer(t, extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-relay-'));
  const logs = [];
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: BOSS, password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: (...a) => logs.push(a.map((x) => (x instanceof Error ? `${x.stack} ${JSON.stringify(x)}` : String(x))).join(' ')), ...extra,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    if (!extra.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { token, json, body, headers = {} } = {}) => {
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    return fetch(base + url, { method, headers, body });
  };
  const signIn = async (username, password = PASSWORD) => (await (await call('POST', '/api/auth/login', { json: { username, password } })).json()).token;
  const boss = await signIn(BOSS);
  // Admin helpers
  const makeRelay = async (name, more = {}) => {
    const res = await call('POST', '/api/relays', { token: boss, json: { name, ...more } });
    assert.equal(res.status, 201);
    return res.json();
  };
  const pair = (code, kind, client = { name: 'test', version: '0.1.0' }) => call('POST', '/api/relay/v1/pair', { json: { code, kind, client } });
  // A TV coming in through a relay add-on that has paired.
  const tvVia = async (proxyCredential, extraHeaders = {}) => {
    const headers = { ...(proxyCredential ? { 'x-kiosk-relay-auth': proxyCredential } : {}), ...extraHeaders };
    const res = await call('POST', '/api/player/register', { json: { app_version: '0.6.0' }, headers: { ...headers } });
    return { res, tv: res.status === 201 ? await res.json() : null, headers };
  };
  return { app, call, signIn, boss, makeRelay, pair, tvVia, logs, dataDir };
}

test('a relay is made by an admin, and paired once by its integration and once by its add-on', async (t) => {
  const { app, call, boss, makeRelay, pair, logs, dataDir } = await startServer(t);
  const made = await makeRelay('Qoltured', { description: 'Cafe on level 2' });
  const { relay, pairing_code: code, expires_at: expiresAt } = made;
  assert.match(relay.id, /^rly_[0-9a-f]{20}$/);
  assert.equal(relay.status, 'pending');
  assert.equal(relay.site, 'Qoltured'); // defaults to the name
  assert.match(code, /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
  assert.ok(Math.abs(expiresAt - (Date.now() + 10 * 60 * 1000)) < 5000);
  // Only a keyed hash of the code is stored, never the code.
  const stored = app.locals.db.prepare(`SELECT code_hash FROM relay_pairing_codes`).all();
  assert.equal(stored.length, 1);
  assert.match(stored[0].code_hash, /^[0-9a-f]{64}$/);
  for (const file of fs.readdirSync(dataDir).filter((f) => f.startsWith('kiosk.db'))) {
    assert.equal(fs.readFileSync(path.join(dataDir, file), 'latin1').includes(code.replace('-', '')), false, `code found in ${file}`);
  }
  // Listing never shows the code again.
  const list = await (await call('GET', '/api/relays', { token: boss })).json();
  assert.doesNotMatch(JSON.stringify(list), new RegExp(code.replace('-', '-?')));
  assert.deepEqual(list.relays[0].pairing, { expires_at: list.relays[0].pairing.expires_at, control_done: false, proxy_done: false });

  // The integration pairs, typed loosely (lower case, no dash).
  const control = await pair(code.toLowerCase().replace('-', ' '), 'control');
  assert.equal(control.status, 201);
  const c = await control.json();
  assert.match(c.credential, /^rk_[A-Za-z0-9_-]{43}$/);
  assert.match(c.credential_id, /^rcr_/);
  assert.deepEqual(c.relay, { id: relay.id, name: 'Qoltured', site: 'Qoltured' });
  // The same code can't pair a second integration...
  assert.equal((await pair(code, 'control')).status, 401);
  // ...but it still pairs the add-on, once.
  const proxy = await pair(code, 'proxy');
  assert.equal(proxy.status, 201);
  const p = await proxy.json();
  assert.equal((await pair(code, 'proxy')).status, 401);
  // Credentials: only hashes are stored.
  const creds = app.locals.db.prepare(`SELECT kind, secret_hash FROM relay_credentials ORDER BY kind`).all();
  assert.deepEqual(creds.map((x) => x.kind), ['control', 'proxy']);
  for (const x of creds) assert.match(x.secret_hash, /^[0-9a-f]{64}$/);

  const view = await (await call('GET', `/api/relays/${relay.id}`, { token: boss })).json();
  assert.equal(view.status, 'active');
  assert.deepEqual(view.paired, { control: true, proxy: true });
  assert.equal(view.pairing, null); // used up
  assert.doesNotMatch(JSON.stringify(view), /rk_/);

  // Each credential knows who it is.
  const me = await (await call('GET', '/api/relay/v1/me', { token: c.credential })).json();
  assert.deepEqual([me.relay.id, me.credential.kind], [relay.id, 'control']);
  assert.equal((await (await call('GET', '/api/relay/v1/me', { token: p.credential })).json()).credential.kind, 'proxy');
  // Nothing secret reached the log.
  const logged = logs.join('\n');
  for (const secret of [code, code.replace('-', ''), c.credential, p.credential]) assert.equal(logged.includes(secret), false, 'secret in the log');
});

test('pairing codes: wrong, expired, replaced, disabled, and guessing is limited', async (t) => {
  const { app, call, boss, makeRelay, pair, logs } = await startServer(t);
  const { relay, pairing_code: first } = await makeRelay('Linsy');
  // A new code makes the old one stop working.
  const second = (await (await call('POST', `/api/relays/${relay.id}/pairing-code`, { token: boss })).json()).pairing_code;
  assert.notEqual(first, second);
  assert.equal((await pair(first, 'control')).status, 401);
  // Expired.
  app.locals.db.prepare(`UPDATE relay_pairing_codes SET expires_at = ? WHERE cancelled_at IS NULL`).run(Date.now() - 1);
  const expired = await pair(second, 'control');
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).error, /isn’t valid/);
  // A wrong kind is refused before anything else.
  assert.equal((await pair(second, 'admin')).status, 400);
  // A disabled relay can't be paired.
  const third = (await (await call('POST', `/api/relays/${relay.id}/pairing-code`, { token: boss })).json()).pairing_code;
  await call('PATCH', `/api/relays/${relay.id}`, { token: boss, json: { status: 'disabled' } });
  assert.equal((await pair(third, 'control')).status, 403);
  assert.equal((await call('POST', `/api/relays/${relay.id}/pairing-code`, { token: boss })).status, 409);

  // Broken JSON holding a code: refused, and the code isn't logged.
  const broken = await call('POST', '/api/relay/v1/pair', { body: `{"code":"${third}",`, headers: { 'content-type': 'application/json' } });
  assert.equal(broken.status, 400);
  assert.equal(logs.join('\n').includes(third), false);

  // Guessing: 10 tries a minute from one address, then "too many".
  let status;
  for (let i = 0; i < 12; i++) status = (await pair('AAAAA-AAAAA', 'control')).status;
  assert.equal(status, 429);
});

test('credentials: revoked and disabled relays are refused on every request; a relay can rotate its own', async (t) => {
  const { call, boss, makeRelay, pair } = await startServer(t);
  const { relay, pairing_code: code } = await makeRelay('Qoltured');
  const control = await (await pair(code, 'control')).json();
  const me = () => call('GET', '/api/relay/v1/me', { token: control.credential });
  assert.equal((await me()).status, 200);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: 'rk_nonsense' })).status, 401);
  assert.equal((await call('GET', '/api/relay/v1/me')).status, 401);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: boss })).status, 401); // a person's session isn't a relay credential

  // Disabled: refused until enabled again.
  await call('PATCH', `/api/relays/${relay.id}`, { token: boss, json: { status: 'disabled' } });
  assert.equal((await me()).status, 403);
  const enabled = await (await call('PATCH', `/api/relays/${relay.id}`, { token: boss, json: { status: 'active' } })).json();
  assert.equal(enabled.status, 'active');
  assert.equal((await me()).status, 200);

  // Rotation: the old credential works until the new one is used, then never again.
  const rotated = await (await call('POST', '/api/relay/v1/credentials/rotate', { token: control.credential })).json();
  assert.notEqual(rotated.credential, control.credential);
  assert.equal((await me()).status, 200);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: rotated.credential })).status, 200);
  assert.equal((await me()).status, 401);

  // Revoked by an admin.
  const r = await call('POST', `/api/relays/${relay.id}/credentials/${rotated.credential_id}/revoke`, { token: boss });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).paired.control, false);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: rotated.credential })).status, 401);
  assert.equal((await call('POST', `/api/relays/${relay.id}/credentials/${rotated.credential_id}/revoke`, { token: boss })).status, 404);

  // Pairing the integration again replaces its credential.
  const again = await (await call('POST', `/api/relays/${relay.id}/pairing-code`, { token: boss })).json();
  const repaired = await (await pair(again.pairing_code, 'control')).json();
  assert.equal((await call('GET', '/api/relay/v1/me', { token: repaired.credential })).status, 200);

  // History has all of it, without secrets.
  const events = await (await call('GET', `/api/relays/${relay.id}/events`, { token: boss })).json();
  const kinds = events.map((e) => e.kind);
  for (const k of ['created', 'pairing_code_created', 'paired', 'disabled', 'enabled', 'credential_rotated', 'credential_revoked']) assert.ok(kinds.includes(k), k);
  assert.doesNotMatch(JSON.stringify(events), /rk_|[2-9A-Z]{5}-[2-9A-Z]{5}/);
});

test('ownership: a relay only sees its own screens; three relays at once', async (t) => {
  const { call, boss, makeRelay, pair, tvVia } = await startServer(t);
  const relays = {};
  for (const name of ['Qoltured', 'Linsy', 'Relay 003']) {
    const made = await makeRelay(name);
    const control = await (await pair(made.pairing_code, 'control')).json();
    const proxy = await (await pair(made.pairing_code, 'proxy')).json();
    relays[name] = { id: made.relay.id, control: control.credential, proxy: proxy.credential };
  }
  // A TV registers through each relay's add-on, and is added.
  const tvs = {};
  for (const [relayName, tvName] of [['Qoltured', 'Cafe wall'], ['Linsy', 'Counter'], ['Relay 003', 'Kiosk 3']]) {
    const { tv, headers } = await tvVia(relays[relayName].proxy);
    const claimed = await (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: tvName, location: relayName } })).json();
    assert.deepEqual(claimed.relay, { id: relays[relayName].id, name: relayName, status: 'active' });
    assert.equal(claimed.site, relayName); // the site comes from the credential
    tvs[tvName] = { ...tv, id: claimed.id, headers };
  }
  const players = async (name) => (await (await call('GET', '/api/relay/v1/players', { token: relays[name].control })).json());
  assert.deepEqual((await players('Qoltured')).map((p) => p.name), ['Cafe wall']);
  assert.deepEqual((await players('Linsy')).map((p) => p.name), ['Counter']);
  assert.deepEqual((await players('Relay 003')).map((p) => p.name), ['Kiosk 3']);
  // Another relay's screen doesn't exist, as far as a relay can tell.
  assert.equal((await call('GET', `/api/relay/v1/players/${tvs['Counter'].id}`, { token: relays.Qoltured.control })).status, 404);
  const own = await (await call('GET', `/api/relay/v1/players/${tvs['Cafe wall'].id}`, { token: relays.Qoltured.control })).json();
  assert.equal(own.name, 'Cafe wall');
  assert.equal(own.location, 'Qoltured');
  assert.equal('token' in own || 'pairing_code' in own, false);
  // A proxy credential can't read the player list; a control one can't pass TVs on.
  assert.equal((await call('GET', '/api/relay/v1/players', { token: relays.Qoltured.proxy })).status, 403);
  assert.equal((await tvVia(relays.Qoltured.control)).res.status, 403);

  // The Qoltured TV turns up through Linsy's add-on: it stays Qoltured's, and that's logged.
  const hb = await call('POST', '/api/player/heartbeat', { token: tvs['Cafe wall'].token, json: { app_version: '0.6.0' }, headers: { 'x-kiosk-relay-auth': relays.Linsy.proxy } });
  assert.equal(hb.status, 200);
  assert.deepEqual((await players('Qoltured')).map((p) => p.name), ['Cafe wall']);
  const events = await (await call('GET', `/api/relays/${relays.Qoltured.id}/events`, { token: boss })).json();
  assert.ok(events.some((e) => e.kind === 'player_seen_elsewhere' && e.device_name === 'Cafe wall'));

  // An admin moves it to Linsy.
  const moved = await (await call('PUT', `/api/devices/${tvs['Cafe wall'].id}/relay`, { token: boss, json: { relay_id: relays.Linsy.id } })).json();
  assert.equal(moved.relay.name, 'Linsy');
  assert.deepEqual((await players('Linsy')).map((p) => p.name).sort(), ['Cafe wall', 'Counter']);
  assert.deepEqual(await players('Qoltured'), []);
  assert.equal((await call('PUT', `/api/devices/${tvs['Cafe wall'].id}/relay`, { token: boss, json: { relay_id: 'rly_nope' } })).status, 400);

  // A relay with screens can't be deleted; an empty one can, with its name typed.
  assert.equal((await call('DELETE', `/api/relays/${relays.Linsy.id}`, { token: boss, json: { confirm_name: 'Linsy' } })).status, 409);
  assert.equal((await call('DELETE', `/api/relays/${relays.Qoltured.id}`, { token: boss, json: { confirm_name: 'qoltured' } })).status, 400);
  assert.equal((await call('DELETE', `/api/relays/${relays.Qoltured.id}`, { token: boss, json: { confirm_name: 'Qoltured' } })).status, 200);
  assert.equal((await call('GET', '/api/relay/v1/me', { token: relays.Qoltured.control })).status, 401);
});

test('a paired relay’s site can’t be claimed with a header; unpaired relays can be refused altogether', async (t) => {
  const { call, boss, makeRelay, pair, tvVia } = await startServer(t);
  // Before 0.7.0 a relay only sent its site name. That keeps working while it isn't paired.
  const legacy = await tvVia(null, { 'x-kiosk-site': 'Old branch' });
  assert.equal(legacy.res.status, 201);
  // Once Qoltured's add-on has paired, a header naming Qoltured is refused.
  const { relay, pairing_code: code } = await makeRelay('Qoltured');
  await pair(code, 'proxy');
  const spoof = await tvVia(null, { 'x-kiosk-site': 'Qoltured' });
  assert.equal(spoof.res.status, 401);
  assert.match((await spoof.res.json()).error, /must be paired/);
  // Its file downloads too.
  assert.equal((await call('GET', '/media/1', { headers: { 'x-kiosk-site': 'Qoltured', authorization: `Bearer ${legacy.tv.token}` } })).status, 401);
  // Requiring credentials refuses every unpaired relay, but not TVs talking to this server directly.
  const settings = await (await call('PATCH', '/api/settings', { token: boss, json: { relays_require_credentials: true } })).json();
  assert.equal(settings.relays_require_credentials, true);
  assert.equal((await tvVia(null, { 'x-kiosk-site': 'Old branch' })).res.status, 401);
  assert.equal((await tvVia(null)).res.status, 201);
  // A disabled relay's add-on is refused too.
  const { pairing_code: code2, relay: linsy } = await makeRelay('Linsy');
  const proxy = await (await pair(code2, 'proxy')).json();
  assert.equal((await tvVia(proxy.credential)).res.status, 201);
  await call('PATCH', `/api/relays/${linsy.id}`, { token: boss, json: { status: 'disabled' } });
  assert.equal((await tvVia(proxy.credential)).res.status, 403);
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { relays_require_credentials: 'yes' } })).status, 400);
  assert.ok(relay.id);
});

test('only Spongebob manages relays; Patrick can move a screen between relays', async (t) => {
  const { call, boss, signIn, makeRelay, tvVia, pair } = await startServer(t);
  await call('POST', '/api/users', { token: boss, json: { username: 'patrick', role: 'system_manager', password: PASSWORD } });
  await call('POST', '/api/users', { token: boss, json: { username: 'squid', role: 'content_uploader', password: PASSWORD } });
  const patrick = await signIn('patrick');
  const squid = await signIn('squid');
  const { relay, pairing_code: code } = await makeRelay('Qoltured');
  for (const token of [patrick, squid]) {
    assert.equal((await call('GET', '/api/relays', { token })).status, 403);
    assert.equal((await call('POST', '/api/relays', { token, json: { name: 'X' } })).status, 403);
    assert.equal((await call('POST', `/api/relays/${relay.id}/pairing-code`, { token })).status, 403);
  }
  const proxy = await (await pair(code, 'proxy')).json();
  const { tv } = await tvVia(proxy.credential);
  const claimed = await (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'TV', location: 'Lobby' } })).json();
  assert.equal((await call('PUT', `/api/devices/${claimed.id}/relay`, { token: patrick, json: { relay_id: null } })).status, 200);
  assert.equal((await call('PUT', `/api/devices/${claimed.id}/relay`, { token: squid, json: { relay_id: relay.id } })).status, 403);
  // Names and sites are checked.
  assert.equal((await call('POST', '/api/relays', { token: boss, json: { name: '' } })).status, 400);
  assert.equal((await call('POST', '/api/relays', { token: boss, json: { name: 'Main', site: 'Main Centre' } })).status, 409);
  assert.equal((await call('POST', '/api/relays', { token: boss, json: { name: 'Another', site: 'Qoltured' } })).status, 409);
});

test('Home Assistant’s sidebar headers are trusted only on the ingress port (D2)', async (t) => {
  const { app, call } = await startServer(t);
  const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'hairil', 'x-remote-user-display-name': 'Hairil' };
  // On the normal port (and so through Funnel), they mean nothing.
  assert.equal((await call('GET', '/api/me', { headers: { ...ha } })).status, 401);
  assert.equal((await call('GET', '/api/relays', { headers: { ...ha } })).status, 401);
  // On the ingress port, only from Home Assistant's own address.
  const ingress = createIngressServer(app, '127.0.0.1');
  await new Promise((r) => ingress.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => ingress.close(r)));
  const viaHa = await fetch(`http://127.0.0.1:${ingress.address().port}/api/relays`, { headers: ha });
  assert.equal(viaHa.status, 200);
  const other = createIngressServer(app, '10.0.0.9');
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => other.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${other.address().port}/api/relays`, { headers: ha })).status, 403);
});
