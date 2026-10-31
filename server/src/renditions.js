// Playback copies for TV boxes whose decoder tops out around 1080p H.264.
//
// The original file in Google Drive is never changed. After it arrives we
// make smaller copies (renditions) and the player downloads the one that
// fits the box. Planning the ffmpeg command and choosing a copy are pure
// functions so they can be tested without ffmpeg.

const PROFILES = {
  // Safe baseline: 1080p H.264 High profile level 4.1, constant frame rate,
  // 8-bit 4:2:0. Level 4.1 only allows 1080p30, so the frame rate is capped.
  h264_1080: {
    id: 'h264_1080', codec: 'h264', maxLong: 1920, maxShort: 1080,
    level: '4.1', levelNum: 41, maxFps: 30, crf: '20', maxrate: '8M', bufsize: '16M',
  },
  // Smaller fallback for boxes that cannot decode 1080p.
  h264_720: {
    id: 'h264_720', codec: 'h264', maxLong: 1280, maxShort: 720,
    level: '3.1', levelNum: 31, maxFps: 30, crf: '21', maxrate: '3M', bufsize: '6M',
  },
  // Optional, for a box that can decode HEVC and a 4K screen. 8-bit Main,
  // never Main 10: many cheap boxes decode 8-bit and refuse 10-bit.
  hevc_2160: {
    id: 'hevc_2160', codec: 'hevc', maxLong: 3840, maxShort: 2160,
    level: null, levelNum: null, maxFps: 60, crf: '24', maxrate: '18M', bufsize: '36M',
  },
};

const PROFILE_IDS = Object.keys(PROFILES);

function boxOf(width, height) {
  return { long: Math.max(width, height), short: Math.min(width, height) };
}

// True when width x height fits inside maxLong x maxShort, in either orientation.
// slop covers the 16-pixel alignment some decoders report (1088 instead of 1080).
function fitsBox(maxLong, maxShort, width, height, slop = 16) {
  if (!width || !height || !maxLong || !maxShort) return false;
  const box = boxOf(width, height);
  return box.long <= maxLong + slop && box.short <= maxShort + slop;
}

function largerThan(width, height, profile) {
  const box = boxOf(width, height);
  return box.long > profile.maxLong || box.short > profile.maxShort;
}

function parseRate(rate) {
  if (typeof rate === 'number') return rate > 0 && Number.isFinite(rate) ? rate : null;
  if (!rate || rate === '0/0') return null;
  const [n, d] = String(rate).split('/').map(Number);
  if (!n || !d) return null;
  const value = n / d;
  return value > 0 && Number.isFinite(value) ? value : null;
}

// Turns ffprobe's JSON into the small shape the planner understands.
function summarizeProbe(json) {
  const streams = (json && json.streams) || [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  if (!video) return { video: null, audio: audioSummary(audio) };
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  const nominal = parseRate(video.r_frame_rate);
  return {
    video: {
      codec: video.codec_name || null,
      profile: video.profile || null,
      level: Number.isFinite(Number(video.level)) ? Number(video.level) : null,
      width: video.width || 0,
      height: video.height || 0,
      pixFmt: video.pix_fmt || null,
      fps,
      variableFrameRate: Boolean(nominal && fps && Math.abs(nominal - fps) > 1),
    },
    audio: audioSummary(audio),
  };
}

function audioSummary(audio) {
  if (!audio) return null;
  return {
    codec: audio.codec_name || null,
    channels: audio.channels || null,
    profile: audio.profile || null,
  };
}

// Snap to a common rate at or under the cap, so 23.976 becomes 24 and 60 becomes 30.
function targetFps(fps, maxFps) {
  const raw = !fps || fps <= 0 ? maxFps : Math.min(fps, maxFps);
  // Keep film and NTSC rates exact. Snapping 23.976 to 24 makes the picture judder.
  for (const ntsc of [23.976, 29.97, 59.94]) {
    if (Math.abs(raw - ntsc) < 0.02 && ntsc <= maxFps + 0.01) return ntsc;
  }
  for (const common of [24, 25, 30, 50, 60]) {
    if (Math.abs(raw - common) < 0.05) return common;
  }
  return Math.round(raw * 1000) / 1000;
}

// ffmpeg's fps filter wants a fraction for the repeating NTSC rates.
function fpsFilterValue(fps) {
  if (Math.abs(fps - 23.976) < 0.02) return '24000/1001';
  if (Math.abs(fps - 29.97) < 0.02) return '30000/1001';
  if (Math.abs(fps - 59.94) < 0.02) return '60000/1001';
  return String(fps);
}

// Output size for a profile. Never upscales, and both sides stay even (required by yuv420p).
function plannedSize(video, profileId) {
  const profile = PROFILES[profileId];
  const landscape = video.width >= video.height;
  const maxW = landscape ? profile.maxLong : profile.maxShort;
  const maxH = landscape ? profile.maxShort : profile.maxLong;
  const scale = Math.min(1, maxW / video.width, maxH / video.height);
  const even = (n) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(video.width), height: even(video.height) };
}

