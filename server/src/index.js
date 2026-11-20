// Starts the server. Settings come from environment variables, or, when it
// runs as a Home Assistant add-on, from the add-on's Configuration tab
// (Home Assistant saves those in /data/options.json).
//
//   PORT                         port to listen on (default 3000)
//   DATA_DIR                     where the database lives (default ./data)
//   ADMIN_USERNAME               outside Home Assistant only: the first person who can sign in,
//   ADMIN_PASSWORD                 made a superadmin at start-up (at least 8 characters). In Home
//                                  Assistant, make users on the sidebar page's Users tab instead.
//   GOOGLE_SERVICE_ACCOUNT_FILE  path to the service account's JSON key
//   DRIVE_FOLDER_ID              the Drive folder holding the signage content
//   MEDIA_CACHE                  "on" to keep a local copy of each file for the TVs
//   TRANSCODE                    "on" to make playback copies. Off unless set, so an
//                                upgraded install does not start encoding by itself.
//   TRANSCODE_4K_HEVC            "on" to also make an optional 4K HEVC copy
//   INGRESS_PORT                 optional: port for Home Assistant's sidebar page
//   SITE_NAME                    optional: this site's name, e.g. "Head office"
//   MODE                         "main" (default) or "relay", for a Home Assistant at
//   MAIN_SERVER_URL                another site: its TVs then reach the main server
//                                  at MAIN_SERVER_URL through this one (see relay.js)
//   PAIRING_CODE                 relay only: the code made for this relay on the main server
//   PUBLIC_DASHBOARD             "on" for the public web dashboard (Google sign-in) through the
//   TAILSCALE_AUTH_KEY             server's own Tailscale Funnel (see public-access.js), as
//   PUBLIC_HOSTNAME                that Tailscale machine's name (default "kiosk")

const fs = require('node:fs');
const path = require('node:path');
const { createWindowsApp } = require('./windows-app');
const { createApp, createIngressServer, createPublicServer } = require('./app');
const { createPublicAccess } = require('./public-access');
const { transcodeOptIn } = require('./transcode');
const { createGoogle, parseServiceAccountKey } = require('./google');
const { createRelay, normalizeMainUrl } = require('./relay');
const { createHomeAssistant } = require('./notify');

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
      firstAdmin: null, // users are made on the sidebar page, which Home Assistant's own login protects
      folderId: o.drive_folder_id,
      serviceAccountFile: o.service_account_file ? path.resolve(configDir, o.service_account_file) : '',
      cache: o.cache_media !== false,
      transcodeVideos: transcodeOptIn(o.transcode_videos),
      transcode4kHevc: Boolean(o.transcode_4k_hevc),
      transcodeThreads: Math.min(4, Math.max(1, Number(o.transcode_threads) || 1)),
      ingressPort: Number(env.INGRESS_PORT) || 8099,
      mode: o.mode === 'relay' ? 'relay' : 'main',
      siteName: (o.site_name || '').trim() || null,
      mainServerUrl: (o.main_server_url || '').trim(),
      pairingCode: (o.pairing_code || '').trim(),
      publicDashboard: Boolean(o.public_dashboard),
      tailscaleAuthKey: (o.tailscale_auth_key || '').trim(),
      publicHostname: (o.public_hostname || '').trim() || 'kiosk',
    };
  }
  return {
    source: 'environment variables (see the top of src/index.js)',
    port: Number(env.PORT) || 3000,
    dataDir,
    firstAdmin: env.ADMIN_USERNAME && env.ADMIN_PASSWORD ? { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD } : null,
    folderId: env.DRIVE_FOLDER_ID,
    serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE,
    cache: env.MEDIA_CACHE === 'on',
    transcodeVideos: transcodeOptIn(env.TRANSCODE),
    transcode4kHevc: env.TRANSCODE_4K_HEVC === 'on',
    transcodeThreads: Math.min(4, Math.max(1, Number(env.TRANSCODE_THREADS) || 1)),
    ingressPort: Number(env.INGRESS_PORT) || null,
    mode: env.MODE === 'relay' ? 'relay' : 'main',
    siteName: (env.SITE_NAME || '').trim() || null,
    mainServerUrl: (env.MAIN_SERVER_URL || '').trim(),
    pairingCode: (env.PAIRING_CODE || '').trim(),
    publicDashboard: env.PUBLIC_DASHBOARD === 'on',
    tailscaleAuthKey: (env.TAILSCALE_AUTH_KEY || '').trim(),
    publicHostname: (env.PUBLIC_HOSTNAME || '').trim() || 'kiosk',
  };
}

