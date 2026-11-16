// What the Kiosk Browser shows when no customer is using the web page: setup, the
// pairing code, "getting ready", the signage playlist ("Touch to start"), a black
// screen after hours, the bar under the web page, and the staff PIN pad and menu.
// Plain text only (textContent), so nothing from the server can run as code here.

// "bridge", not "kiosk": the preload already defines a global called kiosk.
const bridge = window.kiosk;
const screenEl = document.getElementById('screen');
const badge = document.getElementById('badge');
const notice = document.getElementById('notice');
const bar = document.getElementById('bar');
const staffEl = document.getElementById('staff');

let state = { phase: 'setup' };
let shownKey = '';
let playTimer = null;
let playIndex = 0;
let noticeTimer = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const fill = (parent, ...children) => { parent.replaceChildren(); parent.append(...children.flat().filter(Boolean)); };
const prettyCode = (code) => (code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code || '…');

// ---------- setup ----------

function renderSetup(problem = '') {
  const address = el('input', { class: 'address', type: 'text', placeholder: 'e.g. 192.168.1.20', inputmode: 'url', spellcheck: 'false' });
  const error = el('div', { class: 'error', role: 'alert' }, problem);
  const found = el('div', { class: 'found' });
  const connect = async (url) => {
    error.textContent = '';
    const result = await bridge.connect(url);
    if (!result.ok) error.textContent = result.error;
  };
  fill(screenEl, el('div', { class: 'panel' },
    el('h1', {}, 'Kiosk Browser'),
    el('p', {}, 'Connect this PC to your Kiosk server. It shows the web page and signage you choose on the Kiosk dashboard.'),
    el('div', { class: 'row' },
      el('button', {
        class: 'big-btn primary', type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          fill(found, el('p', {}, 'Looking for the Kiosk server on this network…'));
          const list = await bridge.findServers().catch(() => []);
          e.target.disabled = false;
          fill(found, list.length
            ? list.map((s) => el('button', { class: 'big-btn', type: 'button', onclick: () => connect(s.url) },
              s.role === 'relay' ? `${s.siteName || 'Relay'} (this site’s Home Assistant)` : `Main Kiosk server${s.siteName ? ` · ${s.siteName}` : ''}`))
            : el('p', {}, 'No Kiosk server found on this network. Type its address instead.'));
        },
      }, 'Find the Kiosk server')),
    found,
    el('div', { class: 'row' }, address,
      el('button', { class: 'big-btn', type: 'button', onclick: () => address.value.trim() && connect(address.value) }, 'Connect')),
    error));
}

// ---------- pairing and getting ready ----------

function renderPairing(s) {
  fill(screenEl, el('div', { class: 'panel' },
    el('h1', {}, 'Add this kiosk on the Kiosk dashboard'),
    el('div', { class: 'code' }, prettyCode(s.code)),
    el('p', {}, 'Open the Kiosk web page: Screens → New screens waiting → Add (or type this code under Add a screen). Then give it its web address.'),
    s.problem ? el('div', { class: 'error' }, s.problem) : null,
    el('p', { class: 'meta' }, `Server: ${s.server || ''}`)));
}

function renderPreparing(s) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  fill(screenEl, el('div', { class: 'panel' },
    s.name ? el('p', {}, s.name) : null,
    el('h1', {}, 'Getting content ready'),
    el('p', {}, s.detail || ''),
    progressBar(pct)));
}

function progressBar(pct) {
  const inner = el('div');
  inner.style.width = `${pct}%`; // set in code: the page allows no inline styles
  return el('div', { class: 'progress' }, inner);
}

// ---------- signage while idle ----------

function renderReady(s) {
  if (!s.open) {
    clearTimeout(playTimer);
    fill(screenEl, el('div', { class: 'closed' }));
    return;
  }
  const stage = el('div', { class: 'stage' });
  const hint = s.browser && s.browser.url
    ? el('div', { class: 'touch-hint' }, 'Touch the screen to start')
    : el('div', { class: 'touch-hint' }, 'No web address yet: set one on the Kiosk dashboard');
  fill(screenEl, stage, hint);
  playIndex = 0;
  playNext(stage, s.items || []);
}

