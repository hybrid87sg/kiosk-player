// The Kiosk Browser's core (src/core), tested against the real Kiosk server from ../server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/src/app');
const { createFakeGoogle } = require('../../server/test/fake-google');
const { createController } = require('../src/core/controller');
const { createStore } = require('../src/core/store');
const { createSync, DownloadError } = require('../src/core/sync');
const { isAllowed, pinMatches } = require('../src/core/rules');
const { normaliseServerUrl } = require('../src/core/api');
const { ask } = require('../src/core/finder');

const PASSWORD = 'correct-horse-9';
// Windows won't delete a file that's still open, so folders are removed last, with retries,
// and a folder that can't be removed never fails a test.
const removeDir = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the system */ }
};
const tmp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => removeDir(dir));
  return dir;
};

async function startServer(t) {
  const google = createFakeGoogle();
  const picture = crypto.randomBytes(150 * 1024);
  google.addFile('welcome.png', 'image/png', picture, { width: 1920, height: 1080 });
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-'));
  const app = createApp({
    dataDir: serverDir, google, firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {},
  });
  let server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const call = (method, p, { token, json } = {}) => fetch(url + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const boss = (await (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).json()).token;
  const stop = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  const restart = async () => { server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); }); };
  // Stop the server and close its database before its folder is removed (Windows locks open files).
  t.after(async () => {
    await stop().catch(() => {});
    app.locals.relayHub.close();
    app.locals.db.close();
    removeDir(serverDir);
  });
  return { url, call, boss, picture, stop, restart };
}

const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

test('the working-hours rules are an exact copy of the server’s', () => {
  assert.equal(
    fs.readFileSync(path.join(__dirname, '../src/core/hours.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../../server/src/hours.js'), 'utf8'),
  );
});

test('only the web address’s own site, and listed ones, can be opened (the list shared with Android)', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../shared/web-kiosk-rules.json'), 'utf8'));
  for (const u of cases.allowed) assert.equal(isAllowed(u, cases.start, cases.allowed_hosts), true, u);
  for (const u of cases.refused) assert.equal(isAllowed(u, cases.start, cases.allowed_hosts), false, u);
});

test('the staff PIN is checked against the server’s salted hash', () => {
  const salt = 'abc123';
  const stored = { salt, sha256: crypto.createHash('sha256').update(`${salt}:2468`).digest('hex') };
  assert.equal(pinMatches('2468', stored), true);
  assert.equal(pinMatches('2469', stored), false);
  assert.equal(pinMatches('2468', null), false);
});

test('server addresses are tidied like on the TVs', () => {
  assert.equal(normaliseServerUrl('192.168.1.20'), 'http://192.168.1.20:3000');
  assert.equal(normaliseServerUrl(' http://kiosk.local:3000/ '), 'http://kiosk.local:3000');
  assert.equal(normaliseServerUrl('https://kiosk.example.com'), 'https://kiosk.example.com');
  assert.equal(normaliseServerUrl(''), '');
});

test('a dropped connection is a download problem that resumes, never a crash', async (t) => {
  const bytes = crypto.randomBytes(200_000);
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  let cut = true;
  const ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range || null);
    const from = Number((req.headers.range || 'bytes=0-').slice(6, -1));
    res.writeHead(from ? 206 : 200, { 'content-length': bytes.length - from });
    if (cut) { res.write(bytes.subarray(from, 80_000)); setTimeout(() => res.destroy(), 20); return; }
    res.end(bytes.subarray(from));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const sync = createSync({ baseUrl: `http://127.0.0.1:${server.address().port}`, mediaDir: tmp(t, 'kb-media-'), getToken: () => 'x' });
  const item = { id: 3, url: '/media/3', md5, size: bytes.length, filename: 'promo.mp4' };
  await assert.rejects(sync.sync({ items: [item] }), (err) => err instanceof DownloadError && /connection lost|incomplete/.test(err.message));
  cut = false;
  await sync.sync({ items: [item] });
  assert.ok(sync.isReady(item));
  assert.ok(fs.readFileSync(sync.fileFor(item)).equals(bytes));
  // It resumes from what really arrived. Up to 80,000 bytes were sent before the cut; Windows
  // can drop the last of them when a connection is cut, so it may resume a little earlier.
  const resumedAt = Number((/^bytes=(\d+)-$/.exec(ranges[1]) || [])[1]);
  assert.ok(resumedAt > 0 && resumedAt <= 80_000, `resumed from ${ranges[1]}`);
});

