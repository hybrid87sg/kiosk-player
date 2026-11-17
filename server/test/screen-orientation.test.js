// 0.11.2: portrait displays that are already upright (e.g. Rockchip signage stands), and
// choosing any playlist for one screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-orientation-'));
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {},
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { token, json } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const boss = (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).body.token;
  const playlists = async () => {
    const { body } = await call('GET', '/api/playlists', { token: boss });
    return Array.isArray(body) ? body : body.playlists;
  };
  return { call, boss, playlists };
}

test('a portrait display that is already upright plays Portrait, and the TV is told not to turn it', async (t) => {
  const { call, boss } = await start(t);
  const tv = (await call('POST', '/api/player/register', { json: { app_version: '0.11.1', model: 'rk3568' } })).body;
  const added = await call('POST', '/api/devices/claim', {
    token: boss, json: { code: tv.pairing_code, name: 'Stand by the door', location: 'Lobby', orientation: 'portrait_right', upright: true },
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.upright, true);
  assert.equal(added.body.playlist_name, 'Portrait'); // the location's Portrait playlist
  // The TV: turn nothing (every TV app version understands "landscape").
  let list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.orientation, list.flipped, list.playlist_name], ['landscape', false, 'Portrait']);

  // An older phone app saving the screen (it sends orientation, but doesn't know "upright"): kept.
  await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { name: 'Door stand', orientation: 'portrait_right' } });
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.name, list.orientation, list.playlist_name], ['Door stand', 'landscape', 'Portrait']);

  // Turned to landscape: no longer "upright", plays Landscape.
  const flat = await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { orientation: 'landscape' } });
  assert.equal(flat.body.upright, false);
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.orientation, list.playlist_name], ['landscape', 'Landscape']);
  // "Upright" can't be set on a landscape screen.
  assert.equal((await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { upright: true } })).body.upright, false);

  // A TV box turned on its side still gets turned, as before.
  await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { orientation: 'portrait_left', upright: false } });
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.orientation, list.playlist_name], ['portrait_left', 'Portrait']);

  assert.equal((await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { upright: 'yes' } })).status, 400);
});

test('any playlist can be chosen for one screen, from its location or another; Automatic goes back', async (t) => {
  const { call, boss, playlists } = await start(t);
  const tv = (await call('POST', '/api/player/register', { json: { app_version: '0.11.1' } })).body;
  const screen = (await call('POST', '/api/devices/claim', {
    token: boss, json: { code: tv.pairing_code, name: 'Window', location: 'Lobby', orientation: 'landscape' },
  })).body;
  await call('POST', '/api/locations', { token: boss, json: { name: 'Cafe' } });
  const cafe = (await call('GET', '/api/locations', { token: boss })).body.locations.find((l) => l.name === 'Cafe');
  const special = (await call('POST', '/api/playlists', { token: boss, json: { name: 'Cafe specials', orientation: 'landscape', location_id: cafe.id } })).body;
  const all = await playlists();
  const lobbyPortrait = all.find((p) => p.auto && p.orientation === 'portrait' && p.location === 'Lobby');
  assert.ok(lobbyPortrait, 'the Lobby has its own Portrait playlist');

  const playing = async () => (await call('GET', '/api/player/playlist', { token: tv.token })).body.playlist_name;
  assert.equal(await playing(), 'Landscape');
  // This location's other-shape automatic playlist.
  let view = (await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { playlist_id: lobbyPortrait.id } })).body;
  assert.deepEqual([view.playlist_auto, view.playing_playlist_id], [false, lobbyPortrait.id]);
  assert.equal(await playing(), 'Portrait');
  // Another location's playlist.
  view = (await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { playlist_id: special.id } })).body;
  assert.equal(view.playing_playlist_id, special.id);
  assert.equal(await playing(), 'Cafe specials');
  // Back to Automatic.
  view = (await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { playlist_id: null } })).body;
  assert.equal(view.playlist_auto, true);
  assert.equal(await playing(), 'Landscape');
});
