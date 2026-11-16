// The real Kiosk Browser app (Electron), driven like a customer and a member of staff would,
// against the real Kiosk server and a pretend customer website. Runs on Windows in CI, and on
// Linux with a virtual display (xvfb-run). Run: npm run e2e
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { createApp } = require('../../server/src/app');
const { createFakeGoogle } = require('../../server/test/fake-google');

const PASSWORD = 'correct-horse-9';
const step = (text) => console.log(`· ${text}`);
const until = async (check, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function main() {
  const cleanup = [];
  try {
    // The Kiosk server, with one picture in the library.
    const google = createFakeGoogle();
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'promo.png'));
    google.addFile('promo.png', 'image/png', png, { width: 320, height: 180 });
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-server-'));
    const kiosk = createApp({ dataDir: serverDir, google, firstAdmin: { username: 'boss', password: PASSWORD }, siteName: 'Main Centre', syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {} });
    const server = await new Promise((r) => { const s = kiosk.listen(0, '127.0.0.1', () => r(s)); });
    cleanup.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }), () => kiosk.locals.db.close(), () => fs.rmSync(serverDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { token, json } = {}) => fetch(base + p, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
    }).then((r) => r.json());
    const boss = (await call('POST', '/api/auth/login', { json: { username: 'boss', password: PASSWORD } })).token;

    // The customer website: 127.0.0.1 is "its" site; localhost counts as another website.
    const site = http.createServer((req, res) => {
      if (req.url === '/file.zip') { res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment' }); return res.end('PK'); }
      const page = req.url.startsWith('/second') ? 'second' : 'start';
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'visited=yes; Path=/' });
      res.end(`<!doctype html><title>${page}</title><p id="page">${page}</p><p id="cookie">${req.headers.cookie || 'none'}</p>
        <a id="same" href="/second">Second</a> <a id="other" href="http://localhost:${site.address().port}/x">Elsewhere</a>
        <a id="dl" href="/file.zip">Download</a> <button id="pop" onclick="window.open('/second?popup')">Pop-up</button>`);
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => { site.closeAllConnections?.(); site.close(r); }));
    const start = `http://127.0.0.1:${site.address().port}/start`;

    // The app, with its own data folder.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-app-'));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    const env = { ...process.env, KIOSK_BROWSER_DATA: dataDir };
    delete env.NODE_OPTIONS; // Electron refuses some Node options
    const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox'], env });
    cleanup.unshift(() => app.close().catch(() => {}));
    const win = await app.firstWindow();
    const urls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.startsWith('http')));
    const inPage = (js) => app.evaluate(({ webContents }, code) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http'));
      return wc ? wc.executeJavaScript(code) : null;
    }, js);
    // A real click (as a person would), sent to the web page at an element's position.
    const tap = async (id) => {
      const box = await inPage(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      await app.evaluate(({ webContents }, { x, y }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http'));
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }, box);
    };

    step('setup: connect to the server and show a pairing code');
    await win.waitForSelector('h1:has-text("Kiosk Browser")');
    await win.fill('.address', base.replace('http://', ''));
    await win.click('button:text-is("Connect")');
    const code = (await (await win.waitForSelector('.code')).textContent()).replace('-', '');
    assert.match(code, /^[A-Z0-9]{6}$/);

    step('added on the dashboard as a web kiosk, with a playlist, a web address and a PIN');
    const [waiting] = await call('GET', '/api/devices/waiting', { token: boss });
    assert.equal(waiting.kind, 'browser');
    await call('POST', '/api/media/sync', { token: boss });
    const media = (await call('GET', '/api/media', { token: boss })).items[0];
    await call('POST', '/api/locations', { token: boss, json: { name: 'Front desk' } });
    const location = (await call('GET', '/api/locations', { token: boss })).locations[0];
    const playlist = await call('POST', '/api/playlists', { token: boss, json: { name: 'Loop', orientation: 'landscape', location_id: location.id } });
    await call('PUT', `/api/playlists/${playlist.id}/items`, { token: boss, json: { items: [{ media_id: media.id }] } });
    const device = await call('POST', '/api/devices/claim', {
      token: boss, json: { code, name: 'Front desk PC', location: location.name, playlist_id: playlist.id, kiosk_url: start, kiosk_idle_seconds: 15, kiosk_pin: '2468' },
    });

    step('signage plays, inviting a touch');
    await win.waitForSelector('.touch-hint:has-text("Touch the screen to start")', { timeout: 20000 });
    await until(() => win.evaluate(() => { const i = document.querySelector('.stage img'); return i && i.complete && i.naturalWidth > 0; }), 10000, 'the picture');

    step('a touch opens the web page');
    await win.mouse.click(600, 400);
    await until(async () => (await urls()).includes(start), 10000, 'the start page');
    assert.equal(await win.isVisible('#bar'), true);
    assert.equal(await inPage('document.getElementById("cookie").textContent'), 'none');

    step('same-site links work; Back goes back');
    await tap('same');
    await until(async () => (await urls()).some((u) => u.endsWith('/second')), 5000, 'the second page');
    assert.equal(await inPage('document.getElementById("cookie").textContent'), 'visited=yes');
    await win.click('#back');
    await until(async () => (await urls()).includes(start), 5000, 'back to start');

    step('another website, a pop-up and a download are refused');
    await tap('other');
    await win.waitForSelector('#notice:has-text("isn’t available")');
    assert.deepEqual(await urls(), [start]);
    await tap('pop');
    await until(async () => (await urls()).some((u) => u.includes('/second?popup')), 5000, 'the pop-up in the same view');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    let downloads = 0;
    await app.evaluate(({ session }) => { global.__downloads = 0; session.fromPartition('kiosk-web').on('will-download', () => { global.__downloads++; }); });
    await inPage('location.href = "/file.zip"');
    await new Promise((r) => setTimeout(r, 1000));
    downloads = await app.evaluate(() => global.__downloads);
    assert.equal(fs.readdirSync(os.homedir()).filter((f) => f === 'file.zip').length, 0);
    assert.ok(downloads <= 1); // asked for, and cancelled

    step('Start over: a fresh page, the cookie is gone');
    await win.click('#start-over');
    await until(async () => (await inPage('document.getElementById("cookie") && document.getElementById("cookie").textContent')) === 'none', 8000, 'a fresh session');

    step('left alone for 15 seconds: back to signage, nothing kept');
    await until(async () => (await urls()).length === 0, 25000, 'the session to end');
    assert.equal(await win.isVisible('#bar'), false);
    assert.equal(await win.isVisible('.touch-hint'), true);

    step('the dashboard sees it online, with what it shows');
    await until(async () => {
      const d = (await call('GET', '/api/devices', { token: boss })).find((x) => x.id === device.id);
      return d.online && d.app_version && d.current_media_id === media.id && d.kind === 'browser';
    }, 70000, 'a check-in');

    step('closing the window (Alt+F4) is refused');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    step('staff: 5 taps in the corner, a wrong PIN, the right PIN, Quit');
    for (let i = 0; i < 5; i++) await win.mouse.click(20, 20);
    await win.waitForSelector('text=Staff PIN');
    for (const k of ['1', '1', '1', '1', 'OK']) await win.click(`.keypad button:text-is("${k}")`);
    await win.waitForSelector('text=That PIN isn’t right');
    for (const k of ['2', '4', '6', '8', 'OK']) await win.click(`.keypad button:text-is("${k}")`);
    await win.waitForSelector('text=Quit Kiosk Browser');
    const closed = new Promise((r) => app.process().once('exit', r));
    await win.click('text=Quit Kiosk Browser');
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('the app didn’t quit')), 10000))]);
    console.log('All checks passed.');
  } finally {
    for (const fn of cleanup) await Promise.resolve().then(fn).catch(() => {});
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
