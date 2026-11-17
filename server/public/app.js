// Kiosk Signage web interface.
//
// One page, no build step: it asks the server's API (the same one the phone
// app uses) for data, and draws the screens with plain DOM calls. Text from
// the server is always added with textContent (never as HTML), so names of
// files or players can't inject anything into the page.
//
// Sections: Screens (live overview), Library, Playlists, Users, Settings.
// Addresses are relative ("api/...") so the page also works inside Home
// Assistant's sidebar, where it lives under a longer address.

const TOKEN_KEY = 'kiosk-token';
const app = document.getElementById('app');
let me = null; // { email, role, via_home_assistant }
let config = {}; // { web_code_sign_in, version, ... }
let pageTimer = null; // refresh timer of the current page

// ---------- Small helpers ----------

/** Creates an element: el('button', { class: 'btn', onclick: fn }, 'Text', child, ...) */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...nodes(children));
  return node;
}

/** Turns nested lists of children (skipping empty ones) into DOM nodes. */
function nodes(children) {
  return children.flat(Infinity)
    .filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

/** Replaces everything inside node with the given children (lists allowed). */
function fill(node, ...children) {
  node.replaceChildren(...nodes(children));
}

const ICONS = {
  screens: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  library: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  playlists: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  locations: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  collapse: '<path d="M15 18l-6-6 6-6"/>',
  expand: '<path d="M9 18l6-6-6-6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  relay: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 11l10-5M7 13l10 5"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  'volume-off': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  resync: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};

/** An icon from the fixed set above (our own markup, never server text). */
function icon(name, size = 20) {
  const span = el('span', { 'aria-hidden': 'true', style: 'display:inline-flex' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function token() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(value) {
  try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/** Calls the server. Throws an Error with the server's message on failure. */
async function api(method, url, body) {
  const headers = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the server");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `The server answered with error ${res.status}`);
    err.status = res.status;
    if (res.status === 401 && me) { setToken(null); me = null; renderSignIn(); }
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message) {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}

/** Runs an action and shows its error, if any, as a message. */
async function attempt(action) {
  try { return await action(); } catch (e) { toast(e.message); return undefined; }
}

function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function timeAgo(ms) {
  if (!ms) return 'never';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}

const SHAPES = { landscape: 'Landscape', portrait: 'Portrait' };
const MOUNTINGS = {
  landscape: { label: 'Landscape', shape: 'landscape' },
  portrait_right: { label: 'Portrait, turned right', shape: 'portrait' },
  portrait_left: { label: 'Portrait, turned left', shape: 'portrait' },
  landscape_flipped: { label: 'Landscape, upside down', shape: 'landscape' },
};
// The server keeps "upside down" as a flag beside the orientation, so older apps still work.
const mountingOf = (d) => (d && d.flipped && d.orientation === 'landscape' ? 'landscape_flipped' : (d && d.orientation) || 'landscape');
const mountingBody = (key) => (key === 'landscape_flipped' ? { orientation: 'landscape', flipped: true } : { orientation: key, flipped: false });
const playlistLabel = (p) => (p.auto ? `${p.name} (automatic)` : p.name);
// Where "back" goes from a playlist: people who manage screens see playlists under Locations.
const playlistsHome = () => (me && me.role === 'content_uploader' ? '#/playlists' : '#/locations');
const ROLES = {
  superadmin: { label: 'Spongebob', desc: 'Everything, including people and settings' },
  system_manager: { label: 'Patrick', desc: 'Screens and content' },
  content_uploader: { label: 'Squidward', desc: 'Files and playlists only' },
};

/** A small screen with a mark on the edge where the top of the picture is. */
function mountIcon(key, size = 24) {
  const portrait = MOUNTINGS[key].shape === 'portrait';
  const w = portrait ? Math.round(size * 0.62) : size;
  const h = portrait ? size : Math.round(size * 0.62);
  const edge = { landscape: 'top', landscape_flipped: 'bottom', portrait_right: 'right', portrait_left: 'left' }[key];
  return el('span', {
    class: 'mount-icon', 'aria-hidden': 'true',
    style: `width:${w}px;height:${h}px;border-${edge}-width:5px`,
  });
}

/** A small outlined rectangle in landscape or portrait shape. */
function shapeIcon(shape, size = 18) {
  const long = size;
  const short = Math.round(size * 0.62);
  return el('span', {
    class: 'shape', 'aria-hidden': 'true',
    style: `width:${shape === 'portrait' ? short : long}px;height:${shape === 'portrait' ? long : short}px`,
  });
}

/** A coloured tile in the file's shape, with a play or picture icon (or a number). */
function thumb(type, shape, label) {
  const long = 48;
  const short = 34;
  const [w, h] = shape === 'portrait' ? [short, long] : [long, short];
  const tile = el('span', { class: type === 'video' ? 'video' : 'image', style: `width:${w}px;height:${h}px` },
    label !== undefined ? String(label) : icon(type === 'video' ? 'play' : 'image', 18));
  return el('span', { class: 'thumb' }, tile);
}

function mediaMeta(m) {
  return `${m.type === 'video' ? 'Video' : 'Picture'} · ${m.orientation ? SHAPES[m.orientation] : 'Checking shape…'} · ${formatBytes(m.size)}`;
}

// ---------- Expiry dates ----------
// People pick the last day a file shows. It expires at the start of the next
// day, in this browser's time zone (like playlist dates).

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-12-24" for a date input, from an expiry time (the day before it). */
function lastDayValue(expiresAt) {
  if (expiresAt == null) return '';
  const d = new Date(expiresAt - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The expiry time for a chosen last day: midnight at the end of it. */
function expiryFromLastDay(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function shortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** "Shows until 24 Dec", warning-coloured when 3 days or less are left. */
/** "2026-12-01" for a date input, from a start time. */
function firstDayValue(startsAt) {
  return startsAt == null ? '' : lastDayValue(startsAt + 1);
}

/** The start time for a chosen first day: midnight at its beginning. */
function startOfDay(value) {
  return value ? new Date(`${value}T00:00:00`).getTime() : null;
}

/** "Starts 1 Dec" (before its start) and "Shows until 24 Dec" chips for a file. */
function scheduleChips(m) {
  const chips = [];
  if (m.starts_at != null && m.starts_at > Date.now()) {
    chips.push(el('span', { class: 'chip primary', title: 'It goes on screens from this day. TVs download it a day ahead.' }, `Starts ${shortDate(m.starts_at)}`));
  }
  if (m.expires_at != null) {
    const soon = m.expires_at - Date.now() <= 3 * DAY_MS;
    chips.push(el('span', { class: `chip ${soon ? 'attention' : 'primary'}`, title: 'After this day it leaves Kiosk and every screen. Google Drive keeps it.' },
      `Shows until ${shortDate(m.expires_at - 1)}`));
  }
  return chips;
}

/** Choose a file's first and last day (both optional). onSave(startsAt, expiresAt) does the saving. */
function scheduleDialog({ title, text, startsAt = null, expiresAt = null, saveLabel = 'Save', onSave }) {
  openDialog((dialog) => {
    const from = el('input', { type: 'date', class: 'date-input', value: firstDayValue(startsAt) });
    const until = el('input', { type: 'date', class: 'date-input', value: lastDayValue(expiresAt), min: lastDayValue(Date.now() + 1) });
    from.addEventListener('change', () => { until.min = from.value || lastDayValue(Date.now() + 1); });
    const save = async (start, end) => {
      if (start != null && end != null && start >= end) return toast('The last day must be on or after the first day');
      const ok = await attempt(() => onSave(start, end));
      if (ok !== undefined) dialog.close();
    };
    const form = el('form', {
      method: 'dialog',
      onsubmit: (e) => {
        e.preventDefault();
        save(startOfDay(from.value), expiryFromLastDay(until.value));
      },
    },
    el('h2', {}, title),
    el('p', { class: 'sub' }, text),
    el('div', { class: 'row', style: 'gap:16px;align-items:flex-end' },
      el('label', { class: 'field' }, 'Show from (optional)', from),
      el('label', { class: 'field' }, 'Show until (optional)', until)),
    el('p', { class: 'meta', style: 'margin:0' }, 'Before the first day it waits in the library; after the last day it leaves Kiosk and every screen. Google Drive keeps it either way.'),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn', onclick: () => save(null, null) }, 'No dates'),
      el('button', { class: 'btn primary' }, saveLabel)));
    setTimeout(() => from.focus());
    return form;
  });
}

/** Opens a dialog. build(dialog) returns its content; it closes with dialog.close(). */
function openDialog(build) {
  const dialog = el('dialog');
  dialog.append(build(dialog));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function confirmDialog(title, text, okLabel, onOk) {
  openDialog((dialog) => el('div', { class: 'dialog-body' },
    el('h2', {}, title),
    el('p', { class: 'sub' }, text),
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn danger solid', onclick: () => { dialog.close(); onOk(); } }, okLabel)),
  ));
}

// ---------- Start, sign-in and the menu ----------

async function boot() {
  config = (await attempt(() => api('GET', 'api/config'))) || {};
  try {
    me = await api('GET', 'api/me');
    renderShell();
  } catch {
    renderSignIn();
  }
}

// The public address (the add-on's Tailscale Funnel) signs in with Google only. Google's own
// button comes from accounts.google.com and hands back a signed token, which the server checks.
function loadGoogleButton() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = el('script', { src: 'https://accounts.google.com/gsi/client', async: true });
    script.onload = resolve;
    script.onerror = () => reject(new Error('Couldn’t load Google’s sign-in button. Check the internet connection and try again.'));
    document.head.append(script);
  });
}

function renderGoogleSignIn() {
  clearInterval(pageTimer);
  const problem = el('div', { class: 'error', role: 'alert' });
  const holder = el('div', { style: 'display:flex;justify-content:center;min-height:44px' });
  fill(app, el('div', { class: 'signin' },
    el('div', { class: 'brand-mark' }, icon('screens', 36)),
    el('h1', {}, 'Kiosk Signage'),
    el('p', { class: 'sub' }, 'Manage what plays on your screens.'),
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px;text-align:left' },
      config.web_google_client_id
        ? [holder, problem,
          el('p', { class: 'meta', style: 'margin:0' }, 'Use the Google account that whoever runs Kiosk linked to your user. Passwords work only at home or over Tailscale.')]
        : el('p', { class: 'note', style: 'margin:0' }, 'Google sign-in isn’t set up yet. Whoever runs Kiosk can set it up under Settings → Public dashboard.'))));
  if (!config.web_google_client_id) return;
  loadGoogleButton().then(() => {
    window.google.accounts.id.initialize({
      client_id: config.web_google_client_id,
      callback: async ({ credential }) => {
        problem.textContent = '';
        try {
          const result = await api('POST', 'api/auth/google', { credential });
          setToken(result.token);
          me = { username: result.username, email: result.username, role: result.role };
          renderShell();
        } catch (err) { problem.textContent = err.message; }
      },
    });
    window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
  }).catch((err) => { problem.textContent = err.message; });
}

function renderSignIn() {
  if (config.public) return renderGoogleSignIn();
  clearInterval(pageTimer);
  const username = el('input', { type: 'text', id: 'signin-username', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, required: true });
  const password = el('input', { type: 'password', id: 'signin-password', autocomplete: 'current-password', required: true });
  const problem = el('div', { class: 'error', role: 'alert' });
  const button = el('button', { class: 'btn primary', style: 'justify-content:center' }, 'Sign in');
  const form = el('form', {
    class: 'card', style: 'display:flex;flex-direction:column;gap:14px;text-align:left',
    onsubmit: async (e) => {
      e.preventDefault();
      problem.textContent = '';
      button.disabled = true;
      try {
        const result = await api('POST', 'api/auth/login', { username: username.value.trim(), password: password.value });
        setToken(result.token);
        me = { username: result.username, email: result.username, role: result.role };
        renderShell();
      } catch (err) {
        problem.textContent = err.message;
        password.value = '';
        password.focus();
      } finally {
        button.disabled = false;
      }
    },
  },
  el('label', { class: 'field', for: 'signin-username' }, 'Username', username),
  el('label', { class: 'field', for: 'signin-password' }, 'Password', password),
  problem, button,
  el('p', { class: 'meta', style: 'margin:0' }, 'Don’t have a username? Whoever runs Kiosk makes one for you on the Users page.'));
  fill(app, el('div', { class: 'signin' },
    el('div', { class: 'brand-mark' }, icon('screens', 36)),
    el('h1', {}, 'Kiosk Signage'),
    el('p', { class: 'sub' }, 'Manage what plays on your screens.'),
    form));
  username.focus();
}

function tabsFor(role) {
  const tabs = [];
  if (role !== 'content_uploader') tabs.push(['screens', 'Screens'], ['locations', 'Locations']);
  tabs.push(['library', 'Library']);
  if (role === 'content_uploader') tabs.push(['playlists', 'Playlists']); // others find playlists under Locations
  if (role === 'superadmin') tabs.push(['users', 'Users'], ['settings', 'Settings']);
  return tabs;
}

// The side menu can be folded down to icons; remembered in this browser.
const NAV_KEY = 'kiosk-nav-collapsed';
function navCollapsed() {
  try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; }
}

function renderShell() {
  const collapsed = navCollapsed();
  const toggle = el('button', {
    class: 'btn icon nav-toggle', type: 'button',
    'aria-label': collapsed ? 'Expand the menu' : 'Collapse the menu', title: collapsed ? 'Expand the menu' : 'Collapse the menu',
    'aria-expanded': String(!collapsed),
    onclick: () => {
      try { localStorage.setItem(NAV_KEY, navCollapsed() ? '0' : '1'); } catch { /* private mode */ }
      renderShell();
    },
  }, icon(collapsed ? 'expand' : 'collapse', 18));
  const nav = el('nav', { class: `nav${collapsed ? ' collapsed' : ''}`, 'aria-label': 'Main' },
    el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, icon('screens', 20)), el('span', { class: 'label' }, 'Kiosk Signage'), toggle),
    tabsFor(me.role).map(([key, label]) => [
      el('a', { href: `#/${key}`, 'data-tab': key, title: label }, icon(key), el('span', { class: 'label' }, label)),
      key === 'locations' ? el('div', { class: 'nav-sub', id: 'nav-locations' }) : null,
    ]),
    el('div', { class: 'spacer' }),
    el('div', { class: 'who' }, el('strong', {}, me.email), el('span', { class: 'label' }, ROLES[me.role].label,
      me.via_home_assistant ? ' · via Home Assistant' : ''),
    me.via_home_assistant ? null : el('div', { class: 'row', style: 'gap:14px;margin-top:6px' },
      el('button', { class: 'btn text small', style: 'padding:0', onclick: changeMyPasswordDialog }, 'Password'),
      el('button', { class: 'btn text small', style: 'padding:0', onclick: signOut }, 'Sign out'))),
  );
  fill(app, el('div', { class: 'shell' }, nav, el('main', { id: 'page' })));
  refreshNavLocations();
  route();
}

/** Fills the Locations part of the menu: one link per location. */
async function refreshNavLocations() {
  const box = document.getElementById('nav-locations');
  if (!box) return;
  const data = await api('GET', 'api/locations').catch(() => null);
  if (!data) return;
  fill(box, data.locations.map((l) => el('a', { href: `#/locations/${l.id}`, 'data-loc': String(l.id), title: l.name },
    el('span', { class: 'label' }, l.name), el('span', { class: 'count' }, String(l.screens.length)))));
  markCurrentNav();
}

function markCurrentNav() {
  const [, section, id] = (location.hash || '').split('/');
  document.querySelectorAll('.nav a[data-loc]').forEach((a) => {
    if (section === 'locations' && a.dataset.loc === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function signOut() {
  await attempt(() => api('POST', 'api/auth/logout'));
  setToken(null);
  me = null;
  renderSignIn();
}

function route() {
  if (!me) return;
  clearInterval(pageTimer);
  const [, section, id] = (location.hash || '').split('/');
  const allowed = [...tabsFor(me.role).map(([key]) => key), 'playlists', ...(me.role === 'superadmin' ? ['relays'] : [])];
  const current = allowed.includes(section) ? section : allowed[0];
  // A playlist is opened from Locations, so that stays lit in the menu while it is open.
  const lit = current === 'playlists' && me.role !== 'content_uploader' ? 'locations' : current === 'relays' ? 'settings' : current;
  document.querySelectorAll('.nav a[data-tab]').forEach((a) => {
    if (a.dataset.tab === lit && !(current === 'locations' && id)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  markCurrentNav();
  const page = document.getElementById('page');
  if (!page) return;
  fill(page, el('p', { class: 'loading' }, 'Loading…'));
  const pages = { screens: pageScreens, locations: pageLocations, library: pageLibrary, playlists: pagePlaylists, users: pageUsers, settings: pageSettings, relays: pageRelays };
  if (current === 'playlists' && id) pagePlaylist(page, Number(id));
  else if (current === 'locations' && id) pageLocation(page, Number(id));
  else pages[current](page);
}
window.addEventListener('hashchange', route);

// ---------- Screens: live overview of every TV ----------

async function pageScreens(page) {
  async function draw() {
    const [devices, playlists, waiting] = await Promise.all([
      api('GET', 'api/devices'), api('GET', 'api/playlists'), api('GET', 'api/devices/waiting'),
    ]);
    const online = devices.filter((d) => d.online).length;
    // Screens Spongebob can update from here right now.
    const updatable = isSpongebob() ? devices.filter((d) => d.app && d.app.update_available && d.app.can_install_apps !== false && !jobRunning(d.app.update)) : [];
    // With TVs at more than one site, group by site first, then location.
    const sites = new Set([...devices, ...waiting].map((d) => d.site || ''));
    const manySites = sites.size > 1;
    const groups = new Map();
    for (const d of devices) {
      const loc = d.location || 'No location yet · choose one so these screens have a playlist';
      const key = loc; // locations are one list, whichever site a screen connects through
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    // The header of a location's group: its working hours, and a link to the location.
    const groupHead = (group, list) => {
      const first = list[0];
      return el('div', { class: 'section-label row group-head' }, `${group} · ${list.length}`,
        first.location_id ? el('a', { class: 'hours-link', href: `#/locations/${first.location_id}` }, icon('clock', 14), first.hours_summary) : null);
    };
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Screens'),
          el('p', { class: 'sub' }, `${devices.length} screen${devices.length === 1 ? '' : 's'} · ${online} online · updates every 10 seconds`)),
        el('div', { class: 'row' },
          updatable.length ? el('button', {
            class: 'btn',
            onclick: () => confirmDialog(`Update ${updatable.length} screen${updatable.length === 1 ? '' : 's'}?`,
              `They get Kiosk Player ${updatable[0].app.latest.version} at their next check-in. Each closes for a few seconds while it installs.`, 'Update',
              () => attempt(async () => {
                const { started } = await api('POST', 'api/devices/update-all');
                toast(`${started} screen${started === 1 ? '' : 's'} updating`);
                draw();
              })),
          }, icon('download', 18), `Update all screens (${updatable.length})`) : null,
          el('button', { class: 'btn primary', onclick: () => addScreenDialog(playlists, devices, draw) }, '+ Add by code'))),
      waiting.length ? waitingCard(waiting, manySites, playlists, devices, draw) : null,
      devices.length === 0
        ? el('div', { class: 'empty' }, 'No screens yet. Open Kiosk Player on a TV and choose “Find my server automatically”; it then appears here under “New screens waiting”.')
        : [...groups.entries()].map(([group, list]) => [
          groupHead(group, list),
          el('div', { class: 'grid' }, list.map((d) => screenCard(d, playlists, devices, draw))),
        ]),
    );
  }
  await attempt(draw);
  pageTimer = setInterval(() => attempt(draw), 10000);
}

/** TVs showing a pairing code right now: add one with a click instead of typing its code. */
function waitingCard(waiting, manySites, playlists, devices, redraw) {
  const pretty = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;
  return el('div', { class: 'waiting' },
    el('div', { class: 'section-label' }, `New screens waiting · ${waiting.length}`),
    el('div', { class: 'list' }, waiting.map((w) =>
      el('div', { class: 'list-row' },
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, w.kind === 'browser' ? `Windows kiosk${w.model ? ` · ${w.model}` : ''}` : (w.model || 'Android TV')),
          el('div', { class: 'meta' }, manySites && w.site ? `${w.site} · ` : '', 'Showing code ',
            el('strong', {}, pretty(w.pairing_code)), ' on its screen')),
        el('button', {
          class: 'btn primary small',
          onclick: () => screenForm({ code: w.pairing_code, kind: w.kind, site: w.site, mounting: w.mounting, playlists, devices, onDone: redraw }),
        }, 'Add')))),
  );
}

function screenCard(d, playlists, devices, redraw) {
  const mount = MOUNTINGS[mountingOf(d)] || MOUNTINGS.landscape;
  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('strong', { style: 'font-size:17px' }, d.name || 'Unnamed'),
      d.open_now === false
        ? el('span', { class: 'chip offline', title: d.hours_summary }, icon('clock', 12), d.after_hours === 'standby' ? 'After hours · standby' : 'After hours · black screen')
        : el('span', { class: `chip ${d.online ? 'online' : 'offline'}` }, el('span', { class: 'dot' }),
          d.online ? 'Online' : `Offline · ${timeAgo(d.last_seen)}`)),
    el('div', { class: 'row meta' }, shapeIcon(mount.shape), `${mount.label} · ${d.playlist_name ? `${d.playlist_name}${d.playlist_auto ? ' (automatic)' : ''}` : 'No playlist'}`),
    el('div', {}, d.current_filename ? `Now playing: ${d.current_filename}` : 'Waiting for content'),
    d.kind === 'browser' ? el('div', { class: d.browser?.url ? 'meta' : 'warn' },
      d.browser?.url ? `Web kiosk · ${d.browser.url}` : 'Web kiosk · no web address yet: Edit to set one') : null,
    d.playback_error ? el('div', { class: 'error' }, d.playback_error) : null,
    d.last_restart ? el('div', { class: 'warn', title: new Date(d.last_restart.at).toLocaleString() },
      `Closed by itself ${timeAgo(d.last_restart.at)} and reopened: ${d.last_restart.reason}`) : null,
    d.decoders && d.decoders.display_width ? el('div', { class: 'meta' },
      `Screen ${d.decoders.display_width}×${d.decoders.display_height}`
      + (d.decoders.h264_level ? ` · H.264 level ${d.decoders.h264_level === 9 ? '1b' : (d.decoders.h264_level / 10).toFixed(1)}` : '')
      + (d.decoders.hevc ? ' · HEVC' : '')) : null,
    d.download ? el('div', {},
      el('div', { class: 'warn' }, `Downloading ${Math.min(d.download.done + 1, d.download.total)} of ${d.download.total} new files`),
      el('div', { class: 'progress', style: 'margin-top:6px' }, el('div', { style: `width:${Math.round((d.download.done / d.download.total) * 100)}%` }))) : null,
    el('div', { class: 'meta' }, d.free_bytes ? `Storage: ${formatBytes(d.free_bytes)} free` : '', d.app_version ? ` · App ${d.app_version}` : '',
      d.app && d.app.android_sdk ? ` · ${androidName(d.app.android_sdk)}` : ''),
    isSpongebob() ? appUpdateHint(d) : null,
    jobBox('Reset sync', d.resync, resyncText),
    jobBox(`App update${d.app && d.app.latest ? ` to ${d.app.latest.version}` : ''}`, d.app && d.app.update, (job) => updateText(job, d)),
    el('div', { class: 'row' },
      el('button', { class: 'btn text small', onclick: () => screenForm({ device: d, site: d.site, playlists, devices, onDone: redraw }) }, 'Edit'),
      isSpongebob() && d.kind !== 'browser' ? el('button', {
        class: 'btn text small',
        disabled: jobRunning(d.resync),
        onclick: () => resyncDialog(d, redraw),
      }, icon('resync', 16), 'Reset sync') : null,
      isSpongebob() && d.app && d.app.update_available ? el('button', {
        class: 'btn text small',
        disabled: jobRunning(d.app.update) || d.app.can_install_apps === false,
        onclick: () => attempt(async () => {
          await api('POST', `api/devices/${d.id}/update`);
          toast(`${d.name} gets the new app at its next check-in`);
          redraw();
        }),
      }, icon('download', 16), 'Update app') : null,
      el('button', {
        class: 'btn danger small',
        onclick: () => confirmDialog(`Remove ${d.name}?`, 'The TV stops getting updates and shows a new pairing code, so it can be added again later.', 'Remove',
          () => attempt(async () => { await api('DELETE', `api/devices/${d.id}`); toast(`${d.name} removed`); redraw(); })),
      }, 'Remove')),
  );
}

// ---------- Reset sync and app updates (0.11.0, Spongebob only) ----------

const isSpongebob = () => Boolean(me && me.role === 'superadmin');
const jobRunning = (job) => Boolean(job && job.step !== 'done' && job.step !== 'failed');
const ANDROID_NAMES = { 26: '8', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };
const androidName = (sdk) => `Android ${ANDROID_NAMES[sdk] || `(API ${sdk})`}`;

/** A Reset sync or app update in progress, or how it ended. */
function jobBox(title, job, describe) {
  if (!job) return null;
  const failed = job.step === 'failed';
  const progress = job.step === 'downloading' && job.total ? job.done / job.total : null;
  return el('div', { role: 'status', class: 'job-box' },
    el('div', { class: failed ? 'error' : 'warn' }, title),
    el('div', {}, describe(job)),
    progress !== null ? el('div', { class: 'progress' }, el('div', { style: `width:${Math.round(progress * 100)}%` })) : null,
    job.note ? el('div', { class: 'meta' }, job.note) : null);
}

function resyncText(job) {
  switch (job.step) {
    case 'waiting': return 'Waiting for the screen. It checks in about once a minute.';
    case 'downloading': return job.total
      ? `Downloading a fresh copy: ${Math.min(job.done + 1, job.total)} of ${job.total} files. Still playing the current files.`
      : 'Downloading a fresh copy. Still playing the current files.';
    case 'switching': return 'All files are in. Switching to the fresh copy and deleting the old files…';
    case 'done': return 'Done: playing the fresh copy. Old files deleted.';
    default: return job.error || 'It didn’t work.';
  }
}

function updateText(job, d) {
  const version = d.app && d.app.latest ? d.app.latest.version : 'the new app';
  switch (job.step) {
    case 'waiting': return 'Waiting for the screen. It checks in about once a minute.';
    case 'downloading': return `Downloading Kiosk Player ${version}…`;
    case 'waiting_for_install': return `Waiting for someone to press Install on the TV.${d.app.android_sdk && d.app.android_sdk < 31 ? ` This TV runs ${androidName(d.app.android_sdk)}, which asks every time.` : ''}`;
    case 'installing': return 'Installing. The player closes for a few seconds and reopens by itself.';
    case 'done': return `Updated to ${job.version || version}.`;
    default: return job.error || 'The update didn’t work.';
  }
}

/** Whether this screen's app can be updated from here, and how. */
function appUpdateHint(d) {
  const app = d.app;
  if (!app || !app.latest || d.kind === 'browser' || jobRunning(app.update)) return null;
  if (app.version_code == null) {
    return d.app_version ? el('div', { class: 'meta' }, `Install Kiosk Player ${app.latest.version} on this TV by hand once; after that, updates come from here.`) : null;
  }
  if (!app.update_available) return null;
  if (app.can_install_apps === false) {
    return el('div', { class: 'warn' }, 'Can’t update from here yet: on the TV, allow Kiosk Player under Settings → Apps → Special app access → Install unknown apps.');
  }
  return el('div', { class: 'meta' }, `Update available: ${d.app_version || 'this app'} → ${app.latest.version}`,
    app.android_sdk >= 31 ? ' (installs by itself on Android 12 and newer, after the first time)' : ' (someone presses Install on the TV)');
}

function resyncDialog(d, onDone) {
  confirmDialog(`Reset sync on ${d.name}?`,
    'The TV downloads every file in its playlist again, from scratch. It keeps playing what it has meanwhile, then switches to the fresh copy and deletes the old files. If the TV hasn’t enough space for both, it deletes first and shows “Getting content ready” until the files are back.',
    'Reset sync',
    () => attempt(async () => {
      await api('POST', `api/devices/${d.id}/resync`);
      toast(`${d.name} starts at its next check-in`);
      onDone();
    }));
}

function addScreenDialog(playlists, devices, onDone) {
  openDialog((dialog) => {
    const input = el('input', { type: 'text', placeholder: 'K7P-29Q', autocomplete: 'off', style: 'font-size:24px;letter-spacing:0.15em;text-transform:uppercase;font-weight:700' });
    const form = el('form', {
      method: 'dialog',
      onsubmit: (e) => {
        e.preventDefault();
        const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 6) return toast('Type the 6 letters and numbers shown on the TV');
        dialog.close();
        screenForm({ code, playlists, devices, onDone });
      },
    },
    el('h2', {}, 'Add a screen'),
    el('p', { class: 'sub' }, 'Open Kiosk Player on the TV. Type the code it shows under the QR code.'),
    el('label', { class: 'field' }, 'Code on the TV', input),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Next')));
    setTimeout(() => input.focus());
    return form;
  });
}

/** Name, location, how the screen is mounted and its playlist. New (code) or existing (device). */
async function screenForm({ code, device, kind = device?.kind, site = null, mounting: asked = null, playlists, devices, onDone }) {
  // Every location, to choose from (or add a new one). A screen has to be in one:
  // that is where its playlist and its working hours come from.
  const data = await attempt(() => api('GET', 'api/locations'));
  if (!data) return;
  const choices = data.locations.map((l) => l.name);
  if (device?.location && !choices.includes(device.location)) choices.push(device.location);
  openDialog((dialog) => {
    const name = el('input', { type: 'text', value: device?.name || '', placeholder: 'e.g. Front window', required: true });
    const location = el('select', { required: true },
      el('option', { value: '', disabled: true, selected: !device?.location }, 'Choose a location…'),
      choices.map((l) => el('option', { value: l, selected: device?.location === l }, l)),
      el('option', { value: '__new' }, '+ New location…'));
    const newLocation = el('input', { type: 'text', placeholder: 'Name of the new location, e.g. Main lobby', hidden: true });
    location.addEventListener('change', () => {
      newLocation.hidden = location.value !== '__new';
      if (!newLocation.hidden) newLocation.focus();
      updateWarning();
    });
    // A new TV says how staff turned its picture (Turn picture on the TV).
    let mounting = device ? mountingOf(device) : (MOUNTINGS[asked] ? asked : 'landscape');
    // null means Automatic: the screen follows its site's Landscape or Portrait playlist.
    let playlistId = device?.playlist_id ?? null;
    // The chosen location's name ("" until one is chosen, or while a new one is being typed).
    const chosenLocation = () => (location.value && location.value !== '__new' ? location.value : '');
    const warning = el('div', { class: 'note', hidden: true });
    const updateWarning = () => {
      const chosen = playlists.find((p) => p.id === playlistId);
      const screenShape = MOUNTINGS[mounting].shape;
      warning.hidden = !chosen || chosen.orientation === screenShape;
      if (chosen) warning.textContent = `${chosen.name} is made for ${chosen.orientation} screens, but this screen is ${screenShape}. Its files will play with black bars.`;
      const where = chosenLocation();
      autoMeta.textContent = where
        ? `Plays ${where}’s ${SHAPES[screenShape]} playlist. If you turn the screen or move it, it switches by itself.`
        : `Plays its location’s ${SHAPES[screenShape]} playlist.`;
      drawExtras();
    };
    // Turning the picture upside down needs Kiosk Player 0.5.0 or newer on the TV.
    const cantFlip = Boolean(device) && device.can_flip === false;
    const mountChoices = el('div', { class: 'choices' }, Object.entries(MOUNTINGS).map(([key, m]) => {
      const off = key === 'landscape_flipped' && cantFlip && mounting !== key;
      return el('label', { class: `choice${off ? ' disabled' : ''}` },
        el('input', { type: 'radio', name: 'mounting', value: key, checked: mounting === key, disabled: off, onchange: () => { mounting = key; updateWarning(); } }),
        el('span', {}, mountIcon(key, 26), ' ', m.label,
          off ? [el('br'), el('span', { class: 'meta' }, `Needs Kiosk Player 0.5.0 or newer; this TV has ${device.app_version || 'an older version'}.`)] : null));
    }));
    const autoMeta = el('span', { class: 'meta' });
    // Automatic first; then the chosen location's extra playlists (and the one in use, wherever it is).
    const autoInput = el('input', { type: 'radio', name: 'playlist', value: '', checked: playlistId === null, onchange: () => { playlistId = null; updateWarning(); } });
    const extraBox = el('div', { class: 'choices', style: 'display:contents' });
    const extraHint = el('span', { class: 'meta' });
    function drawExtras() {
      const where = chosenLocation();
      const extras = playlists.filter((p) => !p.auto && ((!p.unassigned && p.location === where) || p.id === playlistId));
      fill(extraBox, extras.map((p) =>
        el('label', { class: 'choice' },
          el('input', { type: 'radio', name: 'playlist', value: p.id, checked: playlistId === p.id, onchange: () => { playlistId = p.id; autoInput.checked = false; updateWarning(); } }),
          el('span', {}, el('strong', {}, p.name), el('br'), el('span', { class: 'meta' }, `${SHAPES[p.orientation]} · ${p.item_count} item${p.item_count === 1 ? '' : 's'}`)))));
      extraHint.textContent = extras.length || !where ? '' : `To show something different on one screen, add an extra playlist for ${where} under Locations.`;
    }
    const playlistChoices = el('div', { class: 'choices' },
      el('label', { class: 'choice' }, autoInput, el('span', {}, el('strong', {}, 'Automatic'), el('br'), autoMeta)),
      extraBox);
    updateWarning();
    // A Windows Kiosk Browser: the page customers use, and its rules.
    const isBrowser = kind === 'browser';
    const b = device?.browser || {};
    const kioskUrl = el('input', { type: 'url', value: b.url || '', placeholder: 'https://shop.example.com/start', spellcheck: false });
    const kioskIdle = el('input', { type: 'number', min: 15, max: 3600, step: 5, value: b.idle_seconds || 90, style: 'max-width:120px' });
    const kioskHosts = el('textarea', { rows: 2, placeholder: 'e.g. pay.example.com (one per line)', spellcheck: false }, (b.allowed_hosts || []).join('\n'));
    const kioskPin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 8, placeholder: b.has_pin ? 'Unchanged (type a new one to change)' : '4 to 8 digits', style: 'max-width:260px' });
    const kioskNoPin = el('input', { type: 'checkbox' });
    const browserBody = () => {
      const out = {
        kiosk_url: kioskUrl.value.trim() || null,
        kiosk_idle_seconds: Number(kioskIdle.value) || 90,
        kiosk_allowed_hosts: kioskHosts.value.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean),
      };
      if (kioskNoPin.checked) out.kiosk_pin = null;
      else if (kioskPin.value) out.kiosk_pin = kioskPin.value;
      return out;
    };
    const browserFields = !isBrowser ? null : el('div', { class: 'field', style: 'display:flex;flex-direction:column;gap:10px' },
      el('strong', {}, 'Web kiosk'),
      el('span', { class: 'meta' }, 'When nobody is using it, this screen plays its playlist. A touch opens this web page, fresh for each customer.'),
      el('label', { class: 'field' }, 'Web address', kioskUrl),
      el('label', { class: 'field' }, 'Back to the playlist after (seconds untouched)', kioskIdle),
      el('label', { class: 'field' }, 'Other websites customers may open', kioskHosts,
        el('span', { class: 'meta' }, 'Pages on the web address’s own site always work. Links to any other site are blocked unless listed here.')),
      el('label', { class: 'field' }, 'Staff PIN', kioskPin,
        el('span', { class: 'meta' }, 'To leave the kiosk on the PC: tap the top-left corner 5 times quickly, then type the PIN.')),
      b.has_pin ? el('label', { class: 'row', style: 'gap:8px' }, kioskNoPin, 'Remove the staff PIN') : null);
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), location: location.value || null, ...mountingBody(mounting), playlist_id: playlistId, ...(isBrowser ? browserBody() : {}) };
        if (isBrowser && !body.kiosk_url) return toast('Type the web address customers should see');
        if (!body.name) return toast('Give the screen a name');
        if (!body.location) return toast('Choose a location for this screen');
        if (body.location === '__new' && !newLocation.value.trim()) return toast('Type the new location’s name');
        if (body.location === '__new') {
          const created = await attempt(() => api('POST', 'api/locations', { name: newLocation.value.trim() }));
          if (!created) return;
          body.location = created.name;
          refreshNavLocations();
        }
        const ok = await attempt(() => (device
          ? api('PATCH', `api/devices/${device.id}`, body)
          : api('POST', 'api/devices/claim', { ...body, code })));
        if (!ok) return;
        dialog.close();
        toast(device ? `${body.name} updated` : `${body.name} added. It starts playing once its files are downloaded.`);
        onDone();
      },
    },
    el('h2', {}, device ? (isBrowser ? 'Edit web kiosk' : 'Edit screen') : `Set up ${isBrowser ? 'web kiosk' : 'screen'} ${code.slice(0, 3)}-${code.slice(3)}`),
    el('label', { class: 'field' }, 'Name', name),
    el('label', { class: 'field' }, 'Location', location, newLocation),
    el('div', { class: 'field' }, el('strong', {}, 'How the screen is mounted'), mountChoices,
      el('span', { class: 'meta' }, kind === 'browser'
        ? 'This picks its Landscape or Portrait playlist. Turn a Windows screen in Windows itself: Settings → System → Display → Display orientation.'
        : 'Pick the way the top of the picture should point. Kiosk Player turns the picture to match, because TV boxes always send a landscape picture.')),
    el('div', { class: 'field' }, el('strong', {}, 'Playlist'), playlistChoices, extraHint),
    warning,
    browserFields,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, device ? 'Save' : 'Add screen')));
    return form;
  });
}

