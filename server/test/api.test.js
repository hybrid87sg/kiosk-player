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
const { createRelay } = require('../src/relay');
const { createFakeGoogle } = require('./fake-google');

const BOSS = 'boss@example.com';

// A downloaded file's local copy is saved just after its last byte goes out,
// so a test that checks for the copy waits a moment for it.
async function untilCopied(dir, count = 1) {
  for (let i = 0; i < 200; i++) {
    if (fs.readdirSync(dir).filter((name) => !name.includes('.part-')).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No local copy appeared in ${dir}`);
}

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
  const config = await (await call('GET', '/api/config')).json();
  assert.match(config.server_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(config, {
    google_web_client_id: 'web-client-123', web_code_sign_in: true, version: require('../package.json').version,
    kind: 'kiosk-signage', role: 'main', server_id: config.server_id, site_name: null,
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

  // "Remove from Kiosk" leaves Google Drive alone, and the next sync doesn't bring it back.
  const video = library.items.find((m) => m.filename === 'Lobby promo.mp4');
  assert.equal((await call('DELETE', `/api/media/${video.id}`, { token: boss })).status, 200);
  assert.equal(google.has(dropped.id), true);
  const afterRemove = await (await call('POST', '/api/media/sync', { token: boss })).json();
  assert.equal(afterRemove.items.some((m) => m.id === video.id), false);
  assert.deepEqual(afterRemove.removed.map((m) => [m.id, m.removed_reason]), [[video.id, 'removed']]);

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
  await untilCopied(cacheDir);

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
  await untilCopied(cacheDir);
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
});

test('new TVs wait on a list, so they can be added without typing their code', async (t) => {
  const { call, signIn, app } = await startServer(t, { siteName: 'Head office' });
  const boss = await signIn(BOSS);
  await call('POST', '/api/users', { token: boss, json: { email: 'up@example.com', role: 'content_uploader' } });
  const uploader = await signIn('up@example.com');

  // The server ID stays the same, so a TV can recognise its server after an address change.
  const id = (await (await call('GET', '/api/config')).json()).server_id;
  assert.equal((await (await call('GET', '/api/config')).json()).server_id, id);

  const tv = await (await call('POST', '/api/player/register', { json: { app_version: '0.4.0', model: '  Xiaomi MIBOX4  ' } })).json();
  const waiting = await (await call('GET', '/api/devices/waiting', { token: boss })).json();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].model, 'Xiaomi MIBOX4');
  assert.equal(waiting[0].site, 'Head office');
  assert.equal(waiting[0].pairing_code, tv.pairing_code);
  assert.equal((await call('GET', '/api/devices/waiting', { token: uploader })).status, 403);

  // Adding it (the "Add" button sends the code) takes it off the list.
  const added = await (await call('POST', '/api/devices/claim', {
    token: boss, json: { code: waiting[0].pairing_code, name: 'Lobby TV' },
  })).json();
  assert.equal(added.site, 'Head office');
  assert.equal(added.model, 'Xiaomi MIBOX4');
  assert.deepEqual(await (await call('GET', '/api/devices/waiting', { token: boss })).json(), []);

  // A TV that stopped asking drops off the list, and is forgotten after a day.
  const old = await (await call('POST', '/api/player/register', { json: {} })).json();
  app.locals.db.prepare(`UPDATE devices SET last_seen = ?, created_at = ? WHERE token = ?`)
    .run(Date.now() - 20 * 60 * 1000, Date.now() - 20 * 60 * 1000, old.token);
  assert.deepEqual(await (await call('GET', '/api/devices/waiting', { token: boss })).json(), []);
  assert.equal((await call('GET', '/api/player/status', { token: old.token })).status, 200);
  assert.equal((await (await call('GET', '/api/devices/waiting', { token: boss })).json()).length, 1);
  app.locals.db.prepare(`UPDATE devices SET last_seen = ?, created_at = ? WHERE token = ?`)
    .run(Date.now() - 25 * 60 * 60 * 1000, Date.now() - 25 * 60 * 60 * 1000, old.token);
  await call('GET', '/api/devices/waiting', { token: boss });
  assert.equal((await call('GET', '/api/player/status', { token: old.token })).status, 401);
});

test('another site: TVs reach the main server through a relay that keeps copies of files', async (t) => {
  const { call, signIn, upload, google, base } = await startServer(t, { siteName: 'Head office' });
  const boss = await signIn(BOSS);

  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-relay-'));
  const relayApp = createRelay({ mainUrl: base, siteName: 'Orchard branch', dataDir: relayDir, log: () => {}, pruneIntervalMs: 0 });
  const relayServer = await new Promise((resolve) => {
    const s = relayApp.listen(0, () => resolve(s));
  });
  t.after(async () => {
    await new Promise((resolve) => relayServer.close(resolve));
    fs.rmSync(relayDir, { recursive: true, force: true });
  });
  const relay = `http://127.0.0.1:${relayServer.address().port}`;
  const viaRelay = (url, { token, json, headers = {} } = {}) => {
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    return fetch(relay + url, { method: json !== undefined ? 'POST' : 'GET', headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  };

  // TVs find the relay just like a main server, and it says which site it is.
  const config = await (await viaRelay('/api/config')).json();
  assert.equal(config.kind, 'kiosk-signage');
  assert.equal(config.role, 'relay');
  assert.equal(config.site_name, 'Orchard branch');

  // A TV at the branch registers through the relay and waits on the main server's list.
  const tv = await (await viaRelay('/api/player/register', { json: { model: 'Branch box' } })).json();
  const [waiting] = await (await call('GET', '/api/devices/waiting', { token: boss })).json();
  assert.equal(waiting.site, 'Orchard branch');

  const data = crypto.randomBytes(5000);
  const media = await (await upload(boss, 'promo.jpg', data, 'image/jpeg')).json();
  const playlist = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Branch', orientation: 'landscape' } })).json();
  await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: media.id }] } });
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Branch TV', playlist_id: playlist.id } });

  const list = await (await viaRelay('/api/player/playlist', { token: tv.token })).json();
  assert.equal(list.items.length, 1);
  const [screen] = await (await call('GET', '/api/devices', { token: boss })).json();
  assert.equal(screen.site, 'Orchard branch');

  // The first download goes to the main server; later ones (and resumed
  // ones) come from the relay's own copy.
  const before = google.downloadCount();
  const first = await viaRelay(list.items[0].url, { token: tv.token });
  assert.equal(first.status, 200);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), data);
  await relayApp.locals.waitForCopies();
  await untilCopied(path.join(relayDir, 'media-cache'));
  const again = await viaRelay(list.items[0].url, { token: tv.token });
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), data);
  const part = await viaRelay(list.items[0].url, { token: tv.token, headers: { range: 'bytes=4000-' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), data.subarray(4000));
  assert.equal(google.downloadCount() - before, 1);

  // Heartbeats keep the site, and the status page knows the TV.
  await viaRelay('/api/player/heartbeat', { token: tv.token, json: { app_version: '0.4.0' } });
  const status = await (await viaRelay('/api/relay/status')).json();
  assert.equal(status.main.reachable, true);
  assert.equal(status.tvs_seen, 1);
  assert.equal(status.cache.files, 1);

  // Files are only for real, paired TVs.
  assert.equal((await viaRelay(list.items[0].url, { token: 'made-up' })).status, 401);
  assert.equal((await viaRelay(list.items[0].url)).status, 401);
});

