// What the dashboard asks a Kiosk Browser to do (0.13.0), without any window:
//
//   Restart     the app, or the whole PC. The request's id is saved first, so once
//               the app is running again it reports "done" instead of restarting again.
//   See screen  the window (main.js) takes the picture; this sends it.
//   Update      downloads the installer that goes with the server, checks its fingerprint,
//               and says when it's ready. The window installs it when nobody is using the
//               kiosk ("now"), or outside working hours ("closed": overnight, by itself).
//
// The controller calls handle() with each playlist's actions, and sends what reports()
// returns with its heartbeat.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function createRemote({ store, dataDir, events, log = () => {}, fetchImpl = fetch }) {
  const updateDir = path.join(dataDir, 'updates');
  let restartReport = null;
  let updateReport = null;
  let lastShot = null;
  let ready = null; // { id, file, version, when }
  let downloading = null;
  let failed = null; // { version, at }: a version that didn't download isn't tried again for an hour
  const RETRY_FAILED_MS = 60 * 60 * 1000;

  const installerFor = (u) => path.join(updateDir, `KioskBrowser-Setup-${String(u.version).replace(/[^0-9A-Za-z.-]/g, '')}.exe`);

  async function sha256Of(file) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
  }

  async function download(api, baseUrl, u) {
    fs.mkdirSync(updateDir, { recursive: true });
    const file = installerFor(u);
    try {
      if (fs.statSync(file).size === u.size && (await sha256Of(file)) === u.sha256) return file; // already here
    } catch { /* not yet */ }
    // Older downloads aren't needed.
    for (const f of fs.readdirSync(updateDir)) if (path.join(updateDir, f) !== file) fs.rmSync(path.join(updateDir, f), { force: true });
    const res = await fetchImpl(`${baseUrl}${u.url}`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!res.ok || !res.body) throw new Error(`The server didn’t send the installer (${res.status}).`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const part = `${file}.part`;
    const counter = new Transform({
      transform(chunk, enc, done) {
        size += chunk.length;
        if (size > u.size) return done(new Error('The installer is bigger than expected.'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
      if (size !== u.size || hash.digest('hex') !== u.sha256) throw new Error('The installer doesn’t match its fingerprint, so it wasn’t kept.');
      fs.renameSync(part, file);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }
    return file;
  }

  return {
    /** The playlist's actions (from servers 0.13.0 and newer; older ones send none of these). */
    async handle(actions = {}, { api, baseUrl }) {
      // Restart.
      const r = actions.restart;
      if (!r) {
        store.set('restartDoneId', null);
        restartReport = null;
      } else if (store.get('restartDoneId') === r.id) {
        restartReport = { id: r.id, step: 'done' };
      } else {
        store.set('restartDoneId', r.id);
        log(`Restart (${r.kind}) asked for on the dashboard`);
        events.emit('restart', r.kind === 'device' ? 'device' : 'app');
      }

      // See screen.
      if (actions.screenshot && actions.screenshot !== lastShot) {
        lastShot = actions.screenshot;
        events.emit('screenshot', actions.screenshot);
      }

      // Update.
      const u = actions.update;
      if (!u || !u.id || !u.url || !u.sha256 || !(u.size > 0)) {
        ready = null;
        updateReport = null;
        return;
      }
      if (failed && failed.version === u.version && Date.now() - failed.at < RETRY_FAILED_MS) {
        updateReport = { id: u.id, step: 'failed', error: failed.error };
        return;
      }
      if (ready && ready.id === u.id) {
        ready.when = u.when === 'closed' ? 'closed' : 'now';
        return;
      }
      if (downloading) return;
      updateReport = { id: u.id, step: 'downloading' };
      downloading = download(api, baseUrl, u)
        .then((file) => {
          ready = { id: u.id, file, version: u.version, when: u.when === 'closed' ? 'closed' : 'now' };
          updateReport = { id: u.id, step: 'waiting_for_install' };
          events.emit('update-ready', ready);
        })
        .catch((err) => {
          log(`Update didn’t download: ${err.message}`);
          const error = String(err.message || err).slice(0, 300);
          failed = { version: u.version, at: Date.now(), error };
          updateReport = { id: u.id, step: 'failed', error };
        })
        .finally(() => { downloading = null; });
      await downloading;
    },

    /** A downloaded update waiting to be installed, or null. */
    get ready() { return ready; },

    /** The window is about to run the installer. */
    installing() {
      if (ready) updateReport = { id: ready.id, step: 'installing' };
    },

    /** The installer couldn't be started. */
    installFailed(message) {
      if (ready) updateReport = { id: ready.id, step: 'failed', error: String(message).slice(0, 300) };
      ready = null;
    },

    /** Added to each heartbeat. */
    reports() {
      return {
        can_reboot: process.platform === 'win32',
        ...(restartReport ? { restart: restartReport } : {}),
        ...(updateReport ? { update: updateReport } : {}),
      };
    },
  };
}

module.exports = { createRemote };
