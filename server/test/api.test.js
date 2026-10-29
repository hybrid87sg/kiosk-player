// End-to-end test of the API: starts a real server on a random port with a
// throwaway data folder, then acts like the admin app and a TV player.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

let server, base, dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  const app = createApp({ dataDir, adminPassword: 'secret', maxUploadBytes: 1024 * 1024, log: () => {} });
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function call(method, url, { token, json, body, headers = {} } = {}) {
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return fetch(base + url, { method, headers, body });
}

test('full admin + player flow', async () => {
  // Wrong password is rejected, right one gives a token.
  assert.equal((await call('POST', '/api/auth/login', { json: { username: 'admin', password: 'nope' } })).status, 401);
  const login = await call('POST', '/api/auth/login', { json: { username: 'admin', password: 'secret' } });
  assert.equal(login.status, 200);
  const admin = (await login.json()).token;

  // Admin routes need the token.
  assert.equal((await call('GET', '/api/media')).status, 401);

  // Upload a "video" and an "image".
  const videoBytes = crypto.randomBytes(50_000);
  const up1 = await call('POST', '/api/media', {
    token: admin,
    body: videoBytes,
    headers: { 'content-type': 'video/mp4', 'x-filename': encodeURIComponent('Lobby promo.mp4') },
  });
  assert.equal(up1.status, 201);
  const video = await up1.json();
  assert.equal(video.type, 'video');
  assert.equal(video.filename, 'Lobby promo.mp4');
  assert.equal(video.size, videoBytes.length);
  assert.equal(video.sha256, crypto.createHash('sha256').update(videoBytes).digest('hex'));

  // Unknown MIME type falls back to the file extension.
  const up2 = await call('POST', '/api/media', {
    token: admin,
    body: crypto.randomBytes(1000),
    headers: { 'content-type': 'application/octet-stream', 'x-filename': 'menu.JPG' },
  });
  assert.equal(up2.status, 201);
  const image = await up2.json();
  assert.equal(image.type, 'image');

  // Unsupported and oversized files are refused.
  const bad = await call('POST', '/api/media', {
    token: admin, body: 'hello', headers: { 'content-type': 'text/plain', 'x-filename': 'notes.txt' },
  });
  assert.equal(bad.status, 415);
  const huge = await call('POST', '/api/media', {
    token: admin, body: crypto.randomBytes(2 * 1024 * 1024), headers: { 'content-type': 'video/mp4', 'x-filename': 'big.mp4' },
  });
  assert.equal(huge.status, 413);
  assert.equal((await (await call('GET', '/api/media', { token: admin })).json()).length, 2);

  // Save a playlist: image first (5 s), then the video.
  const put = await call('PUT', '/api/playlist', {
    token: admin,
    json: { items: [{ media_id: image.id, image_seconds: 5 }, { media_id: video.id }] },
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.deepEqual(saved.items.map((i) => i.media_id), [image.id, video.id]);
  assert.equal((await call('PUT', '/api/playlist', { token: admin, json: { items: [{ media_id: 999 }] } })).status, 400);

  // A TV registers and gets a pairing code; it can't get the playlist yet.
  const reg = await (await call('POST', '/api/player/register', { json: { app_version: '0.1.0' } })).json();
  assert.match(reg.pairing_code, /^[A-Z0-9]{6}$/);
  const tv = reg.token;
  assert.equal((await call('GET', '/api/player/playlist', { token: tv })).status, 403);
  assert.deepEqual(await (await call('GET', '/api/player/status', { token: tv })).json(), {
    claimed: false, name: null, pairing_code: reg.pairing_code,
  });

  // Admin claims it, typing the code in lower case with a dash.
  const typed = (reg.pairing_code.slice(0, 3) + '-' + reg.pairing_code.slice(3)).toLowerCase();
  assert.equal((await call('POST', '/api/devices/claim', { token: admin, json: { code: 'ZZZZZZ', name: 'x' } })).status, 404);
  const claim = await call('POST', '/api/devices/claim', { token: admin, json: { code: typed, name: 'Front window' } });
  assert.equal(claim.status, 200);
  assert.equal((await (await call('GET', '/api/player/status', { token: tv })).json()).claimed, true);

  // Now the TV gets the playlist in order.
  const pl = await (await call('GET', '/api/player/playlist', { token: tv })).json();
  assert.equal(pl.version, saved.version);
  assert.deepEqual(pl.items.map((i) => [i.id, i.type, i.duration_seconds]), [[image.id, 'image', 5], [video.id, 'video', null]]);

  // It downloads the video, and can resume part-way with a Range request.
  const full = Buffer.from(await (await call('GET', pl.items[1].url, { token: tv })).arrayBuffer());
  assert.ok(full.equals(videoBytes));
  const partial = await call('GET', pl.items[1].url, { token: tv, headers: { range: 'bytes=1000-' } });
  assert.equal(partial.status, 206);
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(videoBytes.subarray(1000)));

  // Heartbeat makes it show as online and playing the video.
  await call('POST', '/api/player/heartbeat', { token: tv, json: { current_media_id: video.id, free_bytes: 123456 } });
  const [device] = await (await call('GET', '/api/devices', { token: admin })).json();
  assert.equal(device.name, 'Front window');
  assert.equal(device.online, true);
  assert.equal(device.current_filename, 'Lobby promo.mp4');

  // Deleting a playlist file bumps the version so players re-sync.
  assert.equal((await call('DELETE', `/api/media/${image.id}`, { token: admin })).status, 200);
  const after = await (await call('GET', '/api/player/playlist', { token: tv })).json();
  assert.ok(after.version > pl.version);
  assert.deepEqual(after.items.map((i) => i.id), [video.id]);

  // Removing the device locks the TV out.
  assert.equal((await call('DELETE', `/api/devices/${device.id}`, { token: admin })).status, 200);
  assert.equal((await call('GET', '/api/player/playlist', { token: tv })).status, 401);
});
