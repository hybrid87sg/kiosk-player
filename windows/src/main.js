// Kiosk Browser for Windows: the window, and how customers and staff use it.
//
// One full-screen window (no title bar, menus or address bar) shows player.html:
// the signage playlist while nobody uses the kiosk, the pairing code during setup,
// and a black screen outside working hours. A touch opens the screen's web page in a
// browser view on top, with a small bar underneath (Back, Start over). After the set
// time untouched, or on Start over, that browser view is thrown away and everything it
// stored (cookies, logins, form data, cache) is wiped, so the next customer starts fresh.
//
// Customers stay on the web page's own site (and sites allowed on the dashboard): other
// links, pop-ups, downloads, and requests for the camera, location etc. are refused.
// Staff leave it by tapping the top-left corner 5 times quickly and typing the PIN.

const { app, BrowserWindow, WebContentsView, ipcMain, session, powerSaveBlocker } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createController } = require('./core/controller');
const { createStore } = require('./core/store');
const { isAllowed, pinMatches } = require('./core/rules');
const { findServers } = require('./core/finder');

const BAR_HEIGHT = 76; // the bar under the web page (Back, Start over)
const LEAVE_MS = 15 * 60 * 1000; // staff "Leave for 15 minutes"

// Signage videos play with sound without anyone touching first, as on the TVs.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Tests run the app with its own data folder, never a real installation's.
if (process.env.KIOSK_BROWSER_DATA) app.setPath('userData', process.env.KIOSK_BROWSER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Anything unexpected in this process: start again rather than leave a dead screen.
process.on('uncaughtException', (err) => {
  log('Unexpected error, restarting:', err && err.stack ? err.stack : err);
  app.relaunch();
  app.exit(1);
});

let win = null;
let view = null; // the customer's browser view, only while someone is using it
let controller = null;
let idleTimer = null;
let quitting = false;
let leftUntil = 0;
let sleepBlocker = null;
let lastOpen = true;

const webSession = () => session.fromPartition('kiosk-web'); // in memory only, wiped after each customer

function current() {
  const s = controller.state;
  return s.phase === 'ready' ? s : null;
}

function isOpenNow() {
  const s = current();
  return s ? controller.isOpen(s.hours) : true;
}

/** What player.html shows. Files become file:// addresses it can play. */
function sendState() {
  if (!win) return;
  const s = controller.state;
  const out = { ...s, open: isOpenNow(), browsing: Boolean(view) };
  if (s.phase === 'ready') {
    out.items = s.items.map((item) => ({ id: item.id, type: item.type, filename: item.filename, duration: item.duration_seconds, src: pathToFileURL(item.file).toString() }));
    out.browser = s.browser ? { url: s.browser.url, has_pin: Boolean(s.browser.pin) } : null;
  }
  win.webContents.send('state', out);
}

// ---------- a customer's session ----------

function guardWebSession() {
  const ses = webSession();
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'fullscreen'));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

function allowed(url) {
  const s = current();
  return Boolean(s && s.browser && s.browser.url && isAllowed(url, s.browser.url, s.browser.allowed_hosts));
}

function layoutView() {
  if (!view || !win) return;
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height: Math.max(0, height - BAR_HEIGHT) });
}

function startSession() {
  const s = current();
  if (view || !s || !s.browser || !s.browser.url || !isOpenNow()) return;
  view = new WebContentsView({
    webPreferences: {
      partition: 'kiosk-web',
      preload: path.join(__dirname, 'preload-web.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      devTools: false,
    },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // "Open in a new window": shown in the same view, if it's allowed at all.
    if (allowed(url)) wc.loadURL(url);
    else blocked();
    return { action: 'deny' };
  });
  const stopIfNotAllowed = (event, url) => {
    if (!allowed(url)) { event.preventDefault(); blocked(); }
  };
  wc.on('will-navigate', stopIfNotAllowed);
  wc.on('will-redirect', stopIfNotAllowed);
  wc.on('render-process-gone', () => endSession());
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win && win.webContents.send('notice', 'The page didn’t load. Check the internet connection, or tap Start over.');
  });
  win.contentView.addChildView(view);
  layoutView();
  wc.loadURL(s.browser.url);
  wc.focus();
  stillThere();
  sendState();
}

