// Upgrading a real database made by Kiosk Signage 0.6.0 (test/fixtures/kiosk-0.6.0.db,
// built with the released 0.6.0 code through its API; see kiosk-0.6.0.json for its tokens).
// Nothing may be lost, and every existing sign-in and TV must keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp } = require('../src/app');
const { SCHEMA_VERSION } = require('../src/db');
const { createFakeGoogle } = require('./fake-google');

const FIXTURE = path.join(__dirname, 'fixtures', 'kiosk-0.6.0.db');
const SECRETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kiosk-0.6.0.json'), 'utf8'));
const KEPT_TABLES = ['users', 'sessions', 'media', 'playlists', 'playlist_items', 'devices', 'locations', 'app_settings', 'renditions'];

// A copy of the fixture, so the file in the repository never changes.
function copyOfFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(FIXTURE, path.join(dir, 'kiosk.db'));
  // Sessions last 30 days from when the fixture was made; keep them fresh so this test
  // doesn't start failing next month. Nothing else about the rows changes.
  const db = new Database(path.join(dir, 'kiosk.db'));
  db.prepare(`UPDATE sessions SET created_at = ?`).run(Date.now());
  db.close();
  return dir;
}

function snapshot(dir) {
  const db = new Database(path.join(dir, 'kiosk.db'), { readonly: true });
  const rows = Object.fromEntries(KEPT_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const version = db.pragma('user_version', { simple: true });
  db.close();
  return { rows, version };
}

async function start(t, dataDir) {
  const app = createApp({ dataDir, google: createFakeGoogle(), siteName: 'Main Centre', syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {} });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { token, json, headers = {} } = {}) => fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const stop = async () => { await new Promise((r) => server.close(r)); app.locals.db.close(); };
  return { app, call, stop };
}

test('the schema version is never raised (raising it would delete the data)', () => {
  assert.equal(SCHEMA_VERSION, 3);
});

test('upgrading a 0.6.0 database keeps everything, and existing sign-ins and TVs keep working', async (t) => {
  const dir = copyOfFixture(t);
  const before = snapshot(dir);
  assert.equal(before.version, 3);
  assert.equal(before.rows.users.length, 2);
  assert.equal(before.rows.devices.length, 3);

  const first = await start(t, dir);
  const { call } = first;

  // Every row of every existing table is still there. Rows can gain new columns but keep their values.
  const db = first.app.locals.db;
  for (const table of KEPT_TABLES) {
    const now = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const ignore = table === 'app_settings' ? new Set(['relay_hmac_secret', 'relays_adopted']) : new Set();
    const kept = table === 'app_settings' ? now.filter((r) => !ignore.has(r.key)) : now;
    assert.equal(kept.length, before.rows[table].length, `${table}: row count`);
    before.rows[table].forEach((old, i) => {
      for (const [column, value] of Object.entries(old)) {
        if (table === 'devices' && ['last_seen'].includes(column)) continue; // changes when a TV checks in below
        assert.deepEqual(kept[i][column], value, `${table}.${column} of row ${i}`);
      }
    });
  }
  assert.equal(db.pragma('user_version', { simple: true }), 3);

  // Existing phone and web sessions still work, and so do the passwords.
  const me = await (await call('GET', '/api/me', { token: SECRETS.boss_session })).json();
  assert.deepEqual([me.username, me.role], ['boss', 'superadmin']);
  assert.equal((await call('GET', '/api/devices', { token: SECRETS.patrick_session })).status, 200);
  for (const [username, password] of Object.entries(SECRETS.passwords)) {
    assert.equal((await call('POST', '/api/auth/login', { json: { username, password } })).status, 200, username);
  }

  // The two sites TVs came through became relays, waiting to pair, with their TVs assigned.
  const relays = (await (await call('GET', '/api/relays', { token: SECRETS.boss_session })).json()).relays;
  assert.deepEqual(relays.map((r) => [r.name, r.site, r.status, r.players.map((p) => p.name)]), [
    ['Linsy relay', 'Linsy relay', 'pending', ['Counter']],
    ['Qoltured relay', 'Qoltured relay', 'pending', ['Cafe wall']],
  ]);
  const devices = await (await call('GET', '/api/devices', { token: SECRETS.boss_session })).json();
  assert.equal(devices.find((d) => d.name === 'Lobby').relay, null); // the main site's own TV

  // Every TV keeps working through its (still unpaired) relay, as before the upgrade.
  for (const [name, token] of Object.entries(SECRETS.tv_tokens)) {
    const site = { 'Cafe wall': 'Qoltured relay', Counter: 'Linsy relay', Lobby: null }[name];
    const headers = site ? { 'x-kiosk-site': site } : {};
    const hb = await call('POST', '/api/player/heartbeat', { token, json: { app_version: '0.5.0' }, headers });
    assert.equal(hb.status, 200, `${name} heartbeat`);
    const playlist = await (await call('GET', '/api/player/playlist', { token, headers })).json();
    assert.ok(playlist.version, `${name} playlist`);
    if (name === 'Cafe wall') assert.equal(playlist.items.length, 2); // Qoltured's Landscape, filled in 0.6.0
  }
  await first.stop();

  // Starting again changes nothing more.
  const counts = () => {
    const d = new Database(path.join(dir, 'kiosk.db'), { readonly: true });
    const c = Object.fromEntries(['relays', 'relay_player_assignments', 'relay_events', 'relay_credentials'].map((x) => [x, d.prepare(`SELECT COUNT(*) AS n FROM ${x}`).get().n]));
    d.close();
    return c;
  };
  const afterFirst = counts();
  const second = await start(t, dir);
  await second.stop();
  assert.deepEqual(counts(), afterFirst);
});