// ---------- Locations: where screens are, and their working hours ----------

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

async function pageLocations(page) {
  async function draw() {
    const [data, playlists, devices] = await Promise.all([api('GET', 'api/locations'), api('GET', 'api/playlists'), api('GET', 'api/devices')]);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Locations'),
          el('p', { class: 'sub' }, 'Each location has its own Landscape and Portrait playlist, its working hours and its screens.')),
        el('button', { class: 'btn primary', onclick: () => addLocationDialog(data, () => draw()) }, '+ Add location')),
      data.locations.length === 0
        ? el('div', { class: 'empty' }, 'No locations yet. Add one, e.g. “Main lobby”. It gets a Landscape and a Portrait playlist, and you can put screens in it.')
        : data.locations.map((loc) => {
          const here = devices.filter((d) => d.location_id === loc.id);
          return el('section', { class: 'site-block' },
            el('div', { class: 'loc-head' },
              el('h2', {}, el('a', { href: `#/locations/${loc.id}` }, loc.name)),
              el('div', { class: 'row' },
                el('span', { class: 'meta row nowrap', style: 'gap:6px' }, icon('clock', 14), el('span', {}, loc.hours_summary)),
                el('span', { class: 'chip primary' }, `${here.length} screen${here.length === 1 ? '' : 's'}`),
                el('button', { class: 'btn text small', onclick: () => hoursDialog(loc, draw) }, 'Edit hours'),
                el('a', { class: 'btn text small', href: `#/locations/${loc.id}` }, 'Manage'))),
            locationPlaylists(loc, playlists),
            el('div', { class: 'section-label' }, 'Screens'),
            here.length === 0
              ? el('div', { class: 'empty' }, 'No screens here yet. Choose this location when adding a screen, or move one here.')
              : el('div', { class: 'list' }, here.map((d) => screenRow(d, playlists, devices, draw))));
        }),
      olderPlaylists(playlists),
    );
    refreshNavLocations(); // the counts in the menu follow what was just added or moved
  }
  await attempt(draw);
  pageTimer = setInterval(() => { if (!document.querySelector('dialog[open]')) attempt(draw); }, 15000);
}

