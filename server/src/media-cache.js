// Optional local copy of each Drive file, kept on the server's own disk.
//
// Without it, every TV's download is fetched from Google Drive again. With it,
// the first full download of a file is also saved here, and every later
// download of that file (by any TV) is served straight from this disk. Useful
// when the server runs on the same network as the TVs, e.g. Home Assistant.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Leftover half-written files older than this are cleaned up.
const STALE_PART_MS = 60 * 60 * 1000;

class MediaCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  // The file name includes the md5, so a changed file never reuses an old copy.
  pathFor(media) {
    return path.join(this.dir, `${media.id}-${media.md5}${path.extname(media.filename).toLowerCase()}`);
  }

  has(media) {
    try {
      return fs.statSync(this.pathFor(media)).size === media.size;
    } catch {
      return false;
    }
  }

  // Saves a copy while the file streams past. Call write() for each chunk,
  // then finish() (keeps it only if complete and the md5 matches) or abort().
  startRecording(media) {
    const finalPath = this.pathFor(media);
    const partPath = `${finalPath}.part-${crypto.randomUUID()}`; // unique, so two TVs can't mix their writes
    const out = fs.createWriteStream(partPath);
    const hash = crypto.createHash('md5');
    let size = 0;
    let failed = false;
    out.on('error', () => (failed = true));
    return {
      write(chunk) {
        size += chunk.length;
        hash.update(chunk);
        out.write(chunk);
      },
      async finish() {
        await new Promise((resolve) => out.end(resolve));
        if (!failed && size === media.size && hash.digest('hex') === media.md5) {
          fs.renameSync(partPath, finalPath);
        } else {
          fs.rmSync(partPath, { force: true });
        }
      },
      abort() {
        out.destroy();
        fs.rmSync(partPath, { force: true });
      },
    };
  }

  // Deletes copies of files that are no longer in the library (or have changed).
  prune(libraryRows) {
    const keep = new Set(libraryRows.map((m) => path.basename(this.pathFor(m))));
    for (const name of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, name);
      if (name.includes('.part-')) {
        if (Date.now() - fs.statSync(full).mtimeMs > STALE_PART_MS) fs.rmSync(full, { force: true });
      } else if (!keep.has(name)) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

module.exports = { MediaCache };
