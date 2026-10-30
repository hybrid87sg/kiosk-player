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
};
const ROLES = {
  superadmin: { label: 'Spongebob', desc: 'Everything, including people and settings' },
  system_manager: { label: 'Patrick', desc: 'Screens and content' },
  content_uploader: { label: 'Squidward', desc: 'Files and playlists only' },
};

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
  if (role !== 'content_uploader') tabs.push(['screens', 'Screens']);
  tabs.push(['library', 'Library'], ['playlists', 'Playlists']);
  if (role === 'superadmin') tabs.push(['users', 'Users'], ['settings', 'Settings']);
  return tabs;
}

function renderShell() {
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' },
    el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, icon('screens', 20)), 'Kiosk Signage'),
    tabsFor(me.role).map(([key, label]) => el('a', { href: `#/${key}`, 'data-tab': key }, icon(key), label)),
    el('div', { class: 'spacer' }),
    el('div', { class: 'who' }, el('strong', {}, me.email), ROLES[me.role].label,
      me.via_home_assistant ? ' · via Home Assistant' : '',
      me.via_home_assistant ? null : el('div', {}, el('button', { class: 'btn text small', style: 'padding:0;margin-top:6px', onclick: signOut }, 'Sign out'))),
  );
  fill(app, el('div', { class: 'shell' }, nav, el('main', { id: 'page' })));
  route();
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
  const allowed = tabsFor(me.role).map(([key]) => key);
  const current = allowed.includes(section) ? section : allowed[0];
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.tab === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const page = document.getElementById('page');
  if (!page) return;
  fill(page, el('p', { class: 'loading' }, 'Loading…'));
  const pages = { screens: pageScreens, library: pageLibrary, playlists: pagePlaylists, users: pageUsers, settings: pageSettings };
  if (current === 'playlists' && id) pagePlaylist(page, Number(id));
  else pages[current](page);
}
window.addEventListener('hashchange', route);

// ---------- Screens: live overview of every TV ----------

async function pageScreens(page) {
  async function draw() {
    const [devices, playlists] = await Promise.all([api('GET', 'api/devices'), api('GET', 'api/playlists')]);
    const online = devices.filter((d) => d.online).length;
    const groups = new Map();
    for (const d of devices) {
      const loc = d.location || 'No location';
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc).push(d);
    }
    fill(page, 
      el('div', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Screens'),
          el('p', { class: 'sub' }, `${devices.length} screen${devices.length === 1 ? '' : 's'} · ${online} online · updates every 10 seconds`)),
        el('button', { class: 'btn primary', onclick: () => addScreenDialog(playlists, devices, draw) }, '+ Add a screen')),
      devices.length === 0
        ? el('div', { class: 'empty' }, 'No screens yet. Open Kiosk Player on a TV, then click “Add a screen” and type the code it shows.')
        : [...groups.entries()].map(([loc, list]) => [
          el('div', { class: 'section-label' }, `${loc} · ${list.length}`),
          el('div', { class: 'grid' }, list.map((d) => screenCard(d, playlists, devices, draw))),
        ]),
    );
  }
  await attempt(draw);
  pageTimer = setInterval(() => attempt(draw), 10000);
}