function playNext(stage, items) {
  clearTimeout(playTimer);
  if (!items.length) {
    fill(stage);
    bridge.playing(null);
    return;
  }
  const item = items[playIndex % items.length];
  playIndex++;
  const advance = () => playNext(stage, items);
  if (item.type === 'video') {
    const video = el('video', { src: item.src, autoplay: true, playsinline: true });
    video.addEventListener('ended', advance);
    video.addEventListener('error', () => { bridge.playing(item.id, `${item.filename} couldn’t be played on this PC`); playTimer = setTimeout(advance, 2000); });
    fill(stage, video);
    if (items.length === 1) video.loop = true;
  } else {
    fill(stage, el('img', { src: item.src, alt: '' }));
    playTimer = setTimeout(advance, (item.duration || 10) * 1000);
  }
  bridge.playing(item.id);
}

// ---------- drawing ----------

function render() {
  const s = state;
  bar.hidden = !s.browsing;
  badge.hidden = !(s.phase === 'ready' && s.badge && s.open !== false);
  badge.textContent = s.badge || '';
  // Only redraw the main screen when what it shows changes (the playlist keeps playing otherwise).
  const key = JSON.stringify([s.phase, s.code, s.problem, s.detail, s.done, s.open, s.version, s.browser && s.browser.url, (s.items || []).map((i) => i.src)]);
  if (key === shownKey) return;
  shownKey = key;
  if (s.phase === 'setup') renderSetup();
  else if (s.phase === 'pairing') renderPairing(s);
  else if (s.phase === 'preparing') renderPreparing(s);
  else if (s.phase === 'ready') renderReady(s);
}

bridge.onState((s) => { state = s; render(); });
bridge.onNotice((text) => {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
});

// A customer touches the signage: open the web page (not during setup, or after hours).
screenEl.addEventListener('pointerdown', (e) => {
  if (state.phase === 'ready' && state.open && !state.browsing && !cornerTap(e)) bridge.touch();
});
document.getElementById('back').addEventListener('click', () => bridge.back());
document.getElementById('start-over').addEventListener('click', () => bridge.startOver());

// ---------- staff ----------

let taps = [];
function cornerTap(e) {
  if (e.clientX > 80 || e.clientY > 80) return false;
  const now = Date.now();
  taps = taps.filter((t) => now - t < 3000).concat(now);
  if (taps.length >= 5) { taps = []; bridge.staff(); }
  return true;
}
document.addEventListener('pointerdown', (e) => { if (e.target.closest && !e.target.closest('#screen')) cornerTap(e); }, true);

function closeStaff() {
  staffEl.hidden = true;
  staffEl.replaceChildren();
}

function staffMenu() {
  const act = (action) => () => { closeStaff(); bridge.staffAction(action); };
  fill(staffEl, el('div', { class: 'staff-box' },
    el('h1', {}, 'Staff'),
    el('div', { class: 'menu' },
      el('button', { class: 'big-btn primary', type: 'button', onclick: closeStaff }, 'Back to the kiosk'),
      el('button', { class: 'big-btn', type: 'button', onclick: act('reload') }, 'Check for new content now'),
      el('button', { class: 'big-btn', type: 'button', onclick: act('leave') }, 'Leave the kiosk for 15 minutes'),
      el('button', { class: 'big-btn danger', type: 'button', onclick: act('reset') }, 'Forget the server and pair again'),
      el('button', { class: 'big-btn danger', type: 'button', onclick: act('quit') }, 'Quit Kiosk Browser')),
    el('p', { class: 'meta' }, `Server: ${state.server || 'not connected'}`)));
}

function staffPin() {
  let pin = '';
  const dots = el('div', { class: 'pin-dots' }, '');
  const msg = el('div', { class: 'error', role: 'alert' });
  const press = async (key) => {
    msg.textContent = '';
    if (key === '⌫') pin = pin.slice(0, -1);
    else if (key === 'OK') {
      if (await bridge.checkPin(pin)) return staffMenu();
      pin = '';
      msg.textContent = 'That PIN isn’t right';
    } else if (pin.length < 8) pin += key;
    dots.textContent = '●'.repeat(pin.length);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
  fill(staffEl, el('div', { class: 'staff-box' },
    el('h1', {}, 'Staff PIN'),
    dots, msg,
    el('div', { class: 'keypad' }, keys.map((k) => el('button', { type: 'button', onclick: () => press(k) }, k))),
    el('button', { class: 'big-btn', type: 'button', onclick: closeStaff }, 'Cancel')));
}

bridge.onStaff(async () => {
  staffEl.hidden = false;
  // No PIN set on the dashboard yet: straight to the menu.
  if (state.phase !== 'ready' || !(state.browser && state.browser.has_pin)) staffMenu();
  else staffPin();
});

render();