/** One screen as a row on the Locations page: its name, how it is mounted, what it plays, and whether it is on. */
function screenRow(d, playlists, devices, redraw) {
  const mount = MOUNTINGS[mountingOf(d)] || MOUNTINGS.landscape;
  return el('div', { class: 'list-row' },
    el('div', { class: 'grow' }, el('div', { class: 'name' }, d.name || 'Unnamed'),
      el('div', { class: 'meta' }, `${mount.label} · plays ${d.playlist_name || 'nothing yet'}`)),
    d.open_now === false
      ? el('span', { class: 'chip offline' }, icon('clock', 12), 'After hours')
      : el('span', { class: `chip ${d.online ? 'online' : 'offline'}` }, el('span', { class: 'dot' }), d.online ? 'Online' : `Offline · ${timeAgo(d.last_seen)}`),
    el('button', { class: 'btn text small', onclick: () => screenForm({ device: d, site: d.site, playlists, devices, onDone: redraw }) }, 'Edit'));
}

/** One playlist as a card that opens it. */
function playlistCard(p) {
  return el('a', {
    class: 'card', href: `#/playlists/${p.id}`, style: 'text-decoration:none;color:inherit;display:flex;gap:14px;align-items:center',
  },
  el('span', { style: 'color:var(--primary);width:36px;display:grid;place-items:center' }, shapeIcon(p.orientation, 30)),
  el('div', { class: 'grow' },
    el('div', { class: 'name', style: 'font-size:17px' }, p.name, p.auto ? el('span', { class: 'chip', style: 'margin-left:8px' }, 'Automatic') : null),
    el('div', { class: 'meta' }, `${SHAPES[p.orientation]} · ${p.item_count} item${p.item_count === 1 ? '' : 's'}`),
    el('div', { class: 'meta' }, p.devices.length ? `Plays on ${p.devices.map((d) => d.name).join(', ')}` : 'Not playing on any screen yet')));
}

