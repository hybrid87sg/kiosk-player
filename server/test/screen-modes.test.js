// 0.12.0: every screen is a Video Kiosk (plays its playlist; touches ignored) or a Web Kiosk
// (plays its playlist; a touch opens the web page). Android screens can now be Web Kiosks too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-modes-'));
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

test('an Android screen is a Video Kiosk until it is set to Web Kiosk; its TV is told', async (t) => {
  const { call, boss, view } = await start(t);
  const tv = (await call('POST', '/api/player/register', { json: { app_version: '0.12.0', model: 'rk3568' } })).body;
  const screen = (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Door stand', location: 'Lobby' } })).body;
  assert.equal(screen.screen_mode, 'video');
  assert.equal(screen.can_web_kiosk, true);
  let list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.equal(list.mode, 'video');

  // Web Kiosk, with its page, idle time and PIN: the TV gets them (the PIN only as a salted hash).
  const set = await call('PATCH', `/api/devices/${screen.id}`, {
    token: boss, json: { screen_mode: 'web', kiosk_url: 'https://shop.example.com/start', kiosk_idle_seconds: 60, kiosk_pin: '2468' },
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.screen_mode, 'web');
  assert.equal(set.body.browser.has_pin, true);
  const before = list.version;
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.notEqual(list.version, before, 'the TV notices the change');
  assert.equal(list.mode, 'web');
  assert.deepEqual([list.browser.url, list.browser.idle_seconds], ['https://shop.example.com/start', 60]);
  assert.equal(typeof list.browser.pin.sha256, 'string');
  assert.equal(JSON.stringify(list).includes('2468'), false);

  // Back to a Video Kiosk: the settings are kept for next time, and the PIN still guards its corner.
  await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { screen_mode: 'video' } });
  list = (await call('GET', '/api/player/playlist', { token: tv.token })).body;
  assert.equal(list.mode, 'video');
  assert.equal(list.browser.url, 'https://shop.example.com/start');
  assert.equal((await view(screen.id)).screen_mode, 'video');

  // Only the two modes.
  assert.equal((await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { screen_mode: 'website' } })).status, 400);
});

test('the dashboard knows which screens can be Web Kiosks, and what they have', async (t) => {
  const { call, boss, view } = await start(t);
  // An older TV app can't show web pages: the dashboard says so.
  const old = (await call('POST', '/api/player/register', { json: { app_version: '0.11.4' } })).body;
  const oldScreen = (await call('POST', '/api/devices/claim', { token: boss, json: { code: old.pairing_code, name: 'Old box', location: 'Lobby' } })).body;
  assert.equal(oldScreen.can_web_kiosk, false);
  assert.deepEqual([oldScreen.touchscreen, oldScreen.webview_version], [null, null]);

  // A new one reports its touchscreen and web viewer with its check-in.
  const tv = (await call('POST', '/api/player/register', { json: { app_version: '0.12.0' } })).body;
  const screen = (await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Door stand', location: 'Lobby' } })).body;
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.12.0', touchscreen: true, webview_version: '128.0.6613.146' } });
  let v = await view(screen.id);
  assert.deepEqual([v.touchscreen, v.webview_version, v.can_web_kiosk], [true, '128.0.6613.146', true]);
  // No touchscreen and no web viewer are reported as such ('' = none).
  await call('POST', '/api/player/heartbeat', { token: tv.token, json: { app_version: '0.12.0', touchscreen: false, webview_version: '' } });
  v = await view(screen.id);
  assert.deepEqual([v.touchscreen, v.webview_version], [false, '']);
});

test('a Windows Kiosk Browser is a Web Kiosk unless set to Video Kiosk', async (t) => {
  const { call, boss } = await start(t);
  const pc = (await call('POST', '/api/player/register', { json: { kind: 'browser', app_version: '0.12.0' } })).body;
  const screen = (await call('POST', '/api/devices/claim', {
    token: boss, json: { code: pc.pairing_code, name: 'Front desk', location: 'Lobby', kiosk_url: 'https://shop.example.com/' },
  })).body;
  assert.deepEqual([screen.screen_mode, screen.can_web_kiosk], ['web', true]);
  assert.equal((await call('GET', '/api/player/playlist', { token: pc.token })).body.mode, 'web');
  await call('PATCH', `/api/devices/${screen.id}`, { token: boss, json: { screen_mode: 'video' } });
  assert.equal((await call('GET', '/api/player/playlist', { token: pc.token })).body.mode, 'video');
});
