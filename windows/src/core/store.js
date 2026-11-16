// What the PC remembers between restarts (a small JSON file in the app's data folder):
// the server's address and id, this PC's token, and the last playlist (to play offline).

const fs = require('node:fs');
const path = require('node:path');

function createStore(dir) {
  const file = path.join(dir, 'kiosk-browser.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first start */ }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    get: (key) => data[key],
    set(key, value) {
      if (value === undefined || value === null) delete data[key];
      else data[key] = value;
      save();
    },
    clear() { data = {}; save(); },
  };
}

module.exports = { createStore };