/** A location's playlists: its automatic Landscape and Portrait, then any extras, and a button to add one. */
function locationPlaylists(loc, playlists) {
  const mine = playlists.filter((p) => p.location_id === loc.id);
  return [
    el('div', { class: 'section-label row group-head' }, 'Playlists',
      el('button', {
        class: 'btn text small', type: 'button',
        onclick: () => playlistForm({ location: loc, onSaved: (p) => { location.hash = `#/playlists/${p.id}`; } }),
      }, '+ Extra playlist')),
    el('div', { class: 'grid' }, mine.map(playlistCard)),
  ];
}

/** Playlists that belong to no location (from older versions, or left by a deleted location). */
function olderPlaylists(playlists) {
  const old = playlists.filter((p) => p.unassigned);
  if (!old.length) return null;
  return el('section', { class: 'site-block' },
    el('div', { class: 'loc-head' }, el('h2', {}, 'Playlists without a location')),
    el('p', { class: 'meta', style: 'margin:8px 4px 10px' }, 'No screen plays these. Open one to move it to a location or delete it.'),
    el('div', { class: 'grid' }, old.map(playlistCard)));
}

function addLocationDialog(data, onAdded) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', placeholder: 'e.g. Main lobby', maxLength: 60 });
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const added = await attempt(() => api('POST', 'api/locations', { name: name.value.trim() }));
        if (!added) return;
        dialog.close();
        toast(`${added.name} added`);
        refreshNavLocations();
        onAdded(added);
      },
    },
    el('h2', {}, 'Add a location'),
    el('label', { class: 'field' }, 'Name', name),
    el('p', { class: 'meta', style: 'margin:0' }, 'It gets a Landscape and a Portrait playlist of its own.'),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Add location')));
    setTimeout(() => name.focus());
    return form;
  });
}

async function pageLocation(page, id) {
  async function draw() {
    const [loc, devices, playlists] = await Promise.all([api('GET', `api/locations/${id}`), api('GET', 'api/devices'), api('GET', 'api/playlists')]);
    const here = devices.filter((d) => d.location_id === loc.id);
    // Screens in other locations (or in none yet) can be moved here.
    const others = devices.filter((d) => d.location_id !== loc.id);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {},
          el('a', { href: '#/locations', class: 'meta' }, '← Locations'),
          el('h1', {}, loc.name),
          el('p', { class: 'sub row', style: 'gap:6px' }, icon('clock', 16), loc.hours_summary)),
        el('div', { class: 'row' },
          el('button', { class: 'btn tonal', onclick: () => hoursDialog(loc, draw) }, icon('clock', 18), 'Working hours'),
          el('button', { class: 'btn', onclick: () => renameLocationDialog(loc, draw) }, 'Rename'),
          el('button', { class: 'btn danger', onclick: () => deleteLocationDialog(loc, here) }, 'Delete location'))),
      locationPlaylists(loc, playlists),
      el('div', { class: 'row', style: 'justify-content:space-between;margin-top:24px' },
        el('div', { class: 'section-label', style: 'margin:0 4px' }, `Screens here · ${here.length}`),
        others.length ? el('button', { class: 'btn small', onclick: () => moveScreensDialog(loc, others, draw) }, '+ Move a screen here') : null),
      here.length === 0
        ? el('div', { class: 'empty', style: 'margin-top:10px' }, 'No screens here yet. Move one here, or choose this location when adding a screen.')
        : el('div', { class: 'grid', style: 'margin-top:10px' }, here.map((d) => screenCard(d, playlists, devices, draw))),
    );
  }
  await attempt(draw);
  pageTimer = setInterval(() => attempt(draw), 10000);
}

/** Opening times for each day, or "Always on". */
function hoursDialog(loc, onSaved) {
  openDialog((dialog) => {
    const rows = DAYS.map(([key, label]) => {
      const entry = loc.hours ? loc.hours[key] : { open: '08:00', close: '18:00' };
      const open = el('input', { type: 'checkbox', checked: Boolean(entry), 'aria-label': `Open on ${label}` });
      const from = el('input', { type: 'time', class: 'date-input', value: entry?.open || '08:00', 'aria-label': `${label} opening time` });
      const to = el('input', { type: 'time', class: 'date-input', value: entry?.close || '18:00', 'aria-label': `${label} closing time` });
      const sync = () => { from.disabled = !open.checked; to.disabled = !open.checked; };
      open.addEventListener('change', sync);
      sync();
      return { key, open, from, to, row: el('div', { class: 'hours-row' }, el('label', { class: 'row', style: 'gap:8px;font-weight:600' }, open, label), from, el('span', { class: 'meta' }, 'to'), to) };
    });
    const preset = (days, from, to) => rows.forEach((r) => {
      r.open.checked = days.includes(r.key);
      r.from.value = from;
      r.to.value = to;
      r.open.dispatchEvent(new Event('change'));
    });
    const save = async (hours) => {
      const saved = await attempt(() => api('PATCH', `api/locations/${loc.id}`, { hours }));
      if (!saved) return;
      dialog.close();
      toast(`${loc.name}: ${saved.hours_summary}`);
      onSaved();
    };
    return el('form', {
      method: 'dialog',
      onsubmit: (e) => {
        e.preventDefault();
        save(Object.fromEntries(rows.map((r) => [r.key, r.open.checked ? { open: r.from.value, close: r.to.value } : null])));
      },
    },
    el('h2', {}, `Working hours · ${loc.name}`),
    el('p', { class: 'sub' }, 'Outside these hours the screens here go dark (and into standby where the TV allows it). Times are each TV’s local time. A closing time earlier than the opening time runs past midnight.'),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn small', onclick: () => preset(['mon', 'tue', 'wed', 'thu', 'fri'], '09:00', '18:00') }, 'Mon–Fri 9–6'),
      el('button', { type: 'button', class: 'btn small', onclick: () => preset(DAYS.map(([k]) => k), '10:00', '22:00') }, 'Every day 10–10')),
    el('div', { class: 'hours-grid' }, rows.map((r) => r.row)),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn', onclick: () => save(null) }, 'Always on'),
      el('button', { class: 'btn primary' }, 'Save hours')));
  });
}

function renameLocationDialog(loc, onDone) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', value: loc.name, maxLength: 60 });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const saved = await attempt(() => api('PATCH', `api/locations/${loc.id}`, { name: name.value.trim() }));
        if (!saved) return;
        dialog.close();
        refreshNavLocations();
        onDone();
      },
    },
    el('h2', {}, 'Rename location'),
    el('label', { class: 'field' }, 'Name', name),
    el('p', { class: 'meta' }, 'Its screens move along with it.'),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Save')));
  });
}

/** Deleting asks for the location's name to be typed, and only works once it's empty. */
function deleteLocationDialog(loc, screens) {
  openDialog((dialog) => {
    if (screens.length) {
      return el('div', { class: 'dialog-body' },
        el('h2', {}, `${loc.name} still has screens`),
        el('p', { class: 'sub' }, 'Move these screens to another location first (Edit on each screen), then delete it:'),
        el('ul', {}, screens.map((d) => el('li', {}, d.name))),
        el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => dialog.close() }, 'OK')));
    }
    const typed = el('input', { type: 'text', autocomplete: 'off', placeholder: loc.name, 'aria-label': `Type ${loc.name} to confirm` });
    const go = el('button', { class: 'btn danger solid', disabled: true }, 'Delete location');
    typed.addEventListener('input', () => { go.disabled = typed.value !== loc.name; });
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        if (typed.value !== loc.name) return;
        const ok = await attempt(() => api('DELETE', `api/locations/${loc.id}`, { confirm_name: typed.value }));
        if (!ok) return;
        dialog.close();
        toast(`${loc.name} deleted`);
        refreshNavLocations();
        location.hash = '#/locations';
      },
    },
    el('h2', {}, `Delete ${loc.name}?`),
    el('p', { class: 'sub' }, 'Its working hours are deleted too. This can’t be undone.'),
    el('label', { class: 'field' }, el('span', {}, 'Type ', el('strong', {}, loc.name), ' to confirm'), typed),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      go));
    setTimeout(() => typed.focus());
    return form;
  });
}

function moveScreensDialog(loc, others, onDone) {
  openDialog((dialog) => el('div', { class: 'dialog-body' },
    el('h2', {}, `Move a screen to ${loc.name}`),
    el('p', { class: 'sub' }, 'It then plays this location’s Landscape or Portrait playlist, and follows its working hours. A screen pinned to an extra playlist keeps that.'),
    el('div', { class: 'list', style: 'max-height:50vh;overflow:auto' }, others.map((d) => el('div', { class: 'list-row' },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, d.name), el('div', { class: 'meta' }, d.location ? `Now in ${d.location}` : 'No location yet')),
      el('button', {
        class: 'btn tonal small',
        onclick: (e) => attempt(async () => {
          await api('PATCH', `api/devices/${d.id}`, { location: loc.name });
          e.target.closest('.list-row').remove();
          toast(`${d.name} moved to ${loc.name}`);
          refreshNavLocations();
          onDone();
        }),
      }, 'Move here')))),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => dialog.close() }, 'Done'))));
}

// ---------- Library ----------

async function pageLibrary(page) {
  const listArea = el('div');
  const status = el('span', { class: 'meta' });
  let library = null;
  let showRemoved = false;

  function draw() {
    const items = library.items;
    const removed = library.removed || [];
    status.textContent = library.sync_error || `Google Drive · synced ${timeAgo(library.synced_at)}`;
    status.className = library.sync_error ? 'warn' : 'meta';
    const groups = [
      ['Checking shape', items.filter((m) => !m.orientation)],
      ['Landscape files', items.filter((m) => m.orientation === 'landscape')],
      ['Portrait files', items.filter((m) => m.orientation === 'portrait')],
    ].filter(([, list]) => list.length);
    fill(listArea,
      groups.length === 0 ? el('div', { class: 'empty', style: 'margin-top:20px' }, 'No files yet. Add them to the Signage folder in Google Drive, then press Sync with Drive.') : null,
      groups.map(([title, list]) => [
        el('div', { class: 'section-label' }, `${title} · ${list.length}`),
        el('div', { class: 'list' }, list.map((m) => el('div', { class: 'list-row' },
          thumb(m.type, m.orientation),
          el('div', { class: 'grow' }, el('div', { class: 'name' }, m.filename),
            el('div', { class: 'meta row', style: 'gap:8px' }, mediaMeta(m), scheduleChips(m)),
            m.playback_warning ? el('div', { class: 'error' }, m.playback_warning) : null),
          el('button', {
            class: 'btn icon', 'aria-label': `Set when ${m.filename} shows`, title: 'Show from / until',
            onclick: () => scheduleDialog({
              title: `When should ${m.filename} show?`,
              text: 'Choose the first and last day it plays on screens. Leave either empty for no limit.',
              startsAt: m.starts_at,
              expiresAt: m.expires_at,
              onSave: async (startsAt, expiresAt) => {
                await api('PATCH', `api/media/${m.id}`, { starts_at: startsAt, expires_at: expiresAt });
                toast(startsAt || expiresAt ? `${m.filename}: dates saved` : `${m.filename} shows with no date limits`);
                await load();
                return true;
              },
            }),
          }, icon('calendar')),
          el('button', {
            class: 'btn icon', 'aria-label': `Remove ${m.filename} from Kiosk`, title: 'Remove from Kiosk',
            onclick: () => confirmDialog(`Remove ${m.filename} from Kiosk?`, 'It leaves the library, every playlist and every screen. It stays in Google Drive, and you can restore it from “Expired and removed”.', 'Remove',
              () => attempt(async () => { await api('DELETE', `api/media/${m.id}`); toast(`${m.filename} removed from Kiosk. Google Drive still has it.`); await load(); })),
          }, icon('trash'))))),
      ]),
      removed.length ? el('div', { class: 'removed' },
        el('button', {
          class: 'btn text small', 'aria-expanded': String(showRemoved),
          onclick: () => { showRemoved = !showRemoved; draw(); },
        }, `${showRemoved ? '▾' : '▸'} Expired and removed · ${removed.length}`),
        showRemoved ? [
          el('p', { class: 'meta', style: 'margin:4px 4px 8px' }, 'These are still in Google Drive, but not in Kiosk. Restore one to use it again.'),
          el('div', { class: 'list' }, removed.map((m) => el('div', { class: 'list-row' },
            thumb(m.type, m.orientation),
            el('div', { class: 'grow' }, el('div', { class: 'name' }, m.filename),
              el('div', { class: 'meta' }, `${m.removed_reason === 'expired' ? 'Expired' : 'Removed'} ${shortDate(m.removed_at)} · ${mediaMeta(m)}`)),
            el('button', {
              class: 'btn tonal small',
              onclick: () => scheduleDialog({
                title: `Restore ${m.filename}`,
                text: 'It comes back to the library. Add it to playlists again to show it on screens.',
                saveLabel: 'Restore',
                onSave: async (startsAt, expiresAt) => {
                  await api('POST', `api/media/${m.id}/restore`, { starts_at: startsAt, expires_at: expiresAt });
                  toast(`${m.filename} is back in the library`);
                  await load();
                  return true;
                },
              }),
            }, 'Restore')))),
        ] : null) : null,
    );
  }

  async function load(sync = false) {
    library = await api(sync ? 'POST' : 'GET', sync ? 'api/media/sync' : 'api/media');
    draw();
  }

  // Files come from Google Drive only: this card says where to put them.
  const howTo = el('div', { class: 'card' },
    el('strong', {}, 'Add files in Google Drive'),
    el('div', { class: 'meta' }, 'Put .mp4 videos (up to 4K) and .jpg, .png, .webp pictures in the Signage folder in Google Drive, then press Sync with Drive. Kiosk also checks the folder by itself every 5 minutes.'));

  fill(page,
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Library'), el('p', { class: 'sub' }, status)),
      el('button', { class: 'btn', onclick: () => attempt(async () => { await load(true); toast('Library is up to date'); }) }, icon('refresh', 18), 'Sync with Drive')),
    howTo, listArea,
  );
  await attempt(() => load());
  // While a file's shape is still being checked, look again every few seconds.
  pageTimer = setInterval(() => { if (library?.items.some((m) => !m.orientation)) attempt(() => load()); }, 5000);
}

