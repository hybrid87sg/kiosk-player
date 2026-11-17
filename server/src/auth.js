// Tokens, roles and the "middleware" that checks them on each request.
// Middleware is a function Express runs before the route itself; it can
// reject the request (401/403) or attach who is calling (req.user / req.device).

const crypto = require('node:crypto');
const { hashToken } = require('./db');

const ROLES = ['superadmin', 'system_manager', 'content_uploader'];

// Which roles may use which part of the API (see the table in the plan).
const CAN_MANAGE_CONTENT = ['superadmin', 'system_manager', 'content_uploader'];
const CAN_MANAGE_DEVICES = ['superadmin', 'system_manager'];
const CAN_MANAGE_USERS = ['superadmin'];

// Sessions last 30 days; after that, sign in again.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Passwords are never stored. What is stored is a "hash": the password put
// through scrypt (slow on purpose, so guessing is slow) with a random salt.
// Stored as "scrypt$<salt>$<hash>", both in hex.
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(password, salt)).toString('hex')}`;
}
// The same, without waiting: used once at start-up for the first superadmin.
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}
// A stand-in checked when the username doesn't exist, so that takes just as long.
const NO_SUCH_USER = `scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`;
async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || NO_SUCH_USER).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const wanted = Buffer.from(hash, 'hex');
  const got = await scrypt(password, Buffer.from(salt, 'hex'));
  return stored != null && wanted.length === got.length && crypto.timingSafeEqual(wanted, got);
}

// Usernames are lower case: letters, digits and . _ - @ (so an email address works too).
const USERNAME = /^[a-z0-9][a-z0-9._@-]{2,39}$/;
function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Use a password of at least 8 characters';
  if (password.length > 200) return 'That password is too long';
  return null;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Reads "Authorization: Bearer <token>" from the request.
function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// The database keeps only a hash of each sign-in session's token (db.js), so a copy of the
// database can't be used to sign in. This is what to look the caller's session up by.
function sessionKey(req) {
  const token = bearerToken(req);
  return token ? hashToken(token) : '';
}

// Finds who is calling: a Home Assistant user (through the sidebar page), or
// a signed-in session (phone app or web page, by token).
//
// On the public address (req.viaPublic, the Funnel door in app.js) only sessions that signed
// in with Google count: a password session, even a real one, is refused there.
function sessionLookup(db) {
  const stmt = db.prepare(
    `SELECT users.id, users.email, users.role, sessions.method FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.created_at > ?`
  );
  return (req) => {
    const ha = homeAssistantUser(req);
    if (ha) return ha;
    const session = stmt.get(sessionKey(req), Date.now() - SESSION_MAX_AGE_MS);
    if (session && req.viaPublic && session.method !== 'google') return undefined;
    return session;
  };
}

// Requests through Home Assistant's sidebar ("ingress") are already signed in
// to Home Assistant, which says who it is in these headers. They are only
// trusted when the request arrived on the private ingress port from Home
// Assistant itself (req.viaIngress, set in app.js). The sidebar page is for
// Home Assistant admins only, so these people are superadmins.
function homeAssistantUser(req) {
  if (!req.viaIngress) return null;
  const id = req.get('x-remote-user-id');
  if (!id) return null;
  const name = req.get('x-remote-user-display-name') || req.get('x-remote-user-name') || 'Home Assistant user';
  return { id: null, haUserId: id, email: name, role: 'superadmin', viaHomeAssistant: true };
}

// Usage: app.get('/x', requireRole(db, CAN_MANAGE_DEVICES), handler)
function requireRole(db, allowedRoles) {
  const findUser = sessionLookup(db);
  return (req, res, next) => {
    const user = findUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    if (!allowedRoles.includes(user.role)) return res.status(403).json({ error: 'Your role is not allowed to do this' });
    req.user = user;
    next();
  };
}

// claimedOnly=false lets an unpaired player ask "have I been claimed yet?".
function requireDevice(db, { claimedOnly = true } = {}) {
  const findDevice = db.prepare(`SELECT * FROM devices WHERE token = ?`);
  return (req, res, next) => {
    const device = findDevice.get(bearerToken(req));
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    if (claimedOnly && !device.claimed) return res.status(403).json({ error: 'Device not paired yet' });
    req.device = device;
    next();
  };
}

// The media download is used by both players and the admin app (previews).
function requireUserOrDevice(db) {
  const findUser = sessionLookup(db);
  const findDevice = db.prepare(`SELECT id FROM devices WHERE token = ? AND claimed = 1`);
  return (req, res, next) => {
    if (findUser(req) || findDevice.get(bearerToken(req))) return next();
    res.status(401).json({ error: 'Not allowed' });
  };
}

module.exports = {
  ROLES,
  CAN_MANAGE_CONTENT,
  CAN_MANAGE_DEVICES,
  CAN_MANAGE_USERS,
  newToken,
  hashPassword,
  hashPasswordSync,
  checkPassword,
  checkNewPassword,
  USERNAME,
  bearerToken,
  sessionKey,
  hashToken,
  requireRole,
  requireDevice,
  requireUserOrDevice,
};
