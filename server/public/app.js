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
// Playlists belong to a site. The server's own site has no name of its own unless one was set.
const siteLabel = (site, ownSite) => site || ownSite || 'This site';
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

function renderSignIn() {
  clearInterval(pageTimer);
  const box = el('div', { class: 'signin' },
    el('div', { class: 'brand-mark' }, icon('screens', 36)),
    el('h1', {}, 'Kiosk Signage'),
    el('p', { class: 'sub' }, 'Manage what plays on your screens.'));
  if (!config.web_code_sign_in) {
    box.append(el('div', { class: 'card' },
      el('p', {}, 'Signing in on this web address isn’t set up on this server yet.'),
      el('p', { class: 'sub' }, 'Open Kiosk Signage from Home Assistant’s sidebar instead, or ask your admin to add the Google “TVs and Limited Input devices” client in the add-on’s settings.')));
  } else {
    const area = el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px;align-items:center' });
    const start = el('button', { class: 'btn primary', onclick: () => startCodeSignIn(area) }, 'Sign in with Google');
    area.append(start, el('p', { class: 'meta' }, 'You’ll get a short code to enter at google.com/device, on this computer or your phone.'));
    box.append(area);
  }
  fill(app, box);
}

async function startCodeSignIn(area) {
  const started = await attempt(() => api('POST', 'api/auth/device/start'));
  if (!started) return;
  const status = el('p', { class: 'meta' }, 'Waiting for you to enter the code…');
  fill(area, 
    el('p', {}, 'Go to ', el('a', { href: started.verification_url, target: '_blank', rel: 'noopener' }, started.verification_url.replace(/^https?:\/\//, '')), ' and enter:'),
    el('div', { class: 'code' }, started.user_code),
    el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(started.user_code).then(() => toast('Code copied')) }, 'Copy code'),
    status,
  );
  const deadline = Date.now() + started.expires_in * 1000;
  let wait = started.interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    let result;
    try {
      result = await api('POST', 'api/auth/device/poll', { poll_id: started.poll_id });
    } catch (e) {
      status.textContent = e.message;
      area.append(el('button', { class: 'btn', onclick: () => startCodeSignIn(area) }, 'Try again'));
      return;
    }
    if (result.status === 'slow_down') wait += 5000;
    if (result.status === 'denied' || result.status === 'expired') {
      status.textContent = result.status === 'denied' ? 'Sign-in was cancelled.' : 'The code expired.';
      area.append(el('button', { class: 'btn', onclick: () => startCodeSignIn(area) }, 'Start again'));
      return;
    }
    if (result.status === 'done') {
      setToken(result.token);
      me = { email: result.email, role: result.role };
      renderShell();
      return;
    }
  }
  status.textContent = 'The code expired.';
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
    me.via_home_assistant ? null : el('div', {}, el('button', { class: 'btn text small', style: 'padding:0;margin-top:6px', onclick: signOut }, 'Sign out'))),
  );
  fill(app, el('div', { class: 'shell' }, nav, el('main', { id: 'page' })));
  refreshNavLocations();
  route();
}

