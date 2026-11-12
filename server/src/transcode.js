// Makes the playback copies after a video arrives, one at a time.
// Originals stay where they are (Google Drive, and the media cache). ffmpeg
// only reads them and writes a new file under the renditions directory.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  PROFILE_IDS, planRenditions, ffmpegArgs, summarizeProbe, PROFILES,
} = require('./renditions');

function commandWorks(name) {
  try {
    const result = spawnSync(name, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true });
}

function runCommand(cmd, args, { signal, timeoutMs, children } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(cancelledError());
      return;
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (children) children.add(child);
    const out = [];
    const err = [];
    let killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeoutMs)
      : null;
    const stop = () => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref?.();
    };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      err.push(chunk);
      if (Buffer.concat(err).length > 8000) err.shift();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (children) children.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (children) children.delete(child);
      if (signal) signal.removeEventListener('abort', stop);
      if (killed || (signal && signal.aborted)) reject(cancelledError());
      else if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-400)}`));
    });
  });
}

function sleep(ms, signal) {
  if (!ms || ms < 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function createTranscoder({
  db,
  dir,
  downloadOriginal,
  enabledDefault = false,
  hevc4kDefault = false,
  inline = false,
  probe = null,
  runFfmpeg = null,
  log = () => {},
  getSetting,
  threads = 1,
  timeoutMs = 2 * 60 * 60 * 1000,
  niceLevel = 19,
  // Backlog copies (an existing library on a Pi) wait, then start one at a time.
  backlogDelayMs = 20_000,
  backlogGapMs = 10_000,
  retryDelayMs = 60_000,
  maxAttempts = 3,
}) {
  fs.mkdirSync(dir, { recursive: true });
  const ffmpegAvailable = Boolean(runFfmpeg && probe) || (commandWorks('ffmpeg') && commandWorks('ffprobe'));
  const useNice = niceLevel > 0 && commandWorks('nice');
  let tail = Promise.resolve();
  // media id -> AbortController, set for the whole time a job is queued or running.
  const controllers = new Map();
  const attempts = new Map();
  const children = new Set();
  const timers = new Set();
  const threadCount = Math.max(1, Number(threads) || 1);

  const upsertRow = db.prepare(`
    INSERT INTO renditions (media_id, profile, status, width, height, fps, size, md5, source_md5, error, updated_at)
    VALUES (@media_id, @profile, @status, @width, @height, @fps, @size, @md5, @source_md5, @error, @updated_at)
    ON CONFLICT(media_id, profile) DO UPDATE SET
      status = excluded.status,
      width = excluded.width,
      height = excluded.height,
      fps = excluded.fps,
      size = excluded.size,
      md5 = excluded.md5,
      source_md5 = excluded.source_md5,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);

  function requested() {
    const saved = getSetting('transcode_videos');
    return typeof saved === 'boolean' ? saved : enabledDefault;
  }

  function hevc4k() {
    const saved = getSetting('transcode_4k_hevc');
    return typeof saved === 'boolean' ? saved : hevc4kDefault;
  }

  function enabled() {
    return requested() && ffmpegAvailable;
  }

  function list(mediaId) {
    return db.prepare(
      `SELECT profile, status, width, height, fps, size, md5, source_md5, error FROM renditions WHERE media_id = ?`
    ).all(mediaId);
  }

  function get(mediaId, profile) {
    return list(mediaId).find((row) => row.profile === profile) || null;
  }

  function pathFor(mediaId, profile) {
    return path.join(dir, `${mediaId}-${profile}.mp4`);
  }

  function save(mediaId, profile, fields) {
    const current = get(mediaId, profile) || {};
    upsertRow.run({
      media_id: mediaId,
      profile,
      status: fields.status,
      width: fields.width !== undefined ? fields.width : current.width || null,
      height: fields.height !== undefined ? fields.height : current.height || null,
      fps: fields.fps !== undefined ? fields.fps : current.fps || null,
      size: fields.size !== undefined ? fields.size : current.size || null,
      md5: fields.md5 !== undefined ? fields.md5 : current.md5 || null,
      source_md5: fields.source_md5 !== undefined ? fields.source_md5 : current.source_md5 || null,
      error: fields.error !== undefined ? fields.error : null,
      updated_at: Date.now(),
    });
  }

  function markUnsettled(mediaId, status, error, sourceMd5) {
    for (const profile of PROFILE_IDS) {
      const current = get(mediaId, profile);
      if (current && current.status === 'ready') continue;
      save(mediaId, profile, { status, error, source_md5: sourceMd5 || (current && current.source_md5) });
    }
  }

  // Every profile that isn't already a good copy of this file becomes failed,
  // so a timeout cannot leave a hole that the next Drive sync fills by starting again.
  function failOpenProfiles(media, message) {
    log(`${media.filename}: ${message}`);
    for (const profile of desiredProfiles(media)) {
      const existing = get(media.id, profile);
      if (existing && existing.status === 'ready' && existing.source_md5 === media.md5 && existing.size > 0) continue;
      saveQuietly(media.id, profile, { status: 'failed', error: message, source_md5: media.md5 });
    }
  }

  function largerThanProfile(media, profile) {
    if (!media.width || !media.height) return false;
    const long = Math.max(media.width, media.height);
    const short = Math.min(media.width, media.height);
    return long > profile.maxLong || short > profile.maxShort;
  }

  function desiredProfiles(media) {
    const ids = ['h264_1080'];
    if (largerThanProfile(media, PROFILES.h264_720)) ids.push('h264_720');
    if (hevc4k() && largerThanProfile(media, PROFILES.h264_1080)) ids.push('hevc_2160');
    return ids;
  }

  // Ready or failed for this exact original counts as done. A failed copy stays
  // failed across Drive syncs; only the in-process retry (a few attempts) starts it again.
  function isSettled(media) {
    const rows = list(media.id);
    return desiredProfiles(media).every((profile) => rows.some((row) =>
      row.profile === profile && (row.status === 'ready' || row.status === 'failed') && row.source_md5 === media.md5
      && (row.status !== 'ready' || (row.size > 0 && fs.existsSync(pathFor(media.id, profile))))
    ));
  }

  // Expired and removed files (removed_at set) are gone as far as copies go.
  function mediaStillThere(mediaId) {
    return Boolean(db.prepare(`SELECT 1 FROM media WHERE id = ? AND removed_at IS NULL`).get(mediaId));
  }

  function removeFilesFor(mediaId) {
    if (!fs.existsSync(dir)) return;
    const prefix = String(mediaId);
    for (const name of fs.readdirSync(dir)) {
      if (
        name.startsWith(`${prefix}-`)
        || name.startsWith(`.part-${prefix}-`)
        || name.startsWith(`.src-${prefix}-`)
      ) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  // Drop half-written files whose video is gone (a delete during an encode, or a crash).
  function sweepOrphans() {
    if (!fs.existsSync(dir)) return;
    const ids = new Set(db.prepare(`SELECT id FROM media WHERE removed_at IS NULL`).all().map((row) => String(row.id)));
    for (const name of fs.readdirSync(dir)) {
      const match = /^(?:\.part-|\.src-)?(\d+)-/.exec(name);
      if (match && !ids.has(match[1])) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  function forget(mediaId) {
    const controller = controllers.get(mediaId);
    if (controller) controller.abort();
    attempts.delete(mediaId);
    try {
      db.prepare(`DELETE FROM renditions WHERE media_id = ?`).run(mediaId);
    } catch (err) {
      log(err);
    }
    removeFilesFor(mediaId);
  }

  function shutdown() {
    for (const controller of controllers.values()) controller.abort();
    for (const child of children) child.kill('SIGTERM');
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  async function inspect(file) {
    if (probe) return probe(file);
    const json = await runCommand('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,crypto,data', '-f', 'mov',
      '-print_format', 'json', '-show_streams', '-show_format', file,
    ]);
    return summarizeProbe(JSON.parse(json));
  }

  async function encode(args, signal) {
    if (signal && signal.aborted) throw cancelledError();
    if (runFfmpeg) return runFfmpeg(args, signal);
    if (useNice) {
      return runCommand('nice', ['-n', String(niceLevel), 'ffmpeg', ...args], { signal, timeoutMs, children });
    }
    return runCommand('ffmpeg', args, { signal, timeoutMs, children });
  }

  function rememberRetry(media) {
    if (!mediaStillThere(media.id)) return;
    const failed = desiredProfiles(media).some((profile) => {
      const row = get(media.id, profile);
      return row && row.status === 'failed' && row.source_md5 === media.md5;
    });
    if (!failed) {
      attempts.delete(media.id);
      return;
    }
    const count = (attempts.get(media.id) || 0) + 1;
    attempts.set(media.id, count);
    if (count >= maxAttempts) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(media.id);
      if (!row || controllers.has(row.id)) return;
      db.prepare(
        `UPDATE renditions SET status = 'pending', error = NULL WHERE media_id = ? AND status = 'failed' AND source_md5 = ?`
      ).run(row.id, row.md5);
      schedule(row);
    }, retryDelayMs * count);
    timer.unref?.();
    timers.add(timer);
  }

  function saveQuietly(mediaId, profile, fields) {
    if (!mediaStillThere(mediaId)) return false;
    try {
      save(mediaId, profile, fields);
      return true;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return false;
      throw err;
    }
  }

  async function process(media, signal) {
    const fresh = db.prepare(`SELECT * FROM media WHERE id = ?`).get(media.id);
    if (!fresh || fresh.type !== 'video' || !fresh.width || !fresh.height) return;
    if (signal && signal.aborted) return;
    if (!enabled()) {
      markUnsettled(fresh.id, 'skipped', requested() ? 'ffmpeg is not installed' : 'Playback copies are turned off');
      return;
    }
    let source = null;
    try {
      source = await downloadOriginal(fresh);
      if ((signal && signal.aborted) || !mediaStillThere(fresh.id)) return;
      const info = await inspect(source.path);
      const video = info && info.video;
      db.prepare(
        `UPDATE media SET source_codec = ?, source_profile = ?, source_level = ?, source_fps = ?, source_pix_fmt = ?, source_vfr = ? WHERE id = ?`
      ).run(
        video && video.codec,
        video && video.profile,
        video && video.level,
        video && video.fps,
        video && video.pixFmt,
        video && video.variableFrameRate ? 1 : 0,
        fresh.id,
      );
      const jobs = planRenditions(info, { hevc4k: hevc4k() });
      const wanted = new Set(jobs.map((job) => job.profile));
      for (const profile of PROFILE_IDS) {
        if (!wanted.has(profile)) save(fresh.id, profile, { status: 'skipped', error: null, source_md5: fresh.md5 });
      }
      if (!jobs.length) {
        markUnsettled(fresh.id, 'failed', 'No video stream found', fresh.md5);
        return;
      }
      for (const job of jobs) {
        if ((signal && signal.aborted) || !mediaStillThere(fresh.id)) return;
        if (!enabled()) {
          saveQuietly(fresh.id, job.profile, { status: 'skipped', error: 'Playback copies are turned off', source_md5: fresh.md5 });
          continue;
        }
        const existing = get(fresh.id, job.profile);
        if (
          existing && existing.status === 'ready' && existing.source_md5 === fresh.md5
          && existing.size > 0 && fs.existsSync(pathFor(fresh.id, job.profile))
        ) continue;
        const part = path.join(dir, `.part-${fresh.id}-${job.profile}.mp4`);
        saveQuietly(fresh.id, job.profile, { status: 'running', error: null, source_md5: fresh.md5, width: job.width, height: job.height, fps: job.fps });
        try {
          log(`Making a ${job.profile} copy of ${fresh.filename}`);
          await encode(ffmpegArgs(job, source.path, part, { threads: threadCount }), signal);
          if ((signal && signal.aborted) || !mediaStillThere(fresh.id)) {
            fs.rmSync(part, { force: true });
            return;
          }
          const size = fs.statSync(part).size;
          if (size <= 0) throw new Error('empty output');
          const md5 = await md5File(part);
          const finalPath = pathFor(fresh.id, job.profile);
          fs.renameSync(part, finalPath);
          const saved = saveQuietly(fresh.id, job.profile, {
            status: 'ready', width: job.width, height: job.height, fps: job.fps,
            size, md5, source_md5: fresh.md5, error: null,
          });
          if (!saved) fs.rmSync(finalPath, { force: true });
          else log(`Ready ${job.profile} copy of ${fresh.filename}`);
        } catch (err) {
          fs.rmSync(part, { force: true });
          if (signal && signal.aborted) return;
          if (err.cancelled) {
            failOpenProfiles(fresh, 'encode timed out');
            return;
          }
          const message = String(err.message || err).slice(0, 300);
          log(`Could not make a ${job.profile} copy of ${fresh.filename}: ${message}`);
          saveQuietly(fresh.id, job.profile, { status: 'failed', error: message, source_md5: fresh.md5 });
        }
      }
    } catch (err) {
      if ((signal && signal.aborted) || err.cancelled) return;
      const message = String(err.message || err).slice(0, 300);
      log(`Could not prepare copies of ${fresh.filename}: ${message}`);
      for (const profile of desiredProfiles(fresh)) {
        const existing = get(fresh.id, profile);
        if (!existing || existing.status !== 'ready') {
          saveQuietly(fresh.id, profile, { status: 'failed', error: message, source_md5: fresh.md5 });
        }
      }
    } finally {
      if (source && source.temporary) fs.rmSync(source.path, { force: true });
      if (signal && !signal.aborted) rememberRetry(fresh);
    }
  }

  function schedule(media, { delayMs = 0 } = {}) {
    if (!media || media.type !== 'video' || !media.width || !media.height) return Promise.resolve();
    // Already queued or encoding. A Drive sync must not download the original again.
    if (controllers.has(media.id)) return Promise.resolve();
    if (!enabled()) {
      markUnsettled(media.id, 'skipped', requested() ? 'ffmpeg is not installed' : 'Playback copies are turned off', media.md5);
      return Promise.resolve();
    }
    if (isSettled(media)) return Promise.resolve();
    const controller = new AbortController();
    controllers.set(media.id, controller);
    const joinQueue = () => {
      if (controller.signal.aborted) {
        if (controllers.get(media.id) === controller) controllers.delete(media.id);
        return Promise.resolve();
      }
      const job = tail.then(async () => {
        if (controller.signal.aborted) return;
        const fresh = db.prepare(`SELECT * FROM media WHERE id = ?`).get(media.id);
        if (!fresh || isSettled(fresh)) return;
        await process(fresh, controller.signal);
      }).finally(() => {
        if (controllers.get(media.id) === controller) controllers.delete(media.id);
      });
      tail = job.then(() => {}, (err) => log(err));
      return job;
    };
    // The wait happens before the job joins the encode queue, and it is the same
    // length for every backlog video. New uploads (no delay) are not stuck behind
    // a delay that grows with the size of the library.
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        joinQueue();
      }, delayMs);
      timer.unref?.();
      timers.add(timer);
      return Promise.resolve();
    }
    const job = joinQueue();
    return inline ? job : Promise.resolve();
  }

  function resume() {
    if (!enabled()) return Promise.resolve();
    // Failed copies stay failed. A row left "running" by a crash is not settled,
    // so it is picked up here. Each backlog video waits the same gap, outside the queue.
    const videos = db.prepare(
      `SELECT * FROM media WHERE type = 'video' AND width IS NOT NULL AND height IS NOT NULL AND removed_at IS NULL`
    ).all();
    for (const media of videos) {
      if (isSettled(media) || controllers.has(media.id)) continue;
      schedule(media, { delayMs: backlogGapMs });
    }
    return idle();
  }

  function idle() {
    return inline ? tail : Promise.resolve();
  }

  sweepOrphans();

  return {
    schedule,
    resume,
    idle,
    list,
    get,
    pathFor,
    forget,
    shutdown,
    requested,
    hevc4k,
    enabled,
    ffmpegAvailable: () => ffmpegAvailable,
  };
}

// Missing or any other value stays off, so an upgraded install does not start encoding
// until someone turns the option on.
function transcodeOptIn(value) {
  return value === true || value === 'on';
}

module.exports = { createTranscoder, transcodeOptIn };
