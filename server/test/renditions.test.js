const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeProbe, plannedSize, planRenditions, ffmpegArgs, chooseRendition, playbackWarning, normalizeDecoderCaps,
} = require('../src/renditions');

const fourK = {
  video: {
    codec: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160,
    pixFmt: 'yuv420p10le', fps: 60, variableFrameRate: false,
  },
  audio: { codec: 'ac3', channels: 6, profile: null },
};

const alreadyFine = {
  video: {
    codec: 'h264', profile: 'High', level: 40, width: 1920, height: 1080,
    pixFmt: 'yuv420p', fps: 30, variableFrameRate: false,
  },
  audio: { codec: 'aac', channels: 2, profile: 'LC' },
};

function ready(profile, width, height, extra = {}) {
  return { profile, status: 'ready', width, height, size: 1000, md5: `${profile}-md5`, ...extra };
}

test('probe JSON becomes a small description of the video', () => {
  const probe = summarizeProbe({
    streams: [
      { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160, pix_fmt: 'yuv420p10le', avg_frame_rate: '60000/1001', r_frame_rate: '60/1' },
      { codec_type: 'audio', codec_name: 'ac3', channels: 6 },
    ],
  });
  assert.equal(probe.video.codec, 'hevc');
  assert.equal(probe.video.pixFmt, 'yuv420p10le');
  assert.ok(Math.abs(probe.video.fps - 59.94) < 0.02);
  assert.equal(probe.audio.codec, 'ac3');
});

test('a 4K 10-bit 60fps video is re-encoded, not copied, and 4K HEVC is optional', () => {
  const without = planRenditions(fourK, { hevc4k: false }).map((job) => job.profile);
  assert.deepEqual(without, ['h264_1080', 'h264_720']);
  const withHevc = planRenditions(fourK, { hevc4k: true });
  assert.deepEqual(withHevc.map((job) => job.profile), ['h264_1080', 'h264_720', 'hevc_2160']);
  for (const job of withHevc) assert.equal(job.video.copy, false);

  const baseline = ffmpegArgs(withHevc[0], 'in.mp4', 'out.mp4');
  assert.ok(baseline.includes('libx264'));
  assert.ok(baseline.includes('high'));
  assert.ok(baseline.includes('4.1'));
  assert.ok(baseline.includes('yuv420p'));
  assert.ok(baseline.includes('+faststart'));
  assert.ok(baseline.includes('cfr'));
  assert.ok(baseline.some((arg) => arg.includes('fps=30')));
  assert.ok(!baseline.some((arg) => String(arg).includes('10le') || String(arg).includes('main10')));

  const small = ffmpegArgs(withHevc[1], 'in.mp4', 'out720.mp4');
  assert.ok(small.includes('3.1'));
  assert.ok(small.some((arg) => arg.includes('1280') && arg.includes('720')));

  const hevc = ffmpegArgs(withHevc[2], 'in.mp4', 'out4k.mp4');
  assert.ok(hevc.includes('libx265'));
  assert.ok(hevc.includes('hvc1'));
  assert.ok(hevc.includes('main'));
  assert.ok(hevc.includes('yuv420p'));
  assert.ok(!hevc.some((arg) => String(arg).includes('10le') || String(arg).includes('main10')));
  assert.equal(hevc.at(-1), 'out4k.mp4');
});

test('a file that is already 1080p H.264 is remuxed, and a small file is not upscaled', () => {
  const jobs = planRenditions(alreadyFine, { hevc4k: true });
  assert.deepEqual(jobs.map((job) => job.profile), ['h264_1080', 'h264_720']);
  assert.equal(jobs[0].video.copy, true);
  assert.equal(jobs[0].audio.copy, true);
  const args = ffmpegArgs(jobs[0], 'in.mp4', 'out.mp4');
  assert.ok(args.includes('copy'));
  assert.ok(args.includes('+faststart'));
  assert.ok(!args.includes('libx264'));

  assert.deepEqual(plannedSize({ width: 640, height: 360 }, 'h264_1080'), { width: 640, height: 360 });
  assert.deepEqual(plannedSize({ width: 3840, height: 2160 }, 'h264_1080'), { width: 1920, height: 1080 });
  assert.deepEqual(plannedSize({ width: 2160, height: 3840 }, 'h264_1080'), { width: 1080, height: 1920 });
  assert.deepEqual(plannedSize({ width: 3840, height: 2160 }, 'h264_720'), { width: 1280, height: 720 });
});

test('frame rates above the cap are halved instead of clamped to 30', () => {
  const over = (fps) => planRenditions({
    video: { codec: 'h264', profile: 'High', level: 51, width: 1920, height: 1080, pixFmt: 'yuv420p', fps, variableFrameRate: false },
    audio: null,
  })[0].fps;
  assert.equal(over(50), 25);
  assert.equal(over(59.94), 29.97);
  assert.equal(over(60), 30);
});

test('a 720p source only needs the baseline copy', () => {
  const probe = {
    video: { codec: 'h264', profile: 'High', level: 31, width: 1280, height: 720, pixFmt: 'yuv420p', fps: 30, variableFrameRate: false },
    audio: { codec: 'aac', channels: 2, profile: 'LC' },
  };
  assert.deepEqual(planRenditions(probe).map((job) => job.profile), ['h264_1080']);
  assert.deepEqual(plannedSize(probe.video, 'h264_1080'), { width: 1280, height: 720 });
});

