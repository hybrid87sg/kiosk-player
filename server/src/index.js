// Starts the server. Settings come from environment variables, or, when it
// runs as a Home Assistant add-on, from the add-on's Configuration tab
// (Home Assistant saves those in /data/options.json).
//
//   PORT                         port to listen on (default 3000)
//   DATA_DIR                     where the database lives (default ./data)
//   SUPERADMIN_EMAIL             your Google account; always a superadmin
//   GOOGLE_WEB_CLIENT_ID         "Web" OAuth client ID from Google Cloud Console
//   GOOGLE_SERVICE_ACCOUNT_FILE  path to the service account's JSON key
//   DRIVE_FOLDER_ID              the Drive folder holding the signage content
//   MEDIA_CACHE                  "on" to keep a local copy of each file for the TVs
//   TRANSCODE                    "on" to make playback copies. Off unless set, so an
//                                upgraded install does not start encoding by itself.
//   TRANSCODE_4K_HEVC            "on" to also make an optional 4K HEVC copy
//   GOOGLE_DEVICE_CLIENT_ID      optional: "TVs and Limited Input devices" client, for
//   GOOGLE_DEVICE_CLIENT_SECRET    signing in to the web page with a google.com/device code
//   INGRESS_PORT                 optional: port for Home Assistant's sidebar page

const fs = require('node:fs');
const path = require('node:path');
const { createApp, createIngressServer } = require('./app');
const { transcodeOptIn } = require('./transcode');
const { createGoogle } = require('./google');

function loadSettings() {
  const env = process.env;
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const optionsFile = env.HA_OPTIONS_FILE || '/data/options.json';

  if (fs.existsSync(optionsFile)) {
    // Home Assistant add-on: the key file is uploaded to the add-on's config folder.
    const o = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
    const configDir = env.HA_CONFIG_DIR || '/config';
    return {
      source: 'the add-on Configuration tab',
      port: 3000,
      dataDir,
      superadminEmail: o.superadmin_email,
      webClientId: o.google_web_client_id,
      folderId: o.drive_folder_id,
      serviceAccountFile: o.service_account_file ? path.resolve(configDir, o.service_account_file) : '',
      cache: o.cache_media !== false,
      transcodeVideos: transcodeOptIn(o.transcode_videos),
      transcode4kHevc: Boolean(o.transcode_4k_hevc),
      transcodeThreads: Math.min(4, Math.max(1, Number(o.transcode_threads) || 1)),
      deviceClientId: o.google_device_client_id || '',
      deviceClientSecret: o.google_device_client_secret || '',
      ingressPort: Number(env.INGRESS_PORT) || 8099,
    };
  }
  return {
    source: 'environment variables (see the top of src/index.js)',
    port: Number(env.PORT) || 3000,
    dataDir,
    superadminEmail: env.SUPERADMIN_EMAIL,
    webClientId: env.GOOGLE_WEB_CLIENT_ID,
    folderId: env.DRIVE_FOLDER_ID,
    serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE,
    cache: env.MEDIA_CACHE === 'on',
    transcodeVideos: transcodeOptIn(env.TRANSCODE),
    transcode4kHevc: env.TRANSCODE_4K_HEVC === 'on',
    transcodeThreads: Math.min(4, Math.max(1, Number(env.TRANSCODE_THREADS) || 1)),
    deviceClientId: env.GOOGLE_DEVICE_CLIENT_ID || '',
    deviceClientSecret: env.GOOGLE_DEVICE_CLIENT_SECRET || '',
    ingressPort: Number(env.INGRESS_PORT) || null,
  };
}

const settings = loadSettings();
const missing = [
  ['superadmin email', settings.superadminEmail],
  ['Google web client ID', settings.webClientId],
  ['Drive folder ID', settings.folderId],
  ['service account key file', settings.serviceAccountFile],
].filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing settings: ${missing.join(', ')}. Fill them in using ${settings.source}.`);
  process.exit(1);
}
if (!fs.existsSync(settings.serviceAccountFile)) {
  console.error(`Can't find the service account key file at ${settings.serviceAccountFile}.`);
  process.exit(1);
}

fs.mkdirSync(settings.dataDir, { recursive: true });

const app = createApp({
  dataDir: settings.dataDir,
  superadminEmail: settings.superadminEmail,
  googleWebClientId: settings.webClientId,
  mediaCacheDir: path.join(settings.dataDir, 'media-cache'),
  cacheMedia: settings.cache,
  transcode: {
    enabled: settings.transcodeVideos,
    hevc4k: settings.transcode4kHevc,
    dir: path.join(settings.dataDir, 'renditions'),
    threads: settings.transcodeThreads,
  },
  google: createGoogle({
    webClientId: settings.webClientId,
    deviceClientId: settings.deviceClientId,
    deviceClientSecret: settings.deviceClientSecret,
    serviceAccountFile: settings.serviceAccountFile,
    folderId: settings.folderId,
  }),
});

// "0.0.0.0" means: accept connections from other devices too, not just this computer.
const server = app.listen(settings.port, '0.0.0.0', () => {
  const copies = settings.transcodeVideos
    ? `on${settings.transcode4kHevc ? ', with 4K HEVC' : ''}`
    : 'off';
  console.log(`Kiosk server running on port ${settings.port} (data in ${settings.dataDir}, media cache ${settings.cache ? 'on' : 'off'}, playback copies ${copies}, ${settings.transcodeThreads} encode thread${settings.transcodeThreads === 1 ? '' : 's'})`);
});

// Home Assistant stops the add-on with SIGTERM. Kill ffmpeg so it cannot keep the CPU.
function stop() {
  if (app.locals.transcoder) app.locals.transcoder.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Home Assistant's sidebar page talks to the server on its own private port.
if (settings.ingressPort) {
  createIngressServer(app).listen(settings.ingressPort, '0.0.0.0', () => {
    console.log(`Home Assistant sidebar page on port ${settings.ingressPort}`);
  });
}
