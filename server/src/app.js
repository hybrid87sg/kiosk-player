// The API. Each `app.get/post/put/patch/delete(...)` line is a "route":
// a URL the admin app or the player app can call.
//
//   /api/auth/...    admin login
//   /api/media...    admin: upload, list, delete files
//   /api/playlist    admin: read and save the looping playlist
//   /api/devices...  admin: pair, rename, remove TV players
//   /api/player/...  TV players: register, check pairing, get playlist, heartbeat
//   /media/:id       download a file (players and admins)

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { openDatabase, bumpPlaylistVersion, getPlaylistVersion } = require('./db');
const auth = require('./auth');

// File types the player can show, by MIME type and by file extension.
const ALLOWED_TYPES = {
  'video/mp4': { type: 'video', ext: '.mp4' },
  'image/jpeg': { type: 'image', ext: '.jpg' },
  'image/png': { type: 'image', ext: '.png' },
  'image/webp': { type: 'image', ext: '.webp' },
};
const MIME_BY_EXT = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// A player counts as "online" if it sent a heartbeat in the last 2 minutes.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

// Letters and digits that are hard to confuse on a TV screen (no 0/O, 1/I/L).
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function createApp({ dataDir, adminUser = 'admin', adminPassword, maxUploadBytes = 8 * 1024 ** 3, log = console.log }) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDatabase(dataDir);
  ensureAdminUser(db, adminUser, adminPassword, log);

  const requireAdmin = auth.requireAdmin(db);
  const app = express();
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // ---------- Admin login ----------

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username || '');
    if (!user || !password || !auth.verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    const token = auth.newToken();
    db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, user.id, Date.now());
    res.json({ token, username: user.username });
  });

  app.post('/api/auth/logout', requireAdmin, (req, res) => {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(req.get('authorization').slice(7));
    res.json({ ok: true });
  });

  // ---------- Media (admin) ----------

  app.get('/api/media', requireAdmin, (req, res) => {
    const rows = db.prepare(
      `SELECT id, filename, type, mime, size, sha256, created_at FROM media ORDER BY created_at DESC`
    ).all();
    res.json(rows);
  });

  // Upload: the request body IS the file (not a form), so a multi-gigabyte
  // video streams straight to disk instead of being held in memory.
  // The app sends the original name in the "X-Filename" header.
  app.post('/api/media', requireAdmin, async (req, res) => {
    const filename = decodeURIComponent(req.get('x-filename') || '').trim();
    if (!filename) return res.status(400).json({ error: 'Missing X-Filename header' });

    let mime = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES[mime]) mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
    const kind = ALLOWED_TYPES[mime];
    if (!kind) return res.status(415).json({ error: 'Only .mp4, .jpg, .png and .webp files are supported' });

    const declared = Number(req.get('content-length'));
    if (declared > maxUploadBytes) return res.status(413).json({ error: 'File is too large' });

    // Write to a temporary name first; only rename once the whole file arrived.
    const storedName = crypto.randomUUID() + kind.ext;
    const finalPath = path.join(uploadsDir, storedName);
    const tempPath = finalPath + '.part';
    const hash = crypto.createHash('sha256');
    let size = 0;

    // Sits between the request and the file: counts bytes and builds the
    // sha256 fingerprint as each chunk passes through.
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxUploadBytes) return callback(Object.assign(new Error('File is too large'), { status: 413 }));
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(req, meter, fs.createWriteStream(tempPath));
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      if (!res.headersSent) res.status(err.status || 400).json({ error: 'Upload failed: ' + err.message });
      return;
    }
    if (size === 0) {
      fs.rmSync(tempPath, { force: true });
      return res.status(400).json({ error: 'File is empty' });
    }
    fs.renameSync(tempPath, finalPath);

    const result = db.prepare(
      `INSERT INTO media (filename, stored_name, type, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(filename, storedName, kind.type, mime, size, hash.digest('hex'), Date.now());
    const row = db.prepare(
      `SELECT id, filename, type, mime, size, sha256, created_at FROM media WHERE id = ?`
    ).get(result.lastInsertRowid);
    res.status(201).json(row);
  });

  app.delete('/api/media/:id', requireAdmin, (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ?`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    const wasInPlaylist = db.prepare(`SELECT 1 FROM playlist_items WHERE media_id = ?`).get(media.id);
    db.prepare(`DELETE FROM media WHERE id = ?`).run(media.id); // also removes it from the playlist
    if (wasInPlaylist) bumpPlaylistVersion(db);
    fs.rmSync(path.join(uploadsDir, media.stored_name), { force: true });
    res.json({ ok: true });
  });

  // Download. sendFile handles "Range" requests, so an interrupted
  // download on the TV can continue where it stopped.
  app.get('/media/:id', auth.requireAdminOrDevice(db), (req, res) => {
    const media = db.prepare(`SELECT * FROM media WHERE id = ?`).get(req.params.id);
    if (!media) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(uploadsDir, media.stored_name), { headers: { 'Content-Type': media.mime } });
  });

  // ---------- Playlist (admin) ----------

  function playlistRows() {
    return db.prepare(
      `SELECT p.media_id, p.image_seconds, m.filename, m.type, m.mime, m.size, m.sha256
       FROM playlist_items p JOIN media m ON m.id = p.media_id ORDER BY p.position`
    ).all();
  }

  app.get('/api/playlist', requireAdmin, (req, res) => {
    res.json({ version: getPlaylistVersion(db), items: playlistRows() });
  });

  // The admin app sends the whole list in the new order; we replace the old one.
  app.put('/api/playlist', requireAdmin, (req, res) => {
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

  // ---------- Devices (admin) ----------

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

  app.get('/api/devices', requireAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM devices WHERE claimed = 1 ORDER BY name`).all();
    res.json(rows.map(deviceView));
  });

  // The admin types the code shown on the TV. Dashes and case don't matter.
  app.post('/api/devices/claim', requireAdmin, (req, res) => {
    const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the player a name' });
    const device = db.prepare(`SELECT * FROM devices WHERE pairing_code = ? AND claimed = 0`).get(code);
    if (!device) return res.status(404).json({ error: 'No player is showing that code' });
    db.prepare(`UPDATE devices SET claimed = 1, pairing_code = NULL, name = ? WHERE id = ?`).run(name, device.id);
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(device.id)));
  });

  app.patch('/api/devices/:id', requireAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    const result = db.prepare(`UPDATE devices SET name = ? WHERE id = ? AND claimed = 1`).run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json(deviceView(db.prepare(`SELECT * FROM devices WHERE id = ?`).get(req.params.id)));
  });

  // Removing a device makes its token useless; the TV will show a new code.
  app.delete('/api/devices/:id', requireAdmin, (req, res) => {
    const result = db.prepare(`DELETE FROM devices WHERE id = ?`).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---------- Player (TV) ----------

  // First launch: the player gets a secret token (kept on the TV) and a short
  // pairing code (shown on screen for the admin to type in).
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
        return res.status(201).json({ token, pairing_code: code });
      } catch (err) {
        if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err; // otherwise: code taken, try another
      }
    }
    res.status(503).json({ error: 'Could not create a pairing code, try again' });
  });

  app.get('/api/player/status', auth.requireDevice(db, { claimedOnly: false }), (req, res) => {
    const d = req.device;
    res.json({ claimed: !!d.claimed, name: d.name, pairing_code: d.pairing_code });
  });

  app.get('/api/player/playlist', auth.requireDevice(db), (req, res) => {
    const items = playlistRows().map((r) => ({
      id: r.media_id,
      type: r.type,
      filename: r.filename,
      url: `/media/${r.media_id}`,
      sha256: r.sha256,
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

  app.locals.db = db;
  return app;
}

function randomPairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return code;
}

// On the very first start, create the admin account. If no password was
// given via ADMIN_PASSWORD, make one up and print it once.
function ensureAdminUser(db, username, password, log) {
  if (db.prepare(`SELECT 1 FROM users LIMIT 1`).get()) return;
  const finalPassword = password || crypto.randomBytes(9).toString('base64url');
  db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`).run(username, auth.hashPassword(finalPassword));
  if (!password) {
    log(`Created admin account. Username: ${username}  Password: ${finalPassword}`);
    log('Write this password down; it will not be shown again.');
  }
}

module.exports = { createApp };