test('pairs, downloads its playlist, gets its web page, checks in, and keeps going offline', async (t) => {
  const srv = await startServer(t);
  const { call, boss } = srv;
  // The server finds it like a TV finds the server.
  assert.equal((await ask(srv.url, fetch)).role, 'main');

  const dataDir = tmp(t, 'kb-pc-');
  const states = [];
  const controller = createController({ store: createStore(dataDir), dataDir, appVersion: '0.10.0', model: 'Test PC', loopMs: 300, retryMs: 200 });
  controller.events.on('state', (s) => states.push(s));
  t.after(() => controller.stop());
  await controller.connect(srv.url.replace('http://', ''));
  const pairing = await until(() => states.find((s) => s.phase === 'pairing' && s.code));

  // Waiting on the dashboard as a web kiosk; added with a web address and a PIN.
  const [waiting] = await (await call('GET', '/api/devices/waiting', { token: boss })).json();
  assert.deepEqual([waiting.kind, waiting.model, waiting.pairing_code], ['browser', 'Test PC', pairing.code]);
  await call('POST', '/api/media/sync', { token: boss });
  const media = (await (await call('GET', '/api/media', { token: boss })).json()).items[0];
  await call('POST', '/api/locations', { token: boss, json: { name: 'Front desk area' } });
  const { locations } = await (await call('GET', '/api/locations', { token: boss })).json();
  const playlist = await (await call('POST', '/api/playlists', { token: boss, json: { name: 'Front desk loop', orientation: 'landscape', location_id: locations[0].id } })).json();
  await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: media.id }] } });
  const claimed = await (await call('POST', '/api/devices/claim', {
    token: boss,
    json: { code: pairing.code, name: 'Front desk', location: locations[0].name, playlist_id: playlist.id, kiosk_url: 'https://shop.example.com/', kiosk_pin: '1357' },
  })).json();

  // It downloads the file (checked) and is ready with its web page.
  const ready = await until(() => controller.state.phase === 'ready' && controller.state.items.length === 1 && controller.state);
  assert.ok(fs.readFileSync(ready.items[0].file).equals(srv.picture));
  assert.equal(ready.browser.url, 'https://shop.example.com/');
  assert.equal(pinMatches('1357', ready.browser.pin), true);

  // The dashboard sees it online, with its version and what it shows.
  controller.playing(media.id);
  await until(async () => {
    const d = (await (await call('GET', '/api/devices', { token: boss })).json()).find((x) => x.id === claimed.id);
    return d.online && d.app_version === '0.10.0' && d.current_media_id === media.id;
  });

  // A new web address on the dashboard reaches it.
  await call('PATCH', `/api/devices/${claimed.id}`, { token: boss, json: { kiosk_url: 'https://shop.example.com/v2' } });
  controller.checkNow();
  await until(() => controller.state.browser && controller.state.browser.url === 'https://shop.example.com/v2');

  // The server goes away: it keeps its playlist and says it's offline.
  await srv.stop();
  await until(() => controller.state.phase === 'ready' && /Offline/.test(controller.state.badge || ''));
  assert.equal(controller.state.items.length, 1);

  // It starts again (e.g. after the PC restarts) straight into its saved playlist.
  const again = createController({ store: createStore(dataDir), dataDir, appVersion: '0.10.0', loopMs: 300, retryMs: 200 });
  t.after(() => again.stop());
  again.start();
  assert.equal(again.state.phase, 'ready');
  assert.equal(again.state.items.length, 1);

  // Removed on the dashboard: back to a new pairing code, and its files are gone.
  await srv.restart();
  await call('DELETE', `/api/devices/${claimed.id}`, { token: boss });
  await until(() => controller.state.phase === 'pairing' && controller.state.code && controller.state.code !== pairing.code);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'media')), []);
});