// ---------- Playlists ----------

async function pagePlaylists(page) {
  async function draw() {
    const playlists = await api('GET', 'api/playlists');
    // Every location has its automatic two, so the list of playlists names every location.
    const locations = [];
    for (const p of playlists) if (p.location_id && !locations.some((l) => l.id === p.location_id)) locations.push({ id: p.location_id, name: p.location });
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Playlists'), el('p', { class: 'sub' }, 'Each location has a Landscape and a Portrait playlist that its screens play by themselves.'))),
      locations.length === 0 ? el('div', { class: 'empty' }, 'No locations yet. Someone who manages screens adds them; each one then gets its playlists.') : null,
      locations.map((loc) => el('section', { class: 'site-block' },
        el('div', { class: 'loc-head' }, el('h2', {}, loc.name)),
        locationPlaylists(loc, playlists))),
      olderPlaylists(playlists),
    );
  }
  await attempt(draw);
}

/** New playlist, or name/shape/delete for an existing one. */
async function playlistForm({ playlist, location: forLocation = null, onSaved, onDeleted }) {
  // A playlist without a location can be moved to one here. The list of playlists names every location.
  let places = null;
  if (playlist?.unassigned) {
    const all = await attempt(() => api('GET', 'api/playlists'));
    if (!all) return;
    places = [];
    for (const p of all) if (p.location_id && !places.some((l) => l.id === p.location_id)) places.push({ id: p.location_id, name: p.location });
  }
  openDialog((dialog) => {
    const moveTo = places
      ? el('select', {}, el('option', { value: '' }, 'Leave it without a location'),
        places.map((l) => el('option', { value: String(l.id) }, l.name)))
      : null;
    const name = el('input', { type: 'text', value: playlist?.name || '', placeholder: 'e.g. Menu boards' });
    let shape = playlist?.orientation || 'landscape';
    const problem = el('div', { class: 'error' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return toast('Give the playlist a name');
        const body = { name: name.value.trim(), orientation: shape };
        if (!playlist) body.location_id = forLocation.id;
        if (moveTo && moveTo.value) body.location_id = Number(moveTo.value);
        const saved = await attempt(() => (playlist ? api('PATCH', `api/playlists/${playlist.id}`, body) : api('POST', 'api/playlists', body)));
        if (!saved) return;
        dialog.close();
        toast(playlist ? 'Playlist updated' : `${saved.name} created. Add files, then save.`);
        onSaved?.(saved);
      },
    },
    el('h2', {}, playlist ? 'Playlist settings' : `Extra playlist for ${forLocation.name}`),
    playlist ? null : el('p', { class: 'meta', style: 'margin:0' }, 'Screens don’t play an extra playlist by themselves. After making it, edit a screen and choose it there.'),
    el('label', { class: 'field' }, 'Playlist name', name),
    moveTo ? el('label', { class: 'field' }, 'Location', moveTo) : null,
    el('div', { class: 'field' }, el('strong', {}, 'Made for'),
      el('div', { class: 'choices' }, Object.entries(SHAPES).map(([key, label]) => el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'shape', checked: shape === key, onchange: () => { shape = key; } }),
        el('span', {}, shapeIcon(key, 26), ' ', label, el('br'), el('span', { class: 'meta' }, key === 'landscape' ? 'Wide screens' : 'Screens on their side')))))),
    playlist ? el('div', {},
      el('button', {
        type: 'button', class: 'btn danger small', style: 'padding:0',
        onclick: async () => {
          try {
            await api('DELETE', `api/playlists/${playlist.id}`);
            dialog.close();
            toast('Playlist deleted');
            onDeleted?.();
          } catch (err) { problem.textContent = err.message; }
        },
      }, 'Delete this playlist'), problem) : null,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, playlist ? 'Save' : 'Create')));
  });
}

async function pagePlaylist(page, id) {
  let detail;
  let library;
  let items = [];
  let dragFrom = null;

  const sameAsSaved = () => JSON.stringify(items.map((i) => [i.media_id, i.image_seconds, i.start_at, i.end_at, i.schedule_enabled])) ===
    JSON.stringify(detail.items.map((i) => [i.media_id, i.image_seconds, i.start_at, i.end_at, i.start_at != null || i.end_at != null]));
  const validSchedules = () => items.every((i) =>
    !i.schedule_enabled || (i.start_at != null && i.end_at != null && i.start_at < i.end_at)
  );
  const dateValue = (timestamp) => {
    if (timestamp == null) return '';
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const startTimestamp = (value) => value ? new Date(`${value}T00:00:00`).getTime() : null;
  const endTimestamp = (value) => {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    date.setDate(date.getDate() + 1);
    return date.getTime();
  };

  function move(from, to) {
    if (to < 0 || to >= items.length || from === to) return;
    const [row] = items.splice(from, 1);
    items.splice(to, 0, row);
    draw();
  }

  function draw() {
    const mismatch = (it) => it.orientation && it.orientation !== detail.orientation;
    fill(page, 
      el('div', { class: 'page-head' },
        el('div', {},
          el('a', { href: playlistsHome(), class: 'meta' }, me.role === 'content_uploader' ? '← Playlists' : '← Locations'),
          el('h1', {}, detail.unassigned ? detail.name : `${detail.location} · ${detail.name}`),
          el('p', { class: 'sub row' },
            el('span', { class: 'chip primary' }, shapeIcon(detail.orientation, 14), `${SHAPES[detail.orientation]} screens`),
            detail.auto ? el('span', { class: 'chip' }, 'Automatic') : null,
            `${items.length} item${items.length === 1 ? '' : 's'} · loops forever · `,
            detail.devices.length ? `Plays on ${detail.devices.map((d) => d.name).join(', ')}` : 'Not playing on any screen yet')),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: addFromLibrary }, '+ Add from library'),
          // The automatic two have nothing to set: their name and shape are fixed, and they can't be deleted.
          detail.auto ? null : el('button', { class: 'btn text', onclick: () => playlistForm({ playlist: detail, onSaved: () => load(), onDeleted: () => { location.hash = playlistsHome(); } }) }, 'Playlist settings'))),
      items.length === 0
        ? el('div', { class: 'empty' }, 'This playlist is empty. Its screens show “Waiting for content” until you add something and save.')
        : el('div', { class: 'list' }, items.map((it, i) => {
          const row = el('div', {
            class: 'list-row pl-row', draggable: 'true',
            ondragstart: (e) => { dragFrom = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
            ondragend: () => { dragFrom = null; draw(); },
            ondragover: (e) => { e.preventDefault(); row.classList.add('drop-before'); },
            ondragleave: () => row.classList.remove('drop-before'),
            // Dropping on a row puts the dragged row in that row's place.
            ondrop: (e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); },
          },
          el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
          thumb(it.type, it.orientation, i + 1),
          el('div', { class: 'grow' },
            el('div', { class: 'name' }, it.filename),
            it.starts_at != null || it.expires_at != null ? el('div', { class: 'row', style: 'gap:6px' }, scheduleChips(it)) : null,
            mismatch(it) ? el('div', { class: 'warn' }, `${SHAPES[it.orientation]} file · plays with black bars here`) : null,
            it.type === 'video'
              ? el('div', { class: 'meta' }, 'Video · plays to the end')
              : el('label', { class: 'meta row' }, 'Show for',
                el('input', {
                  class: 'secs', type: 'number', min: 1, max: 120, value: it.image_seconds,
                  onchange: (e) => { it.image_seconds = Math.max(1, Math.min(120, Number(e.target.value) || 10)); draw(); },
                }), 'seconds'),
            el('label', { class: 'meta row' },
              el('input', {
                type: 'checkbox',
                checked: it.schedule_enabled,
                onchange: (e) => {
                  it.schedule_enabled = e.target.checked;
                  if (!it.schedule_enabled) { it.start_at = null; it.end_at = null; }
                  draw();
                },
              }),
              ' Schedule play dates'),
            it.schedule_enabled
              ? el('div', { class: 'meta row' },
                'From ',
                el('input', {
                  class: 'date-input', type: 'date', value: dateValue(it.start_at),
                  onchange: (e) => { it.start_at = startTimestamp(e.target.value); draw(); },
                }),
                ' through ',
                el('input', {
                  class: 'date-input', type: 'date', value: dateValue(it.end_at == null ? null : it.end_at - 1),
                  onchange: (e) => { it.end_at = endTimestamp(e.target.value); draw(); },
                }),
                ' · Dates use this device’s local timezone; the end date is included.')
              : null),
          el('button', { class: 'btn icon', 'aria-label': `Move ${it.filename} up`, disabled: i === 0, onclick: () => move(i, i - 1) }, icon('up')),
          el('button', { class: 'btn icon', 'aria-label': `Move ${it.filename} down`, disabled: i === items.length - 1, onclick: () => move(i, i + 1) }, icon('down')),
          el('button', { class: 'btn icon', 'aria-label': `Remove ${it.filename} from the playlist`, onclick: () => { items.splice(i, 1); draw(); } }, icon('trash')));
          return row;
        })),
      items.length > 1 ? el('p', { class: 'meta' }, 'Drag rows to reorder them, or use the arrow buttons.') : null,
      items.some((i) => i.schedule_enabled && (i.start_at == null || i.end_at == null))
        ? el('p', { class: 'warn' }, 'Choose both a start date and an end date for each scheduled file.')
        : items.some((i) => i.start_at != null && i.end_at != null && i.start_at >= i.end_at)
          ? el('p', { class: 'warn' }, 'A scheduled file’s end date must be on or after its start date.')
          : null,
      sameAsSaved() ? null : el('div', { class: 'save-bar' },
        el('span', { class: 'warn' }, '● Unsaved changes'),
        el('div', { class: 'row' },
          el('button', { class: 'btn text', onclick: () => { items = detail.items.map((x) => ({ ...x, schedule_enabled: x.start_at != null || x.end_at != null })); draw(); } }, 'Undo'),
          el('button', { class: 'btn primary', disabled: !validSchedules(), onclick: save }, 'Save playlist'))),
    );
  }

  async function save() {
    const saved = await attempt(() => api('PUT', `api/playlists/${id}/items`, {
      items: items.map((i) => ({ media_id: i.media_id, image_seconds: i.image_seconds, start_at: i.start_at, end_at: i.end_at })),
    }));
    if (!saved) return;
    detail = saved;
    items = detail.items.map((x) => ({ ...x, schedule_enabled: x.start_at != null || x.end_at != null }));
    draw();
    const n = detail.devices.length;
    toast(n ? `Saved. ${n} screen${n === 1 ? '' : 's'} update within a minute.` : 'Saved. No screens use this playlist yet.');
  }

  function addFromLibrary() {
    const inList = new Set(items.map((i) => i.media_id));
    const addable = library.items.filter((m) => !inList.has(m.id))
      .sort((a, b) => (a.orientation === detail.orientation ? 0 : 1) - (b.orientation === detail.orientation ? 0 : 1));
    openDialog((dialog) => el('div', { class: 'dialog-body' },
      el('h2', {}, `Add to ${detail.name}`),
      el('p', { class: 'sub' }, `${SHAPES[detail.orientation]} files are listed first.`),
      addable.length === 0 ? el('p', { class: 'meta' }, 'Everything in the library is already in this playlist.') : null,
      el('div', { class: 'list', style: 'max-height:50vh;overflow:auto' }, addable.map((m) => el('div', { class: 'list-row' },
        thumb(m.type, m.orientation),
        el('div', { class: 'grow' }, el('div', { class: 'name' }, m.filename), el('div', { class: 'meta row', style: 'gap:8px' }, mediaMeta(m), scheduleChips(m)),
          m.orientation && m.orientation !== detail.orientation ? el('div', { class: 'warn' }, `${SHAPES[m.orientation]} file · plays with black bars here`) : null),
        el('button', {
          class: 'btn tonal small',
          onclick: (e) => {
            items.push({ media_id: m.id, filename: m.filename, type: m.type, orientation: m.orientation, starts_at: m.starts_at, expires_at: m.expires_at, image_seconds: 10, start_at: null, end_at: null, schedule_enabled: false });
            e.target.closest('.list-row').remove();
            draw();
          },
        }, 'Add')))),
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => dialog.close() }, 'Done'))));
  }

  async function load() {
    [detail, library] = await Promise.all([api('GET', `api/playlists/${id}`), api('GET', 'api/media')]);
    items = detail.items.map((x) => ({ ...x, schedule_enabled: x.start_at != null || x.end_at != null }));
    draw();
  }
  await attempt(load);
}

