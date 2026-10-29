// The API. Each `app.get/post/put/patch/delete(...)` line is a "route":
// a URL the admin app or the player app can call.
//
//   /api/auth/...    admin app: sign in with Google, sign out
//   /api/me          admin app: who am I and what's my role
//   /api/users...    superadmin: who may use the admin app, and their roles
//   /api/media...    library of files in the Google Drive folder; upload, delete
//   /api/playlist    read and save the looping playlist
//   /api/devices...  pair (QR code or PIN), rename, remove TV players
//   /api/player/...  TV players: register, check pairing, get playlist, heartbeat
//   /media/:id       download a file (streamed from Drive)

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { openDatabase, bumpPlaylistVersion, getPlaylistVersion } = require('./db');
const auth = require('./auth');

// File types the player can show, by MIME type and by file extension.
const TYPE_BY_MIME = { 'video/mp4': 'video', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image' };
const MIME_BY_EXT = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// A player counts as "online" if it sent a heartbeat in the last 2 minutes.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

// Opening the library re-reads the Drive folder at most this often.
const SYNC_THROTTLE_MS = 60 * 1000;

// Letters and digits that are hard to confuse on a TV screen (no 0/O, 1/I/L).
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Works out whether a Drive file is something the player can show.
function mediaKind(name, mimeType) {
  const mime = TYPE_BY_MIME[mimeType] ? mimeType : MIME_BY_EXT[path.extname(name).toLowerCase()];
  return mime ? { mime, type: TYPE_BY_MIME[mime] } : null;
}

function createApp({
  dataDir,
  google,
  superadminEmail,
  maxUploadBytes = 8 * 1024 ** 3,
  syncIntervalMs = 5 * 60 * 1000,
  log = console.log,
}) {
  const db = openDatabase(dataDir);
  if (superadminEmail) ensureSuperadmin(db, superadminEmail);

  const requireContent = auth.requireRole(db, auth.CAN_MANAGE_CONTENT);
  const requireDevices = auth.requireRole(db, auth.CAN_MANAGE_DEVICES);
  const requireUsers = auth.requireRole(db, auth.CAN_MANAGE_USERS);
  const requireAnyUser = auth.requireRole(db, auth.ROLES);

  const app = express();
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

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
    if (!user) return res.status(403).json({ error: `${email} is not allowed in yet. Ask a superadmin to add you.` });
    const token = auth.newToken();
    db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, Date.now());
    res.json({ token, email: user.email, role: user.role });
  });

  app.post('/api/auth/logout', requireAnyUser, (req, res) => {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(auth.bearerToken(req));
    res.json({ ok: true });
  });

  app.get('/api/me', requireAnyUser, (req, res) => {
    res.json({ email: req.user.email, role: req.user.role });
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

  const mediaColumns = `id, filename, type, mime, size, md5, created_at`;

  // Saves (or refreshes) one Drive file in our catalogue. Returns the row,
  // or null if it's not a file type the player can show.
  function upsertMedia(file) {
    const kind = mediaKind(file.name, file.mimeType);
    if (!kind || !file.md5Checksum) return null;
    const existing = db.prepare(`SELECT * FROM media WHERE drive_file_id = ?`).get(file.id);
    if (!existing) {
      db.prepare(
        `INSERT INTO media (drive_file_id, filename, type, mime, size, md5, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(file.id, file.name, kind.type, kind.mime, file.size, file.md5Checksum, Date.now());
    } else if (existing.md5 !== file.md5Checksum || existing.filename !== file.name) {
      db.prepare(`UPDATE media SET filename = ?, type = ?, mime = ?, size = ?, md5 = ? WHERE id = ?`)
        .run(file.name, kind.type, kind.mime, file.size, file.md5Checksum, existing.id);
      // The content changed, so players showing it must download it again.
      if (existing.md5 !== file.md5Checksum && isInPlaylist(existing.id)) bumpPlaylistVersion(db);
    }
    return db.prepare(`SELECT ${mediaColumns} FROM media WHERE drive_file_id = ?`).get(file.id);
  }

  function isInPlaylist(mediaId) {
    return !!db.prepare(`SELECT 1 FROM playlist_items WHERE media_id = ?`).get(mediaId);
  }

  // Makes our catalogue match the Drive folder: new files are added to the
  // library (NOT to the playlist), missing files are removed everywhere.
  let lastSyncAt = 0;
  let syncInFlight = null;
  function syncDriveFolder() {
    if (!syncInFlight) {
      syncInFlight = (async () => {
        const files = await google.listFolder();
        const seen = new Set();
        db.transaction(() => {
          for (const file of files) if (upsertMedia(file)) seen.add(file.id);
          let removedFromPlaylist = false;
          for (const row of db.prepare(`SELECT id, drive_file_id FROM media`).all()) {
            if (seen.has(row.drive_file_id)) continue;
            if (isInPlaylist(row.id)) removedFromPlaylist = true;
            db.prepare(`DELETE FROM media WHERE id = ?`).run(row.id);
          }
          if (removedFromPlaylist) bumpPlaylistVersion(db);
        })();
        lastSyncAt = Date.now();
      })().finally(() => (syncInFlight = null));
    }
    return syncInFlight;
  }

  // Lists the library. Re-reads Drive first if it's been more than a minute.
  // If Drive can't be reached, the last known list is returned with sync_error.
  app.get('/api/media', requireContent, async (req, res) => {
    let syncError = null;
    if (Date.now() - lastSyncAt > SYNC_THROTTLE_MS) {
      try {
        await syncDriveFolder();
      } catch (err) {
        log(err);
        syncError = 'Could not reach Google Drive; showing the last known list';
      }
    }
    const items = db.prepare(`SELECT ${mediaColumns} FROM media ORDER BY created_at DESC`).all();
    res.json({ items, synced_at: lastSyncAt || null, sync_error: syncError });
  });

  // The "pull to refresh" in the admin app: re-read Drive right now.
  app.post('/api/media/sync', requireContent, async (req, res) => {
    try {
      await syncDriveFolder();
    } catch (err) {
      log(err);
      return res.status(502).json({ error: 'Could not reach Google Drive' });
    }
    const items = db.prepare(`SELECT ${mediaColumns} FROM media ORDER BY created_at DESC`).all();
    res.json({ items, synced_at: lastSyncAt, sync_error: null });
  });

  // File picker upload: the request body IS the file (not a form), and it is
  // streamed straight on to Google Drive, so nothing is stored on this server.
  // The app sends the original name in the "X-Filename" header.
  app.post('/api/media', requireContent, async (req, res) => {
    const filename = decodeURIComponent(req.get('x-filename') || '').trim();
    if (!filename) return res.status(400).json({ error: 'Missing X-Filename header' });
    const kind = mediaKind(filename, (req.get('content-type') || '').split(';')[0].trim().toLowerCase());
    if (!kind) return res.status(415).json({ error: 'Only .mp4, .jpg, .png and .webp files are supported' });
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
    res.status(201).json(upsertMedia(file));
  });

  app.delete('/api/media/:id', requireContent, async (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ?`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    try {
      await google.deleteFile(media.drive_file_id); // goes to Drive's trash, so it can be recovered
    } catch (err) {
      if (!(err.status === 404 || (err.response && err.response.status === 404))) {
        log(err);
        return res.status(502).json({ error: 'Could not delete the file in Google Drive' });
      }
    }
    const wasInPlaylist = isInPlaylist(media.id);
    db.prepare(`DELETE FROM media WHERE id = ?`).run(media.id); // also removes it from the playlist
    if (wasInPlaylist) bumpPlaylistVersion(db);
    res.json({ ok: true });
  });

  // Download, streamed from Drive. The "Range" header is passed through so an
  // interrupted download on the TV can continue where it stopped.
  app.get('/media/:id', auth.requireUserOrDevice(db), async (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ?`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
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
    try {
      await pipeline(download.stream, res);
    } catch (err) {
      // Usually the TV disconnected mid-download; it will resume later.
    }
  });

  // ---------- Playlist ----------

  function playlistRows() {
    return db.prepare(
      `SELECT p.media_id, p.image_seconds, m.filename, m.type, m.mime, m.size, m.md5
       FROM playlist_items p JOIN media m ON m.id = p.media_id ORDER BY p.position`
    ).all();
  }

  app.get('/api/playlist', requireContent, (req, res) => {
    res.json({ version: getPlaylistVersion(db), items: playlistRows() });
  });

  // The admin app sends the whole list in the new order; we replace the old one.
  app.put('/api/playlist', requireContent, (req, res) => {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Body must be { items: [...] }' });
    const mediaExists = db.prepare(`SELECT 1 FROM media WHERE id = ?`);
    for (const item of items) {
      if (!Number.isInteger(item.media_id) || !mediaExists.get(item.media_id)) {
        return res.status(400).json({ error: `Unknown media_id ${item.media_id}` });
      }
      if (item.image_seconds !== undefined && !(Number.isInteger(item.image_seconds) && item.image_seconds >= 1)) {
        return res.status(400).json({ error: 'image_seconds must be a whole number of at least 1' });
      }
    }
    // A transaction means "all of these changes or none of them".
    db.transaction(() => {
      db.prepare(`DELETE FROM playlist_items`).run();
      const insert = db.prepare(`INSERT INTO playlist_items (media_id, position, image_seconds) VALUES (?, ?, ?)`);
      items.forEach((item, i) => insert.run(item.media_id, i, item.image_seconds ?? 10));
      bumpPlaylistVersion(db);
    })();
    res.json({ version: getPlaylistVersion(db), items: playlistRows() });
  });

  // ---------- Devices (superadmin, system manager) ----------

  function deviceView(d) {
    const current = d.current_media_id
      ? db.prepare(`SELECT filename FROM media WHERE id = ?`).get(d.current_media_id)
      : null;
    return {
      id: d.id,
      name: d.name,
      online: d.last_seen != null && Date.now() - d.last_seen < ONLINE_WINDOW_MS,
      last_seen: d.last_seen,
      current_media_id: d.current_media_id,
      current_filename: current ? current.filename : null,
      free_bytes: d.free_bytes,
      app_version: d.app_version,
    };
  }

  app.get('/api/devices', requireDevices, (req, res) => {
    const rows = db.prepare(`SELECT * FROM devices WHERE claimed = 1 ORDER BY name`).all();
    res.json(rows.map(deviceView));
  });

  // Pairing. "code" is either what the admin app read from the TV's QR code
  // ("kiosk-pair:K7P29Q") or what someone typed in ("k7p-29q"). Both work.
  app.post('/api/devices/claim', requireDevices, (req, res) => {
    const code = String((req.body && req.body.code) || '')
      .replace(/^kiosk-pair:/i, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the player a name' });
    const device = db.prepare(`SELECT * FROM devices WHERE pairing_code = ? AND claimed = 0`).get(code);
    if (!device) return res.status(404).json({ error: 'No player is showing that code' });
    db.prepare(`UPDATE devices SET claimed = 1, pairing_code = NULL, name = ? WHERE id = ?`).run(name, device.id);
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(device.id)));
  });

  app.patch('/api/devices/:id', requireDevices, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    const result = db.prepare(`UPDATE devices SET name = ? WHERE id = ? AND claimed = 1`).run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(req.params.id)));
  });

  // Removing a device makes its token useless; the TV will show a new code.
  app.delete('/api/devices/:id', requireDevices, (req, res) => {
    const result = db.prepare(`DELETE FROM devices WHERE id = ?`).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---------- Player (TV) ----------

  // First launch: the player gets a secret token (kept on the TV) and a short
  // pairing code, which it shows on screen as a QR code and as text.
  app.post('/api/player/register', (req, res) => {
    const token = auth.newToken();
    const appVersion = (req.body && req.body.app_version) || null;
    const insert = db.prepare(
      `INSERT INTO devices (token, pairing_code, app_version, created_at) VALUES (?, ?, ?, ?)`
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomPairingCode();
      try {
        insert.run(token, code, appVersion, Date.now());
        return res.status(201).json({ token, pairing_code: code, qr_payload: `kiosk-pair:${code}` });
      } catch (err) {
        if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err; // otherwise: code taken, try another
      }
    }
    res.status(503).json({ error: 'Could not create a pairing code, try again' });
  });

  app.get('/api/player/status', auth.requireDevice(db, { claimedOnly: false }), (req, res) => {
    const d = req.device;
    res.json({
      claimed: !!d.claimed,
      name: d.name,
      pairing_code: d.pairing_code,
      qr_payload: d.pairing_code ? `kiosk-pair:${d.pairing_code}` : null,
    });
  });

  app.get('/api/player/playlist', auth.requireDevice(db), (req, res) => {
    const items = playlistRows().map((r) => ({
      id: r.media_id,
      type: r.type,
      filename: r.filename,
      url: `/media/${r.media_id}`,
      md5: r.md5,
      size: r.size,
      duration_seconds: r.type === 'image' ? r.image_seconds : null,
    }));
    res.json({ version: getPlaylistVersion(db), items });
  });

  app.post('/api/player/heartbeat', auth.requireDevice(db), (req, res) => {
    const body = req.body || {};
    db.prepare(
      `UPDATE devices SET last_seen = ?, current_media_id = ?, free_bytes = ?, app_version = ? WHERE id = ?`
    ).run(
      Date.now(),
      Number.isInteger(body.current_media_id) ? body.current_media_id : null,
      Number.isInteger(body.free_bytes) ? body.free_bytes : null,
      typeof body.app_version === 'string' ? body.app_version : req.device.app_version,
      req.device.id
    );
    res.json({ ok: true, playlist_version: getPlaylistVersion(db) });
  });

  // Anything that throws ends up here, so the apps always get JSON back.
  app.use((err, req, res, next) => {
    log(err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
  });

  // Keep the library in step with Drive even when nobody has the admin app open.
  if (syncIntervalMs > 0) {
    setInterval(() => syncDriveFolder().catch(log), syncIntervalMs).unref();
  }

  app.locals.db = db;
  app.locals.syncDriveFolder = syncDriveFolder;
  return app;
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

module.exports = { createApp };
