const { ipcRenderer } = require('electron');

window.settingsApi = {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
};