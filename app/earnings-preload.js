const { ipcRenderer } = require('electron');
window.earningsApi = {
    get: () => ipcRenderer.invoke('earnings:get'),
    setIncome: (v) => ipcRenderer.invoke('earnings:set-income', Number(v) || 0),
    add: (n, v) => ipcRenderer.invoke('earnings:add', String(n || ''), Number(v) || 0),
    finish: (v) => ipcRenderer.invoke('earnings:finish', Number(v) || 0),
    unfinish: () => ipcRenderer.invoke('earnings:unfinish'),
    del: (k) => ipcRenderer.invoke('earnings:delete', String(k)),
    clear: () => ipcRenderer.invoke('earnings:clear')
};