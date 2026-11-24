// 弹窗预加载
const { ipcRenderer } = require('electron');

window.toastApi = {
    close: () => ipcRenderer.send('toast:close'),
    openReminders: () => ipcRenderer.send('toast:open-reminders')
};
