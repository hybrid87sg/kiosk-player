// 0.8.0: Google sign-in for the web dashboard, and the public door (the add-on's Funnel port).
// The pretend Google (fake-google.js) accepts "valid:<email>" as a signed-in Google account,
// and "valid:<email>@for:<client>" as one made for another app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp, createPublicServer } = require('../src/app');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';
const CLIENT = '1234567890-abc123def.apps.googleusercontent.com';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-google-'));
  const app = createApp({
    dataDir, google: createFakeGoogle(), firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre',
    syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {},
  });
  const local = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const door = createPublicServer(app);
  await new Promise((r) => door.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => door.close(r));
    await new Promise((r) => local.close(r));
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const at = (server) => (method, url, { token, json, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const call = at(local);
  const pub = at(door);
  const boss = (await (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).json()).token;
  return { app, call, pub, boss, doorPort: door.address().port };
}

test('a Google account linked to a user signs in with that user’s role; any other is refused', async (t) => {
  const { call, boss } = await start(t);
  // Not set up yet.
  assert.equal((await call('POST', '/api/auth/google', { json: { credential: 'valid:pat@gmail.com' } })).status, 400);
  // Spongebob sets the web client ID (checked for shape) and links a Google account to Patrick.
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { google_web_client_id: 'not-a-client' } })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { google_web_client_id: CLIENT } })).status, 200);
  const patrick = await (await call('POST', '/api/users', { token: boss, json: { username: 'patrick', role: 'system_manager', password: PASSWORD, google_email: 'Pat@Gmail.com' } })).json();
  assert.equal(patrick.google_email, 'pat@gmail.com');
  // One Google account per user.
  const squid = await (await call('POST', '/api/users', { token: boss, json: { username: 'squid', role: 'content_uploader', password: PASSWORD } })).json();
  assert.equal((await call('PATCH', `/api/users/${squid.id}`, { token: boss, json: { google_email: 'pat@gmail.com' } })).status, 400);
  assert.equal((await call('PATCH', `/api/users/${squid.id}`, { token: boss, json: { google_email: 'not an email' } })).status, 400);
  // Only Spongebob links accounts.
  const patToken = (await (await call('POST', '/api/auth/login', { json: { username: 'patrick', password: PASSWORD } })).json()).token;
  assert.equal((await call('PATCH', `/api/users/${squid.id}`, { token: patToken, json: { google_email: 'squid@gmail.com' } })).status, 403);

  // The public config tells the page which client to use.
  assert.equal((await (await call('GET', '/api/config')).json()).web_google_client_id, CLIENT);
  // Linked: in, as Patrick.
  const res = await call('POST', '/api/auth/google', { json: { credential: 'valid:pat@gmail.com' } });
  assert.equal(res.status, 200);
  const session = await res.json();
  assert.deepEqual([session.username, session.role], ['patrick', 'system_manager']);
  assert.equal((await (await call('GET', '/api/me', { token: session.token })).json()).username, 'patrick');
  // Not linked: refused, with a message saying what to do.
  const stranger = await call('POST', '/api/auth/google', { json: { credential: 'valid:someone@gmail.com' } });
  assert.equal(stranger.status, 403);
  assert.match((await stranger.json()).error, /isn’t linked/);
  // A token Google made for another app: refused.
  assert.equal((await call('POST', '/api/auth/google', { json: { credential: `valid:pat@gmail.com@for:999-other.apps.googleusercontent.com` } })).status, 401);
  assert.equal((await call('POST', '/api/auth/google', { json: { credential: 'forged' } })).status, 401);

  // Unlinking signs that Google sign-in out; Patrick's password sessions (the phone) stay.
  await call('PATCH', `/api/users/${patrick.id}`, { token: boss, json: { google_email: null } });
  assert.equal((await call('GET', '/api/me', { token: session.token })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: patToken })).status, 200);
  assert.equal((await call('POST', '/api/auth/google', { json: { credential: 'valid:pat@gmail.com' } })).status, 403);
});