/** Fills the Locations part of the menu: one link per location, under its site when there are several. */
async function refreshNavLocations() {
  const box = document.getElementById('nav-locations');
  if (!box) return;
  const data = await api('GET', 'api/locations').catch(() => null);
  if (!data) return;
  const sites = new Set(data.locations.map((l) => l.site || ''));
  const bySite = new Map();
  for (const l of data.locations) bySite.set(l.site || '', [...(bySite.get(l.site || '') || []), l]);
  fill(box, [...bySite.entries()].map(([site, list]) => [
    sites.size > 1 ? el('div', { class: 'nav-site' }, site || 'This site') : null,
    list.map((l) => el('a', { href: `#/locations/${l.id}`, 'data-loc': String(l.id), title: l.name },
      el('span', { class: 'label' }, l.name), el('span', { class: 'count' }, String(l.screens.length)))),
  ]));
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
  const allowed = [...tabsFor(me.role).map(([key]) => key), 'playlists'];
  const current = allowed.includes(section) ? section : allowed[0];
  // A playlist is opened from Locations, so that stays lit in the menu while it is open.
  const lit = current === 'playlists' && me.role !== 'content_uploader' ? 'locations' : current;
  document.querySelectorAll('.nav a[data-tab]').forEach((a) => {
    if (a.dataset.tab === lit && !(current === 'locations' && id)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  markCurrentNav();
  const page = document.getElementById('page');
  if (!page) return;
  fill(page, el('p', { class: 'loading' }, 'Loading…'));
  const pages = { screens: pageScreens, locations: pageLocations, library: pageLibrary, playlists: pagePlaylists, users: pageUsers, settings: pageSettings };
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
    // With TVs at more than one site, group by site first, then location.
    const sites = new Set([...devices, ...waiting].map((d) => d.site || ''));
    const manySites = sites.size > 1;
    const groups = new Map();
    for (const d of devices) {
      const loc = d.location || 'No location';
      const key = manySites ? `${d.site || 'This site'} › ${loc}` : loc;
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
        el('button', { class: 'btn primary', onclick: () => addScreenDialog(playlists, devices, draw) }, '+ Add by code')),
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
          el('div', { class: 'name' }, w.model || 'Android TV'),
          el('div', { class: 'meta' }, manySites && w.site ? `${w.site} · ` : '', 'Showing code ',
            el('strong', {}, pretty(w.pairing_code)), ' on its screen')),
        el('button', {
          class: 'btn primary small',
          onclick: () => screenForm({ code: w.pairing_code, site: w.site, playlists, devices, onDone: redraw }),
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
    d.playback_error ? el('div', { class: 'error' }, d.playback_error) : null,
    d.decoders && d.decoders.display_width ? el('div', { class: 'meta' },
      `Screen ${d.decoders.display_width}×${d.decoders.display_height}`
      + (d.decoders.h264_level ? ` · H.264 level ${d.decoders.h264_level === 9 ? '1b' : (d.decoders.h264_level / 10).toFixed(1)}` : '')
      + (d.decoders.hevc ? ' · HEVC' : '')) : null,
    d.download ? el('div', {},
      el('div', { class: 'warn' }, `Downloading ${Math.min(d.download.done + 1, d.download.total)} of ${d.download.total} new files`),
      el('div', { class: 'progress', style: 'margin-top:6px' }, el('div', { style: `width:${Math.round((d.download.done / d.download.total) * 100)}%` }))) : null,
    el('div', { class: 'meta' }, d.free_bytes ? `Storage: ${formatBytes(d.free_bytes)} free` : '', d.app_version ? ` · App ${d.app_version}` : ''),
    el('div', { class: 'row' },
      el('button', { class: 'btn text small', onclick: () => screenForm({ device: d, site: d.site, playlists, devices, onDone: redraw }) }, 'Edit'),
      el('button', {
        class: 'btn danger small',
        onclick: () => confirmDialog(`Remove ${d.name}?`, 'The TV stops getting updates and shows a new pairing code, so it can be added again later.', 'Remove',
          () => attempt(async () => { await api('DELETE', `api/devices/${d.id}`); toast(`${d.name} removed`); redraw(); })),
      }, 'Remove')),
  );
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
async function screenForm({ code, device, site = null, playlists, devices, onDone }) {
  // The locations at this screen's site, to choose from (or add a new one).
  const data = await attempt(() => api('GET', 'api/locations'));
  if (!data) return;
  const siteKey = (s) => s || data.own_site || '';
  const choices = data.locations.filter((l) => siteKey(l.site) === siteKey(site)).map((l) => l.name);
  if (device?.location && !choices.includes(device.location)) choices.push(device.location);
  openDialog((dialog) => {
    const name = el('input', { type: 'text', value: device?.name || '', placeholder: 'e.g. Front window', required: true });
    const location = el('select', {},
      el('option', { value: '' }, 'No location'),
      choices.map((l) => el('option', { value: l, selected: device?.location === l }, l)),
      el('option', { value: '__new' }, '+ New location…'));
    const newLocation = el('input', { type: 'text', placeholder: 'Name of the new location, e.g. Main lobby', hidden: true });
    location.addEventListener('change', () => {
      newLocation.hidden = location.value !== '__new';
      if (!newLocation.hidden) newLocation.focus();
    });
    let mounting = mountingOf(device);
    // null means Automatic: the screen follows its site's Landscape or Portrait playlist.
    let playlistId = device?.playlist_id ?? null;
    const siteName = siteLabel(site, data.own_site);
    // A screen can instead be pinned to one of its site's extra playlists.
    const extras = playlists.filter((p) => !p.auto && ((!p.unassigned && siteKey(p.site) === siteKey(site)) || p.id === playlistId));
    const warning = el('div', { class: 'note', hidden: true });
    const updateWarning = () => {
      const chosen = playlists.find((p) => p.id === playlistId);
      const screenShape = MOUNTINGS[mounting].shape;
      warning.hidden = !chosen || chosen.orientation === screenShape;
      if (chosen) warning.textContent = `${chosen.name} is made for ${chosen.orientation} screens, but this screen is ${screenShape}. Its files will play with black bars.`;
      autoMeta.textContent = `Plays ${siteName}’s ${SHAPES[screenShape]} playlist. If you turn the screen, it switches by itself.`;
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
    const playlistChoices = el('div', { class: 'choices' },
      el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'playlist', value: '', checked: playlistId === null, onchange: () => { playlistId = null; updateWarning(); } }),
        el('span', {}, el('strong', {}, 'Automatic'), el('br'), autoMeta)),
      extras.map((p) =>
        el('label', { class: 'choice' },
          el('input', { type: 'radio', name: 'playlist', value: p.id, checked: playlistId === p.id, onchange: () => { playlistId = p.id; updateWarning(); } }),
          el('span', {}, el('strong', {}, p.name), el('br'), el('span', { class: 'meta' }, `${SHAPES[p.orientation]} · ${p.item_count} item${p.item_count === 1 ? '' : 's'}`)))));
    updateWarning();
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), location: location.value || null, ...mountingBody(mounting), playlist_id: playlistId };
        if (!body.name) return toast('Give the screen a name');
        if (body.location === '__new') {
          const created = await attempt(() => api('POST', 'api/locations', { site: site || null, name: newLocation.value.trim() }));
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
    el('h2', {}, device ? 'Edit screen' : `Set up screen ${code.slice(0, 3)}-${code.slice(3)}`),
    el('label', { class: 'field' }, 'Name', name),
    el('label', { class: 'field' }, 'Location', location, newLocation),
    el('div', { class: 'field' }, el('strong', {}, 'How the screen is mounted'), mountChoices,
      el('span', { class: 'meta' }, 'Pick the way the top of the picture should point. Kiosk Player turns the picture to match, because TV boxes always send a landscape picture.')),
    el('div', { class: 'field' }, el('strong', {}, 'Playlist'), playlistChoices,
      extras.length ? null : el('span', { class: 'meta' }, `To show something different on one screen, add an extra playlist for ${siteName} under Locations.`)),
    warning,
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
    const [data, playlists] = await Promise.all([api('GET', 'api/locations'), api('GET', 'api/playlists')]);
    const bySite = new Map(data.sites.map((s) => [s || '', []]));
    for (const l of data.locations) bySite.set(l.site || '', [...(bySite.get(l.site || '') || []), l]);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Locations'),
          el('p', { class: 'sub' }, 'Each site has its own playlists, and the areas where its screens are. Each area has its own working hours; outside them its screens go dark.')),
        el('button', { class: 'btn primary', onclick: () => addLocationDialog(data, (l) => { location.hash = `#/locations/${l.id}`; }) }, '+ Add location')),
      [...bySite.entries()].map(([site, list]) => el('section', { class: 'site-block' },
        el('h2', { class: 'site-name' }, siteLabel(site, data.own_site)),
        sitePlaylists(site || null, data.own_site, playlists, draw),
        el('div', { class: 'section-label' }, 'Areas and screens'),
        list.length === 0
          ? el('div', { class: 'empty' }, 'No areas here yet. Add a location, e.g. “Main lobby”, then put screens in it.')
          : el('div', { class: 'list' }, list.map((l) => el('a', { class: 'list-row link-row', href: `#/locations/${l.id}` },
            el('span', { class: 'loc-mark' }, icon('locations', 22)),
            el('div', { class: 'grow' }, el('div', { class: 'name' }, l.name),
              el('div', { class: 'meta row nowrap', style: 'gap:6px' }, icon('clock', 14), el('span', {}, l.hours_summary))),
            el('span', { class: 'chip primary' }, `${l.screens.length} screen${l.screens.length === 1 ? '' : 's'}`)))))),
      olderPlaylists(playlists, data.sites, data.own_site, draw),
    );
  }
  await attempt(draw);
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