function screenCard(d, playlists, devices, redraw) {
  const mount = MOUNTINGS[d.orientation] || MOUNTINGS.landscape;
  return el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('strong', { style: 'font-size:17px' }, d.name || 'Unnamed'),
      el('span', { class: `chip ${d.online ? 'online' : 'offline'}` }, el('span', { class: 'dot' }),
        d.online ? 'Online' : `Offline · ${timeAgo(d.last_seen)}`)),
    el('div', { class: 'row meta' }, shapeIcon(mount.shape), `${mount.label} · ${d.playlist_name || 'No playlist'}`),
    el('div', {}, d.current_filename ? `Now playing: ${d.current_filename}` : 'Waiting for content'),
    d.download ? el('div', {},
      el('div', { class: 'warn' }, `Downloading ${Math.min(d.download.done + 1, d.download.total)} of ${d.download.total} new files`),
      el('div', { class: 'progress', style: 'margin-top:6px' }, el('div', { style: `width:${Math.round((d.download.done / d.download.total) * 100)}%` }))) : null,
    el('div', { class: 'meta' }, d.free_bytes ? `Storage: ${formatBytes(d.free_bytes)} free` : '', d.app_version ? ` · App ${d.app_version}` : ''),
    el('div', { class: 'row' },
      el('button', { class: 'btn text small', onclick: () => screenForm({ device: d, playlists, devices, onDone: redraw }) }, 'Edit'),
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
function screenForm({ code, device, playlists, devices, onDone }) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', value: device?.name || '', placeholder: 'e.g. Front window', required: true });
    const locations = [...new Set(devices.map((d) => d.location).filter(Boolean))];
    const listId = `locations-${Math.random().toString(36).slice(2)}`;
    const location = el('input', { type: 'text', value: device?.location || '', placeholder: 'e.g. Main lobby', list: listId });
    location.setAttribute('list', listId);
    let mounting = device?.orientation || 'landscape';
    let playlistId = device?.playlist_id ?? playlists[0]?.id ?? null;
    const warning = el('div', { class: 'note', hidden: true });
    const updateWarning = () => {
      const chosen = playlists.find((p) => p.id === playlistId);
      const screenShape = MOUNTINGS[mounting].shape;
      warning.hidden = !chosen || chosen.orientation === screenShape;
      if (chosen) warning.textContent = `${chosen.name} is made for ${chosen.orientation} screens, but this screen is ${screenShape}. Its files will play with black bars.`;
    };
    const mountChoices = el('div', { class: 'choices' }, Object.entries(MOUNTINGS).map(([key, m]) =>
      el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'mounting', value: key, checked: mounting === key, onchange: () => { mounting = key; updateWarning(); } }),
        el('span', {}, shapeIcon(m.shape, 22), ' ', m.label))));
    const playlistChoices = playlists.length
      ? el('div', { class: 'choices' }, playlists.map((p) =>
        el('label', { class: 'choice' },
          el('input', { type: 'radio', name: 'playlist', value: p.id, checked: playlistId === p.id, onchange: () => { playlistId = p.id; updateWarning(); } }),
          el('span', {}, el('strong', {}, p.name), el('br'), el('span', { class: 'meta' }, `${SHAPES[p.orientation]} · ${p.item_count} items`)))))
      : el('p', { class: 'meta' }, 'No playlists yet. Make one in Playlists; the screen waits for content until then.');
    updateWarning();
    const form = el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), location: location.value.trim() || null, orientation: mounting, playlist_id: playlistId };
        if (!body.name) return toast('Give the screen a name');
        const ok = await attempt(() => (device
          ? api('PATCH', `api/devices/${device.id}`, body)
          : api('POST', 'api/devices/claim', { ...body, code })));
        if (!ok) return;
        dialog.close();
        toast(device ? `${body.name} updated` : `${body.name} added. It starts playing once its files are downloaded.`);
        onDone();
      },
    },
    el('h2', {}, device ? 'Edit screen' : `Set up screen ${code}`),
    el('label', { class: 'field' }, 'Name', name),
    el('label', { class: 'field' }, 'Location', location, el('datalist', { id: listId }, locations.map((l) => el('option', { value: l })))),
    el('div', { class: 'field' }, el('strong', {}, 'How the screen is mounted'), mountChoices,
      el('span', { class: 'meta' }, 'Kiosk Player turns the picture to match, because TV boxes always send a landscape picture.')),
    el('div', { class: 'field' }, el('strong', {}, 'Playlist'), playlistChoices),
    warning,
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'btn primary' }, device ? 'Save' : 'Add screen')));
    return form;
  });
}

// ---------- Library ----------

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/media');
    const t = token();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
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

  function draw() {
    const items = library.items;
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
          el('div', { class: 'grow' }, el('div', { class: 'name' }, m.filename), el('div', { class: 'meta' }, mediaMeta(m))),
          el('button', {
            class: 'btn icon', 'aria-label': `Delete ${m.filename}`, title: 'Delete',
            onclick: () => confirmDialog(`Delete ${m.filename}?`, 'It goes to the Google Drive trash and leaves every playlist. Screens stop showing it after their next update.', 'Delete',
              () => attempt(async () => { await api('DELETE', `api/media/${m.id}`); toast(`${m.filename} moved to the Google Drive trash`); await load(); })),
          }, icon('trash'))))),
      ]),
    );
  }

  async function load(sync = false) {
    library = await api(sync ? 'POST' : 'GET', sync ? 'api/media/sync' : 'api/media');
    draw();
  }

  async function addFiles(files) {
    for (const file of files) {
      const bar = el('div', { style: 'width:0%' });
      const label = el('span', { class: 'meta' }, '0%');
      const row = el('div', { class: 'card' },
        el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, el('strong', {}, `Uploading ${file.name}`), label),
        el('div', { class: 'progress' }, bar));
      uploads.append(row);
      try {
        await uploadFile(file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; label.textContent = `${Math.round(p * 100)}%`; });
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
    drop, picker, uploads, listArea,
  );
  await attempt(() => load());
  // While a file's shape is still being checked, look again every few seconds.
  pageTimer = setInterval(() => { if (library?.items.some((m) => !m.orientation)) attempt(() => load()); }, 5000);
}

