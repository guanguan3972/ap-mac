const { ipcRenderer } = require('electron');

window.updaterApi = {
    info: () => ipcRenderer.invoke('update:info'),
    setFeed: (url) => ipcRenderer.invoke('update:set-feed', String(url || '')),
    check: () => ipcRenderer.invoke('update:check'),
    apply: (meta) => ipcRenderer.invoke('update:apply', meta),
    applyFile: () => ipcRenderer.invoke('update:apply-file')
};