function videoCopyable(video, profile) {
  if (!video || !video.width || !video.height) return false;
  if (largerThan(video.width, video.height, profile)) return false;
  if (!video.fps || video.variableFrameRate) return false;
  if (video.fps > profile.maxFps + 0.05) return false;
  if (video.pixFmt !== 'yuv420p') return false;
  if (profile.codec === 'h264') {
    if (video.codec !== 'h264') return false;
    if (!video.level || video.level > profile.levelNum) return false;
    return true;
  }
  if (video.codec !== 'hevc' && video.codec !== 'h265') return false;
  if (video.profile && /10|12/i.test(video.profile)) return false;
  return true;
}

function audioCopyable(audio) {
  if (!audio) return true;
  if (audio.codec !== 'aac') return false;
  if (audio.channels && audio.channels > 2) return false;
  if (audio.profile && !/lc|aac_low/i.test(String(audio.profile))) return false;
  return true;
}

function planOne(profileId, probe) {
  const profile = PROFILES[profileId];
  const size = plannedSize(probe.video, profileId);
  const copyVideo = videoCopyable(probe.video, profile);
  return {
    profile: profileId,
    width: size.width,
    height: size.height,
    fps: copyVideo ? (Math.round(probe.video.fps * 1000) / 1000) : targetFps(probe.video.fps, profile.maxFps),
    video: { copy: copyVideo },
    audio: probe.audio ? { copy: audioCopyable(probe.audio) } : { none: true },
  };
}

// Which copies to make. 720p is skipped when the picture is already that small
// (the 1080p copy is not upscaled, so it is the same size). 4K HEVC is optional.
function planRenditions(probe, { hevc4k = false } = {}) {
  if (!probe || !probe.video || !probe.video.width || !probe.video.height) return [];
  const jobs = [planOne('h264_1080', probe)];
  if (largerThan(probe.video.width, probe.video.height, PROFILES.h264_720)) {
    jobs.push(planOne('h264_720', probe));
  }
  if (hevc4k && largerThan(probe.video.width, probe.video.height, PROFILES.h264_1080)) {
    jobs.push(planOne('hevc_2160', probe));
  }
  return jobs;
}