/** A site's playlists: its automatic Landscape and Portrait, then any extras, and a button to add one. */
function sitePlaylists(site, ownSite, playlists, redraw) {
  const key = (s) => s || ownSite || '';
  const mine = playlists.filter((p) => !p.unassigned && key(p.site) === key(site));
  const name = siteLabel(site, ownSite);
  return [
    el('div', { class: 'section-label row group-head' }, 'Playlists',
      el('button', {
        class: 'btn text small', type: 'button',
        onclick: () => playlistForm({ site, siteName: name, onSaved: (p) => { location.hash = `#/playlists/${p.id}`; } }),
      }, '+ Extra playlist')),
    el('p', { class: 'meta', style: 'margin:0 4px 10px' },
      `Screens at ${name} play Landscape or Portrait by themselves, whichever fits how they’re mounted. An extra playlist is for a screen that should show something different.`),
    el('div', { class: 'grid' }, mine.map(playlistCard)),
  ];
}

/** Playlists from before playlists belonged to sites that no screen was using. */
function olderPlaylists(playlists, sites, ownSite, redraw) {
  const old = playlists.filter((p) => p.unassigned);
  if (!old.length) return null;
  return el('section', { class: 'site-block' },
    el('h2', { class: 'site-name' }, 'Older playlists'),
    el('p', { class: 'meta', style: 'margin:0 4px 10px' }, 'These were made before playlists belonged to a site, and no screen plays them. Open one to move it to a site or delete it.'),
    el('div', { class: 'grid' }, old.map(playlistCard)));
}

