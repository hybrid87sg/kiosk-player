// Passwords, tokens and the "middleware" that checks them on each request.
// Middleware is a function Express runs before the route itself; it can
// reject the request (401) or attach who is calling (req.user / req.device).

const crypto = require('node:crypto');

// Passwords are never stored as-is. scrypt turns them into a slow-to-crack hash.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Reads "Authorization: Bearer <token>" from the request.
function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAdmin(db) {
  const findSession = db.prepare(
    `SELECT users.id, users.username FROM sessions
     JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?`
  );
  return (req, res, next) => {
    const user = findSession.get(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not logged in' });
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
function requireAdminOrDevice(db) {
  const findSession = db.prepare(`SELECT user_id FROM sessions WHERE token = ?`);
  const findDevice = db.prepare(`SELECT id FROM devices WHERE token = ? AND claimed = 1`);
  return (req, res, next) => {
    const token = bearerToken(req);
    if (findSession.get(token) || findDevice.get(token)) return next();
    res.status(401).json({ error: 'Not allowed' });
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  requireAdmin,
  requireDevice,
  requireAdminOrDevice,
};