// ---------- Users ----------

/** A password field with a "Show" switch, so a new password can be checked before saving. */
function passwordField(id, label, autocomplete = 'new-password') {
  const input = el('input', { type: 'password', id, autocomplete, minlength: 8, required: true });
  const show = el('button', {
    type: 'button', class: 'btn text small', 'aria-pressed': 'false',
    onclick: () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      show.textContent = hidden ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(hidden));
    },
  }, 'Show');
  return { input, field: el('label', { class: 'field', for: id }, el('span', { class: 'row', style: 'justify-content:space-between' }, label, show), input) };
}

/** Give someone a new password (Spongebob), signing them out everywhere. */
function resetPasswordDialog(user, onDone) {
  openDialog((dialog) => {
    const pw = passwordField('reset-password', 'New password');
    const problem = el('div', { class: 'error', role: 'alert' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('PATCH', `api/users/${user.id}`, { password: pw.input.value });
          dialog.close();
          toast(`${user.username} has a new password and was signed out everywhere`);
          onDone?.();
        } catch (err) { problem.textContent = err.message; }
      },
    },
    el('h2', {}, `New password for ${user.username}`),
    el('p', { class: 'meta', style: 'margin:0' }, 'At least 8 characters. Tell them the new password yourself; Kiosk doesn’t send it anywhere.'),
    pw.field, problem,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Set password')));
  });
}

/** Link (or unlink) the Google account that may sign in as this user on the public dashboard. */
function googleAccountDialog(user, onDone) {
  openDialog((dialog) => {
    const email = el('input', { type: 'email', id: 'google-email', value: user.google_email || '', placeholder: 'e.g. patrick@gmail.com', autocomplete: 'off', spellcheck: false });
    const problem = el('div', { class: 'error', role: 'alert' });
    const save = async (value) => {
      try {
        await api('PATCH', `api/users/${user.id}`, { google_email: value });
        dialog.close();
        toast(value ? `${user.username} can sign in with Google as ${value.toLowerCase()}` : `${user.username}’s Google account is unlinked`);
        onDone?.();
      } catch (err) { problem.textContent = err.message; }
    };
    return el('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); save(email.value.trim() || null); } },
      el('h2', {}, `Google account for ${user.username}`),
      el('p', { class: 'meta', style: 'margin:0' }, 'On the public dashboard address, people sign in with Google only. Signing in with this Google account gives this user’s role. Their username and password keep working at home and in the phone app.'),
      el('label', { class: 'field', for: 'google-email' }, 'Google account (email)', email),
      problem,
      el('div', { class: 'dialog-actions' },
        user.google_email ? el('button', { type: 'button', class: 'btn text danger', onclick: () => save(null) }, 'Unlink') : null,
        el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
        el('button', { class: 'btn primary' }, 'Save')));
  });
}

/** Change your own password. */
function changeMyPasswordDialog() {
  openDialog((dialog) => {
    const current = el('input', { type: 'password', id: 'my-current-password', autocomplete: 'current-password', required: true });
    const pw = passwordField('my-new-password', 'New password');
    const problem = el('div', { class: 'error', role: 'alert' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', 'api/auth/password', { current_password: current.value, new_password: pw.input.value });
          dialog.close();
          toast('Password changed. Your other devices were signed out.');
        } catch (err) { problem.textContent = err.message; }
      },
    },
    el('h2', {}, 'Change your password'),
    el('label', { class: 'field', for: 'my-current-password' }, 'Current password', current),
    pw.field, problem,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Change password')));
  });
}

async function pageUsers(page) {
  async function draw() {
    const users = await api('GET', 'api/users');
    const username = el('input', { type: 'text', id: 'new-username', placeholder: 'e.g. patrick', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, required: true });
    const pw = passwordField('new-user-password', 'Password');
    const role = el('select', { id: 'new-user-role' }, Object.entries(ROLES).map(([key, r]) => el('option', { value: key, selected: key === 'content_uploader' }, r.label)));
    const problem = el('div', { class: 'error', role: 'alert' });
    fill(page,
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Users'),
        el('p', { class: 'sub' }, 'Who may use the Kiosk Admin phone app and this web page. Each person signs in with a username and password you make here.'))),
      el('form', {
        class: 'card', style: 'display:flex;flex-direction:column;gap:12px',
        onsubmit: async (e) => {
          e.preventDefault();
          problem.textContent = '';
          try {
            const made = await api('POST', 'api/users', { username: username.value.trim(), role: role.value, password: pw.input.value });
            toast(`${made.username} can sign in now. Tell them their username and password.`);
            draw();
          } catch (err) { problem.textContent = err.message; }
        },
      },
      el('h2', {}, 'Add someone'),
      el('div', { class: 'user-form' },
        el('label', { class: 'field', for: 'new-username' }, 'Username', username),
        pw.field,
        el('label', { class: 'field', for: 'new-user-role' }, 'Role', role)),
      el('span', { class: 'meta' }, 'The password needs at least 8 characters. Kiosk keeps it scrambled and can’t show it again, so note it down for them.'),
      problem,
      el('div', {}, el('button', { class: 'btn primary' }, 'Add user'))),
      el('div', { class: 'section-label' }, `${users.length} ${users.length === 1 ? 'person' : 'people'}`),
      users.length === 0
        ? el('div', { class: 'empty' }, 'Nobody yet. Add the first person above; they can then sign in on the phone app.')
        : el('div', { class: 'list' }, users.map((u) => {
          const isMe = !me.via_home_assistant && u.username === me.username;
          return el('div', { class: 'list-row' },
            el('div', { class: 'grow' }, el('div', { class: 'name' }, u.username),
              el('div', { class: 'meta' }, isMe ? `You · ${ROLES[u.role].label}` : (u.has_password ? '' : 'No password yet: set one so they can sign in')),
              u.google_email ? el('div', { class: 'meta' }, `Google: ${u.google_email}`) : null),
            isMe ? null : el('select', {
              'aria-label': `Role for ${u.username}`,
              onchange: (e) => attempt(async () => { await api('PATCH', `api/users/${u.id}`, { role: e.target.value }); toast(`${u.username} is now ${ROLES[e.target.value].label}`); }),
            }, Object.entries(ROLES).map(([key, r]) => el('option', { value: key, selected: key === u.role }, r.label))),
            el('button', { class: 'btn text small', onclick: () => (isMe ? changeMyPasswordDialog() : resetPasswordDialog(u, draw)) }, isMe ? 'Change password' : 'New password'),
            el('button', { class: 'btn text small', onclick: () => googleAccountDialog(u, draw) }, u.google_email ? 'Google…' : 'Link Google'),
            isMe ? null : el('button', {
              class: 'btn icon', 'aria-label': `Remove ${u.username}`,
              onclick: () => confirmDialog(`Remove ${u.username}?`, 'They are signed out and can no longer sign in.', 'Remove',
                () => attempt(async () => { await api('DELETE', `api/users/${u.id}`); toast(`${u.username} can no longer sign in`); draw(); })),
            }, icon('trash')));
        })),
      el('div', { class: 'card', style: 'margin-top:20px' },
        el('h2', {}, 'What each role can do'),
        Object.values(ROLES).map((r) => el('div', {}, el('strong', {}, r.label), ` · ${r.desc}`))),
    );
  }
  await attempt(draw);
}

// ---------- Settings → Sound (0.11.0) ----------

/** One switch for every screen: videos play with or without sound. Playback copies follow it. */
function soundCard(s, redraw) {
  const sound = s.sound || { on: false, copies: { done: 0, total: 0 } };
  const copies = sound.copies || { done: 0, total: 0 };
  const remaking = s.transcode && s.transcode.active && copies.total > 0 && copies.done < copies.total;
  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
    el('h2', { class: 'row', style: 'gap:8px' }, icon(sound.on ? 'volume' : 'volume-off', 20), 'Sound'),
    el('p', { class: 'meta', style: 'margin:0' }, 'For every screen. With sound off, screens play videos silently whatever their TV’s volume is, and the playback copies are made without sound, so they’re a little smaller. Your files in Google Drive keep their sound.'),
    el('label', { class: 'row', style: 'font-weight:600;min-height:44px' },
      el('input', {
        type: 'checkbox', checked: sound.on, style: 'width:20px;height:20px;accent-color:var(--primary)',
        onchange: (e) => attempt(async () => {
          await api('PATCH', 'api/settings', { play_sound: e.target.checked });
          toast(e.target.checked ? 'Sound on for all screens' : 'Sound off for all screens');
          redraw();
        }),
      }),
      'Play videos with sound'),
    el('div', { class: 'row meta', role: 'status' },
      el('span', { class: 'dot', style: `width:10px;height:10px;border-radius:5px;background:${sound.on ? 'var(--accent)' : 'var(--success)'}` }),
      sound.on ? 'Screens play videos with sound, at their TV’s volume. Screens change within a minute.'
        : 'Every screen plays videos silently. Screens change within a minute.'),
    remaking ? el('div', { class: 'meta' }, sound.on
      ? `Remaking playback copies with sound: ${copies.done} of ${copies.total} done. Until a video’s new copy is ready, screens keep playing its silent one.`
      : `Taking the sound out of playback copies: ${copies.done} of ${copies.total} done. Screens are already silent meanwhile.`) : null);
}

// ---------- Settings → Public dashboard (0.8.0) ----------

const PUBLIC_STATES = {
  off: { chip: 'offline', label: 'Off', text: 'Switch on “Public dashboard” in the Kiosk add-on’s Configuration tab (in Home Assistant), with a Tailscale auth key, then restart the add-on.' },
  unavailable: { chip: 'offline', label: 'Not available', text: 'Available when Kiosk runs as the Home Assistant add-on.' },
  starting: { chip: 'attention', label: 'Starting', text: 'Tailscale is starting inside the add-on. This takes up to a minute.' },
  needs_key: { chip: 'attention', label: 'Needs a key', text: null },
  login_failed: { chip: 'offline', label: 'Key refused', text: null },
  https_not_enabled: { chip: 'attention', label: 'Needs HTTPS', text: null },
  funnel_not_allowed: { chip: 'attention', label: 'Needs Funnel', text: null },
  error: { chip: 'offline', label: 'Problem', text: null },
  on: { chip: 'online', label: 'On', text: null },
};

function publicDashboardCard(s, redraw) {
  const p = s.public_dashboard || { state: 'unavailable' };
  const st = PUBLIC_STATES[p.state] || PUBLIC_STATES.error;
  const clientId = el('input', { type: 'text', id: 'google-client-id', value: p.google_web_client_id || '', placeholder: '1234567890-abc123.apps.googleusercontent.com', style: 'font-family:monospace', spellcheck: false });
  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
      el('h2', { style: 'margin:0' }, 'Public dashboard'),
      el('span', { class: `chip ${st.chip}` }, st.label)),
    el('p', { class: 'meta', style: 'margin:0' }, 'This web page on the internet at its own https address, for people away from home and Tailscale. There, people sign in with a Google account you link to their user; passwords work only at home.'),
    p.state === 'on' && p.url
      ? el('p', { style: 'margin:0' }, 'Address: ', el('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.url))
      : el('p', { class: 'note', style: 'margin:0' }, p.message || st.text || ''),
    p.link ? el('a', { class: 'btn', href: p.link, target: '_blank', rel: 'noopener', style: 'align-self:flex-start' }, 'Open Tailscale to allow it') : null,
    el('label', { class: 'field', for: 'google-client-id' }, 'Google web client ID', clientId),
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      el('button', {
        class: 'btn primary',
        onclick: () => attempt(async () => {
          await api('PATCH', 'api/settings', { google_web_client_id: clientId.value.trim() || null });
          toast(clientId.value.trim() ? 'Google sign-in is set up' : 'Google sign-in is off');
          redraw();
        }),
      }, 'Save'),
      el('a', { class: 'btn text', href: '#/users' }, `Linked Google accounts: ${p.linked_users || 0}`)),
    el('p', { class: 'meta', style: 'margin:0' }, 'Step by step (Google client, Tailscale key and Funnel): see “Public dashboard” in the README on GitHub.'));
}

// ---------- Settings → Home Assistant Relays ----------

const RELAY_STATUS = {
  pending: { label: 'Waiting to pair', chip: 'attention' },
  active: { label: 'Paired', chip: 'online' },
  disabled: { label: 'Disabled', chip: 'offline' },
};

/** "in 9 min", for a pairing code's expiry. */
function minutesLeft(at) {
  const m = Math.max(0, Math.ceil((at - Date.now()) / 60000));
  return m <= 1 ? 'in under a minute' : `in ${m} min`;
}

