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
const http = require('node:http');
const { createApp, createIngressServer } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const BOSS = 'boss@example.com';

async function startServer(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  const google = createFakeGoogle();
  const app = createApp({
    dataDir, google, googleWebClientId: 'web-client-123', superadminEmail: BOSS, maxUploadBytes: 1024 * 1024, syncIntervalMs: 0, log: () => {}, ...extra,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
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

  return { call, signIn, upload, google, app, base };
}

test('Google sign-in: only invited emails get in, with their role', async (t) => {
  const { call, signIn } = await startServer(t);

  // The admin app learns which Google client to sign in with.
  assert.deepEqual(await (await call('GET', '/api/config')).json(), {
    google_web_client_id: 'web-client-123', web_code_sign_in: true, version: require('../package.json').version,
  });

  assert.equal((await call('POST', '/api/auth/google', { json: { id_token: 'forged' } })).status, 401);
  const stranger = await call('POST', '/api/auth/google', { json: { id_token: 'valid:stranger@example.com' } });
  assert.equal(stranger.status, 403);

  // SUPERADMIN_EMAIL is let in automatically, in any letter case.
  const boss = await signIn('Boss@Example.com');
  assert.deepEqual(await (await call('GET', '/api/me', { token: boss })).json(), { email: BOSS, role: 'superadmin', via_home_assistant: false });

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
    assert.equal((await call('GET', '/api/playlists', { token })).status, 200);
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
  assert.equal((await call('GET', '/api/playlists', { token: uploader })).status, 401);
});

test('library: Drive folder sync, shapes, and file picker upload into Drive', async (t) => {
  const { call, signIn, upload, google } = await startServer(t);
  const boss = await signIn(BOSS);

  // Someone drops files into the Drive folder; only playable types appear,
  // and each one is sorted into landscape or portrait from its size.
  const dropped = google.addFile('Lobby promo.mp4', 'video/mp4', crypto.randomBytes(5000), { width: 3840, height: 2160 });
  google.addFile('Menu board.jpg', 'image/jpeg', crypto.randomBytes(800), { width: 1080, height: 1920 });
  google.addFile('notes.txt', 'text/plain', Buffer.from('hello'));
  let library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(
    library.items.map((m) => [m.filename, m.type, m.orientation]).sort(),
    [['Lobby promo.mp4', 'video', 'landscape'], ['Menu board.jpg', 'image', 'portrait']]
  );
  assert.equal(library.sync_error, null);

  // A brand-new video Drive hasn't measured yet shows as "still checking"
  // (orientation null) until a later sync fills it in.
  const fresh = google.addFile('Fresh upload.mp4', 'video/mp4', crypto.randomBytes(900), null);
  library = await (await call('POST', '/api/media/sync', { token: boss })).json();
  assert.equal(library.items.find((m) => m.filename === 'Fresh upload.mp4').orientation, null);
  google.setDims(fresh.id, 1080, 1920);
  library = await (await call('GET', '/api/media', { token: boss })).json(); // re-syncs because one was checking
  assert.equal(library.items.find((m) => m.filename === 'Fresh upload.mp4').orientation, 'portrait');

  // The file picker upload goes into Drive and into the library.
  const imageBytes = crypto.randomBytes(2000);
  const up = await upload(boss, 'menu.JPG', imageBytes);
  assert.equal(up.status, 201);
  const image = await up.json();
  assert.equal(image.type, 'image');
  assert.equal(image.orientation, 'landscape');
  assert.equal(image.md5, crypto.createHash('md5').update(imageBytes).digest('hex'));

  // Bad types and oversized files are refused.
  assert.equal((await upload(boss, 'notes.txt', 'hi', 'text/plain')).status, 415);
  assert.equal((await upload(boss, 'big.mp4', crypto.randomBytes(2 * 1024 * 1024))).status, 413);

  // Deleting from the app sends the file to Drive's trash.
  const video = library.items.find((m) => m.filename === 'Lobby promo.mp4');
  assert.equal((await call('DELETE', `/api/media/${video.id}`, { token: boss })).status, 200);
  assert.equal(google.has(dropped.id), false);

  // If Drive is unreachable, a refresh fails but the last known list is still shown.
  google.setFailing(true);
  assert.equal((await call('POST', '/api/media/sync', { token: boss })).status, 502);
  // An upload Drive refuses gets a clear error instead of hanging.
  assert.equal((await upload(boss, 'later.mp4', crypto.randomBytes(200_000), 'video/mp4')).status, 502);
  library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.ok(library.items.some((m) => m.filename === 'menu.JPG'));
});

test('library: the app is told when Google Drive is unreachable', async (t) => {
  const { call, signIn, google } = await startServer(t);
  const boss = await signIn(BOSS);
  google.setFailing(true);
  const library = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(library.items, []);
  assert.match(library.sync_error, /Google Drive/);
});

test('playlists: several named playlists, each landscape or portrait', async (t) => {
  const { call, signIn, upload } = await startServer(t);
  const boss = await signIn(BOSS);
  const a = await (await upload(boss, 'a.jpg', crypto.randomBytes(100), 'image/jpeg')).json();
  const b = await (await upload(boss, 'b.jpg', crypto.randomBytes(100), 'image/jpeg')).json();

  assert.equal((await call('POST', '/api/playlists', { token: boss, json: { name: '', orientation: 'landscape' } })).status, 400);
  assert.equal((await call('POST', '/api/playlists', { token: boss, json: { name: 'X', orientation: 'square' } })).status, 400);
  const lobby = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Lobby screens', orientation: 'landscape' } })).json();
  const recep = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Reception portrait', orientation: 'portrait' } })).json();
  assert.equal(lobby.item_count, 0);

  // Save items, in order; the version goes up each time.
  const saved = await (await call('PUT', `/api/playlists/${lobby.id}/items`, {
    token: boss, json: { items: [{ media_id: b.id, image_seconds: 5 }, { media_id: a.id, start_at: null, end_at: null }] },
  })).json();
  assert.deepEqual(saved.items.map((i) => [i.media_id, i.image_seconds]), [[b.id, 5], [a.id, 10]]);
  assert.ok(saved.version > lobby.version);
  assert.equal((await call('PUT', `/api/playlists/${lobby.id}/items`, { token: boss, json: { items: [{ media_id: 999 }] } })).status, 400);
  assert.equal((await call('PUT', `/api/playlists/${lobby.id}/items`, {
    token: boss, json: { items: [{ media_id: a.id, start_at: 20, end_at: 10 }] },
  })).status, 400);
  assert.equal((await call('PUT', `/api/playlists/${lobby.id}/items`, {
    token: boss, json: { items: [{ media_id: a.id, start_at: 20 }] },
  })).status, 400);

  // The same file can be in several playlists.
  await call('PUT', `/api/playlists/${recep.id}/items`, { token: boss, json: { items: [{ media_id: a.id }] } });
  const list = await (await call('GET', '/api/playlists', { token: boss })).json();
  assert.deepEqual(list.map((p) => [p.name, p.orientation, p.item_count]), [['Lobby screens', 'landscape', 2], ['Reception portrait', 'portrait', 1]]);

  // Rename and change shape.
  const renamed = await (await call('PATCH', `/api/playlists/${recep.id}`, { token: boss, json: { name: 'Reception' } })).json();
  assert.equal(renamed.name, 'Reception');
  assert.equal(renamed.orientation, 'portrait');

  // Deleting a file takes it out of every playlist.
  await call('DELETE', `/api/media/${a.id}`, { token: boss });
  const after = await (await call('GET', `/api/playlists/${lobby.id}`, { token: boss })).json();
  assert.deepEqual(after.items.map((i) => i.media_id), [b.id]);
  assert.equal((await (await call('GET', `/api/playlists/${recep.id}`, { token: boss })).json()).item_count, 0);

  // An unused playlist can be deleted.
  assert.equal((await call('DELETE', `/api/playlists/${recep.id}`, { token: boss })).status, 200);
  assert.equal((await call('GET', `/api/playlists/${recep.id}`, { token: boss })).status, 404);
});

test('playlist item play dates are saved and only active files are sent to players', async (t) => {
  const { call, signIn, upload } = await startServer(t);
  const boss = await signIn(BOSS);
  const file = await (await upload(boss, 'scheduled.jpg', crypto.randomBytes(100), 'image/jpeg')).json();
  const playlist = await (await call('POST', '/api/playlists', {
    token: boss, json: { name: 'Scheduled', orientation: 'landscape' },
  })).json();
  const now = Date.now();
  const dates = {
    upcoming: { start_at: now + 60 * 60 * 1000, end_at: now + 2 * 60 * 60 * 1000 },
    active: { start_at: now - 60 * 60 * 1000, end_at: now + 60 * 60 * 1000 },
    expired: { start_at: now - 2 * 60 * 60 * 1000, end_at: now - 60 * 60 * 1000 },
  };
  const saved = await call('PUT', `/api/playlists/${playlist.id}/items`, {
    token: boss,
    json: { items: Object.values(dates).map((range) => ({ media_id: file.id, ...range })) },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).items.map(({ start_at, end_at }) => [start_at, end_at]), [
    [dates.upcoming.start_at, dates.upcoming.end_at],
    [dates.active.start_at, dates.active.end_at],
    [dates.expired.start_at, dates.expired.end_at],
  ]);

  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', {
    token: boss, json: { code: tv.pairing_code, name: 'Scheduled TV', playlist_id: playlist.id },
  });
  const playerPlaylist = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.equal(playerPlaylist.items.length, 1);
  assert.equal(playerPlaylist.items[0].id, file.id);
  assert.ok(playerPlaylist.version.endsWith('.1'));
});