function addLocationDialog(data, onAdded) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', placeholder: 'e.g. Main lobby', maxLength: 60 });
    const site = el('select', {}, data.sites.map((s) => el('option', { value: s || '' }, s || 'This site')));
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const added = await attempt(() => api('POST', 'api/locations', { name: name.value.trim(), site: site.value || null }));
        if (!added) return;
        dialog.close();
        toast(`${added.name} added`);
        refreshNavLocations();
        onAdded(added);
      },
    },
    el('h2', {}, 'Add a location'),
    el('label', { class: 'field' }, 'Name', name),
    data.sites.length > 1 ? el('label', { class: 'field' }, 'Site', site) : null,
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
    // Screens at the same site, in other locations, can be moved here.
    const others = devices.filter((d) => d.location_id !== loc.id && (d.site || null) === loc.site);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {},
          el('a', { href: '#/locations', class: 'meta' }, '← Locations'),
          el('h1', {}, loc.name),
          el('p', { class: 'sub row', style: 'gap:6px' }, loc.site ? `${loc.site} · ` : '', icon('clock', 16), loc.hours_summary)),
        el('div', { class: 'row' },
          el('button', { class: 'btn tonal', onclick: () => hoursDialog(loc, draw) }, icon('clock', 18), 'Working hours'),
          el('button', { class: 'btn', onclick: () => renameLocationDialog(loc, draw) }, 'Rename'),
          el('button', { class: 'btn danger', onclick: () => deleteLocationDialog(loc, here) }, 'Delete location'))),
      el('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
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
    el('p', { class: 'sub' }, 'It keeps its playlist, and follows this location’s working hours.'),
    el('div', { class: 'list', style: 'max-height:50vh;overflow:auto' }, others.map((d) => el('div', { class: 'list-row' },
      el('div', { class: 'grow' }, el('div', { class: 'name' }, d.name), el('div', { class: 'meta' }, d.location ? `Now in ${d.location}` : 'No location')),
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

function uploadFile(file, onProgress, startsAt = null, expiresAt = null) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/media');
    const t = token();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (startsAt) xhr.setRequestHeader('X-Starts-At', String(startsAt));
    if (expiresAt) xhr.setRequestHeader('X-Expires-At', String(expiresAt));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status < 300) resolve(data); else reject(new Error(data.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error("Can't reach the server"));
    xhr.send(file);
  });
}

async function pageLibrary(page) {
  const uploads = el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:12px' });
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
      groups.length === 0 ? el('div', { class: 'empty', style: 'margin-top:20px' }, 'No files yet. Drop files above, or add them to the Signage folder in Google Drive.') : null,
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

  // Optional: first and last day for the files about to be uploaded.
  const uploadStart = el('input', { type: 'date', class: 'date-input', id: 'upload-start', 'aria-label': 'New uploads show from' });
  const uploadExpiry = el('input', { type: 'date', class: 'date-input', id: 'upload-expiry', min: lastDayValue(Date.now() + 1), 'aria-label': 'New uploads show until' });

  async function addFiles(files) {
    const startsAt = startOfDay(uploadStart.value);
    const expiresAt = expiryFromLastDay(uploadExpiry.value);
    for (const file of files) {
      const bar = el('div', { style: 'width:0%' });
      const label = el('span', { class: 'meta' }, '0%');
      const row = el('div', { class: 'card' },
        el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, el('strong', {}, `Uploading ${file.name}`), label),
        el('div', { class: 'progress' }, bar));
      uploads.append(row);
      try {
        await uploadFile(file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; label.textContent = `${Math.round(p * 100)}%`; }, startsAt, expiresAt);
        toast(`${file.name} saved to Google Drive`);
      } catch (e) {
        toast(`${file.name}: ${e.message}`);
      }
      row.remove();
      await attempt(() => load());
    }
  }

  const picker = el('input', { type: 'file', multiple: true, accept: 'video/mp4,image/jpeg,image/png,image/webp', hidden: true, onchange: () => addFiles([...picker.files]) });
  const drop = el('div', {
    class: 'drop', tabIndex: 0, role: 'button',
    onclick: () => picker.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } },
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
  },
  el('strong', {}, 'Drop videos and pictures here, or click to choose'),
  el('div', { class: 'meta' }, '.mp4 videos up to 4K, and .jpg, .png, .webp pictures. They’re saved into the Signage folder in Google Drive.'));

  fill(page,
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Library'), el('p', { class: 'sub' }, status)),
      el('button', { class: 'btn', onclick: () => attempt(async () => { await load(true); toast('Library is up to date'); }) }, icon('refresh', 18), 'Sync with Drive')),
    drop,
    el('div', { class: 'row meta upload-expiry' }, icon('calendar', 16), 'New uploads (optional) show from', uploadStart, 'until', uploadExpiry,
      el('button', { type: 'button', class: 'btn text small', onclick: () => { uploadStart.value = ''; uploadExpiry.value = ''; } }, 'Clear')),
    picker, uploads, listArea,
  );
  await attempt(() => load());
  // While a file's shape is still being checked, look again every few seconds.
  pageTimer = setInterval(() => { if (library?.items.some((m) => !m.orientation)) attempt(() => load()); }, 5000);
}

