// Tokens, roles and the "middleware" that checks them on each request.
// Middleware is a function Express runs before the route itself; it can
// reject the request (401/403) or attach who is calling (req.user / req.device).

const crypto = require('node:crypto');

const ROLES = ['superadmin', 'system_manager', 'content_uploader'];

// Which roles may use which part of the API (see the table in the plan).
const CAN_MANAGE_CONTENT = ['superadmin', 'system_manager', 'content_uploader'];
const CAN_MANAGE_DEVICES = ['superadmin', 'system_manager'];
const CAN_MANAGE_USERS = ['superadmin'];

// Admin app sessions last 30 days; after that, sign in with Google again.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Reads "Authorization: Bearer <token>" from the request.
function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function sessionLookup(db) {
  const stmt = db.prepare(
    `SELECT users.id, users.email, users.role FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.created_at > ?`
  );
  return (token) => stmt.get(token, Date.now() - SESSION_MAX_AGE_MS);
}

// Usage: app.get('/x', requireRole(db, CAN_MANAGE_DEVICES), handler)
function requireRole(db, allowedRoles) {
  const findUser = sessionLookup(db);
  return (req, res, next) => {
    const user = findUser(bearerToken(req));
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
    const token = bearerToken(req);
    if (findUser(token) || findDevice.get(token)) return next();
    res.status(401).json({ error: 'Not allowed' });
  };
}

module.exports = {
  ROLES,
  CAN_MANAGE_CONTENT,
  CAN_MANAGE_DEVICES,
  CAN_MANAGE_USERS,
  newToken,
  bearerToken,
  requireRole,
  requireDevice,
  requireUserOrDevice,
};