async function pageRelays(page) {
  async function draw() {
    const [data, devices] = await Promise.all([api('GET', 'api/relays'), api('GET', 'api/devices')]);
    const unpaired = data.relays.filter((r) => r.status !== 'disabled' && !r.paired.proxy);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {},
          el('a', { href: '#/settings', class: 'meta' }, '← Settings'),
          el('h1', {}, 'Home Assistant Relays'),
          el('p', { class: 'sub' }, 'A relay is the Home Assistant at one of your other sites. Its TVs reach this main server through it. Each relay controls only the screens assigned to it.')),
        el('button', { class: 'btn primary', onclick: () => addRelayDialog(draw) }, '+ Add relay')),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:10px' },
        el('label', { class: 'row', style: 'font-weight:600;gap:10px' },
          el('input', {
            type: 'checkbox', checked: data.require_credentials, style: 'width:20px;height:20px;accent-color:var(--primary)',
            onchange: (e) => attempt(async () => {
              await api('PATCH', 'api/settings', { relays_require_credentials: e.target.checked });
              toast(e.target.checked ? 'Only paired relays are accepted now' : 'Unpaired relays are accepted again');
              draw();
            }),
          }),
          'Only accept relays that have paired'),
        el('p', { class: 'meta', style: 'margin:0' }, 'A paired relay proves who it is with its own credential. Relays set up before version 0.7.0 only give their site’s name, which anything on your network could copy. Switch this on once every relay is paired.'),
        unpaired.length && !data.require_credentials
          ? el('p', { class: 'note', style: 'margin:0' }, `Not paired yet: ${unpaired.map((r) => r.name).join(', ')}. Their screens would stop updating if you switched this on now.`)
          : null),

      data.relays.length === 0
        ? el('div', { class: 'empty' }, 'No relays yet. Add one for each Home Assistant at another site.')
        : el('div', { class: 'grid', style: 'margin-top:16px' }, data.relays.map((r) => relayCard(r, data.relays, devices, draw))),
    );
  }
  await attempt(draw);
  pageTimer = setInterval(() => { if (!document.querySelector('dialog[open]')) attempt(draw); }, 15000);
}

function relayCard(r, relays, devices, redraw) {
  const st = RELAY_STATUS[r.status] || RELAY_STATUS.pending;
  const piece = (paired, label) => el('div', { class: 'row', style: 'gap:6px' },
    el('span', { 'aria-hidden': 'true' }, paired ? '✓' : '○'), el('span', {}, `${label}: `), el('strong', {}, paired ? 'paired' : 'not paired'));
  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:10px' },
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
      el('div', {},
        el('strong', { style: 'font-size:18px' }, r.name),
        r.site === r.name ? null : el('div', { class: 'meta' }, `Site: ${r.site}`),
        r.description ? el('div', { class: 'meta' }, r.description) : null),
      el('span', { class: `chip ${st.chip}` }, st.label)),
    el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
      piece(r.paired.control, 'Home Assistant integration'),
      piece(r.paired.proxy, 'Kiosk add-on')),
    el('div', { class: 'meta' }, r.connected ? `Home Assistant connected now${r.last_version ? ` · version ${r.last_version}` : ''}`
      : r.last_seen_at ? `Last heard from ${timeAgo(r.last_seen_at)}${r.last_version ? ` · version ${r.last_version}` : ''}` : 'Never connected'),
    r.pairing ? el('div', { class: 'note', style: 'margin:0' },
      `A pairing code is waiting (it ends ${minutesLeft(r.pairing.expires_at)}). Used by: ${[r.pairing.control_done ? 'integration' : null, r.pairing.proxy_done ? 'add-on' : null].filter(Boolean).join(' and ') || 'nothing yet'}.`) : null,
    el('div', {},
      el('div', { class: 'section-label', style: 'margin:4px 0 6px' }, `Screens it controls · ${r.players.length}`),
      r.players.length
        ? el('div', { class: 'meta' }, r.players.map((p) => p.name || 'Unnamed').join(', '))
        : el('div', { class: 'meta' }, 'None yet. TVs that come in through this relay are added to it by themselves.')),
    el('div', { class: 'row', style: 'gap:6px' },
      r.status === 'disabled' ? null : el('button', { class: 'btn small primary', onclick: () => attempt(async () => {
        const made = await api('POST', `api/relays/${r.id}/pairing-code`);
        pairingCodeDialog(made.relay, made.pairing_code, made.expires_at, redraw);
      }) }, r.status === 'pending' ? 'Pairing code' : 'New pairing code'),
      el('button', { class: 'btn small', onclick: () => moveScreensToRelayDialog(r, relays, devices, redraw) }, 'Screens…'),
      el('button', { class: 'btn small', onclick: () => relayHistoryDialog(r) }, 'History'),
      el('button', { class: 'btn small', onclick: () => editRelayDialog(r, redraw) }, 'Edit'),
      r.status === 'disabled'
        ? el('button', { class: 'btn small', onclick: () => attempt(async () => { await api('PATCH', `api/relays/${r.id}`, { status: 'active' }); toast(`${r.name} enabled`); redraw(); }) }, 'Enable')
        : el('button', {
          class: 'btn small danger',
          onclick: () => confirmDialog(`Disable ${r.name}?`, 'Its Home Assistant and its add-on are refused straight away. Its TVs keep playing what they have, but get no updates until it’s enabled again.', 'Disable',
            () => attempt(async () => { await api('PATCH', `api/relays/${r.id}`, { status: 'disabled' }); toast(`${r.name} disabled`); redraw(); })),
        }, 'Disable'),
      r.connected ? el('button', {
        class: 'btn small',
        title: 'Give its Home Assistant integration a new credential over its live connection. The old one stops working once the new one is used.',
        onclick: () => confirmDialog(`New credential for ${r.name}?`, 'Its Home Assistant integration is handed a new credential over its live connection, and the old one stops working once the new one is in use. Nothing else changes.', 'Send new credential',
          () => attempt(async () => { await api('POST', `api/relays/${r.id}/rotate`, { kind: 'control' }); toast(`New credential sent to ${r.name}`); redraw(); })),
      }, 'New credential') : null,
      r.credentials.length ? el('button', { class: 'btn small danger', onclick: () => revokeDialog(r, redraw) }, 'Revoke…') : null,
      r.players.length ? null : el('button', { class: 'btn small danger', onclick: () => deleteRelayDialog(r, redraw) }, 'Delete')),
  );
}

function addRelayDialog(onDone) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', id: 'relay-name', placeholder: 'e.g. Qoltured', maxLength: 60, required: true });
    const site = el('input', { type: 'text', id: 'relay-site', placeholder: 'Same as the name', maxLength: 80 });
    const description = el('input', { type: 'text', id: 'relay-description', placeholder: 'e.g. Cafe, level 2', maxLength: 200 });
    const problem = el('div', { class: 'error', role: 'alert' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const made = await api('POST', 'api/relays', { name: name.value.trim(), site: site.value.trim() || undefined, description: description.value.trim() });
          dialog.close();
          pairingCodeDialog(made.relay, made.pairing_code, made.expires_at, onDone);
          onDone();
        } catch (err) { problem.textContent = err.message; }
      },
    },
    el('h2', {}, 'Add a relay'),
    el('label', { class: 'field', for: 'relay-name' }, 'Name', name),
    el('label', { class: 'field', for: 'relay-site' }, 'Site name (optional)', site),
    el('p', { class: 'meta', style: 'margin:0' }, 'If this relay was already running before, use the Site name from its add-on’s Configuration tab, so its screens stay with it.'),
    el('label', { class: 'field', for: 'relay-description' }, 'Description (optional)', description),
    problem,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Add and get pairing code')));
  });
}

/** Shows a pairing code once. It can't be shown again; a new one can be made. */
function pairingCodeDialog(relay, code, expiresAt, onDone) {
  openDialog((dialog) => {
    const left = el('span', {}, minutesLeft(expiresAt));
    const timer = setInterval(() => { left.textContent = minutesLeft(expiresAt); if (Date.now() > expiresAt) left.textContent = 'now. Make a new one'; }, 15000);
    dialog.addEventListener('close', () => { clearInterval(timer); onDone?.(); });
    return el('div', { class: 'dialog-body' },
      el('h2', {}, `Pair ${relay.name}`),
      el('p', { class: 'sub' }, 'Type this code on the relay’s Home Assistant, in both places below. It works once in each, and stops working ', left, '.'),
      el('div', { class: 'code', 'aria-label': `Pairing code ${code.split('').join(' ')}` }, code),
      el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(code).then(() => toast('Code copied')) }, 'Copy code'),
      el('ol', { style: 'margin:4px 0 0;padding-left:20px;display:flex;flex-direction:column;gap:6px' },
        el('li', {}, el('strong', {}, 'Kiosk Player integration: '), 'install it from HACS (custom repository hybrid87sg/kiosk-player-ha), then Settings → Devices & services → Add integration → Kiosk Player. Enter this main server’s address and the code.'),
        el('li', {}, el('strong', {}, 'Kiosk add-on (relay mode): '), 'its Configuration tab → Pairing code. Save and restart the add-on.')),
      el('p', { class: 'meta', style: 'margin:0' }, 'The code isn’t shown again; you can always make a new one.'),
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => dialog.close() }, 'Done')));
  });
}

function editRelayDialog(r, onDone) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', id: 'relay-edit-name', value: r.name, maxLength: 60, required: true });
    const description = el('input', { type: 'text', id: 'relay-edit-description', value: r.description || '', maxLength: 200 });
    const problem = el('div', { class: 'error', role: 'alert' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('PATCH', `api/relays/${r.id}`, { name: name.value.trim(), description: description.value.trim() });
          dialog.close();
          toast('Relay updated');
          onDone();
        } catch (err) { problem.textContent = err.message; }
      },
    },
    el('h2', {}, `Edit ${r.name}`),
    el('label', { class: 'field', for: 'relay-edit-name' }, 'Name', name),
    el('label', { class: 'field', for: 'relay-edit-description' }, 'Description', description),
    el('p', { class: 'meta', style: 'margin:0' }, `Site name: ${r.site}. It can’t be changed, because its screens are recorded under it.`),
    problem,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, 'Save')));
  });
}

function revokeDialog(r, onDone) {
  const labels = { control: 'Home Assistant integration', proxy: 'Kiosk add-on' };
  openDialog((dialog) => el('div', { class: 'dialog-body' },
    el('h2', {}, `Revoke a credential of ${r.name}`),
    el('p', { class: 'sub' }, 'A revoked credential stops working straight away. That piece of the relay then needs a new pairing code.'),
    el('div', { class: 'list' }, r.credentials.map((c) => el('div', { class: 'list-row' },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, labels[c.kind] || c.kind),
        el('div', { class: 'meta' }, `${c.id} · made ${timeAgo(c.created_at)}${c.last_used_at ? ` · last used ${timeAgo(c.last_used_at)}` : ''}`)),
      el('button', {
        class: 'btn small danger',
        onclick: () => attempt(async () => {
          await api('POST', `api/relays/${r.id}/credentials/${c.id}/revoke`);
          dialog.close();
          toast(`${labels[c.kind]} of ${r.name} revoked`);
          onDone();
        }),
      }, 'Revoke')))),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn text', onclick: () => dialog.close() }, 'Close'))));
}

function deleteRelayDialog(r, onDone) {
  openDialog((dialog) => {
    const typed = el('input', { type: 'text', id: 'relay-delete-name', autocomplete: 'off' });
    const go = el('button', { class: 'btn danger solid', disabled: true }, 'Delete relay');
    typed.addEventListener('input', () => { go.disabled = typed.value !== r.name; });
    const problem = el('div', { class: 'error', role: 'alert' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('DELETE', `api/relays/${r.id}`, { confirm_name: typed.value });
          dialog.close();
          toast(`${r.name} deleted`);
          onDone();
        } catch (err) { problem.textContent = err.message; }
      },
    },
    el('h2', {}, `Delete ${r.name}?`),
    el('p', { class: 'sub' }, 'Its credentials stop working and its history is kept. Type its name to delete it.'),
    el('label', { class: 'field', for: 'relay-delete-name' }, `Type ${r.name}`, typed),
    problem,
    el('div', { class: 'dialog-actions' }, el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'), go));
  });
}

/** Choose which relay controls each screen. */
function moveScreensToRelayDialog(r, relays, devices, onDone) {
  openDialog((dialog) => el('div', { class: 'dialog-body' },
    el('h2', {}, 'Which relay controls each screen'),
    el('p', { class: 'sub' }, 'A relay can only see and control its own screens. A screen with no relay is controlled from this main server only.'),
    el('div', { class: 'list', style: 'max-height:55vh;overflow:auto' }, devices.map((d) => el('div', { class: 'list-row' },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, d.name || 'Unnamed'), el('div', { class: 'meta' }, d.location || 'No location yet')),
      el('select', {
        'aria-label': `Relay for ${d.name}`,
        onchange: (e) => attempt(async () => {
          await api('PUT', `api/devices/${d.id}/relay`, { relay_id: e.target.value || null });
          toast(`${d.name}: ${e.target.selectedOptions[0].textContent}`);
        }),
      },
      el('option', { value: '', selected: !d.relay }, 'Main server only'),
      relays.map((x) => el('option', { value: x.id, selected: d.relay?.id === x.id }, x.name)))))),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => { dialog.close(); onDone(); } }, 'Done'))));
}

const RELAY_EVENT_TEXT = {
  created: 'Relay added',
  edited: 'Name or description changed',
  pairing_code_created: 'Pairing code made',
  paired: 'Paired',
  credential_revoked: 'Credential revoked',
  credential_rotated: 'Credential renewed by the relay',
  disabled: 'Disabled',
  enabled: 'Enabled',
  player_assigned: 'Screen assigned',
  player_unassigned: 'Screen moved away',
  player_seen_elsewhere: 'Screen showed up through another relay',
};

