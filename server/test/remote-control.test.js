// 0.13.0: Restart and See screen from the dashboard, and Windows PCs updating themselves
// from this server (the installer fetched once from the GitHub release of this version).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createWindowsApp } = require('../src/windows-app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';
// The smallest thing that starts like a JPEG.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

async function start(t, { windowsApp = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-remote-'));
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {}, windowsApp,
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
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const boss = (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).body.token;
  const view = async (id) => (await call('GET', '/api/devices', { token: boss })).body.find((d) => d.id === id);
  async function addScreen(json, name) {
    const tv = (await call('POST', '/api/player/register', { json })).body;
    const added = (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name, location: 'Lobby' } })).body;
    return { token: tv.token, id: added.id };
  }
  return { call, boss, view, addScreen, dataDir };
}

test('Restart: the screen is told once, says "restarting", and reports back when it is up again', async (t) => {
  const { call, boss, view, addScreen } = await start(t);
  const tv = await addScreen({ app_version: '0.13.0' }, 'Door stand');
  assert.equal((await view(tv.id)).can_restart, true);
  assert.equal((await view(tv.id)).can_restart_device, false, 'until it says it can');

  // The whole device only where the screen says it can.
  const refused = await call('POST', `/api/devices/${tv.id}/restart`, { token: boss, json: { kind: 'device' } });
  assert.equal(refused.status, 409);
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.13.0', can_reboot: true } });
  assert.equal((await view(tv.id)).can_restart_device, true);

  const asked = await call('POST', `/api/devices/${tv.id}/restart`, { token: boss, json: { kind: 'app' } });
  assert.equal(asked.status, 200);
  assert.deepEqual([asked.body.restart.step, asked.body.restart.kind], ['waiting', 'app']);
  const action = (await call('GET', '/api/player/playlist', { token: tv.token })).body.actions.restart;
  assert.equal(action.kind, 'app');
  assert.equal((await view(tv.id)).restart.step, 'restarting');

  // Back up: it says so with its next heartbeat, and isn't asked again.
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.13.0', restart: { id: action.id, step: 'done' } } });
  assert.equal((await view(tv.id)).restart.step, 'done');
  assert.equal((await call('GET', '/api/player/playlist', { token: tv.token })).body.actions.restart, null);
});

test('Restart and See screen need the 0.13.0 apps; older ones are told why', async (t) => {
  const { call, boss, addScreen } = await start(t);
  const old = await addScreen({ app_version: '0.12.1' }, 'Old box');
  const r = await call('POST', `/api/devices/${old.id}/restart`, { token: boss, json: {} });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /0\.13\.0/);
  assert.equal((await call('POST', `/api/devices/${old.id}/screenshot`, { token: boss })).status, 409);
});

test('See screen: the screen sends a picture, only screen managers can see it, and it goes with the screen', async (t) => {
  const { call, boss, view, addScreen, dataDir } = await start(t);
  const tv = await addScreen({ app_version: '0.13.0' }, 'Door stand');
  assert.equal((await call('GET', `/api/devices/${tv.id}/screenshot.jpg`, { token: boss })).status, 404, 'no picture yet');

  const asked = await call('POST', `/api/devices/${tv.id}/screenshot`, { token: boss });
  assert.equal(asked.body.screenshot.job.step, 'waiting');
  const id = (await call('GET', '/api/player/playlist', { token: tv.token })).body.actions.screenshot;
  assert.equal(typeof id, 'string');

  // A wrong id or something that isn't a JPEG is refused.
  assert.equal((await call('POST', '/api/player/screenshot/nope', { token: tv.token, json: { jpeg: JPEG.toString('base64') } })).status, 409);
  assert.equal((await call('POST', `/api/player/screenshot/${id}`, { token: tv.token, json: { jpeg: Buffer.from('hello').toString('base64') } })).status, 400);
  // A real-sized picture fits.
  const big = Buffer.concat([JPEG.subarray(0, 4), crypto.randomBytes(900 * 1024)]);
  assert.equal((await call('POST', `/api/player/screenshot/${id}`, { token: tv.token, json: { jpeg: big.toString('base64') } })).status, 200);

  const v = await view(tv.id);
  assert.equal(v.screenshot.job.step, 'done');
  assert.ok(v.screenshot.taken_at > 0);
  const pic = await call('GET', `/api/devices/${tv.id}/screenshot.jpg`, { token: boss });
  assert.equal(pic.status, 200);
  assert.ok(pic.body.equals(big));
  assert.equal((await call('GET', '/api/player/playlist', { token: tv.token })).body.actions.screenshot, null, 'asked once');
  assert.equal((await call('GET', `/api/devices/${tv.id}/screenshot.jpg`)).status, 401);

  // The screen couldn't take one: the dashboard says why.
  await call('POST', `/api/devices/${tv.id}/screenshot`, { token: boss });
  const again = (await call('GET', '/api/player/playlist', { token: tv.token })).body.actions.screenshot;
  await call('POST', `/api/player/screenshot/${again}`, { token: tv.token, json: { error: 'The video is protected' } });
  assert.deepEqual([(await view(tv.id)).screenshot.job.step, (await view(tv.id)).screenshot.job.error], ['failed', 'The video is protected']);

  // Removing the screen removes its picture.
  await call('DELETE', `/api/devices/${tv.id}`, { token: boss });
  assert.equal(fs.existsSync(path.join(dataDir, 'screenshots', `${tv.id}.jpg`)), false);
});