function blocked() {
  if (win) win.webContents.send('notice', 'That page isn’t available on this kiosk.');
}

async function endSession() {
  clearTimeout(idleTimer);
  if (!view) return;
  const old = view;
  view = null;
  try { win.contentView.removeChildView(old); } catch { /* window closing */ }
  try { old.webContents.close(); } catch { /* already gone */ }
  sendState();
  // Nothing the customer did is kept: cookies, logins, storage, cache.
  const ses = webSession();
  await ses.clearStorageData().catch(() => {});
  await ses.clearCache().catch(() => {});
  await ses.clearAuthCache().catch(() => {});
}

/** Someone touched or typed: start the "back to signage" countdown again. */
function stillThere() {
  clearTimeout(idleTimer);
  const s = current();
  const seconds = (s && s.browser && s.browser.idle_seconds) || 90;
  idleTimer = setTimeout(() => endSession(), seconds * 1000);
}

// ---------- the window ----------

function createWindow() {
  win = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-player.js'),
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'player.html'));
  win.once('ready-to-show', () => win.show());
  win.on('resize', layoutView);
  // Alt+F4 and the like don't close it; only staff can (Quit in the staff menu).
  win.on('close', (event) => { if (!quitting) event.preventDefault(); });
  // Something else came to the front: take the screen back (unless staff stepped away).
  win.on('blur', () => setTimeout(() => {
    if (!win || quitting || Date.now() < leftUntil) return;
    win.setKiosk(true);
    win.setAlwaysOnTop(true);
    win.focus();
  }, 1500));
  win.webContents.on('render-process-gone', () => setTimeout(() => win && win.reload(), 1000));
  win.webContents.on('did-finish-load', sendState);
}

function leaveForAWhile() {
  leftUntil = Date.now() + LEAVE_MS;
  endSession();
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.minimize();
  setTimeout(() => {
    if (!win) return;
    leftUntil = 0;
    win.restore();
    win.setKiosk(true);
    win.setAlwaysOnTop(true);
    win.focus();
  }, LEAVE_MS).unref?.();
}

// ---------- messages from the screens ----------

function listen() {
  ipcMain.on('touch', () => startSession());
  ipcMain.on('activity', () => { if (view) stillThere(); });
  ipcMain.on('back', () => {
    const history = view && view.webContents.navigationHistory;
    if (history && history.canGoBack()) history.goBack();
    if (view) stillThere();
  });
  ipcMain.on('start-over', async () => {
    await endSession();
    startSession();
  });
  ipcMain.on('playing', (e, mediaId, error) => controller.playing(mediaId, error || null));
  // Staff: from a corner tap in either screen.
  ipcMain.on('staff', async () => {
    await endSession();
    win.webContents.send('staff');
  });
  ipcMain.handle('staff-pin', (e, pin) => {
    const s = current();
    const stored = s && s.browser && s.browser.pin;
    return stored ? pinMatches(pin, stored) : true; // no PIN set on the dashboard yet
  });
  ipcMain.on('staff-action', (e, action) => {
    if (action === 'reload') controller.checkNow();
    else if (action === 'leave') leaveForAWhile();
    else if (action === 'reset') controller.reset();
    else if (action === 'quit') { quitting = true; app.quit(); }
  });
  // Setup.
  ipcMain.handle('find-servers', () => findServers());
  ipcMain.handle('connect', async (e, url) => {
    try {
      await controller.connect(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ---------- start ----------

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  controller = createController({
    store: createStore(dataDir),
    dataDir,
    appVersion: app.getVersion(),
    model: `Windows · ${os.hostname()}`,
    log,
  });
  controller.events.on('state', () => {
    // Settings changed so the current page isn't allowed any more: back to signage.
    if (view && !allowed(view.webContents.getURL())) endSession();
    sendState();
  });
  guardWebSession();
  listen();
  createWindow();
  controller.start();

  // Working hours: dark and closed outside them; the screen kept awake inside them.
  const checkHours = () => {
    const open = isOpenNow();
    if (!open && view) endSession();
    if (open && !sleepBlocker) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!open && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
    if (open !== lastOpen) { lastOpen = open; sendState(); }
  };
  checkHours();
  setInterval(checkHours, 30_000);

  // Start with Windows, so a power cut or restart comes back to the kiosk by itself.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
});

app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
