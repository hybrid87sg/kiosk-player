// Relays: the Home Assistants at other sites, and what each may do.
//
// A relay is made on this (main) server by an admin, who gets a short pairing
// code. The code is typed into the relay twice: into the kiosk_player
// integration (which gets a 'control' credential) and into the relay add-on
// (which gets a 'proxy' credential, used when it passes its TVs on to us).
//
//   - Pairing codes are random, single-use per piece, valid for 10 minutes,
//     and only a keyed hash of them is stored. Guessing is rate limited.
//   - Credentials are long random secrets; only their SHA-256 is stored. They
//     can be revoked, and a relay can rotate its own.
//   - Every TV is owned by at most one relay. A relay only ever sees and
//     touches its own TVs: another relay's TV answers 404, as if it didn't exist.
//   - Nothing secret (codes, credentials) is ever written to the log or to
//     relay_events.
//
// The routes are under /api/relays (admins) and /api/relay/v1 (relays).

const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const PAIRING_CODE_MS = 10 * 60 * 1000;
const EVENTS_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const SEEN_WRITE_EVERY_MS = 60 * 1000; // last_seen / last_used are written at most this often
// Guessing pairing codes: per caller address, and for the whole server.
const PAIR_TRIES_PER_MINUTE = 10;
const PAIR_TRIES_PER_HOUR = 50;
const KINDS = ['control', 'proxy'];
// Pairing codes use letters and digits that can't be mixed up when read aloud or typed
// (no 0/O, 1/I/L, U). 10 characters is 50 bits, shown as two groups of five.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function randomCode() {
  let code = '';
  while (code.length < 10) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 240) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]; // 240 = 8 × 30: no bias
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** What a person typed, made comparable: upper case, without spaces or dashes. */
function normaliseCode(typed) {
  return String(typed || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * The relay part of the server. `deviceView` is the app's own description of a TV;
 * a relay is shown a subset of it.
 */
function createRelays({ db, log = () => {}, ownSite = '', now = () => Date.now() }) {
  // A server secret the pairing codes are hashed with, so a copy of the database alone
  // doesn't let anyone test guesses offline.
  let secret = getSetting(db, 'relay_hmac_secret');
  if (!secret) setSetting(db, 'relay_hmac_secret', (secret = crypto.randomBytes(32).toString('hex')));
  const revokeListeners = []; // told when a credential stops working, e.g. to close its connection
  const codeHash = (code) => crypto.createHmac('sha256', secret).update(normaliseCode(code)).digest('hex');

  // ---------- history ----------

  function event(relayId, kind, { deviceId = null, detail = null, actor = 'system' } = {}) {
    db.prepare(`INSERT INTO relay_events (relay_id, device_id, kind, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(relayId, deviceId, kind, detail ? JSON.stringify(detail) : null, actor, now());
  }
  function pruneEvents() {
    db.prepare(`DELETE FROM relay_events WHERE created_at < ?`).run(now() - EVENTS_KEEP_MS);
  }

  // ---------- relays already in use before 0.7.0 ----------

  // TVs that came in through a relay were only labelled with that relay's site name.
  // Once, each such site becomes a relay record (not paired yet), and its TVs are
  // assigned to it. Nothing else changes: until a relay is paired, it works as before.
  function adoptExistingSites() {
    if (getSetting(db, 'relays_adopted')) return;
    db.transaction(() => {
      const sites = db.prepare(
        `SELECT DISTINCT site FROM devices WHERE site IS NOT NULL AND site != '' AND site != ? AND claimed = 1`
      ).all(ownSite).map((r) => r.site);
      for (const site of sites) {
        let relay = db.prepare(`SELECT * FROM relays WHERE site = ?`).get(site);
        if (!relay) {
          const id = randomId('rly');
          db.prepare(`INSERT INTO relays (id, name, site, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).run(id, site, site, now());
          event(id, 'created', { detail: { name: site, from: 'existing TVs' } });
          relay = { id };
        }
        db.prepare(
          `INSERT OR IGNORE INTO relay_player_assignments (device_id, relay_id, assigned_at)
           SELECT id, ?, ? FROM devices WHERE site = ? AND claimed = 1`
        ).run(relay.id, now(), site);
      }
      setSetting(db, 'relays_adopted', 1);
    })();
  }
  adoptExistingSites();

  // ---------- reading ----------

  const findRelay = (id) => db.prepare(`SELECT * FROM relays WHERE id = ?`).get(id);
  const relayBySite = (site) => db.prepare(`SELECT * FROM relays WHERE site = ?`).get(site);
  const ownerOf = (deviceId) => db.prepare(
    `SELECT r.* FROM relay_player_assignments a JOIN relays r ON r.id = a.relay_id WHERE a.device_id = ?`
  ).get(deviceId);
  const activeCredentials = (relayId) => db.prepare(
    `SELECT id, kind, created_at, last_used_at FROM relay_credentials WHERE relay_id = ? AND revoked_at IS NULL ORDER BY kind, created_at`
  ).all(relayId);

  /** A relay as admins see it. Never includes secrets. */
  function relayView(r) {
    const creds = activeCredentials(r.id);
    const players = db.prepare(
      `SELECT d.id, d.name, d.last_seen FROM relay_player_assignments a JOIN devices d ON d.id = a.device_id
       WHERE a.relay_id = ? AND d.claimed = 1 ORDER BY d.name`
    ).all(r.id);
    const code = db.prepare(
      `SELECT expires_at, used_control_at, used_proxy_at FROM relay_pairing_codes
       WHERE relay_id = ? AND cancelled_at IS NULL AND expires_at > ? AND (used_control_at IS NULL OR used_proxy_at IS NULL)
       ORDER BY created_at DESC LIMIT 1`
    ).get(r.id, now());
    return {
      id: r.id,
      name: r.name,
      site: r.site,
      description: r.description,
      status: r.status,
      created_at: r.created_at,
      paired_at: r.paired_at,
      last_seen_at: r.last_seen_at,
      last_version: r.last_version,
      paired: { control: creds.some((c) => c.kind === 'control'), proxy: creds.some((c) => c.kind === 'proxy') },
      credentials: creds,
      // A code that is still waiting to be used (its value is never shown again).
      pairing: code ? { expires_at: code.expires_at, control_done: Boolean(code.used_control_at), proxy_done: Boolean(code.used_proxy_at) } : null,
      players: players.map((p) => ({ id: p.id, name: p.name, last_seen: p.last_seen })),
    };
  }

  // ---------- pairing codes ----------

  /** A new code for a relay. Any earlier unused code for it stops working. Returns the code once. */
  function newPairingCode(relayId, actor) {
    db.prepare(`UPDATE relay_pairing_codes SET cancelled_at = ? WHERE relay_id = ? AND cancelled_at IS NULL`).run(now(), relayId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      try {
        db.prepare(`INSERT INTO relay_pairing_codes (relay_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)`)
          .run(relayId, codeHash(code), now() + PAIRING_CODE_MS, now());
        event(relayId, 'pairing_code_created', { actor });
        return { code, expires_at: now() + PAIRING_CODE_MS };
      } catch (err) {
        if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      }
    }
    throw new Error('Could not make a pairing code');
  }

  // Guess limits for pairing, kept in memory (a restart forgets them, which is fine:
  // a code only lives 10 minutes and has 50 bits).
  const triesByAddress = new Map(); // address -> [times]
  let triesOverall = [];
  function pairingAllowed(address) {
    const t = now();
    triesOverall = triesOverall.filter((x) => x > t - 60 * 60 * 1000);
    const mine = (triesByAddress.get(address) || []).filter((x) => x > t - 60 * 1000);
    if (mine.length >= PAIR_TRIES_PER_MINUTE || triesOverall.length >= PAIR_TRIES_PER_HOUR) return false;
    mine.push(t);
    triesOverall.push(t);
    triesByAddress.set(address, mine);
    if (triesByAddress.size > 5000) triesByAddress.clear();
    return true;
  }

  /**
   * Uses a code for one piece of a relay. Returns { relay, credentialId, credential }
   * or { error, status }.
   */
  function pair(code, kind, client = {}) {
    if (!KINDS.includes(kind)) return { status: 400, error: `kind must be one of: ${KINDS.join(', ')}` };
    if (normaliseCode(code).length !== 10) return { status: 401, error: 'That pairing code isn’t valid. Make a new one in Settings → Home Assistant Relays.' };
    const row = db.prepare(`SELECT * FROM relay_pairing_codes WHERE code_hash = ?`).get(codeHash(code));
    const usedColumn = kind === 'control' ? 'used_control_at' : 'used_proxy_at';
    const relay = row ? findRelay(row.relay_id) : null;
    if (!row || !relay || row.cancelled_at || row.expires_at <= now() || row[usedColumn]) {
      return { status: 401, error: 'That pairing code isn’t valid. Make a new one in Settings → Home Assistant Relays.' };
    }
    if (relay.status === 'disabled') return { status: 403, error: 'This relay is disabled. Enable it in Settings → Home Assistant Relays first.' };
    const credential = `rk_${crypto.randomBytes(32).toString('base64url')}`;
    const credentialId = randomId('rcr');
    db.transaction(() => {
      db.prepare(`UPDATE relay_pairing_codes SET ${usedColumn} = ? WHERE id = ?`).run(now(), row.id);
      // Pairing a piece again (e.g. after reinstalling it) replaces its old credential.
      const old = db.prepare(`SELECT id FROM relay_credentials WHERE relay_id = ? AND kind = ? AND revoked_at IS NULL`).all(relay.id, kind);
      for (const o of old) revokeCredential(relay.id, o.id, 're-paired', `relay:${relay.id}`);
      db.prepare(`INSERT INTO relay_credentials (id, relay_id, kind, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(credentialId, relay.id, kind, sha256(credential), now());
      db.prepare(`UPDATE relays SET status = 'active', paired_at = COALESCE(paired_at, ?), last_seen_at = ?, last_version = COALESCE(?, last_version) WHERE id = ?`)
        .run(now(), now(), typeof client.version === 'string' ? client.version.slice(0, 40) : null, relay.id);
      event(relay.id, 'paired', { actor: `relay:${relay.id}`, detail: { kind, credential_id: credentialId, client: clientInfo(client) } });
    })();
    log(`Relay ${relay.name} paired its ${kind === 'control' ? 'Home Assistant integration' : 'add-on'}`);
    return { relay: findRelay(relay.id), credentialId, credential };
  }

  function clientInfo(client) {
    const pick = (v) => (typeof v === 'string' ? v.slice(0, 60) : undefined);
    return { name: pick(client.name), version: pick(client.version), ha_version: pick(client.ha_version) };
  }

  // ---------- credentials ----------

  function revokeCredential(relayId, credentialId, reason, actor) {
    const result = db.prepare(
      `UPDATE relay_credentials SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND relay_id = ? AND revoked_at IS NULL`
    ).run(now(), reason, credentialId, relayId);
    if (result.changes) {
      event(relayId, 'credential_revoked', { actor, detail: { credential_id: credentialId, reason } });
      for (const fn of revokeListeners) fn(credentialId, relayId);
    }
    return result.changes > 0;
  }

  /**
   * Checks a credential. Returns { relay, credential } for a usable one, or
   * { error, status }. Updates last seen (at most once a minute).
   */
  function authenticate(secret, allowedKinds) {
    if (typeof secret !== 'string' || !secret.startsWith('rk_')) return { status: 401, error: 'Relay credential missing' };
    const cred = db.prepare(`SELECT * FROM relay_credentials WHERE secret_hash = ?`).get(sha256(secret));
    if (!cred || cred.revoked_at) return { status: 401, error: 'Relay credential not valid. Pair this relay again.' };
    const relay = findRelay(cred.relay_id);
    if (!relay) return { status: 401, error: 'Relay credential not valid. Pair this relay again.' };
    if (relay.status === 'disabled') return { status: 403, error: 'This relay is disabled on the main Kiosk server.' };
    if (!allowedKinds.includes(cred.kind)) return { status: 403, error: 'This credential can’t be used for that.' };
    const t = now();
    // A rotated credential's first use retires the one it replaced.
    if (cred.replaces_id) {
      revokeCredential(relay.id, cred.replaces_id, 'rotated', `relay:${relay.id}`);
      db.prepare(`UPDATE relay_credentials SET replaces_id = NULL WHERE id = ?`).run(cred.id);
    }
    if (!cred.last_used_at || t - cred.last_used_at > SEEN_WRITE_EVERY_MS) {
      db.prepare(`UPDATE relay_credentials SET last_used_at = ? WHERE id = ?`).run(t, cred.id);
    }
    if (!relay.last_seen_at || t - relay.last_seen_at > SEEN_WRITE_EVERY_MS) {
      db.prepare(`UPDATE relays SET last_seen_at = ? WHERE id = ?`).run(t, relay.id);
    }
    return { relay, credential: cred };
  }

  /** A relay asks for a new credential for itself. The old one keeps working until the new one is used. */
  function rotate(relay, credential) {
    const secret = `rk_${crypto.randomBytes(32).toString('base64url')}`;
    const id = randomId('rcr');
    db.transaction(() => {
      // A rotation that was never finished is dropped, so at most one is waiting.
      db.prepare(`UPDATE relay_credentials SET revoked_at = ?, revoked_reason = 'superseded' WHERE replaces_id = ? AND revoked_at IS NULL`).run(now(), credential.id);
      db.prepare(`INSERT INTO relay_credentials (id, relay_id, kind, secret_hash, replaces_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, relay.id, credential.kind, sha256(secret), credential.id, now());
      event(relay.id, 'credential_rotated', { actor: `relay:${relay.id}`, detail: { kind: credential.kind, old: credential.id, new: id } });
    })();
    return { credentialId: id, credential: secret };
  }

  // ---------- TVs and their owners ----------

  /** A TV came in through a paired relay: if it has no owner yet, that relay owns it now. */
  function noteTvVia(relay, deviceId) {
    const owner = ownerOf(deviceId);
    if (!owner) {
      db.prepare(`INSERT OR IGNORE INTO relay_player_assignments (device_id, relay_id, assigned_at) VALUES (?, ?, ?)`).run(deviceId, relay.id, now());
      event(relay.id, 'player_assigned', { deviceId, detail: { how: 'first seen through this relay' } });
    } else if (owner.id !== relay.id) {
      // It is still owned by the other relay; only an admin moves it. Logged once an hour at most.
      const recent = db.prepare(
        `SELECT 1 FROM relay_events WHERE relay_id = ? AND device_id = ? AND kind = 'player_seen_elsewhere' AND created_at > ?`
      ).get(owner.id, deviceId, now() - 60 * 60 * 1000);
      if (!recent) event(owner.id, 'player_seen_elsewhere', { deviceId, detail: { via_relay: relay.id, via_name: relay.name } });
    }
  }

  function assign(deviceId, relayId, actor) {
    const before = ownerOf(deviceId);
    db.transaction(() => {
      if (relayId) {
        db.prepare(
          `INSERT INTO relay_player_assignments (device_id, relay_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET relay_id = excluded.relay_id, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by`
        ).run(deviceId, relayId, now(), actor.userId ?? null);
        event(relayId, 'player_assigned', { deviceId, actor: actor.label, detail: { from: before ? before.id : null } });
      } else {
        db.prepare(`DELETE FROM relay_player_assignments WHERE device_id = ?`).run(deviceId);
      }
      if (before && before.id !== relayId) event(before.id, 'player_unassigned', { deviceId, actor: actor.label, detail: { to: relayId } });
    })();
  }

  return {
    PAIRING_CODE_MS,
    findRelay,
    relayBySite,
    ownerOf,
    relayView,
    newPairingCode,
    pairingAllowed,
    pair,
    authenticate,
    revokeCredential,
    onCredentialRevoked: (fn) => revokeListeners.push(fn),
    rotate,
    noteTvVia,
    assign,
    event,
    pruneEvents,
    randomId,
  };
}

module.exports = { createRelays, normaliseCode, randomCode, PAIRING_CODE_MS };
