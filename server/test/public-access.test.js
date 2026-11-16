// The add-on's own Tailscale for the public dashboard (src/public-access.js), with a pretend
// `tailscale` command: the real one can't run in tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPublicAccess } = require('../src/public-access');

const KEY = 'tskey-auth-kSECRETSECRET-abcdef';

function pretendTailscale({ loggedIn = false, acceptKey = true, funnel = 'ok' } = {}) {
  const calls = [];
  const keysSeen = [];
  let running = loggedIn;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const sub = args[1];
    if (sub === 'status') {
      return { code: 0, out: JSON.stringify({ BackendState: running ? 'Running' : 'NeedsLogin', Self: { DNSName: 'kiosk.tail1234.ts.net.' } }) };
    }
    if (sub === 'up') {
      const file = args.find((a) => a.startsWith('--auth-key=file:')).slice('--auth-key=file:'.length);
      keysSeen.push(fs.readFileSync(file, 'utf8'));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      if (!acceptKey) return { code: 1, out: 'backend error: invalid key: API key does not exist' };
      running = true;
      return { code: 0, out: '' };
    }
    if (sub === 'funnel') {
      if (funnel === 'ok') return { code: 0, out: 'Available on the internet:\nhttps://kiosk.tail1234.ts.net/\n|-- proxy http://127.0.0.1:3001\n' };
      if (funnel === 'not_allowed') return { code: 1, out: 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nABC123\n' };
      return { code: 1, out: 'something odd' };
    }
    return { code: 1, out: 'unknown' };
  };
  const daemons = [];
  const daemon = (cmd, args) => {
    daemons.push([cmd, ...args]);
    const child = new EventEmitter();
    child.kill = () => child.emit('exit', 0);
    return child;
  };
  return { run, daemon, calls, keysSeen, daemons };
}

function setup(t, options, fake) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-public-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logs = [];
  const access = createPublicAccess({ enabled: true, dataDir, doorPort: 3001, log: (m) => logs.push(m), run: fake.run, daemon: fake.daemon, retryMs: 0, ...options });
  t.after(() => access.stop());
  return { access, logs, dataDir };
}

test('switched off: nothing runs', async (t) => {
  const fake = pretendTailscale();
  const { access } = setup(t, { enabled: false }, fake);
  await access.attempt();
  assert.equal(access.status().state, 'off');
  assert.equal(fake.calls.length + fake.daemons.length, 0);
});

test('first start: logs in with the key, turns Funnel on for the door only, and never shows the key', async (t) => {
  const fake = pretendTailscale();
  const { access, logs, dataDir } = setup(t, { authKey: KEY, hostname: 'kiosk' }, fake);
  await access.attempt();
  assert.deepEqual(access.status(), { state: 'on', url: 'https://kiosk.tail1234.ts.net', hostname: 'kiosk' });
  // tailscaled runs without special rights, its state kept in the add-on's data folder.
  assert.ok(fake.daemons[0].includes('--tun=userspace-networking'));
  assert.ok(fake.daemons[0].includes(`--statedir=${path.join(dataDir, 'tailscale')}`));
  // Funnel points at the door's port, nothing else.
  assert.deepEqual(fake.calls.find((c) => c[2] === 'funnel').slice(2), ['funnel', '--bg', '--yes', '3001']);
  // The key went to Tailscale in a private file that is gone again, and appears nowhere else.
  assert.deepEqual(fake.keysSeen, [KEY]);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tailscale')).filter((f) => f.includes('authkey')), []);
  assert.equal(JSON.stringify([fake.calls, logs, access.status()]).includes('SECRET'), false);
});

test('already logged in (after a restart): no key needed', async (t) => {
  const fake = pretendTailscale({ loggedIn: true });
  const { access } = setup(t, { authKey: '' }, fake);
  await access.attempt();
  assert.equal(access.status().state, 'on');
  assert.equal(fake.calls.some((c) => c[2] === 'up'), false);
});

test('says what to do: no key, a refused key, Funnel not allowed yet', async (t) => {
  const noKey = setup(t, { authKey: '' }, pretendTailscale()).access;
  await noKey.attempt();
  assert.equal(noKey.status().state, 'needs_key');

  const refused = setup(t, { authKey: KEY }, pretendTailscale({ acceptKey: false })).access;
  await refused.attempt();
  assert.equal(refused.status().state, 'login_failed');
  assert.match(refused.status().message, /new one/);

  const notAllowed = setup(t, { authKey: KEY }, pretendTailscale({ funnel: 'not_allowed' })).access;
  await notAllowed.attempt();
  assert.equal(notAllowed.status().state, 'funnel_not_allowed');
  assert.equal(notAllowed.status().link, 'https://login.tailscale.com/f/funnel?node=nABC123');

  const odd = setup(t, { authKey: KEY }, pretendTailscale({ funnel: 'odd' }));
  await odd.access.attempt();
  assert.equal(odd.access.status().state, 'error');
});
