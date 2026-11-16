// Runs inside the customer's web page (isolated from the page's own scripts). It only
// tells the app that someone is still using the kiosk, and notices the staff corner tap.
const { ipcRenderer } = require('electron');

let last = 0;
const active = () => {
  const now = Date.now();
  if (now - last > 1000) { last = now; ipcRenderer.send('activity'); }
};
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input', 'scroll']) {
  window.addEventListener(type, active, { capture: true, passive: true });
}

// Staff: 5 taps in the top-left corner within 3 seconds.
let taps = [];
window.addEventListener('pointerdown', (e) => {
  if (e.clientX > 80 || e.clientY > 80) return;
  const now = Date.now();
  taps = taps.filter((t) => now - t < 3000).concat(now);
  if (taps.length >= 5) { taps = []; ipcRenderer.send('staff'); }
}, { capture: true, passive: true });
