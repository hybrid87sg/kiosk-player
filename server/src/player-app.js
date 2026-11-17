// The Kiosk Player TV app that comes with this server (0.11.0), so TVs can be
// updated from the dashboard instead of by hand. The release build puts
// kiosk-player.apk and kiosk-player.json ({ "version": "0.11.0", "version_code": 10 })
// in the add-on's player/ folder. Without them, updates just aren't offered.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadPlayerApp(dir, log = () => {}) {
  if (!dir) return null;
  const file = path.join(dir, 'kiosk-player.apk');
  const infoFile = path.join(dir, 'kiosk-player.json');
  try {
    if (!fs.existsSync(file) || !fs.existsSync(infoFile)) return null;
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    const versionCode = Number(info.version_code);
    if (!Number.isInteger(versionCode) || versionCode <= 0 || typeof info.version !== 'string') {
      log('TV app: kiosk-player.json has no version, so updates are not offered');
      return null;
    }
    const bytes = fs.readFileSync(file);
    const app = {
      file,
      version: info.version,
      version_code: versionCode,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    log(`TV app ${app.version} (${app.version_code}) is ready to send to screens`);
    return app;
  } catch (err) {
    log(`TV app: could not read it (${err.message}), so updates are not offered`);
    return null;
  }
}

module.exports = { loadPlayerApp };