// ---------- Playlists ----------

async function pagePlaylists(page) {
  async function draw() {
    const [playlists, where] = await Promise.all([api('GET', 'api/playlists'), api('GET', 'api/sites')]);
    fill(page,
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Playlists'), el('p', { class: 'sub' }, 'Each site has a Landscape and a Portrait playlist that its screens play by themselves.'))),
      where.sites.map((site) => el('section', { class: 'site-block' },
        el('h2', { class: 'site-name' }, siteLabel(site, where.own_site)),
        sitePlaylists(site, where.own_site, playlists, draw))),
      olderPlaylists(playlists, where.sites, where.own_site, draw),
    );
  }
  await attempt(draw);
}

/** New playlist, or name/shape/delete for an existing one. */
async function playlistForm({ playlist, site = null, siteName = null, onSaved, onDeleted }) {
  // An older playlist (no site yet) can be moved to a site here.
  const where = playlist?.unassigned ? await attempt(() => api('GET', 'api/sites')) : null;
  if (playlist?.unassigned && !where) return;
  openDialog((dialog) => {
    const moveTo = where
      ? el('select', {}, el('option', { value: '__none' }, 'Leave it without a site'),
        where.sites.map((s) => el('option', { value: s || '' }, siteLabel(s, where.own_site))))
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
        if (!playlist) body.site = site;
        if (moveTo && moveTo.value !== '__none') body.site = moveTo.value || null;
        const saved = await attempt(() => (playlist ? api('PATCH', `api/playlists/${playlist.id}`, body) : api('POST', 'api/playlists', body)));
        if (!saved) return;
        dialog.close();
        toast(playlist ? 'Playlist updated' : `${saved.name} created. Add files, then save.`);
        onSaved?.(saved);
      },
    },
    el('h2', {}, playlist ? 'Playlist settings' : `Extra playlist for ${siteName || 'this site'}`),
    playlist ? null : el('p', { class: 'meta', style: 'margin:0' }, 'Screens don’t play an extra playlist by themselves. After making it, edit a screen and choose it there.'),
    el('label', { class: 'field' }, 'Playlist name', name),
    moveTo ? el('label', { class: 'field' }, 'Site', moveTo) : null,
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
  let ownSiteName = null; // this server's own site, for the heading
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
          el('h1', {}, detail.unassigned ? detail.name : `${siteLabel(detail.site, ownSiteName)} · ${detail.name}`),
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
    let where;
    [detail, library, where] = await Promise.all([api('GET', `api/playlists/${id}`), api('GET', 'api/media'), api('GET', 'api/sites')]);
    ownSiteName = where.own_site;
    items = detail.items.map((x) => ({ ...x, schedule_enabled: x.start_at != null || x.end_at != null }));
    draw();
  }
  await attempt(load);
}