test('file expiry: an expired file leaves Kiosk and every screen, but stays in Google Drive', async (t) => {
  const { call, signIn, upload, google, app } = await startServer(t);
  const boss = await signIn(BOSS);
  await call('POST', '/api/users', { token: boss, json: { email: 'up@example.com', role: 'content_uploader' } });
  const uploader = await signIn('up@example.com');
  const inAWeek = Date.now() + 7 * 24 * 60 * 60 * 1000;

  // An expiry can be chosen while uploading, or set later (also by content uploaders).
  const offer = await (await upload(boss, 'offer.jpg', crypto.randomBytes(300), 'image/jpeg')).json();
  const promo = await (await call('POST', '/api/media', {
    token: boss, body: crypto.randomBytes(400), headers: { 'content-type': 'image/jpeg', 'x-filename': 'promo.jpg', 'x-expires-at': String(inAWeek) },
  })).json();
  assert.equal(promo.expires_at, inAWeek);
  const set = await call('PATCH', `/api/media/${offer.id}`, { token: uploader, json: { expires_at: inAWeek } });
  assert.equal((await set.json()).expires_at, inAWeek);
  assert.equal((await call('PATCH', `/api/media/${offer.id}`, { token: boss, json: { expires_at: Date.now() - 1000 } })).status, 400);
  assert.equal((await call('PATCH', `/api/media/${offer.id}`, { token: boss, json: { expires_at: 'soon' } })).status, 400);

  // Both files play on a TV.
  const playlist = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Lobby', orientation: 'landscape' } })).json();
  await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: offer.id }, { media_id: promo.id }] } });
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Lobby TV', playlist_id: playlist.id } });
  const before = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.deepEqual(before.items.map((i) => i.id), [offer.id, promo.id]);

  // The offer's date passes (pretend time moved on).
  app.locals.db.prepare(`UPDATE media SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, offer.id);
  const beat = await (await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.4.0' } })).json();
  assert.notEqual(beat.version, before.version); // the TV knows to update
  const after = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.deepEqual(after.items.map((i) => i.id), [promo.id]);
  assert.equal((await call('GET', `/media/${offer.id}`, { token: tv.token })).status, 404);
  assert.deepEqual((await (await call('GET', `/api/playlists/${playlist.id}`, { token: boss })).json()).items.map((i) => i.media_id), [promo.id]);

  // It's in "Expired and removed", Drive still has it, and syncing doesn't bring it back.
  const library = await (await call('POST', '/api/media/sync', { token: boss })).json();
  assert.deepEqual(library.items.map((m) => m.id), [promo.id]);
  assert.deepEqual(library.removed.map((m) => [m.id, m.removed_reason]), [[offer.id, 'expired']]);
  assert.equal(google.has(google.findByName('offer.jpg').id), true);
  assert.equal((await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: offer.id }] } })).status, 400);

  // Restoring needs a new date (or none), and brings it back to the library only.
  assert.equal((await call('POST', `/api/media/${offer.id}/restore`, { token: boss, json: { expires_at: Date.now() - 5 } })).status, 400);
  const restored = await (await call('POST', `/api/media/${offer.id}/restore`, { token: boss, json: { expires_at: null } })).json();
  assert.equal(restored.expires_at, null);
  const back = await (await call('GET', '/api/media', { token: boss })).json();
  assert.deepEqual(back.items.map((m) => m.id).sort(), [offer.id, promo.id].sort());
  assert.deepEqual(back.removed, []);
  assert.equal((await (await call('GET', `/api/playlists/${playlist.id}`, { token: boss })).json()).item_count, 1);

  // Once a file is gone from Drive itself, it's gone from the removed list too.
  await call('DELETE', `/api/media/${offer.id}`, { token: boss });
  google.removeFile(google.findByName('offer.jpg').id);
  assert.deepEqual((await (await call('POST', '/api/media/sync', { token: boss })).json()).removed, []);
});

test('file start dates: not on screens before the start, but downloaded a day ahead', async (t) => {
  const { call, signIn, upload } = await startServer(t);
  const boss = await signIn(BOSS);
  const hour = 60 * 60 * 1000;
  const now = await (await upload(boss, 'now.jpg', crypto.randomBytes(100), 'image/jpeg')).json();
  const soon = await (await call('POST', '/api/media', {
    token: boss, body: crypto.randomBytes(200), headers: { 'content-type': 'image/jpeg', 'x-filename': 'soon.jpg', 'x-starts-at': String(Date.now() + 2 * hour) },
  })).json();
  const later = await (await upload(boss, 'later.jpg', crypto.randomBytes(300), 'image/jpeg')).json();
  assert.ok(soon.starts_at > Date.now());
  // Start in 3 days, end in 5: allowed. End before start: refused.
  assert.equal((await call('PATCH', `/api/media/${later.id}`, { token: boss, json: { starts_at: Date.now() + 3 * 24 * hour, expires_at: Date.now() + 5 * 24 * hour } })).status, 200);
  assert.equal((await call('PATCH', `/api/media/${later.id}`, { token: boss, json: { expires_at: Date.now() + 24 * hour } })).status, 400);

  const playlist = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Lobby', orientation: 'landscape' } })).json();
  await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [now, soon, later].map((m) => ({ media_id: m.id })) } });
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Lobby TV', playlist_id: playlist.id } });
  const list = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.deepEqual(list.items.map((i) => i.id), [now.id]);
  assert.deepEqual(list.upcoming.map((i) => i.id), [soon.id]); // later.jpg is more than a day away

  // Once its start passes, it plays (and the version changes, so the TV updates).
  await call('PATCH', `/api/media/${soon.id}`, { token: boss, json: { starts_at: null } });
  const after = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.deepEqual(after.items.map((i) => i.id), [now.id, soon.id]);
  assert.notEqual(after.version, list.version);
});

test('locations: add, rename, working hours to the TV, and delete only when empty with the name typed', async (t) => {
  const { call, signIn } = await startServer(t);
  const boss = await signIn(BOSS);
  await call('POST', '/api/users', { token: boss, json: { email: 'up@example.com', role: 'content_uploader' } });
  const uploader = await signIn('up@example.com');

  const lobby = await (await call('POST', '/api/locations', { token: boss, json: { name: 'Main lobby' } })).json();
  assert.equal(lobby.hours_summary, 'Always on');
  assert.equal((await call('POST', '/api/locations', { token: boss, json: { name: 'Main lobby' } })).status, 409);
  assert.equal((await call('POST', '/api/locations', { token: boss, json: { name: ' ' } })).status, 400);
  assert.equal((await call('POST', '/api/locations', { token: uploader, json: { name: 'Back office' } })).status, 403);

  // A TV set up in the lobby gets the lobby's hours with its playlist.
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Lobby TV', location: 'Main lobby' } });
  const before = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.equal(before.hours, null);
  const weekdays = { open: '08:00', close: '18:00' };
  const hours = { mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sat: { open: '10:00', close: '16:00' }, sun: null };
  assert.equal((await call('PATCH', `/api/locations/${lobby.id}`, { token: boss, json: { hours: { ...hours, mon: { open: '8am', close: '6pm' } } } })).status, 400);
  const saved = await (await call('PATCH', `/api/locations/${lobby.id}`, { token: boss, json: { hours } })).json();
  assert.equal(saved.hours_summary, 'Mon–Fri 08:00–18:00 · Sat 10:00–16:00 · Sun closed');
  const after = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.deepEqual(after.hours, hours);
  assert.notEqual(after.version, before.version);

  // Renaming moves its screens along; a location typed in the phone app is added automatically.
  await call('PATCH', `/api/locations/${lobby.id}`, { token: boss, json: { name: 'Lobby' } });
  const [screen] = await (await call('GET', '/api/devices', { token: boss })).json();
  assert.equal(screen.location, 'Lobby');
  assert.equal(screen.location_id, lobby.id);
  assert.equal(screen.hours_summary, saved.hours_summary);
  await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { location: 'Café' } });
  const all = await (await call('GET', '/api/locations', { token: boss })).json();
  assert.deepEqual(all.locations.map((l) => [l.name, l.screens.length]), [['Café', 1], ['Lobby', 0]]);

  // Deleting needs the exact name, and an empty location.
  const cafe = all.locations.find((l) => l.name === 'Café');
  assert.equal((await call('DELETE', `/api/locations/${cafe.id}`, { token: boss, json: { confirm_name: 'cafe' } })).status, 400);
  const busy = await call('DELETE', `/api/locations/${cafe.id}`, { token: boss, json: { confirm_name: 'Café' } });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /Lobby TV/);
  assert.equal((await call('DELETE', `/api/locations/${lobby.id}`, { token: boss, json: { confirm_name: 'Lobby' } })).status, 200);
  assert.equal((await call('GET', `/api/locations/${lobby.id}`, { token: boss })).status, 404);
});

test('working hours: open, closed, and past midnight', () => {
  const { isOpenAt, summarizeHours, checkHours } = require('../src/hours');
  const at = (iso) => Date.parse(iso);
  const day = { open: '08:00', close: '18:00' };
  const hours = { mon: day, tue: day, wed: day, thu: day, fri: { open: '18:00', close: '02:00' }, sat: null, sun: null };
  assert.equal(isOpenAt(null, at('2026-11-02T03:00:00Z'), 'UTC'), true); // always on
  assert.equal(isOpenAt(hours, at('2026-11-02T10:00:00Z'), 'UTC'), true); // Monday 10:00
  assert.equal(isOpenAt(hours, at('2026-11-02T18:00:00Z'), 'UTC'), false); // closes at 18:00
  assert.equal(isOpenAt(hours, at('2026-11-02T10:00:00Z'), 'Asia/Singapore'), false); // 18:00 in Singapore
  assert.equal(isOpenAt(hours, at('2026-11-07T01:30:00Z'), 'UTC'), true); // Friday night runs into Saturday
  assert.equal(isOpenAt(hours, at('2026-11-07T03:00:00Z'), 'UTC'), false);
  assert.equal(isOpenAt(hours, at('2026-11-08T12:00:00Z'), 'UTC'), false); // Sunday closed
  assert.equal(summarizeHours(hours), 'Mon–Thu 08:00–18:00 · Fri 18:00–02:00 · Sat–Sun closed');
  assert.match(checkHours({ mon: { open: '09:00', close: '09:00' } }).error, /same/);
});

test('notifications: Home Assistant hears when a screen is offline during working hours', async (t) => {
  const sent = [];
  let failing = false;
  const homeAssistant = {
    async listTargets() { return [{ id: 'mobile_app_pixel', name: 'Phone or tablet: pixel' }, { id: 'persistent_notification', name: 'bell' }]; },
    async send(target, message) { if (failing) throw new Error('down'); sent.push({ target, ...message }); },
  };
  const { call, signIn, app } = await startServer(t, { homeAssistant, monitorIntervalMs: 0 });
  const boss = await signIn(BOSS);
  const db = app.locals.db;
  const monday10 = Date.parse('2026-11-02T10:00:00Z');
  const minute = 60 * 1000;

  // Settings: pick the phone, and send a test.
  assert.deepEqual((await (await call('GET', '/api/settings/notify-targets', { token: boss })).json()).targets.map((x) => x.id), ['mobile_app_pixel', 'persistent_notification']);
  assert.equal((await call('POST', '/api/settings/test-notification', { token: boss })).status, 400); // nothing ticked yet
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { notify_targets: ['not valid!'] } })).status, 400);
  const settings = await (await call('PATCH', '/api/settings', { token: boss, json: { notify_targets: ['mobile_app_pixel'] } })).json();
  assert.deepEqual(settings.notifications, { available: true, targets: ['mobile_app_pixel'] });
  assert.equal((await call('POST', '/api/settings/test-notification', { token: boss })).status, 200);
  assert.equal(sent.pop().target, 'mobile_app_pixel');

  // Two lobby screens, open Monday–Friday 08:00–18:00 (UTC TVs).
  const lobby = await (await call('POST', '/api/locations', { token: boss, json: { name: 'Main lobby' } })).json();
  const day = { open: '08:00', close: '18:00' };
  await call('PATCH', `/api/locations/${lobby.id}`, { token: boss, json: { hours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null } } });
  const screens = [];
  for (const name of ['Back wall', 'Front window']) {
    const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
    await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name, location: 'Main lobby' } });
    await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.4.0', time_zone: 'UTC', after_hours: 'standby' } });
    screens.push(tv);
  }
  const lastSeen = (name, ms) => db.prepare(`UPDATE devices SET last_seen = ? WHERE name = ?`).run(ms, name);
  lastSeen('Back wall', monday10);
  lastSeen('Front window', monday10);

  // 3 minutes of silence: nothing yet. 6 minutes: one notification.
  await app.locals.checkScreens(monday10 + 3 * minute);
  assert.equal(sent.length, 0);
  await app.locals.checkScreens(monday10 + 6 * minute);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '2 screens are offline');
  assert.match(sent[0].message, /Back wall \(Main lobby\): last seen 10:00/);
  assert.equal(sent[0].data.url, '/hassio/ingress/local_kiosk_server');
  // It isn't repeated every minute.
  await app.locals.checkScreens(monday10 + 7 * minute);
  assert.equal(sent.length, 1);

  // One comes back.
  lastSeen('Back wall', monday10 + 8 * minute);
  await app.locals.checkScreens(monday10 + 8 * minute);
  assert.equal(sent[1].title, 'Back wall is back online');
  assert.equal(sent[1].data.tag, `kiosk-screen-${db.prepare(`SELECT id FROM devices WHERE name = 'Back wall'`).get().id}`);

  // Outside working hours (Monday 20:00, or Saturday), going quiet is expected.
  lastSeen('Back wall', monday10 + 9 * 60 * minute);
  await app.locals.checkScreens(monday10 + 10 * 60 * minute);
  assert.equal(sent.length, 2);
  // A screen that doesn't wake at Tuesday 08:00 is reported at 08:05, not at 08:00.
  const tuesday8 = Date.parse('2026-11-03T08:00:00Z');
  await app.locals.checkScreens(tuesday8 + minute);
  assert.equal(sent.length, 2);
  await app.locals.checkScreens(tuesday8 + 6 * minute);
  assert.equal(sent[2].title, 'Back wall is offline');

  // If Home Assistant can't be reached, it tries again next minute.
  lastSeen('Back wall', tuesday8 + 7 * minute);
  failing = true;
  await app.locals.checkScreens(tuesday8 + 7 * minute);
  failing = false;
  await app.locals.checkScreens(tuesday8 + 8 * minute);
  assert.equal(sent[3].title, 'Back wall is back online');
});

test('notifications: a whole site going quiet is reported as the site, not screen by screen', async (t) => {
  const sent = [];
  const homeAssistant = { async listTargets() { return []; }, async send(target, message) { sent.push(message); } };
  const { call, signIn, app } = await startServer(t, { homeAssistant, monitorIntervalMs: 0, siteName: 'Head office' });
  const boss = await signIn(BOSS);
  await call('PATCH', '/api/settings', { token: boss, json: { notify_targets: ['mobile_app_pixel'] } });
  for (const name of ['Branch 1', 'Branch 2']) {
    const tv = await (await call('POST', '/api/player/register', { json: {}, headers: { 'x-kiosk-site': 'Orchard branch' } })).json();
    await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name } });
  }
  app.locals.db.prepare(`UPDATE devices SET last_seen = ?`).run(Date.now() - 10 * 60 * 1000);
  await app.locals.checkScreens();
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Orchard branch: all 2 screens are offline/);
});

test('Home Assistant notify services are read from its API', async () => {
  const { createHomeAssistant } = require('../src/notify');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url, init.headers.authorization, init.body]);
    return new Response(JSON.stringify(url.endsWith('/services')
      ? [{ domain: 'light', services: { turn_on: {} } }, { domain: 'notify', services: { send_message: {}, mobile_app_pixel_8: {}, persistent_notification: {} } }]
      : []), { status: 200 });
  };
  const ha = createHomeAssistant({ baseUrl: 'http://supervisor/core/api', token: 'secret', fetchImpl });
  assert.deepEqual(await ha.listTargets(), [
    { id: 'mobile_app_pixel_8', name: 'Phone or tablet: pixel 8' },
    { id: 'persistent_notification', name: 'Home Assistant notifications (the bell in the sidebar)' },
  ]);
  await ha.send('mobile_app_pixel_8', { title: 'Hi', message: 'There' });
  assert.deepEqual(calls[1].slice(0, 3), ['POST', 'http://supervisor/core/api/services/notify/mobile_app_pixel_8', 'Bearer secret']);
  await assert.rejects(ha.send('../../config', { title: 'x', message: 'y' }));
});
