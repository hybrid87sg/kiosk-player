// Keeps this PC's copies of its playlist's files, like the TV app's ContentSync:
// downloads what's missing (resuming a half-finished file), checks each file's
// fingerprint (md5), and deletes files no playlist uses any more.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class DownloadError extends Error {}

function createSync({ baseUrl, mediaDir, getToken, fetchImpl = fetch, timeoutMs = 60_000 }) {
  fs.mkdirSync(mediaDir, { recursive: true });

  const extOf = (item) => {
    const ext = path.extname(item.filename || '').toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
  };
  const fileFor = (item) => path.join(mediaDir, `${item.id}-${item.md5}${item.rendition ? '-r' : ''}${extOf(item)}`);

  function isReady(item) {
    try { return fs.statSync(fileFor(item)).size === item.size; } catch { return false; }
  }

  function md5Of(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
    });
  }

  async function download(item) {
    const target = fileFor(item);
    const part = `${target}.part`;
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* none yet */ }
    if (have > item.size) { fs.rmSync(part, { force: true }); have = 0; }
    const free = freeBytes();
    if (free !== null && free < (item.size - have) + 200 * 1024 * 1024) {
      throw new DownloadError(`${item.filename}: not enough free space on this PC`);
    }
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${item.url}`, {
        headers: { authorization: `Bearer ${getToken()}`, ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
        signal: AbortSignal.timeout(timeoutMs * 10),
      });
    } catch {
      throw new DownloadError(`${item.filename}: connection lost, will resume`);
    }
    if (res.status === 416) { fs.rmSync(part, { force: true }); throw new DownloadError(`${item.filename}: starting again`); }
    if (!res.ok || !res.body) throw new DownloadError(`${item.filename}: server answered ${res.status}`);
    const append = res.status === 206;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
    } catch {
      throw new DownloadError(`${item.filename}: connection lost, will resume`);
    }
    const size = fs.statSync(part).size;
    if (size !== item.size) throw new DownloadError(`${item.filename}: incomplete, will resume`);
    if ((await md5Of(part)).toLowerCase() !== String(item.md5).toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new DownloadError(`${item.filename}: damaged download, starting again`);
    }
    fs.renameSync(part, target);
  }

  /** Gets every file of the playlist (and those starting soon). Throws DownloadError on a problem. */
  async function sync(playlist, { onProgress = () => {}, keep = [] } = {}) {
    const items = [...(playlist.items || []), ...(playlist.upcoming || [])]
      .filter((item, i, all) => all.findIndex((x) => x.id === item.id && x.md5 === item.md5) === i);
    removeUnused(items, keep);
    let done = items.filter(isReady).length;
    onProgress(done, items.length);
    for (const item of items) {
      if (isReady(item)) continue;
      await download(item);
      done++;
      onProgress(done, items.length);
    }
  }

  function removeUnused(items, keep = []) {
    const wanted = new Set([...items.map((i) => path.basename(fileFor(i))), ...keep.map((f) => path.basename(f))]);
    for (const name of fs.readdirSync(mediaDir)) {
      if (!wanted.has(name.replace(/\.part$/, ''))) fs.rmSync(path.join(mediaDir, name), { force: true });
    }
  }

  function freeBytes() {
    try {
      const s = fs.statfsSync(mediaDir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  return { sync, isReady, fileFor, removeUnused, freeBytes };
}

module.exports = { createSync, DownloadError };
