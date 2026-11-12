// Runs the real ffmpeg command the server would run, on a one-second clip,
// and checks the file that comes out. Skipped only when ffmpeg is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planRenditions, ffmpegArgs, summarizeProbe } = require('../src/renditions');

function has(cmd) {
  const result = spawnSync(cmd, ['-hide_banner', '-version'], { stdio: 'ignore' });
  return result.status === 0;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('ffmpeg writes a faststart 1080p H.264 High@4.1 copy and a 720p fallback', { skip: !has('ffmpeg') || !has('ffprobe') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-ffmpeg-'));
  const source = path.join(dir, 'source.mp4');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=60:duration=0.4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '5.1',
    '-c:a', 'aac', '-shortest', source,
  ]);
  const before = fs.readFileSync(source);
  const probed = summarizeProbe(JSON.parse(spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', source,
  ], { encoding: 'utf8' }).stdout));
  const jobs = planRenditions(probed, { hevc4k: false });
  assert.deepEqual(jobs.map((job) => job.profile), ['h264_1080', 'h264_720']);
  assert.equal(jobs[0].video.copy, false);

  for (const job of jobs) {
    const output = path.join(dir, `${job.profile}.mp4`);
    run('ffmpeg', ffmpegArgs(job, source, output));
    const bytes = fs.readFileSync(output);
    assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), `${job.profile} is not faststart`);
    const out = summarizeProbe(JSON.parse(spawnSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', output,
    ], { encoding: 'utf8' }).stdout));
    assert.equal(out.video.codec, 'h264');
    assert.equal(out.video.profile, 'High');
    assert.equal(out.video.pixFmt, 'yuv420p');
    assert.equal(out.video.level, job.profile === 'h264_720' ? 31 : 41);
    assert.ok(Math.abs(out.video.fps - 30) < 0.05);
    if (job.profile === 'h264_1080') assert.deepEqual([out.video.width, out.video.height], [1920, 1080]);
    if (job.profile === 'h264_720') assert.deepEqual([out.video.width, out.video.height], [1280, 720]);
    assert.equal(out.audio.codec, 'aac');
  }
  assert.ok(fs.readFileSync(source).equals(before));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ffmpeg writes an 8-bit HEVC copy when asked', { skip: !has('ffmpeg') || !has('ffprobe') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-ffmpeg-hevc-'));
  const source = path.join(dir, 'source.mp4');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=0.3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '0.3', source,
  ]);
  const job = {
    profile: 'hevc_2160', width: 320, height: 180, fps: 30,
    video: { copy: false }, audio: { none: true },
  };
  const output = path.join(dir, 'hevc.mp4');
  run('ffmpeg', ffmpegArgs(job, source, output));
  const out = summarizeProbe(JSON.parse(spawnSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', output,
  ], { encoding: 'utf8' }).stdout));
  assert.equal(out.video.codec, 'hevc');
  assert.equal(out.video.pixFmt, 'yuv420p');
  assert.match(out.video.profile, /Main/);
  assert.ok(!/10|12/.test(out.video.profile));
  const bytes = fs.readFileSync(output);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')));
  fs.rmSync(dir, { recursive: true, force: true });
});