const settings = loadSettings();

// Home Assistant's sidebar page talks to the server on its own private port.
function startIngress(app) {
  if (!settings.ingressPort) return;
  createIngressServer(app).listen(settings.ingressPort, '0.0.0.0', () => {
    console.log(`Home Assistant sidebar page on port ${settings.ingressPort}`);
  });
}

if (settings.mode === 'relay') {
  // A relay only needs its site name and where the main server is.
  const missingRelay = [
    ['site name', settings.siteName],
    ['main server address', settings.mainServerUrl],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missingRelay.length) {
    console.error(`Relay mode needs: ${missingRelay.join(', ')}. Fill them in using ${settings.source}.`);
    process.exit(1);
  }
  const mainUrl = normalizeMainUrl(settings.mainServerUrl);
  const relay = createRelay({ mainUrl, siteName: settings.siteName, dataDir: settings.dataDir, pairingCode: settings.pairingCode });
  if (!settings.pairingCode) console.log('No pairing code yet. Make one on the main server (Settings → Home Assistant Relays) and put it in this add-on\'s Configuration tab.');
  relay.listen(settings.port, '0.0.0.0', () => {
    console.log(`Kiosk relay for site "${settings.siteName}" running on port ${settings.port}, main server ${mainUrl}`);
  });
  startIngress(relay);
  return;
}

const missing = [
  ['Drive folder ID', settings.folderId],
].filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing settings: ${missing.join(', ')}. Fill them in using ${settings.source}.`);
  process.exit(1);
}
fs.mkdirSync(settings.dataDir, { recursive: true });

// The Google key. One added on the web Settings page (upload or paste) is kept
// in the data folder and wins; otherwise the key file from the settings is
// used. With neither, the server still starts so the key can be added on the page.
const googleKeyFile = path.join(settings.dataDir, 'google-key.json');
function loadGoogleKey() {
  const candidates = [googleKeyFile, settings.serviceAccountFile].filter((file) => file && fs.existsSync(file));
  for (const file of candidates) {
    try {
      return parseServiceAccountKey(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Can't use the key file at ${file}: ${err.message}`);
    }
  }
  return null;
}
const serviceAccountKey = loadGoogleKey();
if (!serviceAccountKey) {
  console.log('No Google key yet. Open Kiosk Signage → Settings → Google key and upload or paste it.');
}

// The public web dashboard (off unless switched on in the add-on's options). Its door listens
// only inside the add-on; the add-on's own Tailscale Funnel is the only way in from outside.
const PUBLIC_DOOR_PORT = 3001;
const publicAccess = createPublicAccess({
  enabled: settings.publicDashboard,
  dataDir: settings.dataDir,
  authKey: settings.tailscaleAuthKey,
  hostname: settings.publicHostname,
  doorPort: PUBLIC_DOOR_PORT,
  log: console.log,
});

const app = createApp({
  publicAccess,
  dataDir: settings.dataDir,
  firstAdmin: settings.firstAdmin,
  mediaCacheDir: path.join(settings.dataDir, 'media-cache'),
  cacheMedia: settings.cache,
  siteName: settings.siteName,
  googleKeyFile,
  // As a Home Assistant add-on, Home Assistant hands us a token for its API (used for notifications).
  homeAssistant: process.env.SUPERVISOR_TOKEN
    ? createHomeAssistant({
        baseUrl: 'http://supervisor/core/api',
        supervisorUrl: 'http://supervisor',
        token: process.env.SUPERVISOR_TOKEN,
      })
    : null,
  // The TV app that came with the add-on (player/), for updating screens from the dashboard.
  playerAppDir: process.env.KIOSK_PLAYER_APP_DIR || path.join(__dirname, '..', 'player'),
  // The Windows Kiosk Browser installer of this version, fetched once from its GitHub release (0.13.0).
  windowsApp: createWindowsApp({ dir: path.join(settings.dataDir, 'windows-app'), version: require('../package.json').version, log: console.log }),
  transcode: {
    enabled: settings.transcodeVideos,
    hevc4k: settings.transcode4kHevc,
    dir: path.join(settings.dataDir, 'renditions'),
    threads: settings.transcodeThreads,
  },
  google: createGoogle({
    serviceAccountKey,
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
  publicAccess.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

startIngress(app);

if (settings.publicDashboard) {
  createPublicServer(app).listen(PUBLIC_DOOR_PORT, '127.0.0.1', () => {
    console.log('Public dashboard door ready (reached only through this add-on\'s Tailscale Funnel)');
    publicAccess.start();
  });
}
