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
//   /media/:id         download a file (streamed from Drive)

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const http = require('node:http');
const { openDatabase, bumpPlaylistVersions, playlistsUsingMedia, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const { MediaCache } = require('./media-cache');
const { checkHours, summarizeHours, isOpenAt } = require('./hours');

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
function orientationOf(width, height) {
  if (!width || !height) return null;
  return width >= height ? 'landscape' : 'portrait';
}

function createApp({
  dataDir,
  google,
  googleWebClientId = null,
  superadminEmail,
  mediaCacheDir = null, // where local copies of Drive files can be kept (see media-cache.js)
  cacheMedia = true, // whether to keep them, until changed on the web Settings page
  maxUploadBytes = 8 * 1024 ** 3,
  syncIntervalMs = 5 * 60 * 1000,
  siteName = null, // this server's own site, e.g. "Head office"; TVs at other sites come through relays
  homeAssistant = null, // notify.js, when running as a Home Assistant add-on
  monitorIntervalMs = 60 * 1000, // how often to look for offline screens (0 = never; tests call checkScreens)
  log = console.log,
}) {
  const db = openDatabase(dataDir);
  // A random ID made once, so a TV can recognise "its" server if the address changes.
  let serverId = getSetting(db, 'server_id');
  if (!serverId) setSetting(db, 'server_id', (serverId = crypto.randomUUID()));
  // Which site a TV is at: relays add the "X-Kiosk-Site" header; TVs talking
  // to this server directly are at this server's own site.
  const siteOf = (req) => String(req.get('x-kiosk-site') || '').trim().slice(0, 80) || siteName || null;

  // Locations are keyed by site; '' is this server's own site while it has no name.
  const ownSite = siteName || '';
  if (siteName) {
    // A site name was set later: move this site's screens and locations under it.
    db.prepare(`UPDATE locations SET site = ? WHERE site = ''`).run(siteName);
    db.prepare(`UPDATE devices SET site = ? WHERE site IS NULL`).run(siteName);
  }
  // Location names typed on screens before locations existed become real locations.
  db.prepare(
    `INSERT OR IGNORE INTO locations (site, name, created_at)
     SELECT DISTINCT COALESCE(site, ''), location, ? FROM devices WHERE claimed = 1 AND location IS NOT NULL`
  ).run(Date.now());
  const locationOf = (d) => (d.location
    ? db.prepare(`SELECT * FROM locations WHERE site = ? AND name = ?`).get(d.site || '', d.location)
    : null);
  const hoursOf = (loc) => (loc && loc.hours ? JSON.parse(loc.hours) : null);
  const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cacheStore = mediaCacheDir ? new MediaCache(mediaCacheDir) : null;
  const cacheOn = () => Boolean(cacheStore) && (getSetting(db, 'cache_media') ?? cacheMedia);
  const pruneCache = () => {
    if (cacheStore) cacheStore.prune(db.prepare(`SELECT id, md5, filename FROM media WHERE removed_at IS NULL`).all());
  };
  // A Drive folder chosen on the web Settings page wins over the start-up setting.
  const savedFolder = getSetting(db, 'drive_folder_id');
  if (savedFolder && google.setFolderId) google.setFolderId(savedFolder);
  if (superadminEmail) ensureSuperadmin(db, superadminEmail);

  const requireContent = auth.requireRole(db, auth.CAN_MANAGE_CONTENT);
  const requireDevices = auth.requireRole(db, auth.CAN_MANAGE_DEVICES);
  const requireUsers = auth.requireRole(db, auth.CAN_MANAGE_USERS);
  const requireAnyUser = auth.requireRole(db, auth.ROLES);

  const app = express();
  app.use(express.json());

  // The web interface: plain files in server/public, served as they are.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Public settings the admin app needs before anyone signs in: the Google
  // client ID that "Sign in with Google" must use for this server.
  app.get('/api/config', (req, res) =>
    res.json({
      google_web_client_id: googleWebClientId,
      web_code_sign_in: Boolean(google.deviceSignInAvailable),
      version: SERVER_VERSION,
      // TVs search the network for this to find the server by themselves.
      kind: 'kiosk-signage',
      role: 'main',
      server_id: serverId,
      site_name: siteName,
    })
  );

  // ---------- Sign in (admin app) ----------

  // The admin app signs in with Google and sends us Google's "ID token".
  // We check it really came from Google for our app, then look the email up.
  app.post('/api/auth/google', async (req, res) => {
    const idToken = req.body && req.body.id_token;
    if (!idToken) return res.status(400).json({ error: 'Missing id_token' });
    let email;
    try {
      email = (await google.verifyIdToken(idToken)).email.toLowerCase();
    } catch (err) {
      return res.status(401).json({ error: 'Google sign-in could not be verified' });
    }
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (!user) return res.status(403).json({ error: `${email} is not allowed in yet. Ask Spongebob to add you.` });
    const token = auth.newToken();
    db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, Date.now());
    res.json({ token, email: user.email, role: user.role });
  });

  app.post('/api/auth/logout', requireAnyUser, (req, res) => {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(auth.bearerToken(req));
    res.json({ ok: true });
  });

  app.get('/api/me', requireAnyUser, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role, via_home_assistant: Boolean(req.user.viaHomeAssistant) });
  });

  // Web page sign-in with a code: the page shows the code, the person enters
  // it at google.com/device, and the page asks /poll until Google says done.
  const deviceSignIns = new Map(); // poll id -> { deviceCode, expiresAt }

  app.post('/api/auth/device/start', async (req, res) => {
    if (!google.deviceSignInAvailable) {
      return res.status(501).json({ error: 'Web sign-in with Google isn\'t set up on this server yet.' });
    }
    let started;
    try {
      started = await google.startDeviceSignIn();
    } catch (err) {
      log(err);
      return res.status(502).json({ error: 'Could not reach Google to start signing in' });
    }
    const pollId = auth.newToken();
    deviceSignIns.set(pollId, { deviceCode: started.deviceCode, expiresAt: Date.now() + started.expiresIn * 1000 });
    for (const [id, s] of deviceSignIns) if (s.expiresAt < Date.now()) deviceSignIns.delete(id);
    res.json({
      poll_id: pollId,
      user_code: started.userCode,
      verification_url: started.verificationUrl,
      interval: started.interval,
      expires_in: started.expiresIn,
    });
  });

  app.post('/api/auth/device/poll', async (req, res) => {
    const pending = deviceSignIns.get(req.body && req.body.poll_id);
    if (!pending || pending.expiresAt < Date.now()) return res.status(410).json({ error: 'This code has expired. Start again.' });
    let result;
    try {
      result = await google.pollDeviceSignIn(pending.deviceCode);
    } catch (err) {
      log(err);
      return res.status(502).json({ error: 'Google sign-in could not be checked' });
    }
    if (result.status !== 'done') {
      if (result.status === 'denied' || result.status === 'expired') deviceSignIns.delete(req.body.poll_id);
      return res.json({ status: result.status });
    }
    deviceSignIns.delete(req.body.poll_id);
    const email = result.email.toLowerCase();
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (!user) return res.status(403).json({ error: `${email} is not allowed in yet. Ask Spongebob to add you.` });
    const token = auth.newToken();
    db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, Date.now());
    res.json({ status: 'done', token, email: user.email, role: user.role });
  });

  // ---------- Users and roles (superadmin) ----------

  const userColumns = `id, email, role, created_at`;

  app.get('/api/users', requireUsers, (req, res) => {
    res.json(db.prepare(`SELECT ${userColumns} FROM users ORDER BY email`).all());
  });

  app.post('/api/users', requireUsers, (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const role = req.body && req.body.role;
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!auth.ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}` });
    if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(email)) return res.status(409).json({ error: 'That email is already a user' });
    const result = db.prepare(`INSERT INTO users (email, role, created_at) VALUES (?, ?, ?)`).run(email, role, Date.now());
    res.status(201).json(db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(result.lastInsertRowid));
  });

  // You can't change or remove yourself, so there is always at least one superadmin.
  app.patch('/api/users/:id', requireUsers, (req, res) => {
    const role = req.body && req.body.role;
    if (!auth.ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}` });
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't change your own role" });
    const result = db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json(db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(req.params.id));
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
    return db.prepare(`SELECT ${mediaColumns} FROM media WHERE drive_file_id = ?`).get(file.id);
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
        db.transaction(() => {
          for (const file of files) if (upsertMedia(file)) seen.add(file.id);
          for (const row of db.prepare(`SELECT id, drive_file_id FROM media`).all()) {
            if (seen.has(row.drive_file_id)) continue;
            bumpPlaylistVersions(db, playlistsUsingMedia(db, row.id));
            db.prepare(`DELETE FROM media WHERE id = ?`).run(row.id);
          }
        })();
        lastSyncAt = Date.now();
        pruneCache();
      })().finally(() => (syncInFlight = null));
    }
    return syncInFlight;
  }

  function libraryResponse(syncError) {
    const items = db.prepare(`SELECT ${mediaColumns} FROM media WHERE removed_at IS NULL ORDER BY created_at DESC`).all();
    const removed = db.prepare(`SELECT ${removedColumns} FROM media WHERE removed_at IS NOT NULL ORDER BY removed_at DESC`).all();
    return { items, removed, synced_at: lastSyncAt || null, sync_error: syncError };
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
        log(err);
        syncError = 'Could not reach Google Drive; showing the last known list';
      }
    }
    res.json(libraryResponse(syncError));
  });

  // The "pull to refresh" in the admin app: re-read Drive right now.
  app.post('/api/media/sync', requireContent, async (req, res) => {
    try {
      await syncDriveFolder();
    } catch (err) {
      log(err);
      return res.status(502).json({ error: 'Could not reach Google Drive' });
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
      log(err);
      req.unpipe(meter);
      req.resume(); // throw away the rest of the phone's upload so the reply gets through
      return res.status(502).json({ error: 'Could not save the file to Google Drive' });
    }
    if (meter.errored || size === 0) {
      // Drive accepted something, but it was cut short or empty; don't keep it.
      await google.deleteFile(file.id).catch(log);
      return res.status(400).json({ error: meter.errored ? 'Upload failed: ' + meter.errored.message : 'File is empty' });
    }
    const saved = upsertMedia(file);
    db.prepare(`UPDATE media SET starts_at = ?, expires_at = ? WHERE id = ?`).run(schedule.startsAt, schedule.expiresAt, saved.id);
    res.status(201).json(db.prepare(`SELECT ${mediaColumns} FROM media WHERE id = ?`).get(saved.id));
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
    res.json(db.prepare(`SELECT ${mediaColumns} FROM media WHERE id = ?`).get(media.id));
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
    res.json(db.prepare(`SELECT ${mediaColumns} FROM media WHERE id = ?`).get(media.id));
  });

  // Download. Served from the local cache when there is a copy; otherwise
  // streamed from Drive (and, with the cache on, saved while it passes).
  // The "Range" header lets an interrupted download on the TV continue where it stopped.
  app.get('/media/:id', auth.requireUserOrDevice(db), async (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ? AND removed_at IS NULL`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
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
    // Only a whole-file download can become the cached copy.
    const recorder = cache && download.status === 200 ? cache.startRecording(media) : null;
    if (recorder) download.stream.on('data', (chunk) => recorder.write(chunk));
    try {
      await pipeline(download.stream, res);
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

  function playlistSummary(p) {
    const devices = db.prepare(`SELECT id, name FROM devices WHERE playlist_id = ? AND claimed = 1 ORDER BY name`).all(p.id);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?`).get(p.id).n;
    return { id: p.id, name: p.name, orientation: p.orientation, version: p.version, item_count: count, devices };
  }

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
    return { fields: out };
  }

  app.get('/api/playlists', requireContent, (req, res) => {
    res.json(db.prepare(`SELECT * FROM playlists ORDER BY name`).all().map(playlistSummary));
  });

  app.post('/api/playlists', requireContent, (req, res) => {
    const { error, fields } = checkPlaylistFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const result = db.prepare(`INSERT INTO playlists (name, orientation, created_at) VALUES (?, ?, ?)`)
      .run(fields.name, fields.orientation, Date.now());
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
    db.prepare(`UPDATE playlists SET name = ?, orientation = ?, version = version + 1 WHERE id = ?`)
      .run(fields.name ?? p.name, fields.orientation ?? p.orientation, p.id);
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
    const users = db.prepare(`SELECT name FROM devices WHERE playlist_id = ? AND claimed = 1`).all(p.id);
    if (users.length) {
      return res.status(409).json({ error: `Still playing on ${users.map((d) => d.name).join(', ')}. Move those players to another playlist first.` });
    }
    db.prepare(`DELETE FROM playlists WHERE id = ?`).run(p.id);
    res.json({ ok: true });
  });

  // ---------- Devices (superadmin, system manager) ----------

  function deviceView(d) {
    const current = d.current_media_id
      ? db.prepare(`SELECT filename FROM media WHERE id = ?`).get(d.current_media_id)
      : null;
    const playlist = d.playlist_id ? findPlaylist(d.playlist_id) : null;
    const loc = locationOf(d);
    return {
      id: d.id,
      name: d.name,
      location: d.location,
      orientation: d.orientation,
      playlist_id: d.playlist_id,
      playlist_name: playlist ? playlist.name : null,
      online: d.last_seen != null && Date.now() - d.last_seen < ONLINE_WINDOW_MS,
      last_seen: d.last_seen,
      current_media_id: d.current_media_id,
      current_filename: current ? current.filename : null,
      free_bytes: d.free_bytes,
      app_version: d.app_version,
      model: d.model,
      site: d.site,
      location_id: loc ? loc.id : null,
      hours_summary: summarizeHours(hoursOf(loc)),
      // false outside the location's working hours (the TV is dark then).
      open_now: isOpenAt(hoursOf(loc), Date.now(), d.time_zone || serverTimeZone),
      after_hours: d.after_hours || 'black',
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
    if (body.location !== undefined) out.location = String(body.location || '').trim() || null;
    if (body.orientation !== undefined) {
      if (!DEVICE_ORIENTATIONS.includes(body.orientation)) {
        return { error: `orientation must be one of: ${DEVICE_ORIENTATIONS.join(', ')}` };
      }
      out.orientation = body.orientation;
    }
    if (body.playlist_id !== undefined) {
      if (body.playlist_id !== null && !findPlaylist(body.playlist_id)) return { error: 'Unknown playlist' };
      out.playlist_id = body.playlist_id;
    }
    return { fields: out };
  }

  // A location typed in the phone app that doesn't exist yet is added to the list.
  function ensureLocation(site, name) {
    if (name) db.prepare(`INSERT OR IGNORE INTO locations (site, name, created_at) VALUES (?, ?, ?)`).run(site || '', name, Date.now());
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
    const screens = db.prepare(`SELECT id, name FROM devices WHERE claimed = 1 AND COALESCE(site, '') = ? AND location = ? ORDER BY name`)
      .all(loc.site, loc.name);
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
    const rows = db.prepare(`SELECT * FROM locations ORDER BY site = ? DESC, site, name COLLATE NOCASE`).all(ownSite);
    res.json({ own_site: ownSite || null, sites: knownSites().map((s) => s || null), locations: rows.map(locationView) });
  });

  app.post('/api/locations', requireDevices, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const site = body.site == null ? ownSite : String(body.site).trim();
    if (!name) return res.status(400).json({ error: 'Give the location a name' });
    if (name.length > 60) return res.status(400).json({ error: 'Keep the name under 60 characters' });
    if (!knownSites().includes(site)) return res.status(400).json({ error: 'Unknown site' });
    if (db.prepare(`SELECT 1 FROM locations WHERE site = ? AND name = ?`).get(site, name)) {
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
      if (name !== loc.name && db.prepare(`SELECT 1 FROM locations WHERE site = ? AND name = ?`).get(loc.site, name)) {
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
      db.prepare(`UPDATE devices SET location = ?, config_version = config_version + 1 WHERE claimed = 1 AND COALESCE(site, '') = ? AND location = ?`)
        .run(name, loc.site, loc.name);
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
    db.prepare(`DELETE FROM locations WHERE id = ?`).run(loc.id);
    res.json({ ok: true });
  });

  // ---------- Notifications through Home Assistant ----------

  const notifyTargets = () => getSetting(db, 'notify_targets') || [];
  const NOTIFY_DATA = { url: '/hassio/ingress/local_kiosk_server' }; // tapping opens Kiosk Signage in the app

  async function notify(title, message, tag) {
    const targets = notifyTargets();
    if (!homeAssistant || !targets.length) return false;
    const results = await Promise.allSettled(
      targets.map((t) => homeAssistant.send(t, { title, message, data: { ...NOTIFY_DATA, tag } })),
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
      cache: cacheStore
        ? { available: true, enabled: cacheOn(), ...cacheStore.stats() }
        : { available: false, enabled: false, files: 0, bytes: 0 },
      sign_in: { phone_app: Boolean(googleWebClientId), web_code: Boolean(google.deviceSignInAvailable) },
      library: db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM media WHERE removed_at IS NULL`).get(),
      notifications: { available: Boolean(homeAssistant), targets: notifyTargets() },
    };
  }

  app.get('/api/settings', requireUsers, (req, res) => res.json(settingsView()));

  app.patch('/api/settings', requireUsers, (req, res) => {
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
    if (body.notify_targets !== undefined) {
      const list = body.notify_targets;
      if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && /^[a-z0-9_]+$/.test(t))) {
        return res.status(400).json({ error: 'notify_targets must be a list of Home Assistant notify services' });
      }
      setSetting(db, 'notify_targets', [...new Set(list)]);
    }
    res.json(settingsView());
  });

  // "Test connection": can the server read the Drive folder right now?
  app.post('/api/settings/test-drive', requireUsers, async (req, res) => {
    try {
      const files = await google.listFolder();
      res.json({ ok: true, files: files.length });
    } catch (err) {
      log(err);
      res.status(502).json({ ok: false, error: 'Could not read the Drive folder. Check the folder ID and that the service account is a member of the shared drive.' });
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
    const insert = db.prepare(
      `INSERT INTO devices (token, pairing_code, app_version, model, site, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomPairingCode();
      try {
        const now = Date.now();
        insert.run(token, code, appVersion, model, siteOf(req), now, now);
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
    res.json({
      claimed: !!d.claimed,
      name: d.name,
      pairing_code: d.pairing_code,
      qr_payload: d.pairing_code ? `kiosk-pair:${d.pairing_code}` : null,
    });
  });

  // What this TV should play, and how to turn the picture for its screen.
  // "version" changes whenever the playlist, its files or this TV's settings change.
  function playerPlaylist(device) {
    const playlist = device.playlist_id ? findPlaylist(device.playlist_id) : null;
    const now = Date.now();
    const all = playlist ? playlistItems(playlist.id) : [];
    // When an entry may play: both the file's dates and the playlist entry's dates allow it.
    const startOf = (item) => Math.max(item.starts_at ?? 0, item.start_at ?? 0);
    const ended = (item) => item.end_at != null && now >= item.end_at;
    const items = all.filter((item) => startOf(item) <= now && !ended(item));
    // Starting within a day: the TV downloads these ahead, but doesn't play them yet.
    const upcoming = all.filter((item) => startOf(item) > now && startOf(item) <= now + UPCOMING_MS && !ended(item))
      .filter((item, i, list) => !items.some((x) => x.media_id === item.media_id) && list.findIndex((x) => x.media_id === item.media_id) === i);
    const toPlayer = (r) => ({
      id: r.media_id,
      type: r.type,
      filename: r.filename,
      url: `/media/${r.media_id}`,
      md5: r.md5,
      size: r.size,
      orientation: r.orientation,
      duration_seconds: r.type === 'image' ? r.image_seconds : null,
    });
    const ids = (list) => list.map((item) => item.media_id).join(',');
    return {
      version: `${device.config_version}.${playlist ? playlist.id : 0}.${playlist ? playlist.version : 0}.${ids(items)}` +
        (upcoming.length ? `~${ids(upcoming)}` : ''),
      name: device.name,
      orientation: device.orientation,
      playlist_name: playlist ? playlist.name : null,
      items: items.map(toPlayer),
      upcoming: upcoming.map(toPlayer),
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
    db.prepare(
      `UPDATE devices SET last_seen = ?, current_media_id = ?, free_bytes = ?, app_version = ?,
       download_done = ?, download_total = ?, site = ?, time_zone = ?, after_hours = ? WHERE id = ?`
    ).run(
      Date.now(),
      Number.isInteger(body.current_media_id) ? body.current_media_id : null,
      Number.isInteger(body.free_bytes) ? body.free_bytes : null,
      typeof body.app_version === 'string' ? body.app_version : req.device.app_version,
      Number.isInteger(body.download_done) ? body.download_done : null,
      Number.isInteger(body.download_total) ? body.download_total : null,
      siteOf(req),
      typeof body.time_zone === 'string' ? body.time_zone.slice(0, 64) : req.device.time_zone,
      ['black', 'standby'].includes(body.after_hours) ? body.after_hours : req.device.after_hours,
      req.device.id
    );
    res.json({ ok: true, version: playerPlaylist(req.device).version });
  });

  // Anything that throws ends up here, so the apps always get JSON back.
  app.use((err, req, res, next) => {
    log(err);
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
function ensureSuperadmin(db, email) {
  db.prepare(
    `INSERT INTO users (email, role, created_at) VALUES (?, 'superadmin', ?)
     ON CONFLICT(email) DO UPDATE SET role = 'superadmin'`
  ).run(email.trim().toLowerCase(), Date.now());
}

module.exports = { createApp, createIngressServer };
