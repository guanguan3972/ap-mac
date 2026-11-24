const { ipcRenderer } = require('electron');

window.splashApi = {
    openUpdate: () => ipcRenderer.send('splash:open-update'),
    close: () => ipcRenderer.send('splash:close')
};
