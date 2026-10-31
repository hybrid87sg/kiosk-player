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

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      err.push(chunk);
      if (Buffer.concat(err).length > 8000) err.shift();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-400)}`));
    });
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
}) {
  fs.mkdirSync(dir, { recursive: true });
  const ffmpegAvailable = Boolean(runFfmpeg && probe) || (commandWorks('ffmpeg') && commandWorks('ffprobe'));
  let tail = Promise.resolve();

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

  function markUnsettled(mediaId, status, error) {
    for (const profile of PROFILE_IDS) {
      const current = get(mediaId, profile);
      if (current && current.status === 'ready') continue;
      save(mediaId, profile, { status, error, source_md5: current && current.source_md5 });
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

  // Ready or failed for this exact original counts as done, so a bad file is
  // not encoded again on every Drive sync. A failed copy is retried on startup.
  function isSettled(media) {
    const rows = list(media.id);
    return desiredProfiles(media).every((profile) => rows.some((row) =>
      row.profile === profile && (row.status === 'ready' || row.status === 'failed') && row.source_md5 === media.md5
      && (row.status !== 'ready' || (row.size > 0 && fs.existsSync(pathFor(media.id, profile))))
    ));
  }

  function forget(mediaId) {
    db.prepare(`DELETE FROM renditions WHERE media_id = ?`).run(mediaId);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (
        name.startsWith(`${mediaId}-`)
        || name.startsWith(`.part-${mediaId}-`)
        || name.startsWith(`.src-${mediaId}-`)
      ) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  async function inspect(file) {
    if (probe) return probe(file);
    const json = await runCommand('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
    ]);
    return summarizeProbe(JSON.parse(json));
  }

  async function encode(args) {
    if (runFfmpeg) return runFfmpeg(args);
    return runCommand('ffmpeg', args);
  }

  async function process(media) {
    const fresh = db.prepare(`SELECT * FROM media WHERE id = ?`).get(media.id);
    if (!fresh || fresh.type !== 'video' || !fresh.width || !fresh.height) return;
    if (!enabled()) {
      markUnsettled(fresh.id, 'skipped', requested() ? 'ffmpeg is not installed' : 'Playback copies are turned off');
      return;
    }
    let source = null;
    try {
      source = await downloadOriginal(fresh);
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
        markUnsettled(fresh.id, 'failed', 'No video stream found');
        return;
      }
      for (const job of jobs) {
        if (!enabled()) {
          save(fresh.id, job.profile, { status: 'skipped', error: 'Playback copies are turned off', source_md5: fresh.md5 });
          continue;
        }
        const existing = get(fresh.id, job.profile);
        if (
          existing && existing.status === 'ready' && existing.source_md5 === fresh.md5
          && existing.size > 0 && fs.existsSync(pathFor(fresh.id, job.profile))
        ) continue;
        const part = path.join(dir, `.part-${fresh.id}-${job.profile}.mp4`);
        save(fresh.id, job.profile, { status: 'running', error: null, source_md5: fresh.md5, width: job.width, height: job.height, fps: job.fps });
        try {
          log(`Making a ${job.profile} copy of ${fresh.filename}`);
          await encode(ffmpegArgs(job, source.path, part));
          const size = fs.statSync(part).size;
          if (size <= 0) throw new Error('empty output');
          const md5 = await md5File(part);
          fs.renameSync(part, pathFor(fresh.id, job.profile));
          save(fresh.id, job.profile, {
            status: 'ready', width: job.width, height: job.height, fps: job.fps,
            size, md5, source_md5: fresh.md5, error: null,
          });
          log(`Ready ${job.profile} copy of ${fresh.filename}`);
        } catch (err) {
          fs.rmSync(part, { force: true });
          const message = String(err.message || err).slice(0, 300);
          log(`Could not make a ${job.profile} copy of ${fresh.filename}: ${message}`);
          save(fresh.id, job.profile, { status: 'failed', error: message, source_md5: fresh.md5 });
        }
      }
    } catch (err) {
      const message = String(err.message || err).slice(0, 300);
      log(`Could not prepare copies of ${fresh.filename}: ${message}`);
      for (const profile of desiredProfiles(fresh)) {
        const existing = get(fresh.id, profile);
        if (!existing || existing.status !== 'ready') {
          save(fresh.id, profile, { status: 'failed', error: message, source_md5: fresh.md5 });
        }
      }
    } finally {
      if (source && source.temporary) fs.rmSync(source.path, { force: true });
    }
  }

  function schedule(media) {
    if (!media || media.type !== 'video' || !media.width || !media.height) return Promise.resolve();
    if (!enabled()) {
      markUnsettled(media.id, 'skipped', requested() ? 'ffmpeg is not installed' : 'Playback copies are turned off');
      return Promise.resolve();
    }
    if (isSettled(media)) return Promise.resolve();
    const job = tail.then(() => process(media));
    tail = job.then(() => {}, (err) => log(err));
    return inline ? job : Promise.resolve();
  }

  function resume() {
    if (!enabled()) return Promise.resolve();
    const videos = db.prepare(`SELECT * FROM media WHERE type = 'video' AND width IS NOT NULL AND height IS NOT NULL`).all();
    for (const media of videos) {
      db.prepare(`UPDATE renditions SET status = 'pending', error = NULL WHERE media_id = ? AND status = 'failed'`).run(media.id);
      schedule(media);
    }
    return idle();
  }

  function idle() {
    return inline ? tail : Promise.resolve();
  }

  return {
    schedule,
    resume,
    idle,
    list,
    get,
    pathFor,
    forget,
    requested,
    hevc4k,
    enabled,
    ffmpegAvailable: () => ffmpegAvailable,
  };
}

module.exports = { createTranscoder };
