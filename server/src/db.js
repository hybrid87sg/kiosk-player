// Database setup. SQLite keeps everything in a single file (data/kiosk.db).
// Each CREATE TABLE below is like a spreadsheet tab with fixed columns.

const Database = require('better-sqlite3');
const path = require('node:path');

function openDatabase(dataDir) {
  const db = new Database(path.join(dataDir, 'kiosk.db'));
  db.pragma('journal_mode = WAL'); // safer and faster when reading and writing at once
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Admin accounts that can log in from the admin app.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );

    -- A logged-in admin gets a random token; the app sends it with every request.
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    -- Every uploaded video or image.
    CREATE TABLE IF NOT EXISTS media (
      id          INTEGER PRIMARY KEY,
      filename    TEXT NOT NULL,       -- original name, shown in the admin app
      stored_name TEXT NOT NULL,       -- name on disk inside data/uploads
      type        TEXT NOT NULL CHECK (type IN ('video', 'image')),
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,    -- bytes
      sha256      TEXT NOT NULL,       -- fingerprint the player uses to check its download
      created_at  INTEGER NOT NULL
    );

    -- The looping playlist, in order of "position".
    CREATE TABLE IF NOT EXISTS playlist_items (
      id            INTEGER PRIMARY KEY,
      media_id      INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      image_seconds INTEGER NOT NULL DEFAULT 10  -- ignored for videos (they play to the end)
    );

    -- TV players. A player gets its token when it registers, but can only
    -- fetch the playlist once an admin has claimed it with the pairing code.
    CREATE TABLE IF NOT EXISTS devices (
      id               INTEGER PRIMARY KEY,
      token            TEXT NOT NULL UNIQUE,
      pairing_code     TEXT UNIQUE,      -- cleared once claimed
      name             TEXT,
      claimed          INTEGER NOT NULL DEFAULT 0,
      last_seen        INTEGER,          -- unix ms of last heartbeat
      current_media_id INTEGER,
      free_bytes       INTEGER,
      app_version      TEXT,
      created_at       INTEGER NOT NULL
    );

    -- Simple key/value store, e.g. the playlist version number.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES ('playlist_version', '1');
  `);

  return db;
}

// Players compare this number with the one they saved. If it changed,
// they know the playlist (or its files) changed and they need to sync.
function bumpPlaylistVersion(db) {
  db.prepare(
    `UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'playlist_version'`
  ).run();
}

function getPlaylistVersion(db) {
  return Number(db.prepare(`SELECT value FROM settings WHERE key = 'playlist_version'`).get().value);
}

module.exports = { openDatabase, bumpPlaylistVersion, getPlaylistVersion };
