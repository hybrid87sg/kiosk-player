// Database setup. SQLite keeps everything in a single file (data/kiosk.db).
// Each CREATE TABLE below is like a spreadsheet tab with fixed columns.

const Database = require('better-sqlite3');
const path = require('node:path');

// Bump this when the tables below change shape. Nothing is deployed yet, so
// an older database is simply wiped and rebuilt instead of being migrated.
const SCHEMA_VERSION = 3;

function openDatabase(dataDir) {
  const db = new Database(path.join(dataDir, 'kiosk.db'));
  db.pragma('journal_mode = WAL'); // safer and faster when reading and writing at once
  db.pragma('foreign_keys = ON');

  if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS playlist_items;
      DROP TABLE IF EXISTS devices;
      DROP TABLE IF EXISTS playlists;
      DROP TABLE IF EXISTS media;
      DROP TABLE IF EXISTS settings;
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  db.exec(`
    -- People allowed to use the admin app. They sign in with Google;
    -- we only store their email and what they're allowed to do.
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,   -- always lower case
      role       TEXT NOT NULL CHECK (role IN ('superadmin', 'system_manager', 'content_uploader')),
      created_at INTEGER NOT NULL
    );

    -- After signing in, the admin app gets a random token and sends it with every request.
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    -- Our copy of the list of videos and images in the Google Drive folder.
    -- The files themselves live in Drive; this is just the catalogue.
    CREATE TABLE IF NOT EXISTS media (
      id            INTEGER PRIMARY KEY,
      drive_file_id TEXT NOT NULL UNIQUE,
      filename      TEXT NOT NULL,
      type          TEXT NOT NULL CHECK (type IN ('video', 'image')),
      mime          TEXT NOT NULL,
      size          INTEGER NOT NULL,   -- bytes
      md5           TEXT NOT NULL,      -- fingerprint from Drive; the player checks its download against it
      width         INTEGER,            -- pixels; empty while Drive is still processing a new video
      height        INTEGER,
      orientation   TEXT CHECK (orientation IN ('landscape', 'portrait')),  -- empty = still checking
      created_at    INTEGER NOT NULL
    );

    -- Named playlists. Each one is made for landscape or portrait screens.
    -- "version" goes up on every change so players know when to re-sync.
    CREATE TABLE IF NOT EXISTS playlists (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      orientation TEXT NOT NULL CHECK (orientation IN ('landscape', 'portrait')),
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    -- What is in each playlist, in order of "position".
    CREATE TABLE IF NOT EXISTS playlist_items (
      id            INTEGER PRIMARY KEY,
      playlist_id   INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      media_id      INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      image_seconds INTEGER NOT NULL DEFAULT 10, -- ignored for videos (they play to the end)
      start_at      INTEGER, -- optional inclusive Unix milliseconds
      end_at        INTEGER  -- optional exclusive Unix milliseconds
    );

    -- TV players. A player gets its token when it registers, but can only
    -- fetch content once an admin has claimed it with the pairing code.
    CREATE TABLE IF NOT EXISTS devices (
      id               INTEGER PRIMARY KEY,
      token            TEXT NOT NULL UNIQUE,
      pairing_code     TEXT UNIQUE,      -- cleared once claimed
      name             TEXT,
      location         TEXT,             -- free text, e.g. "Main lobby"
      orientation      TEXT NOT NULL DEFAULT 'landscape'
                       CHECK (orientation IN ('landscape', 'portrait_right', 'portrait_left')),
      playlist_id      INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
      config_version   INTEGER NOT NULL DEFAULT 1,  -- goes up when an admin changes this player's settings
      claimed          INTEGER NOT NULL DEFAULT 0,
      last_seen        INTEGER,          -- unix ms of last heartbeat
      current_media_id INTEGER,
      free_bytes       INTEGER,
      app_version      TEXT,
      created_at       INTEGER NOT NULL
    );

    -- Places where screens are, e.g. "Main lobby", per site, with their
    -- working hours (JSON, see hours.js; empty = open all the time).
    -- site '' means this server's own site.
    CREATE TABLE IF NOT EXISTS locations (
      id         INTEGER PRIMARY KEY,
      site       TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      hours      TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (site, name)
    );

    -- Settings changed from the web interface (e.g. the Drive folder),
    -- which take priority over the start-up settings.
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Columns added after the first release. Adding them keeps existing data,
  // unlike a SCHEMA_VERSION bump, which starts the database again.
  addColumnIfMissing(db, 'devices', 'download_done', 'INTEGER');
  addColumnIfMissing(db, 'devices', 'download_total', 'INTEGER');
  addColumnIfMissing(db, 'devices', 'decoder_caps', 'TEXT'); // JSON: screen size and what the TV can decode
  addColumnIfMissing(db, 'devices', 'playback_error', 'TEXT');
  addColumnIfMissing(db, 'playlist_items', 'start_at', 'INTEGER');
  addColumnIfMissing(db, 'playlist_items', 'end_at', 'INTEGER');
  addColumnIfMissing(db, 'devices', 'model', 'TEXT'); // e.g. "Xiaomi MIBOX4", shown while waiting to be added
  addColumnIfMissing(db, 'devices', 'site', 'TEXT'); // which site (Home Assistant) the TV is at
  // File expiry, and files taken out of Kiosk (expired or removed). The row is
  // kept, so the next Drive sync doesn't bring the file back; Drive is untouched.
  addColumnIfMissing(db, 'media', 'expires_at', 'INTEGER'); // unix ms; empty = never expires
  addColumnIfMissing(db, 'media', 'removed_at', 'INTEGER'); // unix ms; empty = in the library
  addColumnIfMissing(db, 'media', 'removed_reason', 'TEXT'); // 'expired' or 'removed'
  addColumnIfMissing(db, 'media', 'starts_at', 'INTEGER'); // unix ms; empty = shows straight away
  addColumnIfMissing(db, 'devices', 'time_zone', 'TEXT'); // the TV's own time zone, e.g. "Asia/Singapore"
  addColumnIfMissing(db, 'devices', 'after_hours', 'TEXT'); // what the TV does when closed: 'black' or 'standby'
  addColumnIfMissing(db, 'devices', 'alerted_at', 'INTEGER'); // when we notified that it's offline
  // People sign in with a username and password. The username is kept in the "email"
  // column (it used to hold a Google account's email); password_hash is never the password.
  addColumnIfMissing(db, 'users', 'password_hash', 'TEXT');
  // 0.8.0: a Google account linked to the user, for the public web dashboard (lower case).
  addColumnIfMissing(db, 'users', 'google_email', 'TEXT');
  // 0.8.0: how a session signed in: 'password' or 'google'. Sessions from before are passwords.
  addColumnIfMissing(db, 'sessions', 'method', 'TEXT');
  // Playlists belong to a location (see the playlists table's "auto" column below).
  addColumnIfMissing(db, 'playlists', 'location_id', 'INTEGER');
  addColumnIfMissing(db, 'devices', 'flipped', 'INTEGER'); // 1 = a landscape screen mounted upside down
  // Playlists belong to a site. Each site has two automatic ones (auto = 1), Landscape
  // and Portrait; a screen with no playlist of its own plays the one that fits it.
  // site is empty ('') for this server's own site, and NULL for a playlist from before
  // playlists belonged to sites that no screen was using.
  addColumnIfMissing(db, 'playlists', 'site', 'TEXT');
  addColumnIfMissing(db, 'playlists', 'auto', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'media', 'source_codec', 'TEXT');
  addColumnIfMissing(db, 'media', 'source_profile', 'TEXT');
  addColumnIfMissing(db, 'media', 'source_level', 'INTEGER');
  addColumnIfMissing(db, 'media', 'source_fps', 'REAL');
  addColumnIfMissing(db, 'media', 'source_pix_fmt', 'TEXT');
  addColumnIfMissing(db, 'media', 'source_vfr', 'INTEGER');

  // Playback copies made on this server. The original in Google Drive is untouched.
  db.exec(`
    CREATE TABLE IF NOT EXISTS renditions (
      media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      profile    TEXT NOT NULL CHECK (profile IN ('h264_1080', 'h264_720', 'hevc_2160')),
      status     TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed', 'skipped')),
      width      INTEGER,
      height     INTEGER,
      fps        REAL,
      size       INTEGER,
      md5        TEXT,
      source_md5 TEXT,
      error      TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (media_id, profile)
    );
  `);

  // ---------- Relays: the Home Assistants at other sites (added in 0.7.0) ----------
  // All new tables, so existing data is untouched. SCHEMA_VERSION must stay as it is:
  // raising it would drop the tables above.
  db.exec(`
    -- One per relay Home Assistant. The id is made by this server and isn't sequential.
    CREATE TABLE IF NOT EXISTS relays (
      id           TEXT PRIMARY KEY,           -- 'rly_' + random
      name         TEXT NOT NULL,
      site         TEXT NOT NULL UNIQUE,       -- the site its TVs are recorded under (devices.site)
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
      created_at   INTEGER NOT NULL,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      paired_at    INTEGER,
      last_seen_at INTEGER,
      last_version TEXT,
      disabled_at  INTEGER
    );

    -- Short-lived, single-use pairing codes. Only a keyed hash of the code is kept.
    -- One code pairs both pieces of a relay: its integration ('control') and its add-on ('proxy').
    CREATE TABLE IF NOT EXISTS relay_pairing_codes (
      id              INTEGER PRIMARY KEY,
      relay_id        TEXT NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
      code_hash       TEXT NOT NULL UNIQUE,
      expires_at      INTEGER NOT NULL,
      used_control_at INTEGER,
      used_proxy_at   INTEGER,
      cancelled_at    INTEGER,
      created_at      INTEGER NOT NULL
    );

    -- Long-lived relay credentials. Only a hash is kept; the secret is shown to the relay once.
    CREATE TABLE IF NOT EXISTS relay_credentials (
      id             TEXT PRIMARY KEY,         -- 'rcr_' + random; not secret
      relay_id       TEXT NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
      kind           TEXT NOT NULL CHECK (kind IN ('control', 'proxy')),
      secret_hash    TEXT NOT NULL UNIQUE,
      replaces_id    TEXT,                     -- set by a rotation; the old one is revoked once this is used
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER,
      revoked_at     INTEGER,
      revoked_reason TEXT
    );

    -- Which relay owns which TV: one owner per TV.
    CREATE TABLE IF NOT EXISTS relay_player_assignments (
      device_id   INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      relay_id    TEXT NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
      assigned_at INTEGER NOT NULL,
      assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL -- empty = done automatically
    );

    -- What happened: pairing, credentials, assignments, refused requests. Never secrets.
    CREATE TABLE IF NOT EXISTS relay_events (
      id         INTEGER PRIMARY KEY,
      relay_id   TEXT,
      device_id  INTEGER,
      kind       TEXT NOT NULL,
      detail     TEXT,                         -- JSON
      actor      TEXT,                         -- 'user:<id>', 'relay:<id>', 'system'
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_events_by_relay ON relay_events (relay_id, created_at);
    CREATE INDEX IF NOT EXISTS relay_assignments_by_relay ON relay_player_assignments (relay_id);

    -- Commands a relay's Home Assistant sent for one of its screens (0.7.0).
    -- applied: the server changed what the screen plays; acknowledged: the TV fetched it.
    CREATE TABLE IF NOT EXISTS relay_commands (
      id         TEXT PRIMARY KEY,             -- 'cmd_…', may be chosen by the relay (repeat-safe)
      relay_id   TEXT NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
      device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      payload    TEXT,                         -- JSON
      status     TEXT NOT NULL CHECK (status IN ('applied','acknowledged','expired','rejected','superseded')),
      reason     TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER,
      acked_at   INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS relay_commands_by_device ON relay_commands (device_id, status);
  `);

  return db;
}

function addColumnIfMissing(db, table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function getSetting(db, key) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
  return row ? JSON.parse(row.value) : undefined;
}

function setSetting(db, key, value) {
  if (value === undefined || value === null) db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
  else db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

// Players compare this number with the one they saved. If it changed,
// they know the playlist (or its files) changed and they need to sync.
function bumpPlaylistVersions(db, playlistIds) {
  const bump = db.prepare(`UPDATE playlists SET version = version + 1 WHERE id = ?`);
  for (const id of new Set(playlistIds)) bump.run(id);
}

// The playlists that contain a given file.
function playlistsUsingMedia(db, mediaId) {
  return db.prepare(`SELECT DISTINCT playlist_id FROM playlist_items WHERE media_id = ?`).all(mediaId).map((r) => r.playlist_id);
}

module.exports = { openDatabase, bumpPlaylistVersions, playlistsUsingMedia, getSetting, setSetting, SCHEMA_VERSION };
