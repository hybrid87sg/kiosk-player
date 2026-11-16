// The public web dashboard's way onto the internet (0.8.0): the add-on runs its own small
// Tailscale (as its own machine, e.g. "kiosk" → https://kiosk.your-tailnet.ts.net) and turns on
// Funnel for one thing only: the public door (createPublicServer in app.js, on a port that
// only this add-on can reach). Home Assistant's own Tailscale add-on can't do this: its Funnel
// only shows Home Assistant itself.
//
// Steps, retried every minute until they work:
//   1. start tailscaled (userspace networking: no special rights needed in the add-on),
//   2. log in with the auth key from the add-on's options (only needed the first time; Tailscale
//      remembers it in /data/tailscale),
//   3. `tailscale funnel --bg <door port>`.
// status() says where it got to, in words the Settings page shows.
//
// The auth key is a secret: it is handed to Tailscale in a file that is deleted straight after,
// and never logged or shown.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RETRY_MS = 60 * 1000;
const FUNNEL_LINK = /https:\/\/login\.tailscale\.com\/\S+/;

// Runs a command and collects its output. Never throws: { code, out }.
function runCommand(cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: err.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

function startDaemon(cmd, args) {
  return spawn(cmd, args, { stdio: 'ignore' });
}

function createPublicAccess({
  enabled,
  dataDir,
  authKey = '',
  hostname = 'kiosk',
  doorPort,
  log = () => {},
  run = runCommand,
  daemon = startDaemon,
  retryMs = RETRY_MS,
}) {
  const stateDir = path.join(dataDir, 'tailscale');
  const socket = path.join(stateDir, 'tailscaled.sock');
  const ts = (...args) => run('tailscale', [`--socket=${socket}`, ...args]);
  let state = enabled ? { state: 'starting' } : { state: 'off' };
  let child = null;
  let timer = null;
  let stopped = false;

  const set = (next) => {
    if (next.state !== state.state) log(`Public dashboard: ${next.state}${next.url ? ` at ${next.url}` : ''}`);
    state = next;
  };

  function startTailscaled() {
    if (child) return;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    child = daemon('tailscaled', [
      '--tun=userspace-networking', `--statedir=${stateDir}`, `--socket=${socket}`, '--port=0',
    ]);
    child.on('exit', () => { child = null; }); // started again on the next try
    child.on('error', () => { child = null; });
  }

  async function backendState() {
    const res = await ts('status', '--json');
    if (res.code !== 0 && !res.out.trim().startsWith('{')) return { backend: null, out: res.out };
    try {
      const json = JSON.parse(res.out);
      return { backend: json.BackendState, dnsName: json.Self && json.Self.DNSName };
    } catch {
      return { backend: null, out: res.out };
    }
  }

  async function logIn() {
    if (!authKey) {
      set({ state: 'needs_key', message: 'Add a Tailscale auth key in the Kiosk add-on’s Configuration tab (Public dashboard), then restart the add-on.' });
      return false;
    }
    const keyFile = path.join(stateDir, `.authkey-${process.pid}`);
    fs.writeFileSync(keyFile, authKey, { mode: 0o600 });
    let res;
    try {
      res = await ts('up', `--auth-key=file:${keyFile}`, `--hostname=${hostname}`, '--timeout=60s');
    } finally {
      fs.rmSync(keyFile, { force: true });
    }
    if (res.code !== 0) {
      set({ state: 'login_failed', message: 'Tailscale refused the auth key. Make a new one (Tailscale admin console → Settings → Keys), put it in the add-on’s Configuration tab and restart the add-on.' });
      return false;
    }
    return true;
  }

  async function turnOnFunnel(dnsName) {
    const res = await ts('funnel', '--bg', '--yes', String(doorPort));
    const link = (res.out.match(FUNNEL_LINK) || [])[0] || null;
    if (res.code === 0 && !/not enabled|not allowed/i.test(res.out)) {
      set({ state: 'on', url: dnsName ? `https://${dnsName.replace(/\.$/, '')}` : null });
      return;
    }
    if (/funnel/i.test(res.out) && /not (enabled|allowed)|enable/i.test(res.out)) {
      set({ state: 'funnel_not_allowed', message: 'Funnel isn’t allowed for this machine yet. Open the link (as the Tailscale account owner) to allow it; Kiosk tries again every minute.', link });
      return;
    }
    if (/https|certificate|serve/i.test(res.out) && link) {
      set({ state: 'https_not_enabled', message: 'HTTPS certificates aren’t turned on in your tailnet yet. Open the link to turn them on; Kiosk tries again every minute.', link });
      return;
    }
    set({ state: 'error', message: 'Tailscale couldn’t turn on Funnel. Kiosk tries again every minute; see the add-on’s Log tab.' });
    log(`Public dashboard: tailscale funnel said: ${res.out.replace(/tskey-[\w-]+/g, 'tskey-…').slice(0, 300)}`);
  }

  async function attempt() {
    if (stopped || !enabled) return;
    try {
      startTailscaled();
      let info = await backendState();
      for (let i = 0; i < 10 && info.backend === null; i++) { // tailscaled is still starting
        await new Promise((r) => setTimeout(r, 500));
        info = await backendState();
      }
      if (info.backend === null) {
        set({ state: 'error', message: 'Tailscale didn’t start inside the add-on. See the add-on’s Log tab.' });
        return;
      }
      if (info.backend === 'NeedsLogin' || info.backend === 'NoState') {
        if (!(await logIn())) return;
        info = await backendState();
      }
      if (info.backend !== 'Running') {
        set({ state: 'starting' });
        return;
      }
      await turnOnFunnel(info.dnsName);
    } catch (err) {
      set({ state: 'error', message: 'Something went wrong starting the public dashboard. See the add-on’s Log tab.' });
      log(`Public dashboard: ${err.message}`);
    }
  }

  async function loop() {
    await attempt();
    if (!stopped && enabled) {
      timer = setTimeout(loop, state.state === 'on' ? retryMs * 5 : retryMs);
      timer.unref?.();
    }
  }

  return {
    start: () => (enabled ? loop() : Promise.resolve()),
    attempt,
    status: () => ({ ...state, hostname: enabled ? hostname : null }),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (child) child.kill('SIGTERM');
    },
  };
}

module.exports = { createPublicAccess, runCommand };
