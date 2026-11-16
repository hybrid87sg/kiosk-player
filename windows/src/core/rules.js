// What customers may open, and the staff PIN check.

const crypto = require('node:crypto');

/**
 * May the kiosk show this address? Pages on the start page's own website (and its
 * subdomains) always may; other websites only when listed ("*.example.com" covers
 * every subdomain). Nothing but http/https: no files, e-mail, apps or scripts.
 */
function isAllowed(address, startUrl, allowedHosts = []) {
  let url;
  let start;
  try {
    url = new URL(address);
    start = new URL(startUrl);
  } catch {
    return false;
  }
  if (address === 'about:blank') return true;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  const home = start.hostname.toLowerCase().replace(/^www\./, '');
  if (host === home || host.endsWith(`.${home}`)) return true;
  return allowedHosts.some((rule) => {
    const r = String(rule).toLowerCase();
    if (r.startsWith('*.')) return host === r.slice(2) || host.endsWith(r.slice(1));
    return host === r || host === `www.${r}`;
  });
}

/** Checks a typed staff PIN against { salt, sha256 } from the server. */
function pinMatches(pin, stored) {
  if (!stored || !stored.salt || !stored.sha256) return false;
  const got = crypto.createHash('sha256').update(`${stored.salt}:${String(pin)}`).digest();
  const want = Buffer.from(String(stored.sha256), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { isAllowed, pinMatches };