// Caps each side, swaps the cap for portrait, and refuses to enlarge.
function scaleFilter(profileId) {
  const p = PROFILES[profileId];
  const w = `min(iw\\,if(gte(iw\\,ih)\\,${p.maxLong}\\,${p.maxShort}))`;
  const h = `min(ih\\,if(gte(iw\\,ih)\\,${p.maxShort}\\,${p.maxLong}))`;
  return `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

function ffmpegArgs(job, input, output, options = {}) {
  const threads = Math.max(1, Number(options.threads) || 1);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  const audioNone = Boolean(job.audio && job.audio.none);
  const audioCopy = Boolean(job.audio && job.audio.copy);
  if (job.video.copy && (audioCopy || audioNone)) {
    args.push('-c:v', 'copy');
    if (audioNone) args.push('-an');
    else args.push('-c:a', 'copy');
    args.push('-movflags', '+faststart', output);
    return args;
  }
  if (job.video.copy) {
    args.push('-c:v', 'copy');
  } else {
    const profile = PROFILES[job.profile];
    args.push('-vf', `${scaleFilter(job.profile)},fps=${fpsFilterValue(job.fps)}`, '-fps_mode', 'cfr', '-threads', String(threads));
    if (profile.codec === 'h264') {
      args.push(
        '-c:v', 'libx264', '-profile:v', 'high', '-level:v', profile.level, '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast', '-crf', profile.crf, '-maxrate', profile.maxrate, '-bufsize', profile.bufsize,
      );
    } else {
      args.push(
        '-c:v', 'libx265', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
        '-preset', 'veryfast', '-crf', profile.crf, '-maxrate', profile.maxrate, '-bufsize', profile.bufsize,
      );
    }
  }
  if (audioNone) args.push('-an');
  else if (audioCopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-b:a', '128k', '-ar', '48000');
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

function pixels(rendition) {
  return (rendition.width || 0) * (rendition.height || 0);
}

// A ready copy of this file. A copy made from an older Drive upload (different md5) is not usable.
function usableRendition(rendition, sourceMd5) {
  if (!rendition || rendition.status !== 'ready' || !rendition.md5 || !rendition.size) return false;
  if (sourceMd5 && rendition.source_md5 !== sourceMd5) return false;
  return true;
}

function h264CanPlay(caps, rendition) {
  const long = Math.max(rendition.width || 0, rendition.height || 0);
  const short = Math.min(rendition.width || 0, rendition.height || 0);
  const needLevel = long > 1280 || short > 720 ? 41 : 31;
  if (caps.h264_max_long) {
    const maxShort = caps.h264_max_short || caps.h264_max_long;
    if (!fitsBox(caps.h264_max_long, maxShort, rendition.width, rendition.height)) return false;
  }
  if (caps.h264_level && caps.h264_level < needLevel) return false;
  return true;
}

function hevcCanPlay(caps, rendition) {
  if (!caps.hevc) return false;
  if (!caps.hevc_max_long) return true;
  const maxShort = caps.hevc_max_short || caps.hevc_max_long;
  return fitsBox(caps.hevc_max_long, maxShort, rendition.width, rendition.height);
}

// The copy a player should download.
// [sourceMd5] is the file's current fingerprint. Copies of an older upload are ignored.
// No capability report (an older app): the 1080p copy, or null to mean "send the original".
// A newer app: the largest copy that fits the screen and the decoder.
// 4K HEVC is only chosen for a 4K screen that can decode it.
// If nothing fits (a 720p box, and only the 1080p copy exists), the smallest copy is
// still sent. That is safer than the original 4K file.
function chooseRendition(renditions, caps, sourceMd5) {
  const ready = new Map(
    (renditions || [])
      .filter((r) => usableRendition(r, sourceMd5))
      .map((r) => [r.profile, r]),
  );
  const byPixels = (list, direction) => [...list].sort((a, b) => direction * (pixels(a) - pixels(b)))[0];
  if (!caps) return ready.get('h264_1080') || null;

  const candidates = [];
  const displayLong = Math.max(caps.display_width || 0, caps.display_height || 0);
  const displayShort = Math.min(caps.display_width || 0, caps.display_height || 0);
  const hevc = ready.get('hevc_2160');
  if (hevc && hevcCanPlay(caps, hevc) && (displayLong === 0 || displayLong >= 3000)) candidates.push(hevc);
  for (const id of ['h264_1080', 'h264_720']) {
    const row = ready.get(id);
    if (row && h264CanPlay(caps, row)) candidates.push(row);
  }
  if (!candidates.length) {
    const any = [...ready.values()];
    return any.length ? byPixels(any, 1) : null;
  }
  if (displayLong > 0 && displayShort > 0) {
    const fitting = candidates.filter((r) => fitsBox(displayLong, displayShort, r.width, r.height));
    if (fitting.length) return byPixels(fitting, -1);
    return byPixels(candidates, 1);
  }
  return byPixels(candidates, -1);
}

function safeSource(media) {
  if (media.source_vfr) return false;
  if (!media.source_codec) return true;
  if (media.source_codec !== 'h264') return false;
  if (media.source_pix_fmt && media.source_pix_fmt !== 'yuv420p') return false;
  if (media.source_level && media.source_level > 41) return false;
  if (media.source_fps && media.source_fps > 30.05) return false;
  return true;
}

// Shown in Kiosk Admin and the web library for a file some boxes may not play.
function playbackWarning(media, renditions, { transcodeEnabled = false, ffmpegAvailable = true } = {}) {
  if (!media || media.type !== 'video') return null;
  const oversize = Boolean(media.width && media.height && largerThan(media.width, media.height, PROFILES.h264_1080));
  if (!oversize && safeSource(media)) return null;
  const baseline = (renditions || []).find((r) => r.profile === 'h264_1080' && (!media.md5 || r.source_md5 === media.md5));
  if (baseline && baseline.status === 'ready' && baseline.md5 && baseline.size) return null;
  const dims = media.width && media.height ? `${media.width}×${media.height}` : 'this file';
  if (!transcodeEnabled) {
    return `This video is ${dims}. Playback copies are turned off, so some TV boxes may not play it smoothly.`;
  }
  if (!ffmpegAvailable) {
    return `This video is ${dims}. ffmpeg is not installed, so some TV boxes may not play it smoothly.`;
  }
  if (baseline && baseline.status === 'failed') {
    const why = baseline.error ? ` (${String(baseline.error).slice(0, 160)})` : '';
    return `A 1080p copy of this video could not be made${why}. Some TV boxes may not play it.`;
  }
  return `This video is ${dims}. A 1080p copy is being prepared; until it is ready, some TV boxes may not play it smoothly.`;
}

// The player's heartbeat sends this. Drop anything that isn't a sensible number.
function normalizeDecoderCaps(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const num = (v) => (Number.isInteger(v) && v > 0 && v < 100000 ? v : null);
  return {
    display_width: num(input.display_width) || 0,
    display_height: num(input.display_height) || 0,
    h264_level: num(input.h264_level),
    h264_max_long: num(input.h264_max_long),
    h264_max_short: num(input.h264_max_short),
    hevc: Boolean(input.hevc),
    hevc_max_long: num(input.hevc_max_long),
    hevc_max_short: num(input.hevc_max_short),
  };
}

module.exports = {
  PROFILES,
  PROFILE_IDS,
  summarizeProbe,
  plannedSize,
  planRenditions,
  ffmpegArgs,
  chooseRendition,
  playbackWarning,
  normalizeDecoderCaps,
};