test('pairing a TV by QR code or PIN, setting it up, then playing its playlist', async (t) => {
  const { call, signIn, upload, google } = await startServer(t);
  const boss = await signIn(BOSS);

  const videoBytes = crypto.randomBytes(50_000);
  const video = await (await upload(boss, 'Lobby promo.mp4', videoBytes, 'video/mp4')).json();
  const image = await (await upload(boss, 'menu.png', crypto.randomBytes(1000), 'image/png')).json();
  const lobby = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Lobby screens', orientation: 'landscape' } })).json();
  const recep = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Reception', orientation: 'portrait' } })).json();
  await call('PUT', `/api/playlists/${lobby.id}/items`, {
    token: boss, json: { items: [{ media_id: image.id, image_seconds: 5 }, { media_id: video.id }] },
  });
  await call('PUT', `/api/playlists/${recep.id}/items`, { token: boss, json: { items: [{ media_id: image.id }] } });

  // Two TVs register. Each gets a code and a QR payload; neither can play yet.
  const tvA = await (await call('POST', '/api/player/register', { json: { app_version: '0.1.0' } })).json();
  const tvB = await (await call('POST', '/api/player/register', { json: {} })).json();
  assert.match(tvA.pairing_code, /^[A-Z0-9]{6}$/);
  assert.equal(tvA.qr_payload, `kiosk-pair:${tvA.pairing_code}`);
  assert.equal((await call('GET', '/api/player/playlist', { token: tvA.token })).status, 403);

  // TV A is paired by scanning its QR code and set up as a landscape lobby screen...
  assert.equal((await call('POST', '/api/devices/claim', { token: boss, json: { code: 'kiosk-pair:ZZZZZZ', name: 'x' } })).status, 404);
  assert.equal((await call('POST', '/api/devices/claim', { token: boss, json: { code: tvA.qr_payload, name: 'Front', orientation: 'upside' } })).status, 400);
  const claimA = await call('POST', '/api/devices/claim', {
    token: boss, json: { code: tvA.qr_payload, name: 'Front window', location: 'Main lobby', orientation: 'landscape', playlist_id: lobby.id },
  });
  assert.equal(claimA.status, 200);
  const front = await claimA.json();
  assert.deepEqual([front.location, front.orientation, front.playlist_name], ['Main lobby', 'landscape', 'Lobby screens']);
  // ...and TV B by typing the PIN, in lower case with a dash, as a portrait reception screen.
  const typed = (tvB.pairing_code.slice(0, 3) + '-' + tvB.pairing_code.slice(3)).toLowerCase();
  const claimB = await call('POST', '/api/devices/claim', {
    token: boss, json: { code: typed, name: 'Reception', location: 'Branch office', orientation: 'portrait_right', playlist_id: recep.id },
  });
  assert.equal(claimB.status, 200);
  assert.deepEqual(await (await call('GET', '/api/player/status', { token: tvA.token })).json(), {
    claimed: true, name: 'Front window', pairing_code: null, qr_payload: null,
  });

  // Each TV gets its own playlist and how to turn the picture.
  const plA = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.equal(plA.orientation, 'landscape');
  assert.equal(plA.playlist_name, 'Lobby screens');
  assert.deepEqual(plA.items.map((i) => [i.id, i.type, i.duration_seconds]), [[image.id, 'image', 5], [video.id, 'video', null]]);
  assert.equal(plA.items[1].md5, crypto.createHash('md5').update(videoBytes).digest('hex'));
  const plB = await (await call('GET', '/api/player/playlist', { token: tvB.token })).json();
  assert.equal(plB.orientation, 'portrait_right');
  assert.deepEqual(plB.items.map((i) => i.id), [image.id]);

  // A playlist in use can't be deleted.
  const blocked = await call('DELETE', `/api/playlists/${recep.id}`, { token: boss });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Reception/);

  // The TV downloads the video through the server, and can resume part-way.
  const full = await call('GET', plA.items[1].url, { token: tvA.token });
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(videoBytes));
  const partial = await call('GET', plA.items[1].url, { token: tvA.token, headers: { range: 'bytes=1000-' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1000-${videoBytes.length - 1}/${videoBytes.length}`);
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(videoBytes.subarray(1000)));
  assert.equal((await call('GET', plA.items[1].url)).status, 401);

  // Heartbeat makes it show as online and playing the video; the reply carries the version.
  const beat = await (await call('POST', '/api/player/heartbeat', { token: tvA.token, json: { current_media_id: video.id, free_bytes: 123456 } })).json();
  assert.equal(beat.version, plA.version);
  const devices = await (await call('GET', '/api/devices', { token: boss })).json();
  const frontRow = devices.find((d) => d.name === 'Front window');
  assert.equal(frontRow.online, true);
  assert.equal(frontRow.current_filename, 'Lobby promo.mp4');

  // Moving TV A to the other playlist (and turning it portrait) changes its version.
  await call('PATCH', `/api/devices/${frontRow.id}`, { token: boss, json: { playlist_id: recep.id, orientation: 'portrait_left' } });
  const moved = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.notEqual(moved.version, plA.version);
  assert.equal(moved.orientation, 'portrait_left');
  assert.deepEqual(moved.items.map((i) => i.id), [image.id]);
  assert.equal((await call('PATCH', `/api/devices/${frontRow.id}`, { token: boss, json: { playlist_id: 999 } })).status, 400);

  // Someone replaces the image's content in Drive: after a sync the version
  // changes and the md5 changes, so TVs know to download it again.
  const newBytes = crypto.randomBytes(1200);
  google.replaceContent(google.findByName('menu.png').id, newBytes);
  await call('POST', '/api/media/sync', { token: boss });
  const changed = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.notEqual(changed.version, moved.version);
  assert.equal(changed.items[0].md5, crypto.createHash('md5').update(newBytes).digest('hex'));

  // Someone deletes the image straight from Drive: it leaves the playlist too.
  google.removeFile(google.findByName('menu.png').id);
  await call('POST', '/api/media/sync', { token: boss });
  const empty = await (await call('GET', '/api/player/playlist', { token: tvA.token })).json();
  assert.deepEqual(empty.items, []);

  // Removing a TV locks it out; it would register again and show a new code.
  assert.equal((await call('DELETE', `/api/devices/${frontRow.id}`, { token: boss })).status, 200);
  assert.equal((await call('GET', '/api/player/playlist', { token: tvA.token })).status, 401);
});

test('media cache: the first download comes from Drive, later ones from the local copy', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { call, signIn, upload, google } = await startServer(t, { mediaCacheDir: cacheDir });
  const boss = await signIn(BOSS);
  const bytes = crypto.randomBytes(80_000);
  const video = await (await upload(boss, 'promo.mp4', bytes, 'video/mp4')).json();
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'TV' } });

  const first = await call('GET', `/media/${video.id}`, { token: tv.token });
  assert.ok(Buffer.from(await first.arrayBuffer()).equals(bytes));
  assert.equal(google.downloadCount(), 1);

  // Second TV download, and a resumed (Range) one: both from the local copy.
  const second = await call('GET', `/media/${video.id}`, { token: tv.token });
  assert.ok(Buffer.from(await second.arrayBuffer()).equals(bytes));
  const part = await call('GET', `/media/${video.id}`, { token: tv.token, headers: { range: 'bytes=5000-' } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(5000)));
  assert.equal(google.downloadCount(), 1);

  // Deleting the file removes its local copy too.
  assert.equal(fs.readdirSync(cacheDir).length, 1);
  await call('DELETE', `/api/media/${video.id}`, { token: boss });
  assert.equal(fs.readdirSync(cacheDir).length, 0);
});

test('web page sign-in with a code from google.com/device', async (t) => {
  const { call, google } = await startServer(t);
  const start = await (await call('POST', '/api/auth/device/start')).json();
  assert.equal(start.user_code, 'ABCD-EFGH');
  assert.equal(start.verification_url, 'https://www.google.com/device');

  // Until the person enters the code, the page keeps waiting.
  assert.deepEqual(await (await call('POST', '/api/auth/device/poll', { json: { poll_id: start.poll_id } })).json(), { status: 'pending' });

  // Someone who isn't invited is turned away.
  google.approveDeviceSignIn('stranger@example.com');
  assert.equal((await call('POST', '/api/auth/device/poll', { json: { poll_id: start.poll_id } })).status, 403);

  // An invited person gets a session, and the code can't be reused.
  const again = await (await call('POST', '/api/auth/device/start')).json();
  google.approveDeviceSignIn(BOSS);
  const done = await (await call('POST', '/api/auth/device/poll', { json: { poll_id: again.poll_id } })).json();
  assert.equal(done.status, 'done');
  assert.equal(done.role, 'superadmin');
  assert.equal((await call('GET', '/api/me', { token: done.token })).status, 200);
  assert.equal((await call('POST', '/api/auth/device/poll', { json: { poll_id: again.poll_id } })).status, 410);
});

test('Home Assistant sidebar: trusted only on the ingress port, from Home Assistant', async (t) => {
  const { app, base, call } = await startServer(t);
  const ingress = createIngressServer(app, '127.0.0.1');
  await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve));
  t.after(() => ingress.close());
  const ingressBase = `http://127.0.0.1:${ingress.address().port}`;
  const haHeaders = { 'x-remote-user-id': 'abc123', 'x-remote-user-name': 'hairil', 'x-remote-user-display-name': 'Hairil' };

  // Through the ingress port, the Home Assistant user is a superadmin.
  const me = await (await fetch(`${ingressBase}/api/me`, { headers: haHeaders })).json();
  assert.deepEqual(me, { email: 'Hairil', role: 'superadmin', via_home_assistant: true });
  assert.equal((await fetch(`${ingressBase}/api/users`, { headers: haHeaders })).status, 200);
  // The same page is served there too.
  assert.match(await (await fetch(`${ingressBase}/`)).text(), /Kiosk Signage/);

  // On the normal port, the same headers mean nothing.
  assert.equal((await fetch(`${base}/api/me`, { headers: haHeaders })).status, 401);

  // From anywhere other than Home Assistant, the ingress port says no.
  const outsider = createIngressServer(app, '10.9.9.9');
  await new Promise((resolve) => outsider.listen(0, '127.0.0.1', resolve));
  t.after(() => outsider.close());
  assert.equal((await fetch(`http://127.0.0.1:${outsider.address().port}/api/me`, { headers: haHeaders })).status, 403);
  void call;
});

test('settings page: Drive folder, cache switch, connection test, download progress', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { call, signIn, upload, google } = await startServer(t, { mediaCacheDir: cacheDir });
  const boss = await signIn(BOSS);

  // Only superadmins see settings.
  await call('POST', '/api/users', { token: boss, json: { email: 'manager@example.com', role: 'system_manager' } });
  const manager = await signIn('manager@example.com');
  assert.equal((await call('GET', '/api/settings', { token: manager })).status, 403);

  let settings = await (await call('GET', '/api/settings', { token: boss })).json();
  assert.equal(settings.drive_folder_id, 'folder-original');
  assert.deepEqual(settings.cache, { available: true, enabled: true, files: 0, bytes: 0 });
  assert.deepEqual(settings.sign_in, { phone_app: true, web_code: true });

  // Change the Drive folder from the web page.
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { drive_folder_id: 'x' } })).status, 400);
  settings = await (await call('PATCH', '/api/settings', { token: boss, json: { drive_folder_id: '0AbCdEfGhIjKlMnOpQ' } })).json();
  assert.equal(settings.drive_folder_id, '0AbCdEfGhIjKlMnOpQ');
  assert.equal(google.getFolderId(), '0AbCdEfGhIjKlMnOpQ');
  assert.equal(settings.drive_folder_changed_on_web, true);

  // Test the connection.
  google.addFile('a.jpg', 'image/jpeg', crypto.randomBytes(10));
  assert.deepEqual(await (await call('POST', '/api/settings/test-drive', { token: boss })).json(), { ok: true, files: 1 });
  google.setFailing(true);
  assert.equal((await call('POST', '/api/settings/test-drive', { token: boss })).status, 502);
  google.setFailing(false);

  // Cache: a download fills it; switching it off stops using it; clearing empties it.
  const bytes = crypto.randomBytes(5000);
  const video = await (await upload(boss, 'v.mp4', bytes, 'video/mp4')).json();
  await (await call('GET', `/media/${video.id}`, { token: boss })).arrayBuffer();
  settings = await (await call('GET', '/api/settings', { token: boss })).json();
  assert.equal(settings.cache.files, 1);
  await call('PATCH', '/api/settings', { token: boss, json: { cache_media: false } });
  const before = google.downloadCount();
  await (await call('GET', `/media/${video.id}`, { token: boss })).arrayBuffer();
  assert.equal(google.downloadCount(), before + 1); // fetched from Drive again
  settings = await (await call('POST', '/api/settings/clear-cache', { token: boss })).json();
  assert.equal(settings.cache.files, 0);

  // A TV reports download progress in its heartbeat; the screen overview shows it.
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'TV' } });
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { download_done: 1, download_total: 3 } });
  let [device] = await (await call('GET', '/api/devices', { token: boss })).json();
  assert.deepEqual(device.download, { done: 1, total: 3 });
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: {} });
  [device] = await (await call('GET', '/api/devices', { token: boss })).json();
  assert.equal(device.download, null);

  const withTranscode = await (await call('GET', '/api/settings', { token: boss })).json();
  assert.equal(typeof withTranscode.transcode.ffmpeg, 'boolean');
  assert.equal(withTranscode.transcode.enabled, false);
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { transcode_videos: 'yes' } })).status, 400);
});

