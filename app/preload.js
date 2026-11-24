// 页面内 preload：把主进程能力暴露给番茄页面
// 关键：webview 的 preload 默认在隔离上下文里，直接挂 window.xxx 页面读不到，
// 必须用 contextBridge 暴露到主世界。
const { ipcRenderer, contextBridge } = require('electron');

function expose(name, fn) {
    // 方式一：隔离上下文（Electron 默认）
    try {
        if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
            contextBridge.exposeInMainWorld(name, fn);
        }
    } catch (e) { /* ignore */ }

    // 方式二：非隔离上下文（contextIsolation=false）
    try {
        if (typeof window[name] !== 'function') window[name] = fn;
    } catch (e) { /* ignore */ }
}

expose('__saveSchedule', function (text) {
    try { ipcRenderer.send('schedule:add', String(text)); } catch (e) { /* ignore */ }
});

expose('__saveDump', function (text) {
    try { ipcRenderer.send('save-dump', String(text)); } catch (e) { /* ignore */ }
});


// 给页面脚本用的诊断上报通道：内容直接写到 AppData，方便排查
try {
    contextBridge.exposeInMainWorld('__xbuReport', (name, data) => {
        try { ipcRenderer.send('xbu:report', String(name || 'report'), data); } catch (e) { /* ignore */ }
    });
} catch (e) { /* ignore */ }


// 已发章号（防重复上传）
expose('__xbuProgressGet', function (bookHash) {
    try { return ipcRenderer.invoke('progress:get', String(bookHash || '')); } catch (e) { return Promise.resolve({ max: 0, nums: [] }); }
});

expose('__xbuProgressSet', function (bookHash, num) {
    try { return ipcRenderer.invoke('progress:set', String(bookHash || ''), Number(num) || 0); } catch (e) { return Promise.resolve(null); }
});


// 读取这本书的定时记录（用于"接着上次往后排"）
expose('__xbuScheduleGet', function (bookHash) {
    try { return ipcRenderer.invoke('schedule:find', String(bookHash || '')); } catch (e) { return Promise.resolve(null); }
});


// 每日统计上报
expose('__xbuStats', function (bookHash, chapters, words) {
    try { ipcRenderer.send('stats:add', String(bookHash || ''), Number(chapters) || 0, Number(words) || 0); } catch (e) { /* ignore */ }
});


// 收益上报（用户在收益页时自动扫描）
expose('__xbuIncome', function (bookHash, amount) {
    try { ipcRenderer.send('stats:income', window.__novelUploaderSlot || 0, String(bookHash || ''), Number(amount) || 0); } catch (e) { /* ignore */ }
});


// 多账号任务系统：日志上报（自动带 slot / 任务上下文）
expose('__xbuLog', function (level, msg, taskId, bookName) {
    try {
        ipcRenderer.send('task:log', {
            slot: window.__novelUploaderSlot || 0,
            taskId: String(taskId || ''),
            bookName: String(bookName || ''),
            level: String(level || 'info'),
            msg: String(msg || '')
        });
    } catch (e) { /* ignore */ }
});

// 任务状态回报
expose('__xbuTaskStatus', function (taskId, status) {
    try {
        ipcRenderer.send('task:status', {
            slot: window.__novelUploaderSlot || 0,
            taskId: String(taskId || ''),
            status: String(status || '')
        });
    } catch (e) { /* ignore */ }
});

// 读任务当前状态（跳章后用来判断是否还处于「已暂停」）
expose('__xbuTaskGet', function (taskId) {
    try { return ipcRenderer.invoke('tasks:status-get', String(taskId || '')); } catch (e) { return Promise.resolve(null); }
});

// 任务发布进度回报：done=本批已发章数，total=本批总章数，lastChapter=刚发完的章号
expose('__xbuTaskProgress', function (taskId, done, total, lastChapter) {
    try {
        ipcRenderer.send('task:progress', {
            slot: window.__novelUploaderSlot || 0,
            taskId: String(taskId || ''),
            done: Number(done) || 0,
            total: Number(total) || 0,
            lastChapter: Number(lastChapter) || 0
        });
    } catch (e) { /* ignore */ }
});
