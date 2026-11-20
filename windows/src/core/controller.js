// The Kiosk Browser's brain, without any window: the same steps as the TV app.
//
//   setup      no server yet: find one on the network, or type its address
//   pairing    shows a code until someone adds this PC on the dashboard
//   preparing  downloading the playlist's files
//   ready      has its playlist (local files) and its web page settings
//
// Every minute it asks for its playlist, downloads what changed, and checks in
// (heartbeat). When the server can't be reached it carries on with what it has.
// The window (main.js) listens to 'state' and shows it.

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createApi, ApiError, normaliseServerUrl } = require('./api');
const { createSync, DownloadError } = require('./sync');
const { isOpenAt } = require('./hours');
const { createRemote } = require('./remote');

const LOOP_MS = 60_000;
const RETRY_MS = 15_000;

function createController({ store, dataDir, appVersion, model = null, fetchImpl = fetch, loopMs = LOOP_MS, retryMs = RETRY_MS, now = () => Date.now(), log = () => {}, startedAt, platform }) {
  const events = new EventEmitter();
  let state = { phase: 'setup' };
  let api = null;
  let sync = null;
  let stopped = false;
  let wake = null; // resolves the current wait early (e.g. "check now")
  let runId = 0;
  const report = { currentMediaId: null, playbackError: null };
  // Restart, See screen and updates from the dashboard (0.13.0).
  const remote = createRemote({ store, dataDir, events, log, fetchImpl, ...(startedAt ? { startedAt } : {}), ...(platform ? { platform } : {}) });

  const heartbeatBody = () => ({
    app_version: appVersion,
    current_media_id: report.currentMediaId,
    free_bytes: sync ? sync.freeBytes() : null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    after_hours: 'black',
    playback_error: report.playbackError || '',
    ...(report.download ? { download_done: report.download[0], download_total: report.download[1] } : {}),
    ...remote.reports(),
  });

  const set = (next) => {
    state = next;
    events.emit('state', state);
  };

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    wake = () => { clearTimeout(timer); resolve(); };
  });

  /** The playlist as the window needs it: items with this PC's own file paths. */
  function local(playlist) {
    const withFile = (item) => ({ ...item, file: sync.fileFor(item) });
    return {
      version: playlist.version,
      name: playlist.name,
      items: (playlist.items || []).map(withFile).filter((item) => sync.isReady(item)),
      hours: playlist.hours || null,
      browser: playlist.browser || null,
      // Video Kiosk ('video': touches ignored) or Web Kiosk ('web'), 0.12.0. Older servers: 'web'.
      mode: playlist.mode === 'video' ? 'video' : 'web',
    };
  }

  function showReady(playlist, badge = null) {
    set({ phase: 'ready', ...local(playlist), badge, server: store.get('serverUrl') });
  }

  async function connect(url) {
    const base = normaliseServerUrl(url);
    if (!base) throw new ApiError('That doesn’t look like a server address');
    const probe = createApi({ baseUrl: base, fetchImpl });
    const config = await probe.config();
    if (config.kind !== 'kiosk-signage') throw new ApiError('That address isn’t a Kiosk server');
    if (store.get('serverUrl') !== base) {
      store.set('token', null);
      store.set('playlist', null);
    }
    store.set('serverUrl', base);
    store.set('serverId', config.server_id || null);
    start();
  }

  function start() {
    const myRun = ++runId;
    const base = store.get('serverUrl');
    if (!base) {
      set({ phase: 'setup' });
      return;
    }
    api = createApi({ baseUrl: base, token: store.get('token') || null, fetchImpl });
    sync = createSync({ baseUrl: base, mediaDir: path.join(dataDir, 'media'), getToken: () => api.token, fetchImpl });
    run(myRun).catch((err) => log(`Kiosk Browser stopped unexpectedly: ${err.stack || err}`));
  }

  async function waitUntilPaired(myRun) {
    while (!stopped && myRun === runId) {
      try {
        if (!api.token) {
          const made = await api.register({ app_version: appVersion, model });
          api.token = made.token;
          store.set('token', made.token);
        }
        const status = await api.status();
        if (status.claimed) return true;
        set({ phase: 'pairing', code: status.pairing_code, server: store.get('serverUrl') });
        await sleep(4000);
      } catch (err) {
        if (err.status === 401) { api.token = null; store.set('token', null); continue; }
        const cached = store.get('playlist');
        if (cached && api.token) { showReady(cached, 'Offline · showing saved content'); await sleep(retryMs); continue; }
        set({ phase: 'pairing', code: null, problem: err.message, server: store.get('serverUrl') });
        await sleep(10_000);
      }
    }
    return false;
  }

  async function run(myRun) {
    const cached = store.get('playlist');
    if (cached && store.get('token')) showReady(cached);
    if (!(await waitUntilPaired(myRun))) return;
    let version = cached ? cached.version : null;
    while (!stopped && myRun === runId) {
      let wait = loopMs;
      try {
        const playlist = await api.playlist();
        const missing = [...(playlist.items || []), ...(playlist.upcoming || [])].some((i) => !sync.isReady(i));
        if (playlist.version !== version || missing) {
          const haveOld = state.phase === 'ready';
          await sync.sync(playlist, {
            onProgress: (done, total) => {
              report.download = done < total ? [done, total] : null;
              if (done >= total) return;
              const text = `Downloading ${done + 1} of ${total} new files`;
              if (haveOld) set({ ...state, badge: text });
              else set({ phase: 'preparing', name: playlist.name, done, total, detail: `${text}…`, server: store.get('serverUrl') });
            },
          });
          store.set('playlist', playlist);
          version = playlist.version;
        }
        showReady(playlist);
        await remote.handle(playlist.actions || {}, { api, baseUrl: store.get('serverUrl') });
        await api.heartbeat(heartbeatBody()).catch(() => {});
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Removed on the dashboard: forget everything and show a new code.
          api.token = null;
          store.set('token', null);
          store.set('playlist', null);
          sync.removeUnused([]);
          version = null;
          if (!(await waitUntilPaired(myRun))) return;
          continue;
        }
        const text = err instanceof DownloadError
          ? (/free space/.test(err.message) ? 'Not enough free space, retrying…' : `Download problem, retrying… (${err.message})`)
          : (err instanceof ApiError ? 'Offline · showing saved content' : `Something went wrong, retrying… (${err.message})`);
        if (!(err instanceof ApiError || err instanceof DownloadError)) log(`Kiosk Browser: ${err.stack || err}`);
        if (state.phase === 'ready') set({ ...state, badge: text });
        else if (state.phase === 'preparing') set({ ...state, detail: text });
        else set({ phase: 'pairing', code: null, problem: err.message, server: store.get('serverUrl') });
        wait = retryMs;
      }
      await sleep(wait);
    }
  }

  return {
    events,
    get state() { return state; },
    start,
    connect,
    /** Check for changes now (e.g. after the staff menu's "Reload content"). */
    checkNow: () => wake && wake(),
    /** Forget the server and the pairing (staff menu). */
    reset() {
      store.clear();
      if (sync) sync.removeUnused([]);
      runId++;
      wake && wake();
      set({ phase: 'setup' });
    },
    /** Restart, See screen and updates (0.13.0). Its events come through [events]. */
    remote,
    /** Sends a See screen picture (JPEG bytes), or why there isn't one. */
    async sendScreenshot(id, jpeg, error = null) {
      if (!api) return;
      await api.screenshot(id, jpeg ? { jpeg: Buffer.from(jpeg).toString('base64') } : { error: String(error || 'The kiosk couldn’t take a picture.').slice(0, 300) })
        .catch((err) => log(`Screenshot not sent: ${err.message}`));
    },
    /** Checks in straight away (e.g. "installing" before the app closes for an update). */
    reportNow: () => (api && api.token ? api.heartbeat(heartbeatBody()).catch(() => {}) : Promise.resolve()),
    /** What is on screen, for the next heartbeat. */
    playing(mediaId, error = null) {
      report.currentMediaId = mediaId;
      report.playbackError = error;
    },
    /** Open by the location's working hours, by this PC's own clock and time zone. */
    isOpen: (hours) => isOpenAt(hours, now(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    stop() {
      stopped = true;
      runId++;
      wake && wake();
    },
  };
}

module.exports = { createController };
