// 外壳页预加载：暴露给 shell.js 的能力
const { ipcRenderer } = require('electron');

window.shellApi = {
    getAutomation: () => ipcRenderer.invoke('get-automation'),
    saveFile: (name, text) => ipcRenderer.send('save-file', String(name), String(text)),
    readBooks: (webContentsId) => ipcRenderer.invoke('books:read', { webContentsId: Number(webContentsId) }),
    progressGet: (hash) => ipcRenderer.invoke('progress:get', String(hash || '')),
    toggleDevTools: (id) => ipcRenderer.send('toggle-devtools', Number(id)),

    // 多账号任务系统
    tasksGet: () => ipcRenderer.invoke('tasks:get'),
    tasksSave: (list) => ipcRenderer.invoke('tasks:save', list),
    taskAdd: (t) => ipcRenderer.invoke('tasks:add', t),
    taskUpdate: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
    taskRemove: (id) => ipcRenderer.invoke('tasks:remove', id),
    logsGet: () => ipcRenderer.invoke('logs:get'),
    logsClear: () => ipcRenderer.invoke('logs:clear'),
    onTaskEvent: (cb) => ipcRenderer.on('task:event', (e, p) => cb(p)),
    reportTaskStatus: (payload) => ipcRenderer.send('task:status', payload),

    getAccounts: () => ipcRenderer.invoke('accounts:get'),
    addAccount: (slot) => ipcRenderer.invoke('accounts:add', Number(slot)),
    removeAccount: (slot) => ipcRenderer.invoke('accounts:remove', Number(slot)),
    renameAccount: (slot, name) => ipcRenderer.invoke('accounts:rename', Number(slot), String(name || '')),
    setLast: (slot) => ipcRenderer.send('accounts:set-last', Number(slot)),
    setOpen: (slot, open) => ipcRenderer.invoke('accounts:set-open', Number(slot), !!open),
    setOpenTabs: (list) => ipcRenderer.invoke('accounts:set-open-tabs', list),

    openReminders: () => ipcRenderer.invoke('reminders:open'),
    openUpdater: () => ipcRenderer.invoke('updater:open'),
    openSettings: () => ipcRenderer.invoke('settings:open'),
    openEarnings: () => ipcRenderer.invoke('earnings:open'),
    openXingyue: (site) => ipcRenderer.invoke('xingyue:open', String(site || 'xingyue')),
    xyBind: (id) => ipcRenderer.invoke('xingyue:bind', Number(id)),
    syncXingyueWorks: () => ipcRenderer.invoke('xingyue:syncWorks'),
    readXingyueChapter: () => ipcRenderer.invoke('xingyue:readChapter'),
    xyOpenWork: (name) => ipcRenderer.invoke('xingyue:openWork', String(name || '')),
    xyOpenChapter: (kw) => ipcRenderer.invoke('xingyue:openChapter', String(kw || '')),
    xyCopyChapter: () => ipcRenderer.invoke('xingyue:copyChapter'),
    xyListChapters: (site) => ipcRenderer.invoke('xingyue:listChapters', site),
    xyGrabChapters: (nums, site) => ipcRenderer.invoke('xingyue:grabChapters', nums, site),
    onIntegrity: (cb) => ipcRenderer.on('integrity:result', (e, r) => cb(r)),
    checkUpdate: () => ipcRenderer.invoke('update:check'),
    applyUpdate: (m) => ipcRenderer.invoke('update:apply', m),
    getUpdateResult: () => ipcRenderer.invoke('update:get-result'),
    onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, p) => cb(p)),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (p) => ipcRenderer.invoke('settings:set', p),
    onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (e, s) => cb(s)),
    resetSlot: (slot) => ipcRenderer.invoke('accounts:reset-slot', Number(slot)),
    openHome: () => ipcRenderer.invoke('splash:open')
};