// ---------- Playlists ----------

async function pagePlaylists(page) {
  const playlists = await attempt(() => api('GET', 'api/playlists'));
  if (!playlists) return;
  fill(page, 
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Playlists'), el('p', { class: 'sub' }, 'Each screen plays one playlist. Make one per screen shape or location.')),
      el('button', { class: 'btn primary', onclick: () => playlistForm({ onSaved: (p) => { location.hash = `#/playlists/${p.id}`; } }) }, '+ New playlist')),
    playlists.length === 0 ? el('div', { class: 'empty' }, 'No playlists yet.') : null,
    el('div', { class: 'grid' }, playlists.map((p) => el('a', {
      class: 'card', href: `#/playlists/${p.id}`, style: 'text-decoration:none;color:inherit;display:flex;gap:14px;align-items:center',
    },
    el('span', { style: 'color:var(--primary);width:36px;display:grid;place-items:center' }, shapeIcon(p.orientation, 30)),
    el('div', { class: 'grow' },
      el('div', { class: 'name', style: 'font-size:17px' }, p.name),
      el('div', { class: 'meta' }, `${SHAPES[p.orientation]} · ${p.item_count} item${p.item_count === 1 ? '' : 's'}`),
      el('div', { class: 'meta' }, p.devices.length ? `Plays on ${p.devices.map((d) => d.name).join(', ')}` : 'Not playing on any screen yet'))))),
  );
}

/** New playlist, or name/shape/delete for an existing one. */
function playlistForm({ playlist, onSaved, onDeleted }) {
  openDialog((dialog) => {
    const name = el('input', { type: 'text', value: playlist?.name || '', placeholder: 'e.g. Menu boards' });
    let shape = playlist?.orientation || 'landscape';
    const problem = el('div', { class: 'error' });
    return el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return toast('Give the playlist a name');
        const body = { name: name.value.trim(), orientation: shape };
        const saved = await attempt(() => (playlist ? api('PATCH', `api/playlists/${playlist.id}`, body) : api('POST', 'api/playlists', body)));
        if (!saved) return;
        dialog.close();
        toast(playlist ? 'Playlist updated' : `${saved.name} created. Add files, then save.`);
        onSaved?.(saved);
      },
    },
    el('h2', {}, playlist ? 'Playlist settings' : 'New playlist'),
    el('label', { class: 'field' }, 'Playlist name', name),
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
          el('a', { href: '#/playlists', class: 'meta' }, '← Playlists'),
          el('h1', {}, detail.name),
          el('p', { class: 'sub row' },
            el('span', { class: 'chip primary' }, shapeIcon(detail.orientation, 14), `${SHAPES[detail.orientation]} screens`),
            `${items.length} item${items.length === 1 ? '' : 's'} · loops forever · `,
            detail.devices.length ? `Plays on ${detail.devices.map((d) => d.name).join(', ')}` : 'Not playing on any screen yet')),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: addFromLibrary }, '+ Add from library'),
          el('button', { class: 'btn text', onclick: () => playlistForm({ playlist: detail, onSaved: () => load(), onDeleted: () => { location.hash = '#/playlists'; } }) }, 'Playlist settings'))),
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
        el('div', { class: 'grow' }, el('div', { class: 'name' }, m.filename), el('div', { class: 'meta' }, mediaMeta(m)),
          m.orientation && m.orientation !== detail.orientation ? el('div', { class: 'warn' }, `${SHAPES[m.orientation]} file · plays with black bars here`) : null),
        el('button', {
          class: 'btn tonal small',
          onclick: (e) => {
            items.push({ media_id: m.id, filename: m.filename, type: m.type, orientation: m.orientation, image_seconds: 10, start_at: null, end_at: null, schedule_enabled: false });
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

async function pageSettings(page) {
  async function draw() {
    const s = await api('GET', 'api/settings');
    const folder = el('input', { type: 'text', value: s.drive_folder_id || '', style: 'font-family:monospace' });
    const testResult = el('span', { class: 'meta' });
    fill(page, 
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Settings'), el('p', { class: 'sub' }, `Kiosk server ${s.version}`))),

      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px' },
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
