const { ipcRenderer } = require('electron');
window.loginApi = {
  login: (u, p) => ipcRenderer.invoke('auth:login', String(u || ''), String(p || '')),
  done: () => ipcRenderer.send('auth:done')
};