// End-to-end tests of the API. Each test starts a real server on a random
// port with a throwaway database and the pretend Google from fake-google.js,
// then acts like the admin app and a TV player.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const BOSS = 'boss@example.com';

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  const google = createFakeGoogle();
  const app = createApp({
    dataDir, google, superadminEmail: BOSS, maxUploadBytes: 1024 * 1024, syncIntervalMs: 0, log: () => {},
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  function call(method, url, { token, json, body, headers = {} } = {}) {
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    return fetch(base + url, { method, headers, body });
  }

  async function signIn(email) {
    const res = await call('POST', '/api/auth/google', { json: { id_token: `valid:${email}` } });
    assert.equal(res.status, 200, `sign-in for ${email}`);
    return (await res.json()).token;
  }

  function upload(token, name, data, contentType = 'application/octet-stream') {
    return call('POST', '/api/media', {
      token, body: data, headers: { 'content-type': contentType, 'x-filename': encodeURIComponent(name) },
    });
  }

  return { call, signIn, upload, google };
}

test('Google sign-in: only invited emails get in, with their role', async (t) => {
  const { call, signIn } = await startServer(t);

  assert.equal((await call('POST', '/api/auth/google', { json: { id_token: 'forged' } })).status, 401);
  const stranger = await call('POST', '/api/auth/google', { json: { id_token: 'valid:stranger@example.com' } });
  assert.equal(stranger.status, 403);

  // SUPERADMIN_EMAIL is let in automatically, in any letter case.
  const boss = await signIn('Boss@Example.com');
  assert.deepEqual(await (await call('GET', '/api/me', { token: boss })).json(), { email: BOSS, role: 'superadmin' });

  // Signing out kills the token.
  await call('POST', '/api/auth/logout', { token: boss });
  assert.equal((await call('GET', '/api/me', { token: boss })).status, 401);
});

test('roles: what each role may and may not do', async (t) => {
  const { call, signIn } = await startServer(t);
  const boss = await signIn(BOSS);

  // The superadmin invites a system manager and a content uploader.
  for (const [email, role] of [['manager@example.com', 'system_manager'], ['uploader@example.com', 'content_uploader']]) {
    assert.equal((await call('POST', '/api/users', { token: boss, json: { email, role } })).status, 201);
  }
  assert.equal((await call('POST', '/api/users', { token: boss, json: { email: 'manager@example.com', role: 'superadmin' } })).status, 409);
  assert.equal((await call('POST', '/api/users', { token: boss, json: { email: 'x@example.com', role: 'king' } })).status, 400);
  const manager = await signIn('manager@example.com');
  const uploader = await signIn('uploader@example.com');

  // Everyone can work on content.
  for (const token of [boss, manager, uploader]) {
    assert.equal((await call('GET', '/api/playlist', { token })).status, 200);
  }
  // Only superadmin and system manager can manage TVs.
  assert.equal((await call('GET', '/api/devices', { token: manager })).status, 200);
  assert.equal((await call('GET', '/api/devices', { token: uploader })).status, 403);
  // Only the superadmin can manage users.
  assert.equal((await call('GET', '/api/users', { token: manager })).status, 403);
  assert.equal((await call('GET', '/api/users', { token: uploader })).status, 403);

  // Changing a role takes effect straight away, on the same session.
  const users = await (await call('GET', '/api/users', { token: boss })).json();
  const uploaderRow = users.find((u) => u.email === 'uploader@example.com');
  const bossRow = users.find((u) => u.email === BOSS);
  await call('PATCH', `/api/users/${uploaderRow.id}`, { token: boss, json: { role: 'system_manager' } });
  assert.equal((await call('GET', '/api/devices', { token: uploader })).status, 200);

  // The superadmin can't demote or remove themselves (so one always remains).
  assert.equal((await call('PATCH', `/api/users/${bossRow.id}`, { token: boss, json: { role: 'content_uploader' } })).status, 400);
  assert.equal((await call('DELETE', `/api/users/${bossRow.id}`, { token: boss })).status, 400);

  // Removing a user signs them out.
  assert.equal((await call('DELETE', `/api/users/${uploaderRow.id}`, { token: boss })).status, 200);
  assert.equal((await call('GET', '/api/playlist', { token: uploader })).status, 401);
});

test('library: Drive folder sync and file picker upload into Drive', async (t) => {
  const { call, signIn, upload, google } = await startServer(t);
  const boss = await signIn(BOSS);

  // Someone drops files into the Drive folder; only playable types appear.
  const dropped = google.addFile('Lobby promo.mp4', 'video/mp4', crypto.randomBytes(5000));
  google.addFile('notes.txt', 'text/plain', Buffer.from('hello'));
  let library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(library.items.map((m) => [m.filename, m.type]), [['Lobby promo.mp4', 'video']]);
  assert.equal(library.sync_error, null);

  // New files show up in the library but are NOT added to the playlist by themselves.
  assert.equal((await (await call('GET', '/api/playlist', { token: boss })).json()).items.length, 0);

  // The file picker upload goes into Drive and into the library.
  const imageBytes = crypto.randomBytes(2000);
  const up = await upload(boss, 'menu.JPG', imageBytes);
  assert.equal(up.status, 201);
  const image = await up.json();
  assert.equal(image.type, 'image');
  assert.equal(image.md5, crypto.createHash('md5').update(imageBytes).digest('hex'));

  // Bad types and oversized files are refused.
  assert.equal((await upload(boss, 'notes.txt', 'hi', 'text/plain')).status, 415);
  assert.equal((await upload(boss, 'big.mp4', crypto.randomBytes(2 * 1024 * 1024))).status, 413);

  // Deleting from the app sends the file to Drive's trash.
  const video = library.items[0];
  assert.equal((await call('DELETE', `/api/media/${video.id}`, { token: boss })).status, 200);
  assert.equal(google.has(dropped.id), false);

  // If Drive is unreachable, a refresh fails but the last known list is still shown.
  google.setFailing(true);
  assert.equal((await call('POST', '/api/media/sync', { token: boss })).status, 502);
  // An upload Drive refuses gets a clear error instead of hanging.
  assert.equal((await upload(boss, 'later.mp4', crypto.randomBytes(200_000), 'video/mp4')).status, 502);
  library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(library.items.map((m) => m.filename), ['menu.JPG']);
});

test('library: the app is told when Google Drive is unreachable', async (t) => {
  const { call, signIn, google } = await startServer(t);
  const boss = await signIn(BOSS);
  google.setFailing(true);
  const library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(library.items, []);
  assert.match(library.sync_error, /Google Drive/);
});

test('pairing a TV by QR code or PIN, then playing the playlist', async (t) => {
  const { call, signIn, upload, google } = await startServer(t);
  const boss = await signIn(BOSS);

  const videoBytes = crypto.randomBytes(50_000);
  const video = await (await upload(boss, 'Lobby promo.mp4', videoBytes, 'video/mp4')).json();
  const image = await (await upload(boss, 'menu.png', crypto.randomBytes(1000), 'image/png')).json();
  const saved = await (await call('PUT', '/api/playlist', {
    token: boss, json: { items: [{ media_id: image.id, image_seconds: 5 }, { media_id: video.id }] },
  })).json();
  assert.deepEqual(saved.items.map((i) => i.media_id), [image.id, video.id]);
  assert.equal((await call('PUT', '/api/playlist', { token: boss, json: { items: [{ media_id: 999 }] } })).status, 400);

  // Two TVs register. Each gets a code and a QR payload; neither can play yet.
  const tvA = await (await call('POST', '/api/player/register', { json: { app_version: '0.1.0' } })).json();
  const tvB = await (await call('POST', '/api/player/register', { json: {} })).json();
  assert.match(tvA.pairing_code, /^[A-Z0-9]{6}$/);
  assert.equal(tvA.qr_payload, `kiosk-pair:${tvA.pairing_code}`);
  assert.equal((await call('GET', '/api/player/playlist', { token: tvA.token })).status, 403);

  // TV A is paired by scanning its QR code...
  assert.equal((await call('POST', '/api/devices/claim', { token: boss, json: { code: 'kiosk-pair:ZZZZZZ', name: 'x' } })).status, 404);
  const claimA = await call('POST', '/api/devices/claim', { token: boss, json: { code: tvA.qr_payload, name: 'Front window' } });
  assert.equal(claimA.status, 200);
  // ...and TV B by typing the PIN, in lower case with a dash.
  const typed = (tvB.pairing_code.slice(0, 3) + '-' + tvB.pairing_code.slice(3)).toLowerCase();
  assert.equal((await call('POST', '/api/devices/claim', { token: boss, json: { code: typed, name: 'Back wall' } })).status, 200);
  assert.deepEqual(await (await call('GET', '/api/player/status', { token: tvA.token })).json(), {
    claimed: true, name: 'Front window', pairing_code: null, qr_payload: null,
  });

  // The TV gets the playlist in order, with md5 fingerprints to check downloads.
  const pl = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.equal(pl.version, saved.version);
  assert.deepEqual(pl.items.map((i) => [i.id, i.type, i.duration_seconds]), [[image.id, 'image', 5], [video.id, 'video', null]]);
  assert.equal(pl.items[1].md5, crypto.createHash('md5').update(videoBytes).digest('hex'));

  // It downloads the video through the server, and can resume part-way.
  const full = await call('GET', pl.items[1].url, { token: tvA.token });
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(videoBytes));
  const partial = await call('GET', pl.items[1].url, { token: tvA.token, headers: { range: 'bytes=1000-' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1000-${videoBytes.length - 1}/${videoBytes.length}`);
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(videoBytes.subarray(1000)));
  assert.equal((await call('GET', pl.items[1].url)).status, 401);

  // Heartbeat makes it show as online and playing the video.
  await call('POST', '/api/player/heartbeat', { token: tvA.token, json: { current_media_id: video.id, free_bytes: 123456 } });
  const devices = await (await call('GET', '/api/devices', { token: boss })).json();
  const front = devices.find((d) => d.name === 'Front window');
  assert.equal(front.online, true);
  assert.equal(front.current_filename, 'Lobby promo.mp4');

  // Someone replaces the video's content in Drive: after a sync the version
  // goes up and the md5 changes, so TVs know to download it again.
  const newBytes = crypto.randomBytes(40_000);
  google.replaceContent(google.findByName('Lobby promo.mp4').id, newBytes);
  await call('POST', '/api/media/sync', { token: boss });
  const changed = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.ok(changed.version > pl.version);
  assert.equal(changed.items[1].md5, crypto.createHash('md5').update(newBytes).digest('hex'));

  // Someone deletes the image straight from Drive: it leaves the playlist too.
  google.removeFile(google.findByName('menu.png').id);
  await call('POST', '/api/media/sync', { token: boss });
  const shrunk = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.ok(shrunk.version > changed.version);
  assert.deepEqual(shrunk.items.map((i) => i.id), [video.id]);

  // Removing a TV locks it out; it would register again and show a new code.
  assert.equal((await call('DELETE', `/api/devices/${front.id}`, { token: boss })).status, 200);
  assert.equal((await call('GET', '/api/player/playlist', { token: tvA.token })).status, 401);
});
