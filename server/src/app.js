// The API. Each `app.get/post/put/patch/delete(...)` line is a "route":
// a URL the admin app or the player app can call.
//
//   /api/auth/...      admin app: sign in with Google, sign out
//   /api/me            admin app: who am I and what's my role
//   /api/users...      superadmin: who may use the admin app, and their roles
//   /api/media...      library of files in the Google Drive folder; upload, delete
//   /api/playlists...  named playlists (landscape or portrait) and their items
//   /api/devices...    pair (QR code or PIN), set up, remove TV players
//   /api/player/...    TV players: register, check pairing, get playlist, heartbeat
//   /media/:id         download a file (streamed from Drive, or a playback copy)

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const http = require('node:http');
const { openDatabase, bumpPlaylistVersions, playlistsUsingMedia, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const { createRelays } = require('./relays');
const { MediaCache } = require('./media-cache');
const { checkHours, summarizeHours, isOpenAt } = require('./hours');
const { createTranscoder } = require('./transcode');
const { LOCAL_PANEL } = require('./notify');
const { parseServiceAccountKey, explainDriveError } = require('./google');
const { chooseRendition, playbackWarning, normalizeDecoderCaps, PROFILE_IDS } = require('./renditions');

// File types the player can show, by MIME type and by file extension.
const TYPE_BY_MIME = { 'video/mp4': 'video', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image' };
const MIME_BY_EXT = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const PLAYLIST_ORIENTATIONS = ['landscape', 'portrait'];
const DEVICE_ORIENTATIONS = ['landscape', 'portrait_right', 'portrait_left'];

// A player counts as "online" if it sent a heartbeat in the last 2 minutes.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

// A TV is "waiting to be added" while it asked for its code in the last 10
// minutes. One that never gets added is forgotten after a day.
const WAITING_WINDOW_MS = 10 * 60 * 1000;
const WAITING_FORGET_MS = 24 * 60 * 60 * 1000;

// Files starting within this time are sent to TVs early, to download ahead.
const UPCOMING_MS = 24 * 60 * 60 * 1000;

// A screen counts as "down" (worth a notification) after this long without a
// word, during its location's working hours.
const ALERT_AFTER_MS = 5 * 60 * 1000;

// Opening the library re-reads the Drive folder at most this often.
const SYNC_THROTTLE_MS = 60 * 1000;

// Letters and digits that are hard to confuse on a TV screen (no 0/O, 1/I/L).
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Works out whether a Drive file is something the player can show.
function mediaKind(name, mimeType) {
  const mime = TYPE_BY_MIME[mimeType] ? mimeType : MIME_BY_EXT[path.extname(name).toLowerCase()];
  return mime ? { mime, type: TYPE_BY_MIME[mime] } : null;
}

// Wider than tall is landscape, taller than wide is portrait. Unknown size
// (Drive hasn't finished processing a new video) means "still checking".
// True if an app version like "0.5.1" is at least "0.5.0". Unknown versions count as older.
function versionAtLeast(version, wanted) {
  const parts = (v) => String(v || '').split('.').map((n) => parseInt(n, 10));
  const have = parts(version);
  const need = parts(wanted);
  if (have.some(Number.isNaN) || have.length < 2) return false;
  for (let i = 0; i < need.length; i++) {
    const a = have[i] || 0;
    if (a !== need[i]) return a > need[i];
  }
  return true;
}

function orientationOf(width, height) {
  if (!width || !height) return null;
  return width >= height ? 'landscape' : 'portrait';
}

function createApp({
  dataDir,
  google,
  firstAdmin = null, // { username, password }: made a superadmin at start-up if that username doesn't exist yet
  mediaCacheDir = null, // where local copies of Drive files can be kept (see media-cache.js)
  cacheMedia = true, // whether to keep them, until changed on the web Settings page
  maxUploadBytes = 8 * 1024 ** 3,
  syncIntervalMs = 5 * 60 * 1000,
  siteName = null, // this server's own site, e.g. "Head office"; TVs at other sites come through relays
  homeAssistant = null, // notify.js, when running as a Home Assistant add-on
  googleKeyFile = null, // where a Google key added on the Settings page is kept; null = it can't be added there
  monitorIntervalMs = 60 * 1000, // how often to look for offline screens (0 = never; tests call checkScreens)
  // Playback copies. Omit it and copies stay off (tests). The real server turns them on.
  transcode = null,
  log = console.log,
}) {
  const db = openDatabase(dataDir);
  // A random ID made once, so a TV can recognise "its" server if the address changes.
  let serverId = getSetting(db, 'server_id');
  if (!serverId) setSetting(db, 'server_id', (serverId = crypto.randomUUID()));
  // What went wrong with Google Drive, as one sentence that says what to do.
  // The log gets the short reason too, not Google's whole request dump.
  function driveProblem(err) {
    const reason = explainDriveError(err, google.keyEmail ? google.keyEmail() : null);
    log(`Google Drive: ${(err && err.message) || err} -> ${reason}`);
    return reason;
  }
  // Which site a TV is at. A paired relay proves who it is with its credential (see
  // relayGate below); its site comes from that. TVs talking to this server directly are
  // at this server's own site. An unpaired relay (from before 0.7.0) only says its site
  // in the X-Kiosk-Site header, which is accepted until relays are required to pair.
  const siteOf = (req) => (req.kioskSite !== undefined ? req.kioskSite : siteName || null);

  // Locations are keyed by site; '' is this server's own site while it has no name.
  const ownSite = siteName || '';
  if (siteName) {
    // A site name was set later: move this site's screens and locations under it.
    db.prepare(`UPDATE locations SET site = ? WHERE site = ''`).run(siteName);
    db.prepare(`UPDATE playlists SET site = ? WHERE site = ''`).run(siteName);
    db.prepare(`UPDATE devices SET site = ? WHERE site IS NULL`).run(siteName);
  }
  const relays = createRelays({ db, log, ownSite });
  relays.pruneEvents();
  // Location names typed on screens before locations existed become real locations.
  db.prepare(
    `INSERT OR IGNORE INTO locations (site, name, created_at)
     SELECT DISTINCT COALESCE(d.site, ''), d.location, ? FROM devices d
     WHERE d.claimed = 1 AND d.location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.name = d.location)`
  ).run(Date.now());
  // Locations are one list for the whole system. A screen is in the location that has
  // its location name, whichever site (Home Assistant) it connects through. Should two
  // sites each have a location of that name (from older versions), its own site's wins.
  const locationOf = (d) => (d.location
    ? db.prepare(`SELECT * FROM locations WHERE name = ? ORDER BY site = ? DESC, id LIMIT 1`).get(d.location, d.site || '')
    : null);
  // The same rule in SQL, for "the screens in location @loc_id": use it on the devices table.
  const IN_LOCATION = `devices.location IS NOT NULL AND @loc_id = (
    SELECT l.id FROM locations l WHERE l.name = devices.location ORDER BY l.site = COALESCE(devices.site, '') DESC, l.id LIMIT 1)`;
  const hoursOf = (loc) => (loc && loc.hours ? JSON.parse(loc.hours) : null);
  const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cacheStore = mediaCacheDir ? new MediaCache(mediaCacheDir) : null;
  const cacheOn = () => Boolean(cacheStore) && (getSetting(db, 'cache_media') ?? cacheMedia);
  const pruneCache = () => {
    if (cacheStore) cacheStore.prune(db.prepare(`SELECT id, md5, filename FROM media WHERE removed_at IS NULL`).all());
  };
  const transcodeOptions = transcode && typeof transcode === 'object' ? transcode : {};
  const renditionDir = transcodeOptions.dir || path.join(dataDir, 'renditions');

  // A copy of the original for ffmpeg to read. The Drive file and the cache file are not written.
  function freeBytes(dir) {
    try {
      const stats = fs.statfsSync(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  async function fetchOriginal(media) {
    const cache = cacheOn() ? cacheStore : null;
    if (cache && cache.has(media)) return { path: cache.pathFor(media), temporary: false };
    fs.mkdirSync(renditionDir, { recursive: true });
    if (freeBytes(renditionDir) < media.size + 64 * 1024 * 1024) {
      throw new Error('Not enough free space to make a playback copy');
    }
    const dest = path.join(renditionDir, `.src-${media.id}-${media.md5}${path.extname(media.filename).toLowerCase() || '.bin'}`);
    const download = await google.downloadStream(media.drive_file_id);
    const hash = crypto.createHash('md5');
    const timer = setTimeout(() => download.stream.destroy(new Error('timed out reading the original')), 10 * 60 * 1000);
    try {
      await pipeline(download.stream, new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }), fs.createWriteStream(dest));
    } finally {
      clearTimeout(timer);
    }
    if (hash.digest('hex') !== media.md5) {
      fs.rmSync(dest, { force: true });
      throw new Error('Downloaded file did not match its fingerprint');
    }
    // Keep the download in the local cache so the TVs don't fetch it from Drive again.
    if (cache) {
      const cached = cache.pathFor(media);
      fs.renameSync(dest, cached);
      return { path: cached, temporary: false };
    }
    return { path: dest, temporary: true };
  }

  const transcoder = createTranscoder({
    db,
    dir: renditionDir,
    downloadOriginal: fetchOriginal,
    enabledDefault: Boolean(transcodeOptions.enabled),
    hevc4kDefault: Boolean(transcodeOptions.hevc4k),
    inline: Boolean(transcodeOptions.inline),
    probe: transcodeOptions.probe || null,
    runFfmpeg: transcodeOptions.run || null,
    log,
    getSetting: (key) => getSetting(db, key),
    threads: transcodeOptions.threads,
    timeoutMs: transcodeOptions.timeoutMs,
    backlogDelayMs: transcodeOptions.backlogDelayMs,
    backlogGapMs: transcodeOptions.backlogGapMs,
    retryDelayMs: transcodeOptions.retryDelayMs,
    maxAttempts: transcodeOptions.maxAttempts,
  });
  transcoder.resume();
  // A Drive folder chosen on the web Settings page wins over the start-up setting.
  const savedFolder = getSetting(db, 'drive_folder_id');
  if (savedFolder && google.setFolderId) google.setFolderId(savedFolder);

  // The first superadmin, for a server run outside Home Assistant (where the sidebar
  // page can't be used to make one). Made once; changing the password later is done in the app.
  if (firstAdmin && firstAdmin.username && firstAdmin.password) {
    const username = String(firstAdmin.username).trim().toLowerCase();
    if (!auth.USERNAME.test(username) || auth.checkNewPassword(firstAdmin.password)) {
      log('The first admin was not made: the username or password is not usable (the password needs at least 8 characters).');
    } else if (!db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(username)) {
      db.prepare(`INSERT INTO users (email, role, password_hash, created_at) VALUES (?, 'superadmin', ?, ?)`)
        .run(username, auth.hashPasswordSync(firstAdmin.password), Date.now());
    }
  }

  const requireContent = auth.requireRole(db, auth.CAN_MANAGE_CONTENT);
  const requireDevices = auth.requireRole(db, auth.CAN_MANAGE_DEVICES);
  const requireUsers = auth.requireRole(db, auth.CAN_MANAGE_USERS);
  const requireAnyUser = auth.requireRole(db, auth.ROLES);

  const app = express();
  app.use(express.json());

  // Every TV request (and file download) says which relay, if any, it came through.
  //  - A paired relay add-on sends its credential in X-Kiosk-Relay-Auth: the site is that relay's.
  //  - Without one, an X-Kiosk-Site header is an unpaired relay from before 0.7.0. It is refused
  //    once relays must pair (Settings), and always for a site whose relay has paired or is
  //    disabled, so a paired relay's site can't be claimed by anything else.
  //  - With neither, the TV talks to this server directly.
  function relayGate(req, res, next) {
    const secret = req.get('x-kiosk-relay-auth');
    if (secret) {
      const result = relays.authenticate(secret, ['proxy']);
      if (result.error) return res.status(result.status).json({ error: result.error });
      req.relay = result.relay;
      req.kioskSite = result.relay.site;
      return next();
    }
    const claimed = String(req.get('x-kiosk-site') || '').trim().slice(0, 80);
    if (!claimed) {
      req.kioskSite = siteName || null;
      return next();
    }
    const known = relays.relayBySite(claimed);
    const paired = known && db.prepare(`SELECT 1 FROM relay_credentials WHERE relay_id = ? AND kind = 'proxy' AND revoked_at IS NULL`).get(known.id);
    if (getSetting(db, 'relays_require_credentials') || paired || (known && known.status === 'disabled')) {
      return res.status(401).json({ error: 'This relay must be paired with the main Kiosk server. Add its pairing code in the relay add-on’s Configuration tab.' });
    }
    req.unpairedRelay = known || null;
    req.kioskSite = claimed;
    next();
  }
  app.use(['/api/player', '/media'], relayGate);

  // A TV seen through a relay belongs to that relay, if no relay owns it yet.
  function noteRelayOf(req, deviceId) {
    if (req.relay) relays.noteTvVia(req.relay, deviceId);
    else if (req.unpairedRelay && req.unpairedRelay.status !== 'disabled' && !relays.ownerOf(deviceId)) relays.noteTvVia(req.unpairedRelay, deviceId);
  }

  // The web interface: plain files in server/public, served as they are.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Public settings the admin app needs before anyone signs in: the Google
  // client ID that "Sign in with Google" must use for this server.
  app.get('/api/config', (req, res) =>
    res.json({
      // People sign in with a username and password made on the Users page.
      sign_in: 'password',
      google_web_client_id: null, // apps from before 0.6.0 look for this; they can no longer sign in
      web_code_sign_in: false,
      version: SERVER_VERSION,
      // TVs search the network for this to find the server by themselves.
      kind: 'kiosk-signage',
      role: 'main',
      server_id: serverId,
      site_name: siteName,
    })
  );

  // ---------- Sign in (phone app and web page) ----------

  // Five wrong passwords for a username lock it for five minutes, so a password
  // can't be found by trying thousands of them.
  const MAX_TRIES = 5;
  const LOCK_MS = 5 * 60 * 1000;
  const tries = new Map(); // username -> { count, lockedUntil }

  app.post('/api/auth/login', async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = req.body && req.body.password;
    if (!username || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Enter your username and password' });
    }
    const now = Date.now();
    const record = tries.get(username);
    if (record && record.lockedUntil > now) {
      const minutes = Math.ceil((record.lockedUntil - now) / 60000);
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    }
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(username);
    const ok = await auth.checkPassword(password, user ? user.password_hash : null);
    if (!ok) {
      const count = (record && record.lockedUntil <= now && record.count >= MAX_TRIES ? 0 : (record ? record.count : 0)) + 1;
      tries.set(username, { count, lockedUntil: count >= MAX_TRIES ? now + LOCK_MS : 0 });
      if (tries.size > 10000) tries.clear(); // never grows without limit
      // The same answer whether the username or the password was wrong.
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    tries.delete(username);
    const token = auth.newToken();
    db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, now);
    res.json({ token, username: user.email, email: user.email, role: user.role });
  });

  app.post('/api/auth/logout', requireAnyUser, (req, res) => {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(auth.bearerToken(req));
    res.json({ ok: true });
  });

  app.get('/api/me', requireAnyUser, (req, res) => {
    res.json({
      username: req.user.email,
      email: req.user.email,
      role: req.user.role,
      via_home_assistant: Boolean(req.user.viaHomeAssistant),
    });
  });

  // Change your own password. Other devices signed in as you are signed out.
  app.post('/api/auth/password', requireAnyUser, async (req, res) => {
    if (req.user.viaHomeAssistant) return res.status(400).json({ error: 'You are signed in through Home Assistant, which has no Kiosk password' });
    const body = req.body || {};
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!(await auth.checkPassword(body.current_password, user.password_hash))) {
      return res.status(403).json({ error: 'Your current password isn\'t right' });
    }
    const problem = auth.checkNewPassword(body.new_password);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await auth.hashPassword(body.new_password), user.id);
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token != ?`).run(user.id, auth.bearerToken(req));
    res.json({ ok: true });
  });

  // ---------- Users and roles (superadmin) ----------

  // "email" is the column the username lives in; both names are sent for older pages.
  const userView = (u) => ({ id: u.id, username: u.email, email: u.email, role: u.role, created_at: u.created_at, has_password: Boolean(u.password_hash) });
  const findUser = (id) => db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);

  app.get('/api/users', requireUsers, (req, res) => {
    res.json(db.prepare(`SELECT * FROM users ORDER BY email`).all().map(userView));
  });

  app.post('/api/users', requireUsers, async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    if (!auth.USERNAME.test(username)) {
      return res.status(400).json({ error: 'A username is 3 to 40 letters or digits (and . _ - @), starting with a letter or digit' });
    }
    if (!auth.ROLES.includes(body.role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}` });
    const problem = auth.checkNewPassword(body.password);
    if (problem) return res.status(400).json({ error: problem });
    if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(username)) return res.status(409).json({ error: 'That username is taken' });
    const result = db.prepare(`INSERT INTO users (email, role, password_hash, created_at) VALUES (?, ?, ?, ?)`)
      .run(username, body.role, await auth.hashPassword(body.password), Date.now());
    res.status(201).json(userView(findUser(result.lastInsertRowid)));
  });

  // Change someone's role, or give them a new password (which signs them out everywhere).
  // You can't change your own role or remove yourself, so there is always a superadmin.
  app.patch('/api/users/:id', requireUsers, async (req, res) => {
    const body = req.body || {};
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (body.role === undefined && body.password === undefined) return res.status(400).json({ error: 'Send a role or a password' });
    if (body.role !== undefined) {
      if (!auth.ROLES.includes(body.role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}` });
      if (user.id === req.user.id) return res.status(400).json({ error: "You can't change your own role" });
    }
    if (body.password !== undefined) {
      const problem = auth.checkNewPassword(body.password);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (body.role !== undefined) db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(body.role, user.id);
    if (body.password !== undefined) {
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await auth.hashPassword(body.password), user.id);
      db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token != ?`).run(user.id, auth.bearerToken(req) || '');
      tries.delete(user.email);
    }
    res.json(userView(findUser(user.id)));
  });

  app.delete('/api/users/:id', requireUsers, (req, res) => {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
    const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id); // also signs them out
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---------- Media library (Google Drive folder) ----------

  const mediaColumns = `id, filename, type, mime, size, md5, width, height, orientation, created_at, starts_at, expires_at`;
  const removedColumns = `${mediaColumns}, removed_at, removed_reason`;

  // Takes a file out of Kiosk: out of the library and every playlist, and off
  // the screens (their playlists change, so they drop it). Google Drive is not
  // touched, and the file can be restored from "Expired and removed".
  function retireMedia(ids, reason) {
    if (!ids.length) return;
    db.transaction(() => {
      for (const id of ids) {
        bumpPlaylistVersions(db, playlistsUsingMedia(db, id));
        db.prepare(`DELETE FROM playlist_items WHERE media_id = ?`).run(id);
        db.prepare(`UPDATE media SET removed_at = ?, removed_reason = ? WHERE id = ?`).run(Date.now(), reason, id);
      }
    })();
    for (const id of ids) transcoder.forget(id); // its playback copies go too; made again if restored
    pruneCache();
  }

  // Files whose expiry date has passed leave Kiosk.
  function expireDue() {
    const due = db.prepare(`SELECT id FROM media WHERE removed_at IS NULL AND expires_at <= ?`).all(Date.now());
    retireMedia(due.map((r) => r.id), 'expired');
  }

  // A file's dates from the apps: when it starts showing (null = straight away)
  // and when it leaves Kiosk (null = never; otherwise in the future, after the start).
  function checkSchedule(startsAt, expiresAt) {
    for (const [name, value] of [['starts_at', startsAt], ['expires_at', expiresAt]]) {
      if (value != null && !Number.isSafeInteger(value)) return { error: `${name} must be a time in milliseconds, or null` };
    }
    if (expiresAt != null && expiresAt <= Date.now()) return { error: 'Choose an end date in the future' };
    if (startsAt != null && expiresAt != null && startsAt >= expiresAt) return { error: 'The end date must be after the start date' };
    return { startsAt: startsAt ?? null, expiresAt: expiresAt ?? null };
  }
  const headerTime = (req, name) => (req.get(name) ? Number(req.get(name)) : null);

  // Saves (or refreshes) one Drive file in our catalogue. Returns the row,
  // or null if it's not a file type the player can show.
  function upsertMedia(file) {
    const kind = mediaKind(file.name, file.mimeType);
    if (!kind || !file.md5Checksum) return null;
    const orientation = orientationOf(file.width, file.height);
    const existing = db.prepare(`SELECT * FROM media WHERE drive_file_id = ?`).get(file.id);
    if (!existing) {
      db.prepare(
        `INSERT INTO media (drive_file_id, filename, type, mime, size, md5, width, height, orientation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(file.id, file.name, kind.type, kind.mime, file.size, file.md5Checksum, file.width, file.height, orientation, Date.now());
    } else if (
      existing.md5 !== file.md5Checksum || existing.filename !== file.name ||
      existing.width !== file.width || existing.height !== file.height
    ) {
      db.prepare(
        `UPDATE media SET filename = ?, type = ?, mime = ?, size = ?, md5 = ?, width = ?, height = ?, orientation = ? WHERE id = ?`
      ).run(file.name, kind.type, kind.mime, file.size, file.md5Checksum, file.width, file.height, orientation, existing.id);
      // The content changed, so players showing it must download it again.
      if (existing.md5 !== file.md5Checksum) bumpPlaylistVersions(db, playlistsUsingMedia(db, existing.id));
    }
    const row = db.prepare(`SELECT ${mediaColumns} FROM media WHERE drive_file_id = ?`).get(file.id);
    // Expired and removed files stay remembered (so the sync doesn't bring them back) but get no copies.
    const removed = row && db.prepare(`SELECT removed_at FROM media WHERE id = ?`).get(row.id).removed_at;
    if (row && row.type === 'video' && !removed) transcoder.schedule(row);
    return row;
  }

  // Makes our catalogue match the Drive folder: new files are added to the
  // library (NOT to any playlist), missing files are removed everywhere.
  let lastSyncAt = 0;
  let syncInFlight = null;
  function syncDriveFolder() {
    if (!syncInFlight) {
      syncInFlight = (async () => {
        const files = await google.listFolder();
        const seen = new Set();
        const removed = [];
        db.transaction(() => {
          for (const file of files) if (upsertMedia(file)) seen.add(file.id);
          for (const row of db.prepare(`SELECT id, drive_file_id FROM media`).all()) {
            if (seen.has(row.drive_file_id)) continue;
            transcoder.forget(row.id);
            bumpPlaylistVersions(db, playlistsUsingMedia(db, row.id));
            removed.push(row.id);
            db.prepare(`DELETE FROM media WHERE id = ?`).run(row.id);
          }
        })();
        for (const id of removed) transcoder.forget(id);
        lastSyncAt = Date.now();
        pruneCache();
        await transcoder.idle();
      })().finally(() => (syncInFlight = null));
    }
    return syncInFlight;
  }

  const mediaPublic = mediaColumns.split(',').map((name) => name.trim());

  function presentMedia(row) {
    if (!row) return null;
    const full = db.prepare(`SELECT * FROM media WHERE id = ?`).get(row.id) || row;
    const out = {};
    for (const key of mediaPublic) out[key] = full[key];
    out.playback_warning = playbackWarning(full, transcoder.list(full.id), {
      transcodeEnabled: transcoder.requested(),
      ffmpegAvailable: transcoder.ffmpegAvailable(),
    });
    return out;
  }

  function presentMany(rows) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const fullRows = db.prepare(`SELECT * FROM media WHERE id IN (${placeholders})`).all(...ids);
    const renditionRows = db.prepare(
      `SELECT media_id, profile, status, width, height, fps, size, md5, source_md5, error FROM renditions WHERE media_id IN (${placeholders})`
    ).all(...ids);
    const byId = new Map(fullRows.map((row) => [row.id, row]));
    const grouped = new Map();
    for (const rendition of renditionRows) {
      const list = grouped.get(rendition.media_id) || [];
      list.push(rendition);
      grouped.set(rendition.media_id, list);
    }
    const transcodeEnabled = transcoder.requested();
    const ffmpegAvailable = transcoder.ffmpegAvailable();
    return ids.map((id) => {
      const full = byId.get(id);
      if (!full) return null;
      const out = {};
      for (const key of mediaPublic) out[key] = full[key];
      out.playback_warning = playbackWarning(full, grouped.get(id) || [], { transcodeEnabled, ffmpegAvailable });
      return out;
    }).filter(Boolean);
  }

  function libraryResponse(syncError) {
    const items = db.prepare(`SELECT id FROM media WHERE removed_at IS NULL ORDER BY created_at DESC`).all();
    const removed = db.prepare(`SELECT ${removedColumns} FROM media WHERE removed_at IS NOT NULL ORDER BY removed_at DESC`).all();
    return { items: presentMany(items), removed, synced_at: lastSyncAt || null, sync_error: syncError };
  }

  // Lists the library. Re-reads Drive first if it's been more than a minute,
  // or if a file's shape is still being checked.
  // If Drive can't be reached, the last known list is returned with sync_error.
  app.get('/api/media', requireContent, async (req, res) => {
    expireDue();
    let syncError = null;
    const checking = db.prepare(`SELECT 1 FROM media WHERE orientation IS NULL LIMIT 1`).get();
    if (Date.now() - lastSyncAt > SYNC_THROTTLE_MS || checking) {
      try {
        await syncDriveFolder();
      } catch (err) {
        syncError = `${driveProblem(err)} Showing the last known list.`;
      }
    }
    res.json(libraryResponse(syncError));
  });

  // The "pull to refresh" in the admin app: re-read Drive right now.
  app.post('/api/media/sync', requireContent, async (req, res) => {
    try {
      await syncDriveFolder();
    } catch (err) {
      return res.status(502).json({ error: driveProblem(err) });
    }
    res.json(libraryResponse(null));
  });

  // File picker upload: the request body IS the file (not a form), and it is
  // streamed straight on to Google Drive, so nothing is stored on this server.
  // The app sends the original name in the "X-Filename" header.
  app.post('/api/media', requireContent, async (req, res) => {
    const filename = decodeURIComponent(req.get('x-filename') || '').trim();
    if (!filename) return res.status(400).json({ error: 'Missing X-Filename header' });
    const kind = mediaKind(filename, (req.get('content-type') || '').split(';')[0].trim().toLowerCase());
    if (!kind) return res.status(415).json({ error: 'Only .mp4, .jpg, .png and .webp files are supported' });
    // Optional start and end dates chosen while uploading.
    const schedule = checkSchedule(headerTime(req, 'x-starts-at'), headerTime(req, 'x-expires-at'));
    if (schedule.error) return res.status(400).json({ error: schedule.error });
    if (Number(req.get('content-length')) > maxUploadBytes) return res.status(413).json({ error: 'File is too large' });

    // Sits between the phone and Drive, counting bytes so a file that is too
    // big is stopped part-way instead of filling up the Drive.
    let size = 0;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxUploadBytes) return callback(Object.assign(new Error('File is too large'), { status: 413 }));
        callback(null, chunk);
      },
    });
    pipeline(req, meter).catch(() => {}); // errors show up as meter.errored below

    let file;
    try {
      file = await google.uploadFile(meter, filename, kind.mime);
    } catch (err) {
      if (meter.errored) {
        return res.status(meter.errored.status || 400).json({ error: 'Upload failed: ' + meter.errored.message });
      }
      const reason = driveProblem(err);
      req.unpipe(meter);
      req.resume(); // throw away the rest of the phone's upload so the reply gets through
      return res.status(502).json({ error: `Could not save the file to Google Drive. ${reason}` });
    }
    if (meter.errored || size === 0) {
      // Drive accepted something, but it was cut short or empty; don't keep it.
      await google.deleteFile(file.id).catch(log);
      return res.status(400).json({ error: meter.errored ? 'Upload failed: ' + meter.errored.message : 'File is empty' });
    }
    const saved = upsertMedia(file);
    db.prepare(`UPDATE media SET starts_at = ?, expires_at = ? WHERE id = ?`).run(schedule.startsAt, schedule.expiresAt, saved.id);
    await transcoder.idle();
    res.status(201).json(presentMedia(saved));
  });

  // Set or clear a file's start and end dates (either or both).
  app.patch('/api/media/:id', requireContent, (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ? AND removed_at IS NULL`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const schedule = checkSchedule(
      'starts_at' in body ? body.starts_at : media.starts_at,
      'expires_at' in body ? body.expires_at : media.expires_at,
    );
    if (schedule.error) return res.status(400).json({ error: schedule.error });
    db.prepare(`UPDATE media SET starts_at = ?, expires_at = ? WHERE id = ?`).run(schedule.startsAt, schedule.expiresAt, media.id);
    // A changed start date can change what screens play.
    bumpPlaylistVersions(db, playlistsUsingMedia(db, media.id));
    res.json(presentMedia(media));
  });

  // "Remove from Kiosk": out of the library, playlists and screens. The file
  // stays in Google Drive; Kiosk never deletes anything there.
  app.delete('/api/media/:id', requireContent, (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ? AND removed_at IS NULL`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    retireMedia([media.id], 'removed');
    res.json({ ok: true });
  });

  // Brings an expired or removed file back into the library (not into playlists).
  app.post('/api/media/:id/restore', requireContent, (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ? AND removed_at IS NOT NULL`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    const schedule = checkSchedule((req.body || {}).starts_at, (req.body || {}).expires_at);
    if (schedule.error) return res.status(400).json({ error: schedule.error });
    db.prepare(`UPDATE media SET removed_at = NULL, removed_reason = NULL, starts_at = ?, expires_at = ? WHERE id = ?`)
      .run(schedule.startsAt, schedule.expiresAt, media.id);
    if (media.type === 'video') transcoder.schedule(media); // make its playback copies again
    res.json(presentMedia(media));
  });

  // Download. Served from the local cache when there is a copy; otherwise
  // streamed from Drive (and, with the cache on, saved while it passes).
  // The "Range" header lets an interrupted download on the TV continue where it stopped.
  app.get('/media/:id', auth.requireUserOrDevice(db), async (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ? AND removed_at IS NULL`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    // A playback copy, when the playlist asked for one. The original is still at /media/:id.
    if (req.query.rendition !== undefined) {
      const profile = String(req.query.rendition);
      if (!PROFILE_IDS.includes(profile)) return res.status(404).json({ error: 'Unknown rendition' });
      const rendition = transcoder.get(media.id, profile);
      // source_md5 must be this upload. A copy of the previous file is not served.
      if (!rendition || rendition.status !== 'ready' || rendition.source_md5 !== media.md5) {
        return res.status(404).json({ error: 'That copy is not ready' });
      }
      return res.sendFile(transcoder.pathFor(media.id, profile), {
        headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' },
      });
    }
    const cache = cacheOn() ? cacheStore : null;
    if (cache && cache.has(media)) {
      return res.sendFile(cache.pathFor(media), { headers: { 'Content-Type': media.mime } });
    }
    let download;
    try {
      download = await google.downloadStream(media.drive_file_id, req.get('range'));
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if (status === 404) return res.status(404).json({ error: 'File is gone from Google Drive' });
      if (status === 416) return res.status(416).json({ error: 'Range not satisfiable' });
      log(err);
      return res.status(502).json({ error: 'Could not read the file from Google Drive' });
    }
    res.status(download.status);
    res.set({ 'Content-Type': media.mime, 'Accept-Ranges': 'bytes' });
    for (const [name, value] of Object.entries(download.headers)) if (value) res.set(name, value);
    // Only a whole-file download can become the cached copy. Copy each chunk
    // as it passes, instead of listening for "data" beside the pipeline —
    // those two readers can drop bytes when the machine is busy.
    const recorder = cache && download.status === 200 ? cache.startRecording(media) : null;
    const pass = new Transform({
      transform(chunk, encoding, callback) {
        if (recorder) recorder.write(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(download.stream, pass, res);
      if (recorder) await recorder.finish();
    } catch (err) {
      // Usually the TV disconnected mid-download; it will resume later.
      if (recorder) recorder.abort();
    }
  });

  // ---------- Playlists ----------

  function playlistItems(playlistId) {
    return db.prepare(
      `SELECT p.media_id, p.image_seconds, p.start_at, p.end_at, m.filename, m.type, m.mime, m.size, m.md5, m.orientation,
              m.starts_at, m.expires_at
       FROM playlist_items p JOIN media m ON m.id = p.media_id
       WHERE p.playlist_id = ? ORDER BY p.position`
    ).all(playlistId);
  }

  // Landscape screens play landscape playlists; a screen turned on its side plays portrait ones.
  const shapeOf = (deviceOrientation) => (deviceOrientation === 'landscape' ? 'landscape' : 'portrait');
  const SHAPE_SQL = `(CASE WHEN devices.orientation = 'landscape' THEN 'landscape' ELSE 'portrait' END)`;
  const AUTO_NAMES = { landscape: 'Landscape', portrait: 'Portrait' };

  // Every location has two automatic playlists, Landscape and Portrait. They are made the
  // first time they are needed, so a new location gets them without any setup.
  function autoPlaylist(locationId, orientation) {
    const find = db.prepare(`SELECT * FROM playlists WHERE location_id = ? AND auto = 1 AND orientation = ?`);
    let p = find.get(locationId, orientation);
    if (!p) {
      db.prepare(`INSERT INTO playlists (name, orientation, location_id, auto, created_at) VALUES (?, ?, ?, 1, ?)`)
        .run(AUTO_NAMES[orientation], orientation, locationId, Date.now());
      p = find.get(locationId, orientation);
    }
    return p;
  }
  function ensureAutoPlaylists() {
    for (const loc of db.prepare(`SELECT id FROM locations`).all()) {
      for (const orientation of PLAYLIST_ORIENTATIONS) autoPlaylist(loc.id, orientation);
    }
  }
  // What a screen plays: the playlist it is pinned to, or else its location's automatic
  // one. A screen with no location has nothing to play until it is given one.
  function playlistFor(device) {
    const pinned = device.playlist_id ? findPlaylist(device.playlist_id) : null;
    if (pinned) return pinned;
    const loc = locationOf(device);
    return loc ? autoPlaylist(loc.id, shapeOf(device.orientation)) : null;
  }

  // Playlists used to be one flat list picked per screen (before 0.5.0), then belonged
  // to a site (0.5.x). Once, they are sorted into locations.
  function sortPlaylistsIntoLocations() {
    if (getSetting(db, 'playlists_by_location')) return;
    const cameFromSites = Boolean(getSetting(db, 'playlists_by_site'));
    const locations = db.prepare(`SELECT * FROM locations`).all();
    const pinnedIn = (loc, orientation) => db.prepare(
      `SELECT p.id, COUNT(*) AS n FROM devices JOIN playlists p ON p.id = devices.playlist_id
       WHERE devices.claimed = 1 AND p.location_id IS NULL AND p.auto = 0 AND p.orientation = @orientation
         AND ${SHAPE_SQL} = @orientation AND ${IN_LOCATION}
       GROUP BY p.id ORDER BY n DESC, p.id`
    ).all({ loc_id: loc.id, orientation });
    db.transaction(() => {
      // 0.5.x: a site's automatic playlists. A site with one location hands them to it;
      // otherwise there is no one place for them, and they go.
      for (const p of db.prepare(`SELECT * FROM playlists WHERE auto = 1 AND location_id IS NULL`).all()) {
        const at = locations.filter((l) => l.site === (p.site ?? ''));
        if (at.length === 1 && !db.prepare(`SELECT 1 FROM playlists WHERE location_id = ? AND auto = 1 AND orientation = ?`).get(at[0].id, p.orientation)) {
          db.prepare(`UPDATE playlists SET location_id = ? WHERE id = ?`).run(at[0].id, p.id);
        } else {
          db.prepare(`DELETE FROM playlists WHERE id = ?`).run(p.id);
        }
      }
      for (const loc of locations) {
        for (const orientation of PLAYLIST_ORIENTATIONS) {
          pinnedIn(loc, orientation).forEach((row, i) => {
            const hasAuto = db.prepare(`SELECT 1 FROM playlists WHERE location_id = ? AND auto = 1 AND orientation = ?`).get(loc.id, orientation);
            if (i === 0 && !cameFromSites && !hasAuto) {
              // Before 0.5.0: the playlist most of the location's screens played becomes its
              // automatic one, and those screens simply follow it from now on.
              db.prepare(`UPDATE playlists SET location_id = ?, auto = 1, name = ? WHERE id = ?`).run(loc.id, AUTO_NAMES[orientation], row.id);
              db.prepare(`UPDATE devices SET playlist_id = NULL WHERE playlist_id = @id AND ${IN_LOCATION}`).run({ id: row.id, loc_id: loc.id });
            } else {
              // Others in use here stay as the location's extras, with their screens still pinned.
              db.prepare(`UPDATE playlists SET location_id = ? WHERE id = ?`).run(loc.id, row.id);
            }
          });
        }
      }
      // A playlist pinned to a screen of the other shape stays pinned, as that location's extra.
      for (const loc of locations) {
        db.prepare(
          `UPDATE playlists SET location_id = @loc_id WHERE location_id IS NULL AND auto = 0 AND id IN (
             SELECT playlist_id FROM devices WHERE claimed = 1 AND playlist_id IS NOT NULL AND ${IN_LOCATION})`
        ).run({ loc_id: loc.id });
      }
      // Whatever is left belongs to no location: listed as "older", to move or delete.
      db.prepare(`UPDATE playlists SET site = NULL WHERE location_id IS NULL`).run();
      setSetting(db, 'playlists_by_location', 1);
      setSetting(db, 'playlists_by_site', 1);
    })();
  }

  function playlistSummary(p) {
    // The screens playing it: those pinned to it and, for an automatic one, every screen
    // of that shape in the location that isn't pinned elsewhere.
    const devices = db.prepare(
      `SELECT id, name FROM devices WHERE claimed = 1 AND (playlist_id = @id OR (
         @auto = 1 AND playlist_id IS NULL AND ${SHAPE_SQL} = @orientation AND ${IN_LOCATION}))
       ORDER BY name`
    ).all({ id: p.id, auto: p.auto ? 1 : 0, orientation: p.orientation, loc_id: p.location_id ?? -1 });
    const count = db.prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?`).get(p.id).n;
    const loc = p.location_id ? findLocation(p.location_id) : null;
    return {
      id: p.id,
      name: p.name,
      orientation: p.orientation,
      version: p.version,
      item_count: count,
      devices,
      location_id: loc ? loc.id : null,
      location: loc ? loc.name : null,
      auto: Boolean(p.auto), // the location's automatic Landscape or Portrait playlist
      unassigned: !loc, // from before playlists belonged to locations, and not in use
    };
  }

  sortPlaylistsIntoLocations();

  function playlistDetail(p) {
    return { ...playlistSummary(p), items: playlistItems(p.id) };
  }

  function findPlaylist(id) {
    return db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(id);
  }

  function checkPlaylistFields(body, { partial }) {
    const out = {};
    if (body.name !== undefined || !partial) {
      const name = String(body.name || '').trim();
      if (!name) return { error: 'Give the playlist a name' };
      out.name = name;
    }
    if (body.orientation !== undefined || !partial) {
      if (!PLAYLIST_ORIENTATIONS.includes(body.orientation)) return { error: 'orientation must be landscape or portrait' };
      out.orientation = body.orientation;
    }
    // Which location it belongs to. A new playlist needs one.
    if (body.location_id !== undefined || !partial) {
      if (!Number.isInteger(body.location_id) || !findLocation(body.location_id)) return { error: 'Choose the location this playlist is for' };
      out.location_id = body.location_id;
    }
    return { fields: out };
  }

  // Every playlist, a location at a time: the automatic Landscape and Portrait before a
  // location's extras, and unused older playlists last.
  app.get('/api/playlists', requireContent, (req, res) => {
    ensureAutoPlaylists();
    const rows = db.prepare(
      `SELECT p.* FROM playlists p LEFT JOIN locations l ON l.id = p.location_id
       ORDER BY l.id IS NULL, l.name COLLATE NOCASE, l.id, p.auto DESC, p.orientation, p.name COLLATE NOCASE`
    ).all();
    res.json(rows.map(playlistSummary));
  });

  // An extra playlist for a location, besides its automatic two.
  app.post('/api/playlists', requireContent, (req, res) => {
    const { error, fields } = checkPlaylistFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const result = db.prepare(`INSERT INTO playlists (name, orientation, location_id, auto, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run(fields.name, fields.orientation, fields.location_id, Date.now());
    res.status(201).json(playlistDetail(findPlaylist(result.lastInsertRowid)));
  });

  app.get('/api/playlists/:id', requireContent, (req, res) => {
    const p = findPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(playlistDetail(p));
  });

  app.patch('/api/playlists/:id', requireContent, (req, res) => {
    const p = findPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const { error, fields } = checkPlaylistFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (p.auto && Object.keys(fields).some((k) => fields[k] !== p[k])) {
      return res.status(409).json({ error: 'This is a location\'s automatic playlist: its name, shape and location can\'t be changed. Change what\'s in it instead.' });
    }
    db.prepare(`UPDATE playlists SET name = ?, orientation = ?, location_id = ?, version = version + 1 WHERE id = ?`)
      .run(fields.name ?? p.name, fields.orientation ?? p.orientation, fields.location_id ?? p.location_id, p.id);
    res.json(playlistDetail(findPlaylist(p.id)));
  });

  // The admin app sends the whole list in the new order; we replace the old one.
  app.put('/api/playlists/:id/items', requireContent, (req, res) => {
    const p = findPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Body must be { items: [...] }' });
    const mediaExists = db.prepare(`SELECT 1 FROM media WHERE id = ? AND removed_at IS NULL`);
    for (const item of items) {
      if (!Number.isInteger(item.media_id) || !mediaExists.get(item.media_id)) {
        return res.status(400).json({ error: `Unknown media_id ${item.media_id}` });
      }
      if (item.image_seconds !== undefined && !(Number.isInteger(item.image_seconds) && item.image_seconds >= 1)) {
        return res.status(400).json({ error: 'image_seconds must be a whole number of at least 1' });
      }
      for (const field of ['start_at', 'end_at']) {
        if (item[field] !== undefined && item[field] !== null && (!Number.isSafeInteger(item[field]) || item[field] < 0)) {
          return res.status(400).json({ error: `${field} must be a non-negative Unix timestamp in milliseconds or null` });
        }
      }
      if ((item.start_at == null) !== (item.end_at == null)) {
        return res.status(400).json({ error: 'Set both start_at and end_at, or leave both empty' });
      }
      if (item.start_at != null && item.end_at != null && item.start_at >= item.end_at) {
        return res.status(400).json({ error: 'start_at must be before end_at' });
      }
    }
    // A transaction means "all of these changes or none of them".
    db.transaction(() => {
      db.prepare(`DELETE FROM playlist_items WHERE playlist_id = ?`).run(p.id);
      const insert = db.prepare(`INSERT INTO playlist_items (playlist_id, media_id, position, image_seconds, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?)`);
      items.forEach((item, i) => insert.run(p.id, item.media_id, i, item.image_seconds ?? 10, item.start_at ?? null, item.end_at ?? null));
      bumpPlaylistVersions(db, [p.id]);
    })();
    res.json(playlistDetail(findPlaylist(p.id)));
  });

  // A playlist that players still use can't be deleted: move them first.
  app.delete('/api/playlists/:id', requireContent, (req, res) => {
    const p = findPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.auto) {
      return res.status(409).json({ error: 'This is a location\'s automatic playlist and can\'t be deleted. Take its files out to leave it empty.' });
    }
    const users = db.prepare(`SELECT name FROM devices WHERE playlist_id = ? AND claimed = 1`).all(p.id);
    if (users.length) {
      return res.status(409).json({ error: `Still playing on ${users.map((d) => d.name).join(', ')}. Move those players to another playlist first.` });
    }
    db.prepare(`DELETE FROM playlists WHERE id = ?`).run(p.id);
    res.json({ ok: true });
  });

  // ---------- Devices (superadmin, system manager) ----------

  function deviceView(d) {
    const owner = relays.ownerOf(d.id);
    const current = d.current_media_id
      ? db.prepare(`SELECT filename FROM media WHERE id = ?`).get(d.current_media_id)
      : null;
    const playlist = playlistFor(d);
    const loc = locationOf(d);
    return {
      id: d.id,
      name: d.name,
      location: d.location,
      orientation: d.orientation,
      // A landscape screen mounted upside down. Sent beside "orientation" so that apps
      // from before this existed keep working: they just don't know about the flip.
      flipped: Boolean(d.flipped) && d.orientation === 'landscape',
      can_flip: versionAtLeast(d.app_version, '0.5.0'), // older TV apps can't turn the picture upside down
      // null = "Automatic": the screen follows its location's Landscape or Portrait playlist.
      playlist_id: d.playlist_id,
      playlist_name: playlist ? playlist.name : null, // null: it has no location yet, so nothing to play
      playlist_auto: !d.playlist_id,
      playing_playlist_id: playlist ? playlist.id : null,
      online: d.last_seen != null && Date.now() - d.last_seen < ONLINE_WINDOW_MS,
      last_seen: d.last_seen,
      current_media_id: d.current_media_id,
      current_filename: current ? current.filename : null,
      free_bytes: d.free_bytes,
      app_version: d.app_version,
      model: d.model,
      site: d.site,
      relay: owner ? { id: owner.id, name: owner.name, status: owner.status } : null,
      location_id: loc ? loc.id : null,
      hours_summary: summarizeHours(hoursOf(loc)),
      // false outside the location's working hours (the TV is dark then).
      open_now: isOpenAt(hoursOf(loc), Date.now(), d.time_zone || serverTimeZone),
      after_hours: d.after_hours || 'black',
      playback_error: d.playback_error || null,
      decoders: deviceCaps(d),
      // Set while the TV is downloading new files, e.g. { done: 1, total: 3 }.
      download: d.download_total ? { done: d.download_done || 0, total: d.download_total } : null,
    };
  }

  // Checks name / location / orientation / playlist_id from the admin app.
  function checkDeviceFields(body, { partial }) {
    const out = {};
    if (body.name !== undefined || !partial) {
      const name = String(body.name || '').trim();
      if (!name) return { error: 'Give the player a name' };
      out.name = name;
    }
    // A screen has to be in a location: that is where its playlist comes from.
    if (body.location !== undefined || !partial) {
      const location = String(body.location || '').trim();
      if (!location) return { error: 'Choose a location for this screen' };
      if (location.length > 60) return { error: 'Keep the location\'s name under 60 characters' };
      out.location = location;
    }
    if (body.orientation !== undefined) {
      if (!DEVICE_ORIENTATIONS.includes(body.orientation)) {
        return { error: `orientation must be one of: ${DEVICE_ORIENTATIONS.join(', ')}` };
      }
      out.orientation = body.orientation;
      if (body.orientation !== 'landscape') out.flipped = 0; // only a landscape screen can be upside down
    }
    if (body.flipped !== undefined) {
      if (typeof body.flipped !== 'boolean') return { error: 'flipped must be true or false' };
      out.flipped = body.flipped && (out.orientation ?? 'landscape') === 'landscape' ? 1 : 0;
    }
    if (body.playlist_id !== undefined) {
      if (body.playlist_id !== null && !findPlaylist(body.playlist_id)) return { error: 'Unknown playlist' };
      out.playlist_id = body.playlist_id;
    }
    return { fields: out };
  }

  // A location typed in the phone app that doesn't exist yet is added to the list.
  function ensureLocation(site, name) {
    if (name && !db.prepare(`SELECT 1 FROM locations WHERE name = ?`).get(name)) {
      db.prepare(`INSERT OR IGNORE INTO locations (site, name, created_at) VALUES (?, ?, ?)`).run(site || '', name, Date.now());
    }
  }

  function applyDeviceFields(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
    if (!sets.length) return;
    db.prepare(`UPDATE devices SET ${sets.join(', ')}, config_version = config_version + 1 WHERE id = @id`).run({ ...fields, id });
  }

  app.get('/api/devices', requireDevices, (req, res) => {
    const rows = db.prepare(`SELECT * FROM devices WHERE claimed = 1 ORDER BY site, location, name`).all();
    res.json(rows.map(deviceView));
  });

  // New TVs showing a pairing code right now, so they can be added with one
  // click instead of typing the code. TVs that never got added are tidied up after a day.
  app.get('/api/devices/waiting', requireDevices, (req, res) => {
    const now = Date.now();
    db.prepare(`DELETE FROM devices WHERE claimed = 0 AND COALESCE(last_seen, created_at) < ?`).run(now - WAITING_FORGET_MS);
    const rows = db.prepare(
      `SELECT * FROM devices WHERE claimed = 0 AND last_seen >= ? ORDER BY created_at`
    ).all(now - WAITING_WINDOW_MS);
    res.json(rows.map((d) => ({
      id: d.id,
      model: d.model,
      site: d.site,
      pairing_code: d.pairing_code,
      last_seen: d.last_seen,
    })));
  });

  // Pairing. "code" is either what the admin app read from the TV's QR code
  // ("kiosk-pair:K7P29Q") or what someone typed in ("k7p-29q"). Both work.
  // The rest of the body sets the player up: name, location, orientation, playlist.
  app.post('/api/devices/claim', requireDevices, (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').replace(/^kiosk-pair:/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { error, fields } = checkDeviceFields(body, { partial: false });
    if (error) return res.status(400).json({ error });
    const device = db.prepare(`SELECT * FROM devices WHERE pairing_code = ? AND claimed = 0`).get(code);
    if (!device) return res.status(404).json({ error: 'No player is showing that code' });
    db.transaction(() => {
      db.prepare(`UPDATE devices SET claimed = 1, pairing_code = NULL WHERE id = ?`).run(device.id);
      applyDeviceFields(device.id, fields);
      ensureLocation(device.site, fields.location);
    })();
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(device.id)));
  });

  // Edit a player: any of name, location, orientation, playlist_id.
  app.patch('/api/devices/:id', requireDevices, (req, res) => {
    const device = db.prepare(`SELECT * FROM devices WHERE id = ? AND claimed = 1`).get(req.params.id);
    if (!device) return res.status(404).json({ error: 'Not found' });
    const { error, fields } = checkDeviceFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (fields.flipped && (fields.orientation ?? device.orientation) !== 'landscape') fields.flipped = 0;
    applyDeviceFields(device.id, fields);
    ensureLocation(device.site, fields.location);
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(device.id)));
  });

  // Removing a device makes its token useless; the TV will show a new code.
  app.delete('/api/devices/:id', requireDevices, (req, res) => {
    const result = db.prepare(`DELETE FROM devices WHERE id = ?`).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---------- Locations and their working hours (superadmin, system manager) ----------

  function locationView(loc) {
    const screens = db.prepare(`SELECT id, name FROM devices WHERE claimed = 1 AND ${IN_LOCATION} ORDER BY name`).all({ loc_id: loc.id });
    const hours = hoursOf(loc);
    return {
      id: loc.id,
      site: loc.site || null,
      name: loc.name,
      hours,
      hours_summary: summarizeHours(hours),
      screens,
    };
  }
  const findLocation = (id) => db.prepare(`SELECT * FROM locations WHERE id = ?`).get(id);
  // Every site that has screens or locations, this server's own first.
  function knownSites() {
    const rows = db.prepare(`SELECT DISTINCT COALESCE(site, '') AS site FROM devices UNION SELECT site FROM locations`).all();
    return [...new Set([ownSite, ...rows.map((r) => r.site)])];
  }

  app.get('/api/locations', requireDevices, (req, res) => {
    const rows = db.prepare(`SELECT * FROM locations ORDER BY name COLLATE NOCASE, id`).all();
    res.json({ own_site: ownSite || null, sites: knownSites().map((s) => s || null), locations: rows.map(locationView) });
  });

  app.post('/api/locations', requireDevices, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const site = body.site == null ? ownSite : String(body.site).trim();
    if (!name) return res.status(400).json({ error: 'Give the location a name' });
    if (name.length > 60) return res.status(400).json({ error: 'Keep the name under 60 characters' });
    if (!knownSites().includes(site)) return res.status(400).json({ error: 'Unknown site' });
    if (db.prepare(`SELECT 1 FROM locations WHERE name = ? COLLATE NOCASE`).get(name)) {
      return res.status(409).json({ error: `There's already a location called ${name}` });
    }
    const id = db.prepare(`INSERT INTO locations (site, name, created_at) VALUES (?, ?, ?)`).run(site, name, Date.now()).lastInsertRowid;
    res.status(201).json(locationView(findLocation(id)));
  });

  app.get('/api/locations/:id', requireDevices, (req, res) => {
    const loc = findLocation(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Not found' });
    res.json(locationView(loc));
  });

  // Rename, or change the working hours. The location's screens are told to update.
  app.patch('/api/locations/:id', requireDevices, (req, res) => {
    const loc = findLocation(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    let name = loc.name;
    if (body.name !== undefined) {
      name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Give the location a name' });
      if (name !== loc.name && db.prepare(`SELECT 1 FROM locations WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, loc.id)) {
        return res.status(409).json({ error: `There's already a location called ${name}` });
      }
    }
    let hours = loc.hours;
    if (body.hours !== undefined) {
      const checked = checkHours(body.hours);
      if (checked.error) return res.status(400).json({ error: checked.error });
      hours = checked.hours ? JSON.stringify(checked.hours) : null;
    }
    db.transaction(() => {
      db.prepare(`UPDATE devices SET location = @name, config_version = config_version + 1 WHERE claimed = 1 AND ${IN_LOCATION}`)
        .run({ name, loc_id: loc.id });
      db.prepare(`UPDATE locations SET name = ?, hours = ? WHERE id = ?`).run(name, hours, loc.id);
    })();
    res.json(locationView(findLocation(loc.id)));
  });

  // Deleting needs the location's exact name typed again, and no screens left in it.
  app.delete('/api/locations/:id', requireDevices, (req, res) => {
    const loc = findLocation(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Not found' });
    if (String((req.body || {}).confirm_name || '') !== loc.name) {
      return res.status(400).json({ error: `Type ${loc.name} exactly to delete it` });
    }
    const { screens } = locationView(loc);
    if (screens.length) {
      return res.status(409).json({ error: `Move its screens to another location first: ${screens.map((s) => s.name).join(', ')}`, screens });
    }
    db.transaction(() => {
      // Its two automatic playlists go with it. An extra playlist is kept, without a
      // location, so its contents aren't lost; it can be moved to another location.
      db.prepare(`DELETE FROM playlists WHERE location_id = ? AND auto = 1`).run(loc.id);
      db.prepare(`UPDATE playlists SET location_id = NULL WHERE location_id = ?`).run(loc.id);
      db.prepare(`DELETE FROM locations WHERE id = ?`).run(loc.id);
    })();
    res.json({ ok: true });
  });

  // ---------- Notifications through Home Assistant ----------

  const notifyTargets = () => getSetting(db, 'notify_targets') || [];

  async function notify(title, message, tag) {
    const targets = notifyTargets();
    if (!homeAssistant || !targets.length) return false;
    // Tapping the notification opens Kiosk Signage in the Home Assistant app.
    const url = homeAssistant.panelPath ? await homeAssistant.panelPath() : LOCAL_PANEL;
    const results = await Promise.allSettled(
      targets.map((t) => homeAssistant.send(t, { title, message, data: { url, tag } })),
    );
    results.filter((r) => r.status === 'rejected').forEach((r) => log(`Notification failed: ${r.reason.message}`));
    return results.some((r) => r.status === 'fulfilled');
  }

  const placeOf = (d) => [d.site, d.location].filter(Boolean).join(' › ');
  const clock = (ms, tz) => {
    try {
      return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || serverTimeZone });
    } catch {
      return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
  };

  // Looks for screens that went quiet during their working hours (and ones that
  // came back), and sends one notification for each change. Runs every minute.
  let checking = false;
  async function checkScreens(now = Date.now()) {
    if (!homeAssistant || !notifyTargets().length || checking) return;
    checking = true;
    try {
      const devices = db.prepare(`SELECT * FROM devices WHERE claimed = 1`).all();
      const down = [];
      const back = [];
      for (const d of devices) {
        const silent = d.last_seen == null || now - d.last_seen > ALERT_AFTER_MS;
        // Open now and 5 minutes ago, so a screen waking up at opening time gets a moment.
        const hours = hoursOf(locationOf(d));
        const tz = d.time_zone || serverTimeZone;
        const inHours = isOpenAt(hours, now, tz) && isOpenAt(hours, now - ALERT_AFTER_MS, tz);
        if (silent && inHours && !d.alerted_at) down.push(d);
        else if (!silent && d.alerted_at) back.push(d);
      }

      if (down.length) {
        const lines = [];
        // A whole site going quiet at once is probably that site's internet.
        const bySite = new Map();
        for (const d of down) bySite.set(d.site || '', [...(bySite.get(d.site || '') || []), d]);
        for (const [site, list] of bySite) {
          const atSite = devices.filter((d) => (d.site || '') === site);
          if (site && site !== ownSite && list.length === atSite.length && list.length > 1) {
            lines.push(`${site}: all ${list.length} screens are offline. That site's internet or Home Assistant may be down.`);
          } else {
            for (const d of list) {
              const seen = d.last_seen ? `last seen ${clock(d.last_seen, d.time_zone)}` : 'never connected';
              lines.push(`${d.name}${placeOf(d) ? ` (${placeOf(d)})` : ''}: ${seen}`);
            }
          }
        }
        const title = down.length === 1 ? `${down[0].name} is offline` : `${down.length} screens are offline`;
        const tag = down.length === 1 ? `kiosk-screen-${down[0].id}` : 'kiosk-screens';
        if (await notify(title, lines.join('\n'), tag)) {
          const mark = db.prepare(`UPDATE devices SET alerted_at = ? WHERE id = ?`);
          down.forEach((d) => mark.run(now, d.id));
        }
      }

      if (back.length) {
        const title = back.length === 1 ? `${back[0].name} is back online` : `${back.length} screens are back online`;
        const message = back.map((d) => `${d.name}${placeOf(d) ? ` (${placeOf(d)})` : ''}`).join('\n');
        const tag = back.length === 1 ? `kiosk-screen-${back[0].id}` : 'kiosk-screens';
        if (await notify(title, message, tag)) {
          const clear = db.prepare(`UPDATE devices SET alerted_at = NULL WHERE id = ?`);
          back.forEach((d) => clear.run(d.id));
        }
      }
    } catch (err) {
      log(err);
    } finally {
      checking = false;
    }
  }

  // ---------- Server settings (superadmin, web interface) ----------

  function settingsView() {
    return {
      version: SERVER_VERSION,
      drive_folder_id: google.getFolderId ? google.getFolderId() : null,
      drive_folder_changed_on_web: getSetting(db, 'drive_folder_id') !== undefined,
      // The key itself is never sent back, only which service account it belongs to.
      google_key: {
        present: Boolean(google.keyEmail && google.keyEmail()),
        email: google.keyEmail ? google.keyEmail() : null,
        can_change: Boolean(googleKeyFile && google.setServiceAccountKey),
        added_here: Boolean(googleKeyFile && fs.existsSync(googleKeyFile)),
      },
      cache: cacheStore
        ? { available: true, enabled: cacheOn(), ...cacheStore.stats() }
        : { available: false, enabled: false, files: 0, bytes: 0 },
      users: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL`).get().n,
      // Refuse TVs coming through relays that haven't paired (see relayGate).
      relays_require_credentials: Boolean(getSetting(db, 'relays_require_credentials')),
      library: db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM media WHERE removed_at IS NULL`).get(),
      notifications: { available: Boolean(homeAssistant), targets: notifyTargets() },
      transcode: {
        ffmpeg: transcoder.ffmpegAvailable(),
        enabled: transcoder.requested(),
        hevc_4k: transcoder.hevc4k(),
        active: transcoder.enabled(),
      },
    };
  }

  app.get('/api/settings', requireUsers, (req, res) => res.json(settingsView()));

  app.patch('/api/settings', requireUsers, async (req, res) => {
    const body = req.body || {};
    if (body.drive_folder_id !== undefined) {
      const id = String(body.drive_folder_id || '').trim();
      if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return res.status(400).json({ error: 'That doesn\'t look like a Drive folder ID' });
      setSetting(db, 'drive_folder_id', id);
      google.setFolderId(id);
      lastSyncAt = 0; // read the new folder next time the library is opened
    }
    if (body.cache_media !== undefined) {
      if (typeof body.cache_media !== 'boolean') return res.status(400).json({ error: 'cache_media must be true or false' });
      setSetting(db, 'cache_media', body.cache_media);
    }
    if (body.relays_require_credentials !== undefined) {
      if (typeof body.relays_require_credentials !== 'boolean') return res.status(400).json({ error: 'relays_require_credentials must be true or false' });
      setSetting(db, 'relays_require_credentials', body.relays_require_credentials || null);
    }
    if (body.notify_targets !== undefined) {
      const list = body.notify_targets;
      if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && /^[a-z0-9_]+$/.test(t))) {
        return res.status(400).json({ error: 'notify_targets must be a list of Home Assistant notify services' });
      }
      setSetting(db, 'notify_targets', [...new Set(list)]);
    }
    if (body.transcode_videos !== undefined) {
      if (typeof body.transcode_videos !== 'boolean') return res.status(400).json({ error: 'transcode_videos must be true or false' });
      setSetting(db, 'transcode_videos', body.transcode_videos);
    }
    if (body.transcode_4k_hevc !== undefined) {
      if (typeof body.transcode_4k_hevc !== 'boolean') return res.status(400).json({ error: 'transcode_4k_hevc must be true or false' });
      setSetting(db, 'transcode_4k_hevc', body.transcode_4k_hevc);
    }
    if (body.transcode_videos === false) transcoder.shutdown();
    else if (body.transcode_videos === true || body.transcode_4k_hevc === true) await transcoder.resume();
    res.json(settingsView());
  });

  // The Google key (the service account's .json file), uploaded or pasted on
  // the Settings page. It is checked, kept in the server's own data folder
  // where only the server reads it, and used straight away.
  app.put('/api/settings/google-key', requireUsers, (req, res) => {
    if (!googleKeyFile || !google.setServiceAccountKey) {
      return res.status(400).json({ error: 'The Google key can\'t be changed here on this server' });
    }
    let key;
    try {
      key = parseServiceAccountKey((req.body || {}).key);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      google.setServiceAccountKey(key);
    } catch (err) {
      return res.status(400).json({ error: 'That key couldn\'t be read. Download a new key and try again.' });
    }
    const temp = `${googleKeyFile}.new`;
    fs.writeFileSync(temp, JSON.stringify({ type: 'service_account', ...key }), { mode: 0o600 });
    fs.renameSync(temp, googleKeyFile);
    lastSyncAt = 0; // read Drive with the new key next time the library is opened
    log(`Google key saved for ${key.client_email}`);
    res.json(settingsView());
  });

  // "Test connection": can the server read the Drive folder right now?
  app.post('/api/settings/test-drive', requireUsers, async (req, res) => {
    try {
      const files = await google.listFolder();
      res.json({ ok: true, files: files.length });
    } catch (err) {
      res.status(502).json({ ok: false, error: driveProblem(err) });
    }
  });

  // Home Assistant's notify services, for the Settings page's checkboxes.
  app.get('/api/settings/notify-targets', requireUsers, async (req, res) => {
    if (!homeAssistant) return res.json({ available: false, targets: [] });
    try {
      res.json({ available: true, targets: await homeAssistant.listTargets() });
    } catch (err) {
      log(err);
      res.status(502).json({ error: 'Could not ask Home Assistant for its notify services' });
    }
  });

  app.post('/api/settings/test-notification', requireUsers, async (req, res) => {
    if (!homeAssistant) return res.status(400).json({ error: 'Notifications work when Kiosk runs as a Home Assistant add-on' });
    if (!notifyTargets().length) return res.status(400).json({ error: 'Tick at least one device to notify first' });
    const sent = await notify('Kiosk Signage test', 'Notifications are working. You\'ll hear from Kiosk when a screen goes offline during working hours.', 'kiosk-test');
    if (!sent) return res.status(502).json({ error: 'Home Assistant didn\'t accept the notification. Check the Kiosk add-on log.' });
    res.json({ ok: true });
  });

  app.post('/api/settings/clear-cache', requireUsers, (req, res) => {
    if (cacheStore) cacheStore.clear();
    res.json(settingsView());
  });

  // ---------- Player (TV) ----------

  // First launch: the player gets a secret token (kept on the TV) and a short
  // pairing code, which it shows on screen as a QR code and as text.
  app.post('/api/player/register', (req, res) => {
    const token = auth.newToken();
    const body = req.body || {};
    const appVersion = typeof body.app_version === 'string' ? body.app_version : null;
    const model = typeof body.model === 'string' ? body.model.trim().slice(0, 80) || null : null;
    const caps = normalizeDecoderCaps(body.decoders);
    const insert = db.prepare(
      `INSERT INTO devices (token, pairing_code, app_version, model, site, decoder_caps, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomPairingCode();
      try {
        const now = Date.now();
        const made = insert.run(token, code, appVersion, model, siteOf(req), caps ? JSON.stringify(caps) : null, now, now);
        noteRelayOf(req, made.lastInsertRowid);
        return res.status(201).json({ token, pairing_code: code, qr_payload: `kiosk-pair:${code}` });
      } catch (err) {
        if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err; // otherwise: code taken, try another
      }
    }
    res.status(503).json({ error: 'Could not create a pairing code, try again' });
  });

  app.get('/api/player/status', auth.requireDevice(db, { claimedOnly: false }), (req, res) => {
    const d = req.device;
    // A TV waiting to be added asks every few seconds; that keeps it on the "waiting" list.
    if (!d.claimed) db.prepare(`UPDATE devices SET last_seen = ?, site = ? WHERE id = ?`).run(Date.now(), siteOf(req), d.id);
    noteRelayOf(req, d.id);
    res.json({
      claimed: !!d.claimed,
      name: d.name,
      pairing_code: d.pairing_code,
      qr_payload: d.pairing_code ? `kiosk-pair:${d.pairing_code}` : null,
    });
  });

  // What this TV should play, and how to turn the picture for its screen.
  // "version" changes whenever the playlist, its files, the chosen copy, or this TV's settings change.
  function deviceCaps(device) {
    if (!device.decoder_caps) return null;
    try {
      const parsed = JSON.parse(device.decoder_caps);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // Older apps never send decoder info: they get the 1080p copy, or the original
  // if that copy does not exist yet. Newer apps get the copy that fits.
  function fileForPlayer(item, device) {
    const chosen = item.type === 'video'
      ? chooseRendition(transcoder.list(item.media_id), deviceCaps(device), item.md5)
      : null;
    if (!chosen) {
      return { url: `/media/${item.media_id}`, md5: item.md5, size: item.size, rendition: null };
    }
    return {
      url: `/media/${item.media_id}?rendition=${chosen.profile}`,
      md5: chosen.md5,
      size: chosen.size,
      rendition: chosen.profile,
    };
  }

  function playerPlaylist(device) {
    const playlist = device.claimed ? playlistFor(device) : null;
    const now = Date.now();
    const all = playlist ? playlistItems(playlist.id) : [];
    // When an entry may play: both the file's dates and the playlist entry's dates allow it.
    const startOf = (item) => Math.max(item.starts_at ?? 0, item.start_at ?? 0);
    const ended = (item) => item.end_at != null && now >= item.end_at;
    const items = all.filter((item) => startOf(item) <= now && !ended(item));
    // Starting within a day: the TV downloads these ahead, but doesn't play them yet.
    const upcoming = all.filter((item) => startOf(item) > now && startOf(item) <= now + UPCOMING_MS && !ended(item))
      .filter((item, i, list) => !items.some((x) => x.media_id === item.media_id) && list.findIndex((x) => x.media_id === item.media_id) === i);
    // Each video is sent as the playback copy that suits this TV (or the original).
    const toPlayer = (r) => {
      const file = fileForPlayer(r, device);
      return {
        id: r.media_id,
        type: r.type,
        filename: r.filename,
        url: file.url,
        md5: file.md5,
        size: file.size,
        orientation: r.orientation,
        duration_seconds: r.type === 'image' ? r.image_seconds : null,
        rendition: file.rendition,
      };
    };
    const playing = items.map(toPlayer);
    const ahead = upcoming.map(toPlayer);
    const ids = (list) => list.map((item) => item.id).join(',');
    // Only the copy we are actually sending. A later, unused copy finishing does not
    // change this, and the media ids are not repeated inside the rendition tag.
    const choices = playing.map((file) => file.rendition || 'orig').join(',');
    return {
      version: `${device.config_version}.${playlist ? playlist.id : 0}.${playlist ? playlist.version : 0}.${choices}.${ids(playing)}` +
        (ahead.length ? `~${ids(ahead)}` : ''),
      name: device.name,
      orientation: device.orientation,
      flipped: Boolean(device.flipped) && device.orientation === 'landscape',
      playlist_name: playlist ? playlist.name : null,
      items: playing,
      upcoming: ahead,
      // The location's working hours; the TV goes dark outside them (null = always on).
      hours: hoursOf(locationOf(device)),
    };
  }

  app.get('/api/player/playlist', auth.requireDevice(db), (req, res) => {
    expireDue();
    res.json(playerPlaylist(req.device));
  });

  app.post('/api/player/heartbeat', auth.requireDevice(db), (req, res) => {
    expireDue(); // so the version below already leaves out files that just expired
    const body = req.body || {};
    const caps = normalizeDecoderCaps(body.decoders);
    let playbackError;
    if (Object.prototype.hasOwnProperty.call(body, 'playback_error')) {
      const raw = body.playback_error;
      playbackError = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;
    }
    const sets = [
      'last_seen = ?', 'current_media_id = ?', 'free_bytes = ?', 'app_version = ?',
      'download_done = ?', 'download_total = ?', 'site = ?', 'time_zone = ?', 'after_hours = ?',
    ];
    const params = [
      Date.now(),
      Number.isInteger(body.current_media_id) ? body.current_media_id : null,
      Number.isInteger(body.free_bytes) ? body.free_bytes : null,
      typeof body.app_version === 'string' ? body.app_version : req.device.app_version,
      Number.isInteger(body.download_done) ? body.download_done : null,
      Number.isInteger(body.download_total) ? body.download_total : null,
      siteOf(req),
      typeof body.time_zone === 'string' ? body.time_zone.slice(0, 64) : req.device.time_zone,
      ['black', 'standby'].includes(body.after_hours) ? body.after_hours : req.device.after_hours,
    ];
    if (caps) {
      sets.push('decoder_caps = ?');
      params.push(JSON.stringify(caps));
    }
    if (playbackError !== undefined) {
      sets.push('playback_error = ?');
      params.push(playbackError);
    }
    params.push(req.device.id);
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    noteRelayOf(req, req.device.id);
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(req.device.id);
    res.json({ ok: true, version: playerPlaylist(device).version });
  });

  installRelayRoutes();

  // ---------- Relays (see relays.js) ----------

  function installRelayRoutes() {
    const actorOf = (req) => (req.user.viaHomeAssistant ? 'user:home-assistant' : `user:${req.user.id}`);
    const userIdOf = (req) => (req.user.viaHomeAssistant ? null : req.user.id);
    const findOr404 = (req, res) => {
      const relay = relays.findRelay(req.params.id);
      if (!relay) res.status(404).json({ error: 'Not found' });
      return relay;
    };

    // ----- for admins (Spongebob) -----

    app.get('/api/relays', requireUsers, (req, res) => {
      const rows = db.prepare(`SELECT * FROM relays ORDER BY name COLLATE NOCASE`).all();
      res.json({
        relays: rows.map(relays.relayView),
        require_credentials: Boolean(getSetting(db, 'relays_require_credentials')),
        own_site: siteName || null,
      });
    });

    app.post('/api/relays', requireUsers, (req, res) => {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const site = String(body.site || name).trim();
      const description = String(body.description || '').trim().slice(0, 200) || null;
      if (!name || name.length > 60) return res.status(400).json({ error: 'Give the relay a name of up to 60 characters' });
      if (!site || site.length > 80) return res.status(400).json({ error: 'The site name must be 1 to 80 characters' });
      if (site === (siteName || '')) return res.status(409).json({ error: 'That is this main server’s own site name' });
      if (relays.relayBySite(site)) return res.status(409).json({ error: `There's already a relay for the site ${site}` });
      const id = relays.randomId('rly');
      db.prepare(`INSERT INTO relays (id, name, site, description, status, created_at, created_by) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, name, site, description, Date.now(), userIdOf(req));
      relays.event(id, 'created', { actor: actorOf(req), detail: { name, site } });
      const pairing = relays.newPairingCode(id, actorOf(req));
      res.status(201).json({ relay: relays.relayView(relays.findRelay(id)), pairing_code: pairing.code, expires_at: pairing.expires_at });
    });

    app.get('/api/relays/:id', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (relay) res.json(relays.relayView(relay));
    });

    app.patch('/api/relays/:id', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (!relay) return;
      const body = req.body || {};
      const name = body.name === undefined ? relay.name : String(body.name || '').trim();
      if (!name || name.length > 60) return res.status(400).json({ error: 'Give the relay a name of up to 60 characters' });
      const description = body.description === undefined ? relay.description : (String(body.description || '').trim().slice(0, 200) || null);
      let status = relay.status;
      if (body.status !== undefined) {
        if (!['active', 'disabled'].includes(body.status)) return res.status(400).json({ error: 'status must be active or disabled' });
        // Enabling a relay that never paired leaves it waiting for its pairing.
        status = body.status === 'disabled' ? 'disabled' : (relay.paired_at ? 'active' : 'pending');
      }
      db.prepare(`UPDATE relays SET name = ?, description = ?, status = ?, disabled_at = ? WHERE id = ?`)
        .run(name, description, status, status === 'disabled' ? (relay.disabled_at || Date.now()) : null, relay.id);
      if (status !== relay.status) relays.event(relay.id, status === 'disabled' ? 'disabled' : 'enabled', { actor: actorOf(req) });
      if (name !== relay.name || description !== relay.description) relays.event(relay.id, 'edited', { actor: actorOf(req), detail: { name } });
      res.json(relays.relayView(relays.findRelay(relay.id)));
    });

    app.post('/api/relays/:id/pairing-code', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (!relay) return;
      if (relay.status === 'disabled') return res.status(409).json({ error: 'Enable this relay before pairing it' });
      const pairing = relays.newPairingCode(relay.id, actorOf(req));
      res.status(201).json({ relay: relays.relayView(relays.findRelay(relay.id)), pairing_code: pairing.code, expires_at: pairing.expires_at });
    });

    app.post('/api/relays/:id/credentials/:cid/revoke', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (!relay) return;
      if (!relays.revokeCredential(relay.id, req.params.cid, 'revoked by an admin', actorOf(req))) {
        return res.status(404).json({ error: 'No such credential, or it was already revoked' });
      }
      res.json(relays.relayView(relays.findRelay(relay.id)));
    });

    app.get('/api/relays/:id/events', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (!relay) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(
        `SELECT e.id, e.kind, e.detail, e.actor, e.created_at, e.device_id, d.name AS device_name
         FROM relay_events e LEFT JOIN devices d ON d.id = e.device_id
         WHERE e.relay_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT ?`
      ).all(relay.id, before, limit);
      res.json(rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })));
    });

    app.delete('/api/relays/:id', requireUsers, (req, res) => {
      const relay = findOr404(req, res);
      if (!relay) return;
      if (String((req.body || {}).confirm_name || '') !== relay.name) return res.status(400).json({ error: `Type ${relay.name} exactly to delete it` });
      const view = relays.relayView(relay);
      if (view.players.length) return res.status(409).json({ error: `Move its screens to another relay first: ${view.players.map((p) => p.name).join(', ')}` });
      db.prepare(`DELETE FROM relays WHERE id = ?`).run(relay.id);
      relays.event(null, 'relay_deleted', { actor: actorOf(req), detail: { id: relay.id, name: relay.name } });
      res.json({ ok: true });
    });

    // Which relay owns a screen (null: this main server's own).
    app.put('/api/devices/:id/relay', requireDevices, (req, res) => {
      const device = db.prepare(`SELECT * FROM devices WHERE id = ? AND claimed = 1`).get(req.params.id);
      if (!device) return res.status(404).json({ error: 'Not found' });
      const relayId = (req.body || {}).relay_id ?? null;
      if (relayId !== null && !relays.findRelay(relayId)) return res.status(400).json({ error: 'Unknown relay' });
      relays.assign(device.id, relayId, { userId: userIdOf(req), label: actorOf(req) });
      res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(device.id)));
    });

    // ----- for relays -----

    // Every relay request is checked: a valid credential of an allowed kind, for an enabled relay.
    const requireRelay = (kinds) => (req, res, next) => {
      const header = req.get('authorization') || '';
      const result = relays.authenticate(header.startsWith('Bearer ') ? header.slice(7) : '', kinds);
      if (result.error) return res.status(result.status).json({ error: result.error });
      req.relay = result.relay;
      req.relayCredential = result.credential;
      next();
    };

    // Pairing: a code from Settings → Home Assistant Relays, used once by each piece of the relay.
    app.post('/api/relay/v1/pair', (req, res) => {
      if (!relays.pairingAllowed(req.ip || req.socket.remoteAddress || '')) {
        return res.status(429).json({ error: 'Too many pairing attempts. Wait a minute and try again.' });
      }
      const body = req.body || {};
      const result = relays.pair(body.code, body.kind, body.client || {});
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.status(201).json({
        relay: { id: result.relay.id, name: result.relay.name, site: result.relay.site },
        credential_id: result.credentialId,
        credential: result.credential, // shown once; only its hash is kept
        server: { version: SERVER_VERSION, server_id: serverId },
      });
    });

    app.get('/api/relay/v1/me', requireRelay(['control', 'proxy']), (req, res) => {
      res.json({
        relay: { id: req.relay.id, name: req.relay.name, site: req.relay.site, status: req.relay.status },
        credential: { id: req.relayCredential.id, kind: req.relayCredential.kind },
        server: { version: SERVER_VERSION, server_id: serverId, time: Date.now() },
      });
    });

    app.post('/api/relay/v1/heartbeat', requireRelay(['control', 'proxy']), (req, res) => {
      const version = typeof (req.body || {}).version === 'string' ? req.body.version.slice(0, 40) : null;
      if (version && version !== req.relay.last_version) db.prepare(`UPDATE relays SET last_version = ? WHERE id = ?`).run(version, req.relay.id);
      db.prepare(`UPDATE relays SET last_seen_at = ? WHERE id = ?`).run(Date.now(), req.relay.id);
      res.json({ ok: true, server_time: Date.now() });
    });

    // A new credential for the caller. The old one keeps working until the new one is first used.
    app.post('/api/relay/v1/credentials/rotate', requireRelay(['control', 'proxy']), (req, res) => {
      const rotated = relays.rotate(req.relay, req.relayCredential);
      res.status(201).json({ credential_id: rotated.credentialId, credential: rotated.credential });
    });

    // A relay's own screens only. Another relay's screen is 404, as if it didn't exist.
    const RELAY_PLAYER_FIELDS = [
      'id', 'name', 'location', 'location_id', 'orientation', 'flipped', 'online', 'last_seen', 'current_media_id',
      'current_filename', 'playlist_id', 'playlist_name', 'playlist_auto', 'playing_playlist_id', 'app_version', 'model',
      'free_bytes', 'open_now', 'after_hours', 'hours_summary', 'playback_error', 'download',
    ];
    const relayPlayerView = (d) => {
      const full = deviceView(d);
      return Object.fromEntries(RELAY_PLAYER_FIELDS.map((k) => [k, full[k] ?? null]));
    };
    const ownedDevices = (relayId) => db.prepare(
      `SELECT d.* FROM relay_player_assignments a JOIN devices d ON d.id = a.device_id
       WHERE a.relay_id = ? AND d.claimed = 1 ORDER BY d.name COLLATE NOCASE`
    ).all(relayId);
    app.get('/api/relay/v1/players', requireRelay(['control']), (req, res) => {
      res.json(ownedDevices(req.relay.id).map(relayPlayerView));
    });
    app.get('/api/relay/v1/players/:id', requireRelay(['control']), (req, res) => {
      const d = db.prepare(
        `SELECT d.* FROM relay_player_assignments a JOIN devices d ON d.id = a.device_id
         WHERE a.relay_id = ? AND d.id = ? AND d.claimed = 1`
      ).get(req.relay.id, Number(req.params.id) || 0);
      if (!d) return res.status(404).json({ error: 'Not found' });
      res.json(relayPlayerView(d));
    });
  }

  // Anything that throws ends up here, so the apps always get JSON back.
  app.use((err, req, res, next) => {
    // A request the caller got wrong (e.g. broken JSON) is logged without its body:
    // the body could hold a password, pairing code or relay credential.
    if (err.status && err.status < 500) log(`Bad request to ${req.method} ${req.path}: ${err.message}`);
    else log(err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
  });

  // Expired files leave the screens within a minute, even with nobody signed in.
  if (syncIntervalMs > 0) setInterval(expireDue, 60 * 1000).unref();
  // Offline screens are noticed (and notified) within a minute.
  if (monitorIntervalMs > 0) setInterval(() => checkScreens(), monitorIntervalMs).unref();

  // Keep the library in step with Drive even when nobody has the admin app open.
  if (syncIntervalMs > 0) {
    setInterval(() => syncDriveFolder().catch(log), syncIntervalMs).unref();
  }

  app.locals.db = db;
  app.locals.syncDriveFolder = syncDriveFolder;
  app.locals.checkScreens = checkScreens;
  app.locals.transcoder = transcoder;
  return app;
}

const SERVER_VERSION = require('../package.json').version;

// Home Assistant's sidebar page ("ingress") reaches the server on its own
// private port. Requests there are marked so auth.js can trust the Home
// Assistant user headers, but only when they really come from Home Assistant.
function createIngressServer(app, trustedAddress = '172.30.32.2') {
  return http.createServer((req, res) => {
    const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (from !== trustedAddress) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Only Home Assistant may use this port' }));
    }
    req.viaIngress = true;
    app(req, res);
  });
}

function randomPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return code;
}

// The SUPERADMIN_EMAIL setting is always a superadmin, so you can't lock yourself out.
module.exports = { createApp, createIngressServer };