// ---------- Users ----------

async function pageUsers(page) {
  async function draw() {
    const users = await api('GET', 'api/users');
    const email = el('input', { type: 'email', placeholder: 'name@yourcompany.com', required: true });
    const role = el('select', {}, Object.entries(ROLES).map(([key, r]) => el('option', { value: key, selected: key === 'content_uploader' }, r.label)));
    fill(page, 
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Users'), el('p', { class: 'sub' }, 'Who may use Kiosk Admin and this web page. They sign in with their Google account.'))),
      el('form', {
        class: 'card row', style: 'align-items:flex-end',
        onsubmit: async (e) => {
          e.preventDefault();
          const ok = await attempt(() => api('POST', 'api/users', { email: email.value.trim(), role: role.value }));
          if (ok) { toast(`Invited ${ok.email}. They can sign in with Google now.`); draw(); }
        },
      },
      el('label', { class: 'field grow' }, 'Invite someone (Google account email)', email),
      el('label', { class: 'field' }, 'Role', role),
      el('button', { class: 'btn primary' }, 'Send invite')),
      el('div', { class: 'section-label' }, `${users.length} ${users.length === 1 ? 'person' : 'people'}`),
      el('div', { class: 'list' }, users.map((u) => {
        const isMe = u.email === me.email;
        return el('div', { class: 'list-row' },
          el('div', { class: 'grow' }, el('div', { class: 'name' }, u.email), isMe ? el('div', { class: 'meta' }, `You · ${ROLES[u.role].label}`) : null),
          isMe ? null : el('select', {
            'aria-label': `Role for ${u.email}`,
            onchange: (e) => attempt(async () => { await api('PATCH', `api/users/${u.id}`, { role: e.target.value }); toast(`${u.email} is now ${ROLES[e.target.value].label}`); }),
          }, Object.entries(ROLES).map(([key, r]) => el('option', { value: key, selected: key === u.role }, r.label))),
          isMe ? null : el('button', {
            class: 'btn icon', 'aria-label': `Remove ${u.email}`,
            onclick: () => confirmDialog(`Remove ${u.email}?`, 'They are signed out and can no longer sign in.', 'Remove',
              () => attempt(async () => { await api('DELETE', `api/users/${u.id}`); toast(`${u.email} can no longer sign in`); draw(); })),
          }, icon('trash')));
      })),
      el('div', { class: 'card', style: 'margin-top:20px' },
        el('h2', {}, 'What each role can do'),
        Object.values(ROLES).map((r) => el('div', {}, el('strong', {}, r.label), ` · ${r.desc}`))),
    );
  }
  await attempt(draw);
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

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px;margin-top:16px' },
        el('h2', {}, 'Playback copies'),
        el('p', { class: 'meta', style: 'margin:0' }, 'Heavy 4K videos are hard for some TV boxes. The server can make a 1080p H.264 copy (and a smaller 720p one) after each video arrives. The original in Google Drive is left as it is. Turn this off on a slow machine, such as a Raspberry Pi, if the add-on becomes unresponsive.'),
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

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px;margin-top:16px' },
        el('h2', {}, 'Signing in'),
        el('div', {}, s.sign_in.phone_app ? '✓ ' : '✗ ', el('strong', {}, 'Phone app'), ' · Sign in with Google',
          s.sign_in.phone_app ? '' : ' (set the Google web client ID in the add-on’s Configuration tab)'),
        el('div', {}, s.sign_in.web_code ? '✓ ' : '✗ ', el('strong', {}, 'This web page'), ' · code at google.com/device',
          s.sign_in.web_code ? '' : ' (add the Google “TVs and Limited Input devices” client ID and secret in the add-on’s Configuration tab)'),
        el('div', {}, '✓ ', el('strong', {}, 'Home Assistant sidebar'), ' · Home Assistant admins')),

      el('div', { class: 'card', style: 'margin-top:16px' },
        el('h2', {}, 'Library'),
        el('div', {}, `${s.library.files} file${s.library.files === 1 ? '' : 's'} · ${formatBytes(s.library.bytes)} in Google Drive`)),
    );
  }
  await attempt(draw);
}

boot();
