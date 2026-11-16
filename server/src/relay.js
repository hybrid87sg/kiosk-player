// "Relay" mode, for a Home Assistant at another site.
//
// The TVs at that site talk to this relay on their own network. The relay
// passes their questions on to the main Kiosk server (over Tailscale) and
// keeps its own copy of each video and picture, so a file crosses the
// internet once per site and then reaches every TV there over the fast local
// network. Everything is managed on the main server; the relay has no
// settings of its own apart from its site name, the main server's address and
// (from 0.7.0) the pairing code made for it on the main server.
//
// Pairing: with a code, the relay asks the main server once for its own credential
// (kind "proxy"), keeps it in /data/relay-credential.json, and sends it with every
// request it passes on. The code itself is never stored, only a fingerprint of it, so
// typing a new code (after a credential was revoked) pairs again.

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MediaCache } = require('./media-cache');
const { normaliseCode } = require('./relays');

const VERSION = require('../package.json').version;
// How long the main server's "yes, that TV is real" answer is trusted.
const TOKEN_CHECK_MS = 5 * 60 * 1000;
// Copies of files no TV has had in its playlist for a day are deleted (expired
// and removed files leave every playlist, so their copies go within a day).
const KEEP_UNUSED_MS = 24 * 60 * 60 * 1000;
// A TV counts as "seen" for the status page if it asked something recently.
const SEEN_WINDOW_MS = 10 * 60 * 1000;
// A playback copy's name, as the main server gives it in a playlist (e.g. h264_1080).
const RENDITION = /^[a-z0-9_]{1,32}$/;
const mediaKey = (id, rendition) => (rendition ? `${id}?rendition=${rendition}` : String(id));
// How often the relay tells the main server it is alive, and retries a pairing that couldn't reach it.
const HEARTBEAT_MS = 30 * 1000;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

/**
 * Tidies the main server's address as typed in the settings.
 * "100.101.102.103" becomes "http://100.101.102.103:3000": the Kiosk server
 * listens on port 3000, so that is assumed when no port is given.
 * An https address, or one with its own port, is left alone.
 */
function normalizeMainUrl(typed) {
  let text = String(typed || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' && !url.port) url.port = '3000';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return text;
  }
}

/**
 * Why the main server couldn't be reached, as one sentence that says where to
 * look. Node reports the low-level reason in err.cause.code.
 */
function whyUnreachable(err) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const name = (err && err.name) || '';
  if (code === 'ECONNREFUSED') {
    return 'The main site answered, but nothing is listening at that address and port. Check that the Kiosk add-on is running at the main site, and that the address ends in :3000.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'That name can\'t be found from here. Use the main site\'s Tailscale address (100.x.x.x) instead of a name.';
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT|EHOSTUNREACH|ENETUNREACH/.test(code)) {
    return 'No answer from that address. This add-on can\'t get onto Tailscale: in this site\'s Tailscale add-on, switch "userspace networking" off and restart it. Also check that Tailscale is connected at the main site.';
  }
  return 'Can\'t reach it. Check that Tailscale is running at both sites, and the main server address in this add-on\'s Configuration tab.';
}

