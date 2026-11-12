// The encode queue: one job per video, cancel on delete, retry a failure,
// and drop files whose video is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createTranscoder, transcodeOptIn } = require('../src/transcode');

const probe = {
  video: {
    codec: 'h264', profile: 'High', level: 40, width: 1280, height: 720,
    pixFmt: 'yuv420p', fps: 30, variableFrameRate: false,
  },
  audio: { codec: 'aac', channels: 2, profile: 'LC' },
};

function setup(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-tq-'));
  const dir = path.join(dataDir, 'renditions');
  fs.mkdirSync(dir, { recursive: true });
  const db = openDatabase(dataDir);
  if (t) {
    t.after(() => {
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  }
  const source = path.join(dataDir, 'source.mp4');
  fs.writeFileSync(source, 'original-bytes');
  let downloads = 0;
  const transcoder = createTranscoder({
    db,
    dir,
    enabledDefault: true,
    inline: true,
    backlogDelayMs: 0,
    backlogGapMs: 0,
    retryDelayMs: extra.retryDelayMs ?? 60_000,
    maxAttempts: extra.maxAttempts ?? 3,
    backlogGapMs: extra.backlogGapMs ?? 0,
    probe: async () => extra.probe || probe,
    downloadOriginal: async () => {
      downloads += 1;
      return { path: source, temporary: false };
    },
    runFfmpeg: extra.run,
    log: () => {},
    getSetting: () => undefined,
  });
  return { db, dir, transcoder, source, downloads: () => downloads };
}

function insertVideo(db, md5 = 'md5-1', width = 1280, height = 720) {
  const result = db.prepare(
    `INSERT INTO media (drive_file_id, filename, type, mime, size, md5, width, height, orientation, created_at)
     VALUES (?, 'clip.mp4', 'video', 'video/mp4', 15, ?, ?, ?, 'landscape', ?)`
  ).run(`drive-${md5}`, md5, width, height, Date.now());
  return db.prepare(`SELECT * FROM media WHERE id = ?`).get(result.lastInsertRowid);
}

test('a second sync does not download the original again while a copy is encoding', async (t) => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const { db, dir, transcoder, downloads } = setup(t, {
    run: (args, signal) => new Promise((resolve, reject) => {
      release();
      const stop = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }),
  });
  const media = insertVideo(db);
  const first = transcoder.schedule(media);
  transcoder.schedule(media);
  await started;
  assert.equal(downloads(), 1);
  transcoder.forget(media.id);
  await first;
  assert.equal(downloads(), 1);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('deleting a video while ffmpeg is running does not leave a file or throw', async (t) => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const { db, dir, transcoder } = setup(t, {
    run: (args, signal) => new Promise((resolve, reject) => {
      fs.writeFileSync(args[args.length - 1], 'partial');
      release();
      const stop = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }),
  });
  const media = insertVideo(db);
  const job = transcoder.schedule(media);
  await started;
  transcoder.forget(media.id);
  db.prepare(`DELETE FROM media WHERE id = ?`).run(media.id);
  await job;
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(transcoder.list(media.id).length, 0);
});

test('a failed copy is tried again without waiting for a restart', async (t) => {
  let failures = 0;
  const { db, transcoder } = setup(t, {
    retryDelayMs: 20,
    run: async (args) => {
      if (failures === 0) {
        failures += 1;
        throw new Error('ffmpeg exploded');
      }
      fs.writeFileSync(args[args.length - 1], 'copy');
    },
  });
  const media = insertVideo(db);
  await transcoder.schedule(media);
  assert.equal(transcoder.get(media.id, 'h264_1080').status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(transcoder.get(media.id, 'h264_1080').status, 'ready');
  assert.equal(failures, 1);
});

test('a timed-out encode stays failed and the next sync does not start it again', async (t) => {
  const fourK = {
    video: { codec: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160, pixFmt: 'yuv420p10le', fps: 60, variableFrameRate: false },
    audio: { codec: 'ac3', channels: 6, profile: null },
  };
  const { db, transcoder, downloads } = setup(t, {
    maxAttempts: 1,
    probe: fourK,
    run: async () => {
      throw Object.assign(new Error('cancelled'), { cancelled: true });
    },
  });
  const media = insertVideo(db, 'big', 3840, 2160);
  await transcoder.schedule(media);
  assert.equal(downloads(), 1);
  assert.equal(transcoder.get(media.id, 'h264_1080').status, 'failed');
  assert.equal(transcoder.get(media.id, 'h264_1080').error, 'encode timed out');
  assert.equal(transcoder.get(media.id, 'h264_720').status, 'failed');
  await transcoder.schedule(media);
  assert.equal(downloads(), 1);
});

test('backlog videos wait the same gap instead of a longer one each time', async (t) => {
  const starts = [];
  const { db, transcoder } = setup(t, {
    backlogGapMs: 50,
    run: async (args) => {
      starts.push(Date.now());
      fs.writeFileSync(args[args.length - 1], 'x');
    },
  });
  insertVideo(db, 'a');
  insertVideo(db, 'b');
  insertVideo(db, 'c');
  transcoder.resume();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(starts.length, 3);
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(spread < 100, `starts spread by ${spread}ms`);
});

test('turning copies off aborts the encode that is running', async (t) => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let aborted = false;
  const { db, transcoder } = setup(t, {
    run: (args, signal) => new Promise((resolve, reject) => {
      release();
      const stop = () => {
        aborted = true;
        reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }),
  });
  const media = insertVideo(db);
  const job = transcoder.schedule(media);
  await started;
  transcoder.shutdown();
  await job;
  assert.equal(aborted, true);
});

test('playback copies stay off unless the setting is explicitly on', () => {
  assert.equal(transcodeOptIn(undefined), false);
  assert.equal(transcodeOptIn(false), false);
  assert.equal(transcodeOptIn('off'), false);
  assert.equal(transcodeOptIn(true), true);
  assert.equal(transcodeOptIn('on'), true);
});

test('startup removes rendition files whose video is gone', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-tq-'));
  const dir = path.join(dataDir, 'renditions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '99-h264_1080.mp4'), 'orphan');
  fs.writeFileSync(path.join(dir, '.part-98-h264_720.mp4'), 'partial');
  const db = openDatabase(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const media = insertVideo(db);
  fs.writeFileSync(path.join(dir, `${media.id}-h264_1080.mp4`), 'keep');
  createTranscoder({
    db,
    dir,
    downloadOriginal: async () => { throw new Error('unused'); },
    getSetting: () => undefined,
    log: () => {},
  });
  const names = fs.readdirSync(dir);
  assert.deepEqual(names, [`${media.id}-h264_1080.mp4`]);
});
