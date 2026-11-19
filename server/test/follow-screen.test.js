// 0.12.1: "Automatic: follow this screen". The TV app lets Android turn the screen (its rotation
// sensor, or Android's own setting); the playlist's shape follows the size the screen reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-follow-'));
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
  const view = async (id) => (await call('GET', '/api/devices', { token: boss })).body.find((d) => d.id === id);
  return { call, boss, view };
}

const screen = (width, height) => ({ display_width: width, display_height: height });

test('a screen that follows itself plays the playlist for the shape it reports, and switches when turned', async (t) => {
  const { call, boss, view } = await start(t);
  // A tall stand: Android reports 1080×1920.
  const tv = (await call('POST', '/api/player/register', { json: { app_version: '0.12.1', model: 'rk3568', decoders: screen(1080, 1920) } })).body;
  const waiting = (await call('GET', '/api/devices/waiting', { token: boss })).body[0];
  assert.deepEqual([waiting.can_follow_device, waiting.reported_shape], [true, 'portrait']);
  const added = await call('POST', '/api/devices/claim', {
    token: boss, json: { code: tv.pairing_code, name: 'Door stand', location: 'Lobby', orientation: 'landscape', follow_device: true },
  });
  assert.equal(added.status, 200);
  assert.deepEqual([added.body.follow_device, added.body.screen_shape, added.body.playlist_name], [true, 'portrait', 'Portrait']);
  // The TV is told to follow the screen and to turn nothing itself.
  let list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.follow_device, list.orientation, list.flipped, list.playlist_name], [true, 'landscape', false, 'Portrait']);
  // The Portrait playlist lists it among its screens.
  const playlists = (await call('GET', '/api/playlists', { token: boss })).body;
  const all = Array.isArray(playlists) ? playlists : playlists.playlists;
  const portrait = all.find((p) => p.auto && p.orientation === 'portrait' && p.location === 'Lobby');
  assert.deepEqual(portrait.devices.map((d) => d.name), ['Door stand']);

  // Someone turns it on its side; it reports 1920×1080 and gets the Landscape playlist.
  const before = list.version;
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.12.1', decoders: screen(1920, 1080), rotation_sensor: true } });
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.equal(list.playlist_name, 'Landscape');
  assert.notEqual(list.version, before);
  const v = await view(added.body.id);
  assert.deepEqual([v.screen_shape, v.rotation_sensor], ['landscape', true]);

  // Choosing a fixed mounting again stops following.
  await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { orientation: 'portrait_right', follow_device: false } });
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.deepEqual([list.follow_device, list.orientation, list.playlist_name], [false, 'portrait_right', 'Portrait']);
  assert.equal((await call('PATCH', `/api/devices/${added.body.id}`, { token: boss, json: { follow_device: 'yes' } })).status, 400);
});

test('screens that can’t follow themselves are marked so the dashboard greys the choice out', async (t) => {
  const { call, boss } = await start(t);
  const older = (await call('POST', '/api/player/register', { json: { app_version: '0.12.0', decoders: screen(1920, 1080) } })).body;
  const silent = (await call('POST', '/api/player/register', { json: { app_version: '0.12.1' } })).body;
  const pc = (await call('POST', '/api/player/register', { json: { kind: 'browser', app_version: '0.12.1' } })).body;
  const waiting = (await call('GET', '/api/devices/waiting', { token: boss })).body;
  const byCode = (code) => waiting.find((w) => w.pairing_code === code);
  assert.equal(byCode(older.pairing_code).can_follow_device, false, 'an older TV app');
  assert.equal(byCode(silent.pairing_code).can_follow_device, false, 'no screen size reported yet');
  assert.equal(byCode(pc.pairing_code).can_follow_device, false, 'Windows: turned in Windows itself');
  // Even if asked, an older app just keeps its mounting; the server falls back to it for the shape.
  const added = (await call('POST', '/api/devices/claim', {
    token: boss, json: { code: silent.pairing_code, name: 'Box', location: 'Lobby', orientation: 'portrait_left', follow_device: true },
  })).body;
  assert.equal(added.screen_shape, 'portrait');
});
