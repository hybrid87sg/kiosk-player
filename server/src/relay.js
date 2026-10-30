// "Relay" mode, for a Home Assistant at another site.
//
// The TVs at that site talk to this relay on their own network. The relay
// passes their questions on to the main Kiosk server (over Tailscale) and
// keeps its own copy of each video and picture, so a file crosses the
// internet once per site and then reaches every TV there over the fast local
// network. Everything is managed on the main server; the relay has no
// settings of its own apart from its site name and the main server's address.

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MediaCache } = require('./media-cache');

const VERSION = require('../package.json').version;
// How long the main server's "yes, that TV is real" answer is trusted.
const TOKEN_CHECK_MS = 5 * 60 * 1000;
// Copies of files no TV has had in its playlist for this long are deleted.
const KEEP_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
// A TV counts as "seen" for the status page if it asked something recently.
const SEEN_WINDOW_MS = 10 * 60 * 1000;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

function createRelay({ mainUrl, siteName, dataDir, log = console.log, pruneIntervalMs = 60 * 60 * 1000 }) {
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
  state.media ||= {}; // media id -> { id, md5, size, filename, seen }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();

  const cache = new MediaCache(path.join(dataDir, 'media-cache'));
  const tokenChecks = new Map(); // token -> { ok, at }
  const tvsSeen = new Map(); // token -> time
  const backgroundDownloads = new Map(); // "id-md5" -> promise
  let mainStatus = { reachable: null, version: null, checked_at: null };

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
      mainStatus = { reachable: reply.ok, version: config.version || null, site_name: config.site_name || null, checked_at: Date.now() };
    } catch (err) {
      mainStatus = { reachable: false, version: null, error: err.message, checked_at: Date.now() };
    }
    const now = Date.now();
    res.json({
      site_name: siteName,
      main_url: main,
      main: mainStatus,
      tvs_seen: [...tvsSeen.values()].filter((t) => now - t < SEEN_WINDOW_MS).length,
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
    const headers = { 'x-kiosk-site': siteName, ...extraHeaders };
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
    for (const item of playlist.items || []) {
      if (!item.id || !item.md5) continue;
      state.media[item.id] = { id: item.id, md5: item.md5, size: item.size, filename: item.filename, seen: now };
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
        headers: { authorization: `Bearer ${token}`, 'x-kiosk-site': siteName },
        signal: AbortSignal.timeout(10_000),
      });
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
      const reply = await fetch(`${main}/media/${media.id}`, { headers: { authorization } });
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

    const media = state.media[req.params.id];
    const mime = media && MIME_BY_EXT[path.extname(media.filename || '').toLowerCase()];
    if (media && cache.has(media)) {
      return res.sendFile(cache.pathFor(media), { headers: mime ? { 'Content-Type': mime } : {} });
    }

    let reply;
    const range = req.get('range');
    try {
      reply = await fetch(`${main}/media/${req.params.id}`, {
        headers: { authorization: req.get('authorization'), 'x-kiosk-site': siteName, ...(range ? { range } : {}) },
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
    for (const [id, m] of Object.entries(state.media)) if (now - m.seen > KEEP_UNUSED_MS) delete state.media[id];
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
  app.locals.waitForCopies = () => Promise.all(backgroundDownloads.values());
  return app;
}

module.exports = { createRelay };
