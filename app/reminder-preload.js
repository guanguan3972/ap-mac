// 定时提醒窗口的预加载
const { ipcRenderer } = require('electron');

window.reminderApi = {
    getSchedule: () => ipcRenderer.invoke('schedule:get'),
    removeSchedule: (slot, bookId) => ipcRenderer.invoke('schedule:remove', slot, bookId),
    renameSchedule: (slot, bookId, name) => ipcRenderer.invoke('schedule:rename', slot, bookId, name),
    getAccounts: () => ipcRenderer.invoke('accounts:get'),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    getTodayStats: () => ipcRenderer.invoke('stats:today'),
    onChanged: (cb) => ipcRenderer.on('schedule:changed', () => cb())
};