test('playback copies: weak TVs get 1080p, capable ones get 4K, the original stays put', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-renditions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const probe = {
    video: {
      codec: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160,
      pixFmt: 'yuv420p10le', fps: 60, variableFrameRate: false,
    },
    audio: { codec: 'ac3', channels: 6, profile: null },
  };
  const { call, signIn, upload, google } = await startServer(t, {
    transcode: {
      enabled: true,
      hevc4k: true,
      inline: true,
      dir,
      probe: async () => probe,
      run: async (args) => {
        calls.push(args);
        const output = args[args.length - 1];
        const profile = output.includes('hevc_2160') ? 'hevc_2160' : output.includes('h264_720') ? 'h264_720' : 'h264_1080';
        fs.writeFileSync(output, Buffer.from(`rendition:${profile}`));
      },
    },
  });
  const boss = await signIn(BOSS);
  const bytes = crypto.randomBytes(4000);
  const video = await (await upload(boss, 'Lobby promo.mp4', bytes, 'video/mp4')).json();
  assert.equal(video.playback_warning, null);
  assert.equal(google.findByName('Lobby promo.mp4').data.equals(bytes), true);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.src-')), false);

  const flat = calls.flat().map(String);
  assert.ok(flat.includes('libx264') && flat.includes('4.1') && flat.includes('yuv420p') && flat.includes('+faststart'));
  assert.ok(flat.includes('3.1') && flat.includes('libx265') && flat.includes('hvc1'));
  assert.ok(!flat.some((arg) => arg.includes('10le') || arg.includes('main10')));

  const playlist = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Lobby', orientation: 'landscape' } })).json();
  await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: video.id }] } });

  async function claim(name) {
    const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
    await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name, playlist_id: playlist.id } });
    return tv;
  }

  const oldTv = await claim('Old box');
  const oldList = await (await call('GET', '/api/player/playlist', { token: oldTv.token })).json();
  assert.equal(oldList.items[0].rendition, 'h264_1080');
  assert.equal(oldList.items[0].url, `/media/${video.id}?rendition=h264_1080`);
  const copy = Buffer.from(await (await call('GET', oldList.items[0].url, { token: oldTv.token })).arrayBuffer());
  assert.equal(copy.toString(), 'rendition:h264_1080');
  assert.notEqual(oldList.items[0].md5, video.md5);
  const original = Buffer.from(await (await call('GET', `/media/${video.id}`, { token: oldTv.token })).arrayBuffer());
  assert.ok(original.equals(bytes));
  const partial = await call('GET', oldList.items[0].url, { token: oldTv.token, headers: { range: 'bytes=0-4' } });
  assert.equal(partial.status, 206);
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), 'rendi');

  const capable = await claim('4K box');
  await call('POST', '/api/player/heartbeat', {
    token: capable.token,
    json: {
      decoders: {
        display_width: 3840, display_height: 2160, h264_level: 51,
        h264_max_long: 3840, h264_max_short: 2160, hevc: true, hevc_max_long: 3840, hevc_max_short: 2160,
      },
    },
  });
  const hevcList = await (await call('GET', '/api/player/playlist', { token: capable.token })).json();
  assert.equal(hevcList.items[0].rendition, 'hevc_2160');
  assert.notEqual(hevcList.version, oldList.version);

  const weak = await claim('720 box');
  await call('POST', '/api/player/heartbeat', {
    token: weak.token,
    json: { decoders: { display_width: 1280, display_height: 720, h264_level: 31, h264_max_long: 1280, h264_max_short: 720, hevc: false } },
  });
  const smallList = await (await call('GET', '/api/player/playlist', { token: weak.token })).json();
  assert.equal(smallList.items[0].rendition, 'h264_720');

  await call('POST', '/api/player/heartbeat', { token: weak.token, json: { playback_error: 'Lobby promo.mp4: decoder failed' } });
  let [device] = (await (await call('GET', '/api/devices', { token: boss })).json()).filter((d) => d.name === '720 box');
  assert.equal(device.playback_error, 'Lobby promo.mp4: decoder failed');
  assert.equal(device.decoders.h264_level, 31);
  assert.equal(device.decoders.display_width, 1280);
  await call('POST', '/api/player/heartbeat', { token: weak.token, json: { playback_error: '' } });
  [device] = (await (await call('GET', '/api/devices', { token: boss })).json()).filter((d) => d.name === '720 box');
  assert.equal(device.playback_error, null);

  await call('DELETE', `/api/media/${video.id}`, { token: boss });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('library warns about a video weak boxes may not play while copies are off', async (t) => {
  const { call, signIn, upload, google } = await startServer(t);
  const boss = await signIn(BOSS);
  google.setUploadDims({ width: 1920, height: 1080 });
  const small = await (await upload(boss, 'ok.mp4', crypto.randomBytes(200), 'video/mp4')).json();
  assert.equal(small.playback_warning, null);
  google.setUploadDims({ width: 3840, height: 2160 });
  const big = await (await upload(boss, 'huge.mp4', crypto.randomBytes(200), 'video/mp4')).json();
  assert.match(big.playback_warning, /turned off/);
  assert.match(big.playback_warning, /3840×2160/);
});
