// 0.11.1: tighter sign-in, after a security review of the Google sign-in.
//  1. A linked Google account is remembered by its permanent ID, not only its email address.
//  2. The internet address tells browsers which scripts may run (Content-Security-Policy).
//  3. Google sign-in attempts are limited per visitor, so one visitor can't lock everyone out.
//  4. Sessions are kept as a hash, so a copy of the database can't be used to sign in.
// The pretend Google (fake-google.js) accepts "valid:<email>#sub:<account id>".
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, createPublicServer } = require('../src/app');
const { openDatabase, setSetting } = require('../src/db');
const { createFakeGoogle } = require('./fake-google');

const PASSWORD = 'correct-horse-9';
const CLIENT = '1234567890-abc123def.apps.googleusercontent.com';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function start(t, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-signin-'))) {
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
  await call('PATCH', '/api/settings', { token: boss, json: { google_web_client_id: CLIENT } });
  return { app, call, pub, boss };
}

test('a linked Google account is the same account every time, not just the same email address', async (t) => {
  const { call, boss } = await start(t);
  const pat = await (await call('POST', '/api/users', { token: boss, json: { username: 'patrick', role: 'system_manager', password: PASSWORD, google_email: 'pat@shop.example.com' } })).json();
  const google = (credential) => call('POST', '/api/auth/google', { json: { credential } });

  // The first sign-in remembers the account; it keeps working.
  assert.equal((await google('valid:pat@shop.example.com#sub:111')).status, 200);
  assert.equal((await google('valid:pat@shop.example.com#sub:111')).status, 200);
  // Someone else's Google account that now has the same address (e.g. a reused work address): refused.
  const other = await google('valid:pat@shop.example.com#sub:222');
  assert.equal(other.status, 403);
  assert.match((await other.json()).error, /isn’t the Google account that was linked/);

  // Linking again on the Users page starts fresh: the next sign-in decides which account it is.
  await call('PATCH', `/api/users/${pat.id}`, { token: boss, json: { google_email: 'pat2@shop.example.com' } });
  await call('PATCH', `/api/users/${pat.id}`, { token: boss, json: { google_email: 'pat@shop.example.com' } });
  assert.equal((await google('valid:pat@shop.example.com#sub:222')).status, 200);
  assert.equal((await google('valid:pat@shop.example.com#sub:111')).status, 403);
});

test('the internet address tells the browser to run only this server’s and Google’s scripts', async (t) => {
  const { pub, call } = await start(t);
  for (const url of ['/', '/app.js', '/api/config']) {
    const csp = (await pub('GET', url)).headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client(;|$)/, url);
    assert.match(csp, /frame-ancestors 'none'/, url);
    assert.match(csp, /object-src 'none'/, url);
  }
  // At home the page is unchanged (it also runs inside Home Assistant's sidebar).
  assert.equal((await call('GET', '/')).headers.get('content-security-policy'), null);
});

test('Google sign-in attempts are limited per visitor, so one visitor can’t lock everyone out', async (t) => {
  const { pub, call } = await start(t);
  // On the internet address Tailscale gives the visitor's address in X-Forwarded-For.
  const from = (address) => pub('POST', '/api/auth/google', { json: { credential: 'valid:nobody@gmail.com' }, headers: { 'x-forwarded-for': address } });
  for (let i = 0; i < 10; i++) assert.equal((await from('203.0.113.7')).status, 403);
  assert.equal((await from('203.0.113.7')).status, 429);
  // Anything the visitor added in front of their real address doesn't change who they are.
  assert.equal((await from('198.51.100.1, 203.0.113.7')).status, 429);
  // Everyone else can still sign in.
  assert.equal((await from('198.51.100.1')).status, 403);
  // At home, a made-up X-Forwarded-For is ignored: it's counted by the real connection.
  const home = (address) => call('POST', '/api/auth/google', { json: { credential: 'valid:nobody@gmail.com' }, headers: { 'x-forwarded-for': address } });
  for (let i = 0; i < 10; i++) assert.equal((await home(`10.0.0.${i}`)).status, 403);
  assert.equal((await home('10.0.0.99')).status, 429);
});

test('sessions are kept only as a hash; sessions from before the update keep working', async (t) => {
  // A database from 0.11.0: one session, stored as the token itself.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-signin-old-'));
  const old = openDatabase(dataDir);
  old.prepare(`INSERT INTO users (email, role, password_hash, created_at) VALUES ('sandy', 'content_uploader', NULL, 1)`).run();
  const oldToken = 'a'.repeat(64);
  old.prepare(`INSERT INTO sessions (token, user_id, created_at, method) VALUES (?, (SELECT id FROM users WHERE email = 'sandy'), ?, 'password')`).run(oldToken, Date.now());
  setSetting(old, 'session_tokens_hashed', null);
  old.close();

  const { app, call, boss } = await start(t, dataDir);
  const db = app.locals.db;
  // Upgraded in place: nobody is signed out, and the database no longer holds the token.
  assert.equal((await (await call('GET', '/api/me', { token: oldToken })).json()).username, 'sandy');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`).get(oldToken).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`).get(sha256(oldToken)).n, 1);
  // Done once: opening the database again (the next restart) doesn't hash the hashes.
  openDatabase(dataDir).close();
  assert.equal((await call('GET', '/api/me', { token: oldToken })).status, 200);

  // New sign-ins are stored as a hash too, and the hash itself doesn't sign anyone in.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`).get(boss).n, 0);
  assert.equal((await call('GET', '/api/me', { token: sha256(boss) })).status, 401);
  // Signing out still removes the session.
  assert.equal((await call('POST', '/api/auth/logout', { token: oldToken })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: oldToken })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: boss })).status, 200);
});