async function relayHistoryDialog(r) {
  const events = await attempt(() => api('GET', `api/relays/${r.id}/events?limit=100`));
  if (!events) return;
  const pieces = { control: 'integration', proxy: 'add-on' };
  const describe = (e) => {
    const d = e.detail || {};
    if (e.kind === 'paired') return `${pieces[d.kind] || d.kind}${d.client && d.client.version ? `, version ${d.client.version}` : ''}`;
    if (e.kind === 'credential_revoked') return d.reason || '';
    if (e.kind === 'player_seen_elsewhere') return d.via_name ? `via ${d.via_name}` : '';
    return '';
  };
  openDialog((dialog) => el('div', { class: 'dialog-body' },
    el('h2', {}, `${r.name}: history`),
    events.length === 0 ? el('p', { class: 'meta' }, 'Nothing yet.') : el('div', { class: 'list', style: 'max-height:60vh;overflow:auto' }, events.map((e) => el('div', { class: 'list-row' },
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, RELAY_EVENT_TEXT[e.kind] || e.kind, e.device_name ? `: ${e.device_name}` : ''),
        el('div', { class: 'meta' }, [describe(e), e.actor && e.actor.startsWith('user:') ? 'by an admin' : e.actor && e.actor.startsWith('relay:') ? 'by the relay' : ''].filter(Boolean).join(' · '))),
      el('span', { class: 'meta', title: new Date(e.created_at).toLocaleString() }, timeAgo(e.created_at))))),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn primary', onclick: () => dialog.close() }, 'Close'))));
}

// ---------- Settings ----------

// Settings → Google key. The key is the service account's .json file. It can be
// uploaded as a file or pasted as text; a switch picks which. The page only ever
// learns which service account the saved key belongs to, never the key itself.
function googleKeyCard(s, redraw) {
  const k = s.google_key || { present: false, email: null, can_change: false, added_here: false };
  const result = el('span', { class: 'meta', role: 'status' });
  const save = async (text) => {
    result.textContent = 'Saving…';
    result.className = 'meta';
    try {
      const saved = await api('PUT', 'api/settings/google-key', { key: text });
      toast(`Google key saved for ${saved.google_key.email}`);
      redraw();
    } catch (e) {
      result.textContent = e.message;
      result.className = 'error';
    }
  };

  const file = el('input', { type: 'file', accept: '.json,application/json', id: 'google-key-file' });
  const uploadPane = el('div', { class: 'key-pane' },
    el('label', { class: 'field', for: 'google-key-file' }, 'Key file (.json)', file),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const chosen = file.files && file.files[0];
          if (!chosen) { result.textContent = 'Choose the .json key file first.'; result.className = 'error'; return; }
          if (chosen.size > 20000) { result.textContent = 'That file is too big to be a key file.'; result.className = 'error'; return; }
          await save(await chosen.text());
        },
      }, 'Upload key')));

  const pasted = el('textarea', {
    id: 'google-key-text', rows: 6, spellcheck: false, autocomplete: 'off',
    placeholder: '{ "type": "service_account", … }', style: 'font-family:monospace;font-size:12px',
  });
  const pastePane = el('div', { class: 'key-pane', hidden: true },
    el('label', { class: 'field', for: 'google-key-text' }, 'Everything in the key file', pasted),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!pasted.value.trim()) { result.textContent = 'Paste the whole key file first.'; result.className = 'error'; return; }
          await save(pasted.value);
        },
      }, 'Save key')));

  let mode = 'upload';
  try { mode = localStorage.getItem('kiosk-key-mode') === 'paste' ? 'paste' : 'upload'; } catch { /* keeps the default */ }
  const tabs = {
    upload: el('button', { class: 'seg', type: 'button', role: 'tab', onclick: () => pick('upload') }, 'Upload the file'),
    paste: el('button', { class: 'seg', type: 'button', role: 'tab', onclick: () => pick('paste') }, 'Paste the text'),
  };
  function pick(next) {
    mode = next;
    try { localStorage.setItem('kiosk-key-mode', next); } catch { /* just not remembered */ }
    uploadPane.hidden = next !== 'upload';
    pastePane.hidden = next !== 'paste';
    for (const [name, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(name === next));
    result.textContent = '';
  }
  pick(mode);

  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' },
    el('h2', {}, 'Google key'),
    el('p', { class: 'meta', style: 'margin:0' }, 'The service account’s key file from Google Cloud Console. The server uses it to read your Drive folder. It works like a password: it stays on this server and is never shown again.'),
    k.present
      ? el('p', { style: 'margin:0' }, '✓ Key in use for ', el('strong', { style: 'word-break:break-all' }, k.email), '. Share your Drive folder with this address as Editor (Content manager on a shared drive).')
      : el('p', { class: 'warn', style: 'margin:0' }, 'No key yet. The library stays empty until you add one.'),
    k.can_change
      ? [
        el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'How to add the key' }, tabs.upload, tabs.paste),
        uploadPane, pastePane, result,
        k.added_here ? el('span', { class: 'meta' }, 'Added on this page; this is used instead of a key file in the add-on’s config folder.') : null,
      ]
      : el('span', { class: 'meta' }, 'On this server the key comes from its settings and can’t be changed here.'));
}

async function pageSettings(page) {
  async function draw() {
    const s = await api('GET', 'api/settings');
    const folder = el('input', { type: 'text', value: s.drive_folder_id || '', style: 'font-family:monospace' });
    const testResult = el('span', { class: 'meta' });
    // Home Assistant's notify services (phones with the Home Assistant app, the sidebar bell…).
    const notify = s.notifications.available
      ? await api('GET', 'api/settings/notify-targets').catch((e) => ({ error: e.message, targets: [] }))
      : null;
    const notifyResult = el('span', { class: 'meta' });
    const chosen = new Set(s.notifications.targets);
    fill(page,
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Settings'), el('p', { class: 'sub' }, `Kiosk server ${s.version}`))),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-bottom:16px' },
        el('h2', { class: 'row', style: 'gap:8px' }, icon('bell', 20), 'Notifications'),
        el('p', { class: 'meta', style: 'margin:0' }, 'Home Assistant tells the devices you tick when a screen has been offline for 5 minutes during its location’s working hours, and again when it’s back.'),
        !notify
          ? el('p', { class: 'note' }, 'Available when Kiosk runs as a Home Assistant add-on.')
          : notify.error
            ? el('p', { class: 'error' }, notify.error)
            : [
              notify.targets.length === 0
                ? el('p', { class: 'note' }, 'Home Assistant has no notify services yet. Install the Home Assistant app on your phone and sign in; it then appears here.')
                : el('div', { class: 'choices' }, notify.targets.map((t) => el('label', { class: 'choice' },
                  el('input', {
                    type: 'checkbox', checked: chosen.has(t.id),
                    onchange: (e) => attempt(async () => {
                      if (e.target.checked) chosen.add(t.id); else chosen.delete(t.id);
                      await api('PATCH', 'api/settings', { notify_targets: [...chosen] });
                      toast(chosen.size ? `Notifications go to ${chosen.size} device${chosen.size === 1 ? '' : 's'}` : 'Notifications are off');
                    }),
                  }),
                  el('span', {}, el('strong', {}, t.name), el('br'), el('span', { class: 'meta' }, `notify.${t.id}`))))),
              el('div', { class: 'row' },
                el('button', {
                  class: 'btn',
                  onclick: async () => {
                    notifyResult.textContent = 'Sending…';
                    try {
                      await api('POST', 'api/settings/test-notification');
                      notifyResult.textContent = '✓ Sent. Check your device.';
                      notifyResult.className = 'meta';
                    } catch (e) { notifyResult.textContent = e.message; notifyResult.className = 'error'; }
                  },
                }, 'Send a test notification'),
                notifyResult),
            ]),

      googleKeyCard(s, draw),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
        el('h2', {}, 'Google Drive folder'),
        el('p', { class: 'meta', style: 'margin:0' }, 'The shared drive (or folder) your videos and pictures come from. It’s the last part of its web address: drive.google.com/drive/folders/…'),
        el('label', { class: 'field' }, 'Drive folder ID', folder),
        s.drive_folder_changed_on_web ? el('span', { class: 'meta' }, 'Changed on this page; this overrides the add-on’s Configuration tab.') : null,
        el('div', { class: 'row' },
          el('button', {
            class: 'btn primary',
            onclick: () => confirmDialog('Use this Drive folder?', 'The library will show this folder’s files instead. Playlists lose files that aren’t in the new folder.', 'Use this folder',
              () => attempt(async () => { await api('PATCH', 'api/settings', { drive_folder_id: folder.value.trim() }); toast('Drive folder saved'); draw(); })),
          }, 'Save'),
          el('button', {
            class: 'btn',
            onclick: async () => {
              testResult.textContent = 'Checking…';
              try {
                const r = await api('POST', 'api/settings/test-drive');
                testResult.textContent = `✓ Connected · ${r.files} file${r.files === 1 ? '' : 's'} in the folder`;
                testResult.className = 'meta';
              } catch (e) { testResult.textContent = e.message; testResult.className = 'error'; }
            },
          }, 'Test connection'),
          testResult)),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
        el('h2', {}, 'Local copy of each file'),
        s.cache.available
          ? [
            el('label', { class: 'row', style: 'font-weight:600' },
              el('input', {
                type: 'checkbox', checked: s.cache.enabled, style: 'width:20px;height:20px;accent-color:var(--primary)',
                onchange: (e) => attempt(async () => { await api('PATCH', 'api/settings', { cache_media: e.target.checked }); toast(e.target.checked ? 'Local copies on' : 'Local copies off'); draw(); }),
              }),
              'Keep a local copy of each file on this server'),
            el('p', { class: 'meta', style: 'margin:0' }, 'Each file is downloaded from Google Drive once, then sent to every screen from here. Faster, and saves internet data.'),
            el('div', { class: 'row' }, el('span', {}, `${s.cache.files} file${s.cache.files === 1 ? '' : 's'} · ${formatBytes(s.cache.bytes)} used`),
              el('button', {
                class: 'btn small',
                onclick: () => confirmDialog('Clear local copies?', 'They are downloaded from Google Drive again as screens ask for them.', 'Clear',
                  () => attempt(async () => { await api('POST', 'api/settings/clear-cache'); toast('Local copies cleared'); draw(); })),
              }, 'Clear')),
          ]
          : el('p', { class: 'meta' }, 'Not available on this server.')),

      soundCard(s, draw),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
        el('h2', {}, 'Playback copies'),
        el('p', { class: 'meta', style: 'margin:0' }, 'Heavy 4K videos are hard for some TV boxes. The server can make a 1080p H.264 copy (and a smaller 720p one) after each video arrives. The original in Google Drive is left as it is. Copies follow the Sound setting above. Turn this off on a slow machine, such as a Raspberry Pi, if the add-on becomes unresponsive.'),
        el('label', { class: 'row', style: 'font-weight:600' },
          el('input', {
            type: 'checkbox', checked: s.transcode.enabled, style: 'width:20px;height:20px;accent-color:var(--primary)',
            onchange: (e) => attempt(async () => {
              await api('PATCH', 'api/settings', { transcode_videos: e.target.checked });
              toast(e.target.checked ? 'Playback copies on' : 'Playback copies off');
              draw();
            }),
          }),
          'Make a 1080p and a 720p copy of each video'),
        el('label', { class: 'row', style: 'font-weight:600' },
          el('input', {
            type: 'checkbox', checked: s.transcode.hevc_4k, disabled: !s.transcode.enabled, style: 'width:20px;height:20px;accent-color:var(--primary)',
            onchange: (e) => attempt(async () => {
              await api('PATCH', 'api/settings', { transcode_4k_hevc: e.target.checked });
              toast(e.target.checked ? '4K HEVC copies on' : '4K HEVC copies off');
              draw();
            }),
          }),
          'Also make a 4K HEVC copy for boxes that can play it'),
        s.transcode.ffmpeg ? null : el('p', { class: 'error', style: 'margin:0' }, 'ffmpeg is not installed on this server, so copies cannot be made.')),

      el('a', { class: 'card link-card', href: '#/relays', style: 'display:flex;gap:14px;align-items:center;margin-top:16px;text-decoration:none;color:inherit' },
        el('span', { style: 'color:var(--primary)' }, icon('relay', 26)),
        el('div', { class: 'grow' },
          el('h2', { style: 'margin:0' }, 'Home Assistant Relays'),
          el('div', { class: 'meta' }, s.relays_require_credentials
            ? 'The Home Assistants at your other sites. Only paired relays are accepted.'
            : 'The Home Assistants at your other sites: pair them, see if they’re connected, and choose which screens each one controls.')),
        el('span', { class: 'meta', 'aria-hidden': 'true' }, '›')),

      publicDashboardCard(s, draw),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px;margin-top:16px' },
        el('h2', {}, 'Signing in'),
        el('div', {}, `${s.users} ${s.users === 1 ? 'person has' : 'people have'} a username and password. `,
          el('a', { href: '#/users' }, 'Manage users')),
        el('div', { class: 'meta' }, 'The phone app and this web address (at home or over Tailscale) both ask for them. Opened from Home Assistant’s sidebar, this page needs no sign-in. On the public dashboard address, people sign in with a linked Google account instead.'),
        el('div', {}, '✓ ', el('strong', {}, 'Home Assistant sidebar'), ' · Home Assistant admins')),

      el('div', { class: 'card', style: 'margin-top:16px' },
        el('h2', {}, 'Library'),
        el('div', {}, `${s.library.files} file${s.library.files === 1 ? '' : 's'} · ${formatBytes(s.library.bytes)} in Google Drive`)),
    );
  }
  await attempt(draw);
}

boot();
