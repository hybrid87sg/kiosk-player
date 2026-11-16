// The bridge between player.html and the app (main.js). Only these calls exist.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  onState: (fn) => ipcRenderer.on('state', (e, state) => fn(state)),
  onNotice: (fn) => ipcRenderer.on('notice', (e, text) => fn(text)),
  onStaff: (fn) => ipcRenderer.on('staff', () => fn()),
  touch: () => ipcRenderer.send('touch'),
  back: () => ipcRenderer.send('back'),
  startOver: () => ipcRenderer.send('start-over'),
  playing: (mediaId, error) => ipcRenderer.send('playing', mediaId, error),
  staff: () => ipcRenderer.send('staff'),
  checkPin: (pin) => ipcRenderer.invoke('staff-pin', pin),
  staffAction: (action) => ipcRenderer.send('staff-action', action),
  findServers: () => ipcRenderer.invoke('find-servers'),
  connect: (url) => ipcRenderer.invoke('connect', url),
});