// A stand-in for windows-app.js: the installer is "here" once [ready] is set.
function fakeWindowsApp(dir, version) {
  const file = path.join(dir, 'setup.exe');
  fs.writeFileSync(file, 'installer bytes');
  const app = {
    version,
    ready: null,
    problem: null,
    asked: 0,
    async fetch() { app.asked += 1; return app.ready; },
    makeReady() { app.ready = { version, size: 15, sha256: crypto.createHash('sha256').update('installer bytes').digest('hex'), file }; },
  };
  return app;
}

test('Windows PCs update from this server: overnight by themselves, or now from the dashboard', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-winapp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const windowsApp = fakeWindowsApp(tmp, '0.13.2');
  const { call, boss, view, addScreen } = await start(t, { windowsApp });
  const pc = await addScreen({ kind: 'browser', app_version: '0.13.0' }, 'Front desk');
  const old = await addScreen({ kind: 'browser', app_version: '0.12.1' }, 'Old PC');

  // The installer isn't here yet: the server goes to get it, nothing is offered.
  let list = (await call('GET', '/api/player/playlist', { token: pc.token })).body;
  assert.equal(list.actions.update, null);
  assert.ok(windowsApp.asked > 0);
  assert.equal((await view(pc.id)).app.update_available, false);

  // Now it is: the PC is given it to install outside working hours.
  windowsApp.makeReady();
  list = (await call('GET', '/api/player/playlist', { token: pc.token })).body;
  const action = list.actions.update;
  assert.deepEqual([action.version, action.when, action.url, action.size], ['0.13.2', 'closed', '/api/player/windows-app.exe', 15]);
  let v = await view(pc.id);
  assert.deepEqual([v.app.update_available, v.app.latest.version, v.app.update_when], [true, '0.13.2', 'closed']);
  // An older PC can't update itself: it isn't given one, and the dashboard says what to do.
  assert.equal((await call('GET', '/api/player/playlist', { token: old.token })).body.actions.update, null);
  const refused = await call('POST', `/api/devices/${old.id}/update`, { token: boss });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /by hand once/);

  // The Mac test build says it's a Mac: it's never given the Windows installer.
  const mac = await addScreen({ kind: 'browser', app_version: '0.13.0' }, 'Test Mac');
  await call('POST', '/api/player/heartbeat', { token: mac.token, json: { app_version: '0.13.0', platform: 'darwin' } });
  assert.equal((await call('GET', '/api/player/playlist', { token: mac.token })).body.actions.update, null);
  assert.equal((await view(mac.id)).app.update_available, false);
  assert.match((await call('POST', `/api/devices/${mac.id}/update`, { token: boss })).body.error, /Mac test build/);

  // "Update app" on the dashboard: now instead of tonight.
  const now = await call('POST', `/api/devices/${pc.id}/update`, { token: boss });
  assert.equal(now.status, 200);
  const nowAction = (await call('GET', '/api/player/playlist', { token: pc.token })).body.actions.update;
  assert.equal(nowAction.when, 'now');
  const exe = await call('GET', nowAction.url, { token: pc.token });
  assert.equal(exe.body.toString(), 'installer bytes');
  await call('POST', '/api/player/heartbeat', { token: pc.token, json: { app_version: '0.13.0', update: { id: nowAction.id, step: 'installing' } } });
  assert.equal((await view(pc.id)).app.update.step, 'installing');
  // It comes back as 0.13.2: done.
  await call('POST', '/api/player/heartbeat', { token: pc.token, json: { app_version: '0.13.2' } });
  v = await view(pc.id);
  assert.deepEqual([v.app.update.step, v.app.update_available], ['done', false]);
  assert.equal((await call('GET', '/api/player/playlist', { token: pc.token })).body.actions.update, null, 'nothing more to install');
});

test('the Windows installer is fetched from the GitHub release and checked against its fingerprint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-winfetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('the real installer');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  let served = bytes;
  let asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.includes('/releases/tags/v0.13.0')) {
      return new Response(JSON.stringify({ assets: [
        { name: 'KioskPlayer-for-TV-0.13.0.apk', size: 1, digest: 'sha256:00', browser_download_url: 'https://x/apk' },
        { name: 'KioskBrowser-Setup-0.13.0.exe', size: bytes.length, digest: `sha256:${sha}`, browser_download_url: 'https://x/exe' },
      ] }), { status: 200 });
    }
    if (url === 'https://x/exe') return new Response(served, { status: 200 });
    return new Response('{}', { status: 404 });
  };
  let clock = 0;
  const now = () => clock;

  // Tampered download: refused, and not tried again straight away.
  served = Buffer.from('the fake installer');
  const win = createWindowsApp({ dir, version: '0.13.0', fetchImpl, now });
  assert.equal(await win.fetch(), null);
  assert.match(win.problem, /fingerprint/);
  asked = [];
  assert.equal(await win.fetch(), null);
  assert.deepEqual(asked, [], 'waits before trying again');

  // The right one: kept, and found again after a restart.
  served = bytes;
  clock += 31 * 60 * 1000;
  const got = await win.fetch();
  assert.equal(got.sha256, sha);
  assert.equal(fs.readFileSync(got.file, 'utf8'), 'the real installer');
  const again = createWindowsApp({ dir, version: '0.13.0', fetchImpl: async () => { throw new Error('no network needed'); } });
  assert.equal(again.ready.sha256, sha);

  // No release yet (the add-on comes out a few minutes before the Windows installer).
  const early = createWindowsApp({ dir, version: '0.14.0', fetchImpl, now });
  assert.equal(await early.fetch({ force: true }), null);
  assert.match(early.problem, /no release/);
});
