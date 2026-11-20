// The Windows Kiosk Browser installer that goes with this server's version (0.13.0), so
// PCs can update themselves from here: they only ever talk to this server, never GitHub.
//
// The installer is too big to carry in the add-on, so the server fetches it once from the
// GitHub release of its own version (KioskBrowser-Setup-<version>.exe), checks it against
// the fingerprint (sha256) GitHub lists for that file, and keeps it in its data folder.
// A release's Windows installer is built last, a few minutes after the add-on: until then
// it's simply "not ready yet" and is tried again later.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RETRY_AFTER_MS = 30 * 60 * 1000; // after a failed or too-early try
const MAX_BYTES = 400 * 1024 * 1024;

function createWindowsApp({ dir, version, repo = 'hybrid87sg/kiosk-player', fetchImpl = fetch, log = () => {}, now = () => Date.now() }) {
  const name = `KioskBrowser-Setup-${version}.exe`;
  const file = path.join(dir, name);
  const infoFile = path.join(dir, `${name}.json`);
  let ready = null; // { version, size, sha256, file }
  let fetching = null;
  let lastTry = -Infinity;
  let problem = null;

  try {
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    if (info.version === version && fs.statSync(file).size === info.size) ready = { ...info, file };
  } catch { /* not fetched yet */ }

  // Older versions' installers aren't needed any more.
  function removeOld() {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('KioskBrowser-Setup-') && !f.startsWith(name)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch { /* nothing there */ }
  }

  async function download() {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'kiosk-signage-server' };
    const release = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (release.status === 404) throw new Error(`There is no release v${version} on GitHub yet.`);
    if (!release.ok) throw new Error(`GitHub answered ${release.status}.`);
    const asset = ((await release.json()).assets || []).find((a) => a.name === name);
    if (!asset) throw new Error(`The v${version} release has no Windows installer yet (it's built a few minutes after the rest).`);
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '');
    if (!sha256) throw new Error('GitHub gave no fingerprint for the installer, so it can’t be checked.');
    if (!(asset.size > 0 && asset.size < MAX_BYTES)) throw new Error('The installer’s size looks wrong.');
    fs.mkdirSync(dir, { recursive: true });
    const part = `${file}.part`;
    const reply = await fetchImpl(asset.browser_download_url, { headers: { 'user-agent': 'kiosk-signage-server' }, signal: AbortSignal.timeout(15 * 60_000) });
    if (!reply.ok || !reply.body) throw new Error(`Downloading the installer failed (${reply.status}).`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk, enc, done) {
        size += chunk.length;
        if (size > MAX_BYTES) return done(new Error('The installer is bigger than expected.'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(reply.body), counter, fs.createWriteStream(part));
      const got = hash.digest('hex');
      if (got !== sha256[1] || size !== asset.size) throw new Error('The downloaded installer doesn’t match its fingerprint, so it wasn’t kept.');
      fs.renameSync(part, file);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }
    const info = { version, size, sha256: sha256[1] };
    fs.writeFileSync(infoFile, JSON.stringify(info));
    removeOld();
    return { ...info, file };
  }

  return {
    version,
    /** The installer if it's here, else null. Never waits. */
    get ready() { return ready; },
    /** Why it isn't here yet (null while trying, or once it's here). */
    get problem() { return ready ? null : problem; },
    /**
     * Fetches it if it isn't here yet (at most every 30 minutes, unless [force]).
     * Resolves to the installer or null; never rejects.
     */
    async fetch({ force = false } = {}) {
      if (ready) return ready;
      if (fetching) return fetching;
      if (!force && now() - lastTry < RETRY_AFTER_MS) return null;
      lastTry = now();
      fetching = download()
        .then((got) => {
          ready = got;
          problem = null;
          log(`Windows Kiosk Browser ${version} is ready to send to PCs`);
          return got;
        })
        .catch((err) => {
          problem = err.message;
          log(`Windows Kiosk Browser ${version}: not available yet (${err.message})`);
          return null;
        })
        .finally(() => { fetching = null; });
      return fetching;
    },
  };
}

module.exports = { createWindowsApp };
