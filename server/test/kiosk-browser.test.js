// 0.10.0: Windows "Kiosk Browser" screens. They pair like TVs (kind "browser"), play their
// playlist when idle, and show a web page on touch; the page and its rules come from here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-browser-'));
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
  const call = (method, url, { token, json } = {}) => fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const boss = (await (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).json()).token;
  return { call, boss };
}

test('a Kiosk Browser pairs like a TV and gets its web page, idle time, allowed sites and PIN', async (t) => {
  const { call, boss } = await start(t);
  const pc = await (await call('POST', '/api/player/register', { json: { kind: 'browser', app_version: '0.10.0', model: 'Front desk PC' } })).json();
  const tv = await (await call('POST', '/api/player/register', { json: { app_version: '0.9.2' } })).json();

  // The waiting list says which is which.
  const waiting = await (await call('GET', '/api/devices/waiting', { token: boss })).json();
  assert.deepEqual(waiting.map((w) => w.kind).sort(), ['browser', 'tv']);

  // Added with its settings in one go; they're checked.
  const bad = [
    [{ kiosk_url: 'ftp://x.example.com' }, /https/],
    [{ kiosk_url: 'not a url' }, /https/],
    [{ kiosk_idle_seconds: 5 }, /15 to 3600/],
    [{ kiosk_allowed_hosts: ['not a host'] }, /website name/],
    [{ kiosk_pin: '12' }, /4 to 8 digits/],
  ];
  for (const [fields, message] of bad) {
    const res = await call('POST', '/api/devices/claim', { token: boss, json: { code: pc.pairing_code, name: 'Front desk', location: 'Lobby', ...fields } });
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.match((await res.json()).error, message);
  }
  const claimed = await call('POST', '/api/devices/claim', {
    token: boss,
    json: {
      code: pc.pairing_code, name: 'Front desk', location: 'Lobby',
      kiosk_url: 'https://shop.example.com/start', kiosk_idle_seconds: 60,
      kiosk_allowed_hosts: ['https://Pay.Example.com/checkout', '*.cdn.example.net', 'pay.example.com'], kiosk_pin: '2468',
    },
  });
  assert.equal(claimed.status, 200);
  const view = await claimed.json();
  assert.equal(view.kind, 'browser');
  // The dashboard sees the settings, never the PIN.
  assert.deepEqual(view.browser, {
    url: 'https://shop.example.com/start', idle_seconds: 60, allowed_hosts: ['pay.example.com', '*.cdn.example.net'], has_pin: true,
  });
  assert.equal(JSON.stringify(view).includes('2468'), false);

  // The PC gets them with its playlist; the PIN only as a salted hash it can check.
  const list = await (await call('GET', '/api/player/playlist', { token: pc.token })).json();
  assert.equal(list.browser.url, 'https://shop.example.com/start');
  assert.equal(list.browser.idle_seconds, 60);
  assert.deepEqual(list.browser.allowed_hosts, ['pay.example.com', '*.cdn.example.net']);
  const { salt, sha256 } = list.browser.pin;
  assert.equal(crypto.createHash('sha256').update(`${salt}:2468`).digest('hex'), sha256);
  assert.equal(JSON.stringify(list).includes('2468'), false);

  // Changing a setting changes the version, so the PC picks it up at its next check-in.
  const before = list.version;
  await call('PATCH', `/api/devices/${view.id}`, { token: boss, json: { kiosk_url: 'https://shop.example.com/new', kiosk_pin: null } });
  const after = await (await call('GET', '/api/player/playlist', { token: pc.token })).json();
  assert.notEqual(after.version, before);
  assert.equal(after.browser.url, 'https://shop.example.com/new');
  assert.equal(after.browser.pin, null);

  // A TV is a Video Kiosk unless set otherwise (0.12.0): no web page yet. The Windows PC is a Web Kiosk.
  await call('POST', '/api/devices/claim', { token: boss, json: { code: tv.pairing_code, name: 'Cafe wall', location: 'Lobby' } });
  const tvList = await (await call('GET', '/api/player/playlist', { token: tv.token })).json();
  assert.equal(tvList.mode, 'video');
  assert.equal(tvList.browser.url, null);
  assert.equal(after.mode, 'web');
  const devices = await (await call('GET', '/api/devices', { token: boss })).json();
  assert.deepEqual(devices.map((d) => [d.name, d.kind, d.screen_mode, d.browser.has_pin]).sort(), [['Cafe wall', 'tv', 'video', false], ['Front desk', 'browser', 'web', false]]);
});