function createRelay({ mainUrl, siteName, dataDir, pairingCode = '', log = console.log, pruneIntervalMs = 60 * 60 * 1000, heartbeatMs = HEARTBEAT_MS }) {
  const main = mainUrl.replace(/\/+$/, '');
  fs.mkdirSync(dataDir, { recursive: true });

  // What the relay remembers between restarts: its ID and the files it has seen.
  const stateFile = path.join(dataDir, 'relay.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // first start
  }
  state.server_id ||= crypto.randomUUID();
  // The files TVs here may ask for, by what they ask for: "5" (the original) or
  // "5?rendition=h264_1080" (a playback copy). Before 0.9.2 the list was by number only,
  // which mixed a copy up with its original, so an older list is started afresh.
  if (state.media_version !== 2) {
    state.media = {};
    state.media_version = 2;
  }
  state.media ||= {}; // key -> { id, rendition, md5, size, filename, seen }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();

  const cache = new MediaCache(path.join(dataDir, 'media-cache'));
  const tokenChecks = new Map(); // token -> { ok, at }
  const tvsSeen = new Map(); // token -> time
  const backgroundDownloads = new Map(); // "id-md5" -> promise
  let mainStatus = { reachable: null, version: null, checked_at: null };

  // ----- pairing with the main server -----

  const credentialFile = path.join(dataDir, 'relay-credential.json');
  let credential = null; // { credential_id, credential, code_fingerprint, relay: { id, name, site } }
  try {
    credential = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  } catch {
    // not paired yet
  }
  const code = normaliseCode(pairingCode);
  const fingerprint = code ? crypto.createHash('sha256').update(`kiosk-relay-code:${code}`).digest('hex') : null;
  // not_paired | pairing | paired | code_invalid | revoked | disabled
  let pairing = { state: credential ? 'paired' : 'not_paired', message: null };
  let codeRefused = false; // the main server said no to this code: wait for a new one

  function saveCredential(value) {
    credential = value;
    if (value) fs.writeFileSync(credentialFile, JSON.stringify(value), { mode: 0o600 });
    else fs.rmSync(credentialFile, { force: true });
  }

  // Asks the main server for this relay's credential, with the code from the Configuration tab.
  async function pair() {
    if (!code || (credential && credential.code_fingerprint === fingerprint)) return;
    pairing = { state: 'pairing', message: null };
    let reply;
    let body = {};
    try {
      reply = await fetch(`${main}/api/relay/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, kind: 'proxy', client: { name: 'Kiosk relay add-on', version: VERSION } }),
        signal: AbortSignal.timeout(15_000),
      });
      body = await reply.json().catch(() => ({}));
    } catch (err) {
      pairing = { state: credential ? 'paired' : 'not_paired', message: `Can't reach the main server to pair: ${whyUnreachable(err)}` };
      return; // tried again with the next heartbeat
    }
    if (reply.status === 201 && typeof body.credential === 'string') {
      saveCredential({ credential_id: body.credential_id, credential: body.credential, code_fingerprint: fingerprint, relay: body.relay });
      pairing = { state: 'paired', message: null };
      log(`Paired with the main server as relay "${body.relay && body.relay.name}"`);
      return;
    }
    if (reply.status === 429) {
      pairing = { state: 'not_paired', message: 'Too many pairing attempts. The relay will try again in a minute.' };
      return;
    }
    // A wrong, used or expired code: don't keep trying it.
    pairing = {
      state: 'code_invalid',
      message: `${body.error || `The main server refused the pairing code (${reply.status}).`} Make a new code on the main server (Settings → Home Assistant Relays) and put it in this add-on's Configuration tab.`,
    };
    codeRefused = true;
    log(`Pairing refused by the main server (${reply.status})`);
  }

  // Tells the main server the relay is alive; notices a revoked credential or a disabled relay.
  async function heartbeat() {
    if (!credential) {
      if (code && !codeRefused) await pair();
      return;
    }
    if (code && credential.code_fingerprint !== fingerprint && !codeRefused) {
      await pair(); // a new code was typed in: pair again
      if (!credential) return;
    }
    try {
      const reply = await fetch(`${main}/api/relay/v1/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.credential}` },
        body: JSON.stringify({ version: VERSION }),
        signal: AbortSignal.timeout(10_000),
      });
      if (reply.ok) pairing = { state: 'paired', message: null };
      else if (reply.status === 401) {
        pairing = { state: 'revoked', message: 'The main server no longer accepts this relay\'s credential. Make a new pairing code on the main server (Settings → Home Assistant Relays) and put it in this add-on\'s Configuration tab.' };
      } else if (reply.status === 403) {
        pairing = { state: 'disabled', message: 'This relay is disabled on the main server (Settings → Home Assistant Relays).' };
      }
    } catch {
      // The main server is out of reach; the status page says so already.
    }
  }
  const ready = heartbeat().catch((err) => log(`Relay heartbeat: ${err.message}`));
  if (heartbeatMs > 0) setInterval(() => heartbeat().catch(() => {}), heartbeatMs).unref();

  // Headers that tell the main server which site a request comes from. A paired relay
  // proves it with its credential; an unpaired one (from before 0.7.0) only names its site.
  function siteHeaders() {
    return credential ? { 'x-kiosk-relay-auth': credential.credential, 'x-kiosk-site': siteName } : { 'x-kiosk-site': siteName };
  }

  const app = express();
  app.use(express.json());

  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'relay.html')));
  app.use(express.static(publicDir, { index: false }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // TVs search the network for this, so they find the relay by themselves.
  app.get('/api/config', (req, res) =>
    res.json({
      kind: 'kiosk-signage',
      role: 'relay',
      server_id: state.server_id,
      site_name: siteName,
      main_url: main,
      version: VERSION,
      google_web_client_id: null,
      web_code_sign_in: false,
    })
  );

  // For the small status page shown at this site.
  app.get('/api/relay/status', async (req, res) => {
    try {
      const reply = await fetch(`${main}/api/config`, { signal: AbortSignal.timeout(5000) });
      const config = await reply.json();
      mainStatus = {
        reachable: reply.ok, version: config.version || null, site_name: config.site_name || null, checked_at: Date.now(),
        reason: reply.ok ? null : `Something answered at that address, but it isn't a Kiosk server (it said ${reply.status}). Check the address and that it ends in :3000.`,
      };
    } catch (err) {
      mainStatus = { reachable: false, version: null, error: err.message, reason: whyUnreachable(err), checked_at: Date.now() };
      log(`Main server ${main} not reachable: ${(err.cause && err.cause.code) || err.name || err.message}`);
    }
    const now = Date.now();
    res.json({
      site_name: siteName,
      main_url: main,
      main: mainStatus,
      tvs_seen: [...tvsSeen.values()].filter((t) => now - t < SEEN_WINDOW_MS).length,
      pairing: { ...pairing, relay_name: credential && credential.relay ? credential.relay.name : null, code_given: Boolean(code) },
      cache: cache.stats(),
      version: VERSION,
    });
  });

  const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

  function remember(req) {
    const token = bearer(req);
    if (token) tvsSeen.set(token, Date.now());
  }

  // Passes a TV's request on to the main server, adding which site it's at.
  async function forward(req, extraHeaders = {}) {
    const headers = { ...siteHeaders(), ...extraHeaders };
    if (req.get('authorization')) headers.authorization = req.get('authorization');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    if (hasBody) headers['content-type'] = 'application/json';
    return fetch(`${main}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  // Everything a TV asks about itself and its playlist goes to the main server.
  app.all(/^\/api\/player\//, async (req, res) => {
    remember(req);
    let reply;
    try {
      reply = await forward(req);
    } catch (err) {
      return res.status(502).json({ error: `Can't reach the main Kiosk server (${main})` });
    }
    const text = await reply.text();
    if (reply.ok && req.method === 'GET' && req.path === '/api/player/playlist') learnFiles(text);
    res.status(reply.status).type('application/json').send(text);
  });

  // Notes each file's fingerprint (md5) from a playlist on its way to a TV,
  // so the relay can check its copies.
  function learnFiles(json) {
    let playlist;
    try {
      playlist = JSON.parse(json);
    } catch {
      return;
    }
    const now = Date.now();
    for (const item of [...(playlist.items || []), ...(playlist.upcoming || [])]) {
      if (!item.id || !item.md5) continue;
      const rendition = typeof item.rendition === 'string' && RENDITION.test(item.rendition) ? item.rendition : null;
      state.media[mediaKey(item.id, rendition)] = {
        id: item.id, rendition, md5: item.md5, size: item.size, filename: item.filename, seen: now,
      };
    }
    save();
  }

  // Is this a real, paired TV? Asks the main server, and remembers the answer
  // for a while. If the main server can't be reached, a TV it accepted before
  // still gets its files.
  async function tokenOk(token) {
    if (!token) return false;
    const known = tokenChecks.get(token);
    if (known && Date.now() - known.at < TOKEN_CHECK_MS) return known.ok;
    try {
      const reply = await fetch(`${main}/api/player/status`, {
        headers: { authorization: `Bearer ${token}`, ...siteHeaders() },
        signal: AbortSignal.timeout(10_000),
      });
      // Only a 401 means the TV itself is unknown; anything else (e.g. 503 while this relay
      // isn't accepted by the main server) means "can't tell right now".
      if (!reply.ok && reply.status !== 401) return known ? known.ok : null;
      const ok = reply.ok && (await reply.json()).claimed === true;
      tokenChecks.set(token, { ok, at: Date.now() });
      return ok;
    } catch {
      return known ? known.ok : null; // null: can't tell right now
    }
  }

  // Downloads a whole file from the main server into the relay's copies.
  function downloadInBackground(media, authorization) {
    const key = `${media.id}-${media.md5}`;
    if (backgroundDownloads.has(key)) return backgroundDownloads.get(key);
    const job = (async () => {
      const reply = await fetch(`${main}/media/${mediaKey(media.id, media.rendition)}`, { headers: { authorization, ...siteHeaders() } });
      if (reply.status !== 200) throw new Error(`main server answered ${reply.status}`);
      const recorder = cache.startRecording(media);
      try {
        for await (const chunk of Readable.fromWeb(reply.body)) recorder.write(chunk);
        await recorder.finish();
      } catch (err) {
        recorder.abort();
        throw err;
      }
    })()
      .catch((err) => log(`Relay: could not copy file ${media.id}: ${err.message}`))
      .finally(() => backgroundDownloads.delete(key));
    backgroundDownloads.set(key, job);
    return job;
  }

  // A TV downloading a file. From the relay's copy when there is one;
  // otherwise from the main server, keeping a copy on the way.
  app.get('/media/:id', async (req, res) => {
    remember(req);
    const token = bearer(req);
    const ok = await tokenOk(token);
    if (ok === false) return res.status(401).json({ error: 'Unknown device' });
    if (ok === null) return res.status(502).json({ error: `Can't reach the main Kiosk server (${main})` });

    // The original (/media/5) or a playback copy (/media/5?rendition=h264_1080): both are
    // asked of the main server exactly as the TV asked, and kept apart here.
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    let rendition = null;
    if (req.query.rendition !== undefined) {
      if (typeof req.query.rendition !== 'string' || !RENDITION.test(req.query.rendition)) return res.status(404).json({ error: 'Unknown rendition' });
      rendition = req.query.rendition;
    }
    const key = mediaKey(req.params.id, rendition);
    const media = state.media[key];
    const mime = rendition ? 'video/mp4' : media && MIME_BY_EXT[path.extname(media.filename || '').toLowerCase()];
    if (media && cache.has(media)) {
      return res.sendFile(cache.pathFor(media), { headers: mime ? { 'Content-Type': mime } : {} });
    }

    let reply;
    const range = req.get('range');
    try {
      reply = await fetch(`${main}/media/${key}`, {
        headers: { authorization: req.get('authorization'), ...siteHeaders(), ...(range ? { range } : {}) },
      });
    } catch (err) {
      return res.status(502).json({ error: `Can't reach the main Kiosk server (${main})` });
    }
    res.status(reply.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = reply.headers.get(name);
      if (value) res.set(name, value);
    }
    if (!reply.body) return res.end();
    // A whole-file download is copied as it passes. Part of a file (a resumed
    // download) can't be, so the relay fetches the whole file separately.
    const recorder = media && reply.status === 200 ? cache.startRecording(media) : null;
    if (media && reply.status === 206) downloadInBackground(media, req.get('authorization'));
    const stream = Readable.fromWeb(reply.body);
    if (recorder) stream.on('data', (chunk) => recorder.write(chunk));
    try {
      await pipeline(stream, res);
      if (recorder) await recorder.finish();
    } catch {
      // Usually the TV disconnected mid-download; it will resume later.
      if (recorder) recorder.abort();
    }
  });

  // Copies that no TV has needed for a week are deleted.
  function prune() {
    const now = Date.now();
    for (const [key, m] of Object.entries(state.media)) if (now - m.seen > KEEP_UNUSED_MS) delete state.media[key];
    save();
    cache.prune(Object.values(state.media));
  }
  if (pruneIntervalMs > 0) setInterval(prune, pruneIntervalMs).unref();

  app.use((err, req, res, next) => {
    log(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Server error' });
  });

  app.locals.prune = prune;
  app.locals.ready = ready; // the first pairing attempt / heartbeat
  app.locals.heartbeat = heartbeat;
  app.locals.waitForCopies = () => Promise.all(backgroundDownloads.values());
  return app;
}

module.exports = { createRelay, normalizeMainUrl, whyUnreachable };
