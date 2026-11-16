// Finds Kiosk servers on this PC's network, like the TV app: asks every address of each
// local network (x.x.x.1–254) on port 3000 "are you a Kiosk server?" (/api/config).

const os = require('node:os');

function localNetworks() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && a.netmask === '255.255.255.0') out.push(a.address);
    }
  }
  return [...new Set(out)];
}

async function ask(url, fetchImpl) {
  try {
    const res = await fetchImpl(`${url}/api/config`, { signal: AbortSignal.timeout(2500) });
    const config = await res.json();
    if (config && config.kind === 'kiosk-signage') {
      return { url, serverId: config.server_id || null, role: config.role || 'main', siteName: config.site_name || null };
    }
  } catch { /* nothing there */ }
  return null;
}

async function findServers({ port = 3000, addresses = localNetworks(), fetchImpl = fetch, parallel = 48 } = {}) {
  const targets = [];
  for (const own of addresses) {
    const prefix = own.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) targets.push(`http://${prefix}.${i}:${port}`);
  }
  const found = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, targets.length) }, async () => {
    while (next < targets.length) {
      const result = await ask(targets[next++], fetchImpl);
      if (result) found.push(result);
    }
  }));
  // A relay (this site's own Home Assistant) first: it's the closest; then the main server.
  return found.sort((a, b) => (a.role === 'relay' ? 0 : 1) - (b.role === 'relay' ? 0 : 1) || String(a.siteName).localeCompare(String(b.siteName)));
}

module.exports = { findServers, localNetworks, ask };