test('an older player gets the 1080p copy, or the original when none is ready', () => {
  const renditions = [ready('h264_1080', 1920, 1080), ready('h264_720', 1280, 720), ready('hevc_2160', 3840, 2160)];
  assert.equal(chooseRendition(renditions, null).profile, 'h264_1080');
  assert.equal(chooseRendition([ready('h264_720', 1280, 720)], null), null);
  assert.equal(chooseRendition([], null), null);
});

test('the best copy is the largest one the screen and the decoder can both take', () => {
  const renditions = [ready('h264_1080', 1920, 1080), ready('h264_720', 1280, 720), ready('hevc_2160', 3840, 2160)];
  const fourKHevc = {
    display_width: 3840, display_height: 2160, h264_level: 51, h264_max_long: 3840, h264_max_short: 2160,
    hevc: true, hevc_max_long: 3840, hevc_max_short: 2160,
  };
  assert.equal(chooseRendition(renditions, fourKHevc).profile, 'hevc_2160');

  const fourKNoHevc = { ...fourKHevc, hevc: false };
  assert.equal(chooseRendition(renditions, fourKNoHevc).profile, 'h264_1080');

  const fullHd = { display_width: 1920, display_height: 1080, h264_level: 41, h264_max_long: 1920, h264_max_short: 1088, hevc: true, hevc_max_long: 1920, hevc_max_short: 1080 };
  assert.equal(chooseRendition(renditions, fullHd).profile, 'h264_1080');

  const only720 = { display_width: 1280, display_height: 720, h264_level: 31, h264_max_long: 1280, h264_max_short: 720, hevc: false };
  assert.equal(chooseRendition(renditions, only720).profile, 'h264_720');
  // Only the 1080p copy exists. Sending it is safer than sending the 4K original.
  assert.equal(chooseRendition([ready('h264_1080', 1920, 1080)], only720).profile, 'h264_1080');
  assert.equal(chooseRendition([ready('hevc_2160', 3840, 2160)], only720), null);
  const fullHdNoHevc = { display_width: 1920, display_height: 1080, h264_level: 41, h264_max_long: 1920, h264_max_short: 1088, hevc: false };
  assert.equal(chooseRendition([ready('hevc_2160', 3840, 2160)], fullHdNoHevc), null);
  const unknownDisplay = { display_width: 0, display_height: 0, h264_level: 51, hevc: true, hevc_max_long: 3840, hevc_max_short: 2160 };
  assert.equal(chooseRendition([ready('hevc_2160', 3840, 2160), ready('h264_1080', 1920, 1080)], unknownDisplay).profile, 'h264_1080');
  const stale = [ready('h264_1080', 1920, 1080, { source_md5: 'old-file' })];
  assert.equal(chooseRendition(stale, null, 'new-file'), null);
  assert.equal(chooseRendition(stale, fullHd, 'new-file'), null);
  assert.equal(chooseRendition(stale, fullHd, 'old-file').profile, 'h264_1080');
});

test('the library warns only while a heavy video has no 1080p copy', () => {
  const big = { type: 'video', width: 3840, height: 2160 };
  assert.equal(playbackWarning({ type: 'image', width: 8000, height: 4000 }, [], { transcodeEnabled: false }), null);
  assert.equal(playbackWarning({ type: 'video', width: 1920, height: 1080 }, [], { transcodeEnabled: false }), null);
  assert.match(playbackWarning(big, [], { transcodeEnabled: false }), /turned off/);
  assert.match(playbackWarning(big, [{ profile: 'h264_1080', status: 'pending' }], { transcodeEnabled: true }), /being prepared/);
  assert.match(playbackWarning(big, [{ profile: 'h264_1080', status: 'failed', error: 'ffmpeg exploded' }], { transcodeEnabled: true }), /could not be made/);
  assert.equal(playbackWarning(big, [{ profile: 'h264_1080', status: 'ready', md5: 'x', size: 1 }], { transcodeEnabled: true }), null);
  const replaced = { ...big, md5: 'new-file' };
  assert.match(playbackWarning(replaced, [{ profile: 'h264_1080', status: 'ready', source_md5: 'old-file', md5: 'x', size: 1 }], { transcodeEnabled: true }), /being prepared/);
  assert.equal(playbackWarning(replaced, [{ profile: 'h264_1080', status: 'ready', source_md5: 'new-file', md5: 'x', size: 1 }], { transcodeEnabled: true }), null);
  assert.match(playbackWarning({ type: 'video', width: 1920, height: 1080, source_codec: 'hevc' }, [], { transcodeEnabled: true }), /being prepared/);
  assert.match(playbackWarning(big, [], { transcodeEnabled: true, ffmpegAvailable: false }), /ffmpeg is not installed/);
});

test('decoder reports keep only sensible numbers', () => {
  assert.equal(normalizeDecoderCaps(null), null);
  assert.equal(normalizeDecoderCaps({ display_width: 99999999, h264_level: 41, hevc: 1 }).display_width, 0);
  assert.equal(normalizeDecoderCaps({ display_width: 1920, display_height: 1080, h264_level: 41, hevc: 1 }).h264_level, 41);
  assert.equal(normalizeDecoderCaps({ hevc: 1 }).hevc, true);
});