test('adding someone by Google account alone lets them sign in with Google straight away', async (t) => {
  const { call, boss } = await start(t);
  assert.equal((await call('PATCH', '/api/settings', { token: boss, json: { google_web_client_id: CLIENT } })).status, 200);
  const add = (json) => call('POST', '/api/users', { token: boss, json });
  // Neither a Google account nor a password: refused.
  assert.equal((await add({ role: 'content_uploader' })).status, 400);
  assert.equal((await add({ username: 'gary', role: 'content_uploader' })).status, 400);
  assert.equal((await add({ role: 'content_uploader', google_email: 'not an email' })).status, 400);

  // Just a Google account: the username is the address, and there is no password.
  const res = await add({ role: 'content_uploader', google_email: 'Sandy.Cheeks@Gmail.com' });
  assert.equal(res.status, 201);
  const sandy = await res.json();
  assert.deepEqual([sandy.username, sandy.google_email, sandy.has_password], ['sandy.cheeks@gmail.com', 'sandy.cheeks@gmail.com', false]);
  const session = await (await call('POST', '/api/auth/google', { json: { credential: 'valid:sandy.cheeks@gmail.com' } })).json();
  assert.deepEqual([session.username, session.role], ['sandy.cheeks@gmail.com', 'content_uploader']);
  // No password to guess.
  assert.equal((await call('POST', '/api/auth/login', { json: { username: 'sandy.cheeks@gmail.com', password: '' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { json: { username: 'sandy.cheeks@gmail.com', password: PASSWORD } })).status, 401);
  // The same Google account twice: refused.
  assert.equal((await add({ role: 'content_uploader', google_email: 'sandy.cheeks@gmail.com' })).status, 400);

  // A long address: the part before the @, made unique.
  const long = 'a-really-quite-long-name@some-company-domain.example.com';
  const first = await (await add({ role: 'content_uploader', google_email: long })).json();
  assert.equal(first.username, 'a-really-quite-long-name');
  const second = await (await add({ role: 'content_uploader', google_email: 'a-really-quite-long-name@other-company-domain.example.org' })).json();
  assert.equal(second.username, 'a-really-quite-long-name-2');

  // Unlinking would lock Sandy out: refused until she has a password; then allowed.
  assert.equal((await call('PATCH', `/api/users/${sandy.id}`, { token: boss, json: { google_email: null } })).status, 400);
  assert.equal((await call('PATCH', `/api/users/${sandy.id}`, { token: boss, json: { password: PASSWORD } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { json: { username: 'sandy.cheeks@gmail.com', password: PASSWORD } })).status, 200);
  assert.equal((await call('PATCH', `/api/users/${sandy.id}`, { token: boss, json: { google_email: null } })).status, 200);
});

test('the public door: the dashboard with Google sign-in only, nothing for TVs, relays or passwords', async (t) => {
  const { call, pub, boss, doorPort } = await start(t);
  await call('PATCH', '/api/settings', { token: boss, json: { google_web_client_id: CLIENT } });
  await call('PATCH', '/api/users/1', { token: boss, json: { google_email: 'owner@gmail.com' } });

  // The page and its config are there, saying "Google only".
  const home = await pub('GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal((await pub('GET', '/app.js')).status, 200);
  const config = await (await pub('GET', '/api/config')).json();
  assert.deepEqual([config.sign_in, config.public, config.web_google_client_id], ['google', true, CLIENT]);

  // No password sign-in through the door, however the address is written.
  for (const url of ['/api/auth/login', '/API/auth/login', '//api/auth/login', '/api/auth/login/', '/api/auth/%6Cogin', '/api/auth/login?x=1']) {
    const res = await pub('POST', url, { json: { username: 'boss', password: PASSWORD } });
    assert.equal(res.status, 404, url);
  }
  // A password session (e.g. a phone's, if it leaked) doesn't work through the door...
  assert.equal((await pub('GET', '/api/me', { token: boss })).status, 401);
  // ...a Google one does, for the dashboard's own calls.
  const google = (await (await pub('POST', '/api/auth/google', { json: { credential: 'valid:owner@gmail.com' } })).json()).token;
  assert.equal((await pub('GET', '/api/me', { token: google })).status, 200);
  assert.equal((await pub('GET', '/api/devices', { token: google })).status, 200);
  assert.equal((await pub('GET', '/api/relays', { token: google })).status, 200);
  assert.equal((await pub('POST', '/api/auth/password', { token: google, json: {} })).status, 404);

  // Home Assistant's sidebar headers mean nothing there.
  assert.equal((await pub('GET', '/api/me', { headers: { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'owner' } })).status, 401);

  // Nothing for TVs, relays or files, in any spelling.
  const tv = await (await call('POST', '/api/player/register', { json: {} })).json();
  for (const [method, url] of [
    ['POST', '/api/player/register'], ['GET', '/api/player/status'], ['GET', '/Api/Player/status'], ['GET', '/api/player%2Fstatus'],
    ['GET', '/media/1'], ['GET', '/MEDIA/1'], ['GET', '/api/relay/v1/me'], ['GET', '/api/relay/status'], ['POST', '/api/relay/v1/pair'],
    ['GET', '/relay.html'], ['GET', '/api/%2E%2E/api/player/status'],
  ]) {
    assert.equal((await pub(method, url, { token: tv.token })).status, 404, `${method} ${url}`);
  }
  // Only reading pages outside /api (no posting to odd paths).
  assert.equal((await pub('POST', '/index.html')).status, 404);
  // The relays' live connection doesn't open through the door.
  const opened = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${doorPort}/api/relay/v1/ws`);
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  assert.equal(opened, false);

  // At home, nothing changed: password sign-in works, and so does the phone's session.
  assert.equal((await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: boss })).status, 200);
  assert.equal((await (await call('GET', '/api/config')).json()).sign_in, 'password');
});
