// 小白星月自动上传助手 — 桌面版主进程（单窗口多账号）
const { app, BrowserWindow, ipcMain, Menu, shell, webContents, session, screen, dialog, clipboard } = require('electron');
// 允许无用户交互的窗口播放提示音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

/* ---------------- 目录 ---------------- */
// 程序目录只放程序；登录状态、日志、诊断文件统一放 AppData，
// 这样把整个程序文件夹压缩转发出去，也不会带走任何账号信息。
const APP_HOME = path.dirname(process.execPath);
const DATA_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'XiaobaiUploader');

/* ---------------- 日志 ---------------- */
const LOG_PATH = path.join(DATA_DIR, 'startup.log');
function flog(msg) {
    try {
        fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) { /* ignore */ }
}
process.on('uncaughtException', (e) => flog('uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => flog('unhandledRejection: ' + (e && e.stack ? e.stack : e)));
flog('boot start, electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);

/* ---------------- 便携目录 ---------------- */
const PORTABLE_DATA = DATA_DIR;   // 兼容旧变量名

try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    app.setPath('userData', DATA_DIR);
} catch (e) {
    flog('数据目录初始化失败: ' + (e && e.message));
}

/* ---------------- 旧版数据迁移 ---------------- */
function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else {
            try { fs.copyFileSync(s, d); } catch (e) { /* 跳过被占用的文件 */ }
        }
    }
}

function migrateLegacyData() {
    const legacy = path.join(APP_HOME, 'userdata');
    const already = path.join(DATA_DIR, 'Partitions');

    if (fs.existsSync(legacy) && !fs.existsSync(already)) {
        try {
            copyDirSync(legacy, DATA_DIR);
            flog('已把旧 userdata 迁移到 ' + DATA_DIR);
        } catch (e) {
            flog('迁移旧数据失败: ' + (e && e.message));
        }
    }

    if (fs.existsSync(legacy)) {
        const migrated = fs.existsSync(path.join(DATA_DIR, 'Partitions'));
        if (migrated) {
            // 已经复制到 AppData，程序目录里这份就删掉，免得被一起打包
            try {
                fs.rmSync(legacy, { recursive: true, force: true });
                flog('已删除程序目录里的旧 userdata');
            } catch (e) {
                const bak = path.join(APP_HOME, 'userdata.已迁移可删除');
                try { fs.renameSync(legacy, bak); } catch (e2) { /* ignore */ }
                flog('删除失败，已改名为 userdata.已迁移可删除');
            }
        }
    }

    for (const name of ['startup.log', 'debug.log', 'dump-inputs.json', 'dump-publish.html', 'dump-timed.json']) {
        const p = path.join(APP_HOME, name);
        if (!fs.existsSync(p)) continue;
        try {
            fs.renameSync(p, path.join(DATA_DIR, name));
        } catch (e) {
            try { fs.rmSync(p, { force: true }); } catch (e2) { /* ignore */ }
        }
    }
}

try { migrateLegacyData(); } catch (e) { flog('migrate 异常: ' + (e && e.message)); }


/* ---------------- 上传脚本 ---------------- */
let AUTOMATION = '';
try {
    AUTOMATION = fs.readFileSync(path.join(__dirname, 'userscript.js'), 'utf8');
} catch (e) {
    flog('读取脚本失败: ' + e.message);
}

/* ---------------- 写文件（诊断用） ---------------- */
function safeWrite(name, text) {
    const dir = DATA_DIR;
    const base = path.basename(String(name)).replace(/[\\/:*?"<>|]/g, '_');
    try {
        fs.writeFileSync(path.join(dir, base), String(text), 'utf8');
        flog('已写入 ' + base + ' (' + String(text).length + ' 字节)');
    } catch (e) {
        flog('写入 ' + base + ' 失败: ' + (e && e.message));
    }
}


/* ---------------- 程序完整性校验（防篡改/防夹带） ---------------- */
const INTEGRITY_FILE = path.join(__dirname, 'integrity.json');
const INTEGRITY_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK0yUwyqNHZgfkYa0AMvaKhnVFSiEfgyCAv1NBigXnJE=
-----END PUBLIC KEY-----`;

function verifyIntegrity() {
    let raw;
    try {
        raw = fs.readFileSync(INTEGRITY_FILE, 'utf8');
    } catch (e) {
        // 没有清单（开发版）就跳过
        return { ok: true, skipped: true };
    }

    let doc, payload, files;
    try {
        doc = JSON.parse(raw);
        payload = doc.payload;
        files = JSON.parse(doc.payload).files;
    } catch (e) {
        return { ok: false, reason: '清单损坏' };
    }

    // 1) 验签：确认清单是作者签发的
    let good = false;
    try {
        good = crypto.verify(null, Buffer.from(payload, 'utf8'), INTEGRITY_PUBKEY, Buffer.from(doc.sig, 'base64'));
    } catch (e) {
        good = false;
    }
    if (!good) return { ok: false, reason: '签名不匹配（不是官方签发）' };

    // 2) 逐个文件比对哈希
    const bad = [];
    for (const name of Object.keys(files)) {
        const full = path.join(__dirname, name);
        try {
            const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            if (h !== files[name]) bad.push(name);
        } catch (e) {
            bad.push(name + '（缺失）');
        }
    }

    // 3) 出现清单里没有的文件，也提示（可能是被塞进来的）
    const extra = [];
    try {
        for (const name of fs.readdirSync(__dirname)) {
            if (name === 'integrity.json') continue;
            const full = path.join(__dirname, name);
            if (!fs.statSync(full).isFile()) continue;
            if (!files[name]) extra.push(name);
        }
    } catch (e) { /* ignore */ }

    if (bad.length || extra.length) {
        return { ok: false, reason: '文件被改动', bad: bad, extra: extra };
    }
    return { ok: true, count: Object.keys(files).length };
}

/* ---------------- 账号列表（以磁盘 accounts.json 为准） ---------------- */
const ACCOUNTS_FILE = path.join(PORTABLE_DATA, 'accounts.json');

/* ---------------- 多账号任务系统 ---------------- */
// 任务与运行日志都存 AppData，不进程序目录（不泄露隐私）
const TASKS_FILE = path.join(PORTABLE_DATA, 'tasks.json');
const TASK_LOGS_FILE = path.join(PORTABLE_DATA, 'task-logs.json');
const TASK_LOG_MAX = 2000; // 日志环形上限，防止无限增长

function readTasks() {
    try {
        const o = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        return Array.isArray(o) ? o : [];
    } catch (e) { return []; }
}
function writeTasks(list) {
    try { fs.writeFileSync(TASKS_FILE, JSON.stringify(list || [], null, 2), 'utf8'); } catch (e) { /* ignore */ }
}
function readTaskLogs() {
    try {
        const o = JSON.parse(fs.readFileSync(TASK_LOGS_FILE, 'utf8'));
        return Array.isArray(o) ? o : [];
    } catch (e) { return []; }
}
function writeTaskLogs(list) {
    try {
        const trimmed = (list || []).slice(-TASK_LOG_MAX);
        fs.writeFileSync(TASK_LOGS_FILE, JSON.stringify(trimmed), 'utf8');
    } catch (e) { /* ignore */ }
}
function broadcastTaskEvent(payload) {
    for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('task:event', payload); } catch (e) { /* ignore */ }
    }
}

// 磁盘上真实存在的账号分区（fanqie-1、fanqie-2……）
function existingPartitionSlots() {
    const dir = path.join(PORTABLE_DATA, 'Partitions');
    const out = [];
    try {
        for (const name of fs.readdirSync(dir)) {
            const m = /^fanqie-(\d+)$/.exec(name);
            if (m) out.push(Number(m[1]));
        }
    } catch (e) { /* 首次运行没有该目录 */ }
    return out;
}

function readAccounts() {
    let stored = [];
    let last = 0;
    let rawNames = {};
    let closed = [];
    let openTabs = null;
    try {
        const a = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        stored = Array.isArray(a.slots) ? a.slots.filter(n => Number.isInteger(n) && n > 0) : [];
        last = Number(a.last) || 0;
        if (a.names && typeof a.names === 'object') rawNames = a.names;
        if (Array.isArray(a.closed)) closed = a.closed.filter(n => Number.isInteger(n));
        if (Array.isArray(a.openTabs)) openTabs = a.openTabs.filter(n => Number.isInteger(n) && n > 0);
    } catch (e) { /* 首次运行 */ }

    // 只认 accounts.json 里登记的账号；磁盘上残留的分区目录不再算作账号
    let slots = Array.from(new Set(stored)).sort((x, y) => x - y);

    // 自动剔除空槽位：既没有分区目录、也没有自定义名字、又不在当前打开列表里的，
    // 说明它没有实际数据（多为历史脏数据），直接丢掉
    const tabs = Array.isArray(openTabs) ? openTabs : [];
    const kept = slots.filter((s) => {
        if (tabs.includes(s)) return true;
        if (rawNames && rawNames[s]) return true;
        return fs.existsSync(path.join(DATA_DIR, 'Partitions', 'fanqie-' + s));
    });
    if (kept.length !== slots.length) {
        slots = kept;
        try {
            const fixed = { slots: slots, last: last, names: rawNames };
            if (Array.isArray(openTabs)) fixed.openTabs = openTabs.filter(s => slots.includes(s));
            fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(fixed, null, 2), 'utf8');
            flog('已自动清理 ' + (kept.length ? (stored.length - kept.length) : 0) + ' 个空账号槽位');
        } catch (e) { /* ignore */ }
    }

    if (!slots.length) slots = [1];
    if (!slots.includes(last)) last = slots[0];

    // 只保留当前存在的账号的名字
    const names = {};
    for (const s of slots) {
        const v = rawNames[s];
        if (v && String(v).trim()) names[s] = String(v).trim().slice(0, 20);
    }
    const closedSlots = closed.filter(s => slots.includes(s));
    const openList = (openTabs === null) ? null : openTabs.filter(s => slots.includes(s));
    return { slots, last, names, closed: closedSlots, openTabs: openList };
}

function writeAccounts(a) {
    try {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2), 'utf8');
    } catch (e) {
        flog('写 accounts.json 失败: ' + (e && e.message));
    }
}



/* ---------------- 应用内更新 ---------------- */
// macOS 版是 .app/…dmg，更新包（zip + 替换 resources/app）那套只适用于 Windows 目录版
const IS_MAC = process.platform === 'darwin';

let PKG_VERSION = '0.0.0';
try { PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; } catch (e) { /* ignore */ }

const UPDATE_CFG = path.join(DATA_DIR, 'update.json');

// 默认更新源：按顺序尝试，前面的没有缓存、更可靠
const GH_OWNER = 'guanguan3972';
const GH_REPO = '-';
const GH_BRANCH = 'main';

// Gitee 主源（国内稳定、不卡）
const GITEE_OWNER = 'guanguan520';
const GITEE_REPO = 'update1';
const GITEE_BRANCH = 'master';

const SOURCES_GH = [
    'https://gitee.com/' + GITEE_OWNER + '/' + GITEE_REPO + '/raw/' + GITEE_BRANCH + '/update.json',
    'https://cdn.jsdelivr.net/gh/' + GH_OWNER + '/' + GH_REPO + '@' + GH_BRANCH + '/update.json',
    'https://raw.githubusercontent.com/' + GH_OWNER + '/' + GH_REPO + '/' + GH_BRANCH + '/update.json'
];

const DEFAULT_FEED = SOURCES_GH[0];
const FALLBACK_FEED = SOURCES_GH[1];

function feedUrl() {
    const cfg = readUpdateCfg();
    return (cfg.feed && String(cfg.feed).trim()) || DEFAULT_FEED;
}

function readUpdateCfg() {
    try { return JSON.parse(fs.readFileSync(UPDATE_CFG, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeUpdateCfg(o) {
    try { fs.writeFileSync(UPDATE_CFG, JSON.stringify(o, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}
function cmpVersion(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

let updaterWin = null;

function openUpdaterWindow() {
    if (updaterWin && !updaterWin.isDestroyed()) {
        updaterWin.show(); updaterWin.focus();
        return updaterWin;
    }
    updaterWin = new BrowserWindow({
        width: 460, height: 400, resizable: false,
        title: '检查更新', autoHideMenuBar: true,
        backgroundColor: '#f7f9fc',
        webPreferences: {
            preload: path.join(__dirname, 'updater-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });
    updaterWin.setMenuBarVisibility(false);
    updaterWin.loadFile(path.join(__dirname, 'updater.html'));
    updaterWin.on('closed', () => { updaterWin = null; });
    return updaterWin;
}

/* ---------------- 定时计划记录 ---------------- */
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

function bookHashOf(raw) {
    const s = String(raw || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return '#' + h.toString(16).padStart(8, '0').slice(0, 8);
}

// 只保留脱敏字段：不存书名、不存原始书号
function sanitizeRecord(rec) {
    if (!rec) return null;
    const hash = rec.bookHash || (rec.bookId ? bookHashOf(rec.bookId) : '');
    if (!hash) return null;
    return {
        slot: Number(rec.slot) || 0,
        bookHash: hash,
        bookName: String(rec.bookName || '').slice(0, 40),
        last: String(rec.last || ''),
        count: Number(rec.count) || 0,
        lastChapter: Number(rec.lastChapter) || 0,
        source: rec.source || 'manual',
        updated: Number(rec.updated) || Date.now()
    };
}

function readSchedule() {
    let raw = [];
    try {
        const arr = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        raw = Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }

    // 迁移旧格式：带 bookName / bookId 的记录一律脱敏并重写
    let dirty = false;
    const clean = [];
    for (const r of raw) {
        if (r.bookId !== undefined) dirty = true;
        const s = sanitizeRecord(r);
        if (s) clean.push(s);
    }
    if (dirty) {
        try {
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(clean, null, 2), 'utf8');
            flog('已清除 schedule.json 里的书名等隐私字段');
        } catch (e) { /* ignore */ }
    }
    return clean;
}

function writeSchedule(list) {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        flog('写 schedule.json 失败: ' + (e && e.message));
    }
}

let reminderWin = null;

function notifyReminder() {
    if (reminderWin && !reminderWin.isDestroyed()) {
        try { reminderWin.webContents.send('schedule:changed'); } catch (e) { /* ignore */ }
    }
}

/* ---------------- IPC ---------------- */
// 每次注入都重新读文件，这样更新 userscript.js 后刷新页面即可生效，无需重启程序
ipcMain.handle('get-automation', () => {
    try {
        return fs.readFileSync(path.join(__dirname, 'userscript.js'), 'utf8');
    } catch (e) {
        flog('读取脚本失败（用内存副本）: ' + (e && e.message));
        return AUTOMATION;
    }
});


ipcMain.on('schedule:add', (event, text) => {
    let raw;
    try { raw = JSON.parse(String(text)); } catch (e) { return; }
    const rec = sanitizeRecord(raw);
    if (!rec) return;

    const list = readSchedule();
    const idx = list.findIndex(x => String(x.slot) === String(rec.slot) && x.bookHash === rec.bookHash);
    if (idx >= 0) {
        const old = list[idx];
        const merged = Object.assign({}, old, rec);
        // 扫描记录本身没有章数和章节号，不能把已有信息冲成 0
        if (!rec.count && old.count) merged.count = old.count;
        if (!rec.lastChapter && old.lastChapter) merged.lastChapter = old.lastChapter;
        if (!rec.bookName && old.bookName) merged.bookName = old.bookName;
        list[idx] = merged;
    } else {
        list.push(rec);
    }
    writeSchedule(list);
    notifyReminder();
    flog('记录定时计划: ' + rec.bookHash + ' -> ' + rec.last);
});


/* ---------------- 更新 IPC ---------------- */
ipcMain.handle('update:info', () => ({ current: PKG_VERSION, feed: feedUrl(), isDefault: !readUpdateCfg().feed }));

ipcMain.handle('update:set-feed', (event, url) => {
    const v = String(url || '').trim();
    const o = readUpdateCfg();

    // 空 = 恢复默认更新源
    if (!v) {
        delete o.feed;
        writeUpdateCfg(o);
        flog('已恢复默认更新源');
        return { ok: true, feed: feedUrl(), isDefault: true };
    }

    if (!/^https:\/\//i.test(v)) {
        return { ok: false, error: '地址要以 https:// 开头', feed: o.feed || '', isDefault: !o.feed };
    }
    if (!/\.json$/i.test(v)) {
        return { ok: false, error: '地址要以 .json 结尾（这是更新信息文件）', feed: o.feed || '', isDefault: !o.feed };
    }

    o.feed = v;
    writeUpdateCfg(o);
    flog('更新源已设置: ' + v);
    return { ok: true, feed: v, isDefault: false };
});

ipcMain.handle('update:check', async () => {
    // Mac 版不支持这种「下 zip 替换目录」的更新方式，直接给出明确提示
    if (IS_MAC) return { ok: false, reason: 'Mac 版请到发布页下载新的 .dmg 安装，不支持应用内更新' };

    const custom = readUpdateCfg().feed;
    const sources = custom ? [custom].concat(SOURCES_GH) : SOURCES_GH.slice();

    let lastErr = '';
    for (const feed of sources) {
        try {
            const url = feed + (feed.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) { lastErr = '更新源暂时打不开（HTTP ' + res.status + '）'; continue; }
            let meta = await res.json();
            // GitHub API 会包一层 {content: base64, encoding: 'base64'}
            if (meta && meta.encoding === 'base64' && meta.content) {
                try {
                    const raw = Buffer.from(meta.content, 'base64').toString('utf8');
                    meta = JSON.parse(raw);
                } catch (e) { lastErr = '更新源内容解析失败'; continue; }
            }
            if (!meta || !meta.version) { lastErr = '更新源内容格式不对'; continue; }
            return {
                ok: true,
                current: PKG_VERSION,
                latest: meta.version,
                newer: cmpVersion(meta.version, PKG_VERSION) > 0,
                url: meta.url || '',
                sha256: meta.sha256 || '',
                notes: meta.notes || ''
            };
        } catch (e) {
            lastErr = '网络不通，请检查网络后重试';
        }
    }
    return { ok: false, reason: lastErr || '检查失败，请稍后重试' };
});

// 旧的解析逻辑保留在下方（不会被调用）
async function legacyCheck(feed) {
    try {
        const url = feed + (feed.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
        const meta = await res.json();
        if (!meta || !meta.version) return { ok: false, reason: '更新源格式不对' };
        return {
            ok: true,
            current: PKG_VERSION,
            latest: meta.version,
            newer: cmpVersion(meta.version, PKG_VERSION) > 0,
            url: meta.url || '',
            sha256: meta.sha256 || '',
            notes: meta.notes || ''
        };
    } catch (e) {
        return { ok: false, reason: (e && e.message) || '网络错误' };
    }
}

// 解压 + 写结果标记 + 交给独立看门狗替换重启（在线更新和本地文件更新共用）
// 关键改进：
//   1) 替换由独立 PowerShell 看门狗执行，它先等主进程 PID 真正退出再动手，不靠固定 sleep 猜时序
//   2) 每一步失败都会把 app.old 回滚成 app，不会留下半新半旧的目录
//   3) 替换后核对新 package.json 的版本，确认真的装上了
//   4) 结果写入 update-status.json，下次启动弹窗告知成功/失败
//   5) 无论成败都会重新启动程序，用户不会面对"点了更新程序却没了"
async function applyZipAndRestart(zipPath) {
    const dir = path.join(DATA_DIR, 'update');
    const outDir = path.join(dir, 'app');
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    const psCmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${outDir}" -Force`;
    await new Promise((resolve, reject) => {
        // Mac 上没有 powershell.exe，改用系统自带 unzip
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'powershell.exe' : 'unzip';
        const args = isWin
            ? ['-NoProfile', '-NonInteractive', '-Command', psCmd]
            : ['-o', '-q', zipPath, '-d', outDir];
        const p = spawn(cmd, args, { windowsHide: true });
        p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('解压失败 ' + code)));
        p.on('error', reject);
    });

    let appSrc = outDir;
    try {
        const items = fs.readdirSync(outDir);
        if (items.length === 1 && fs.statSync(path.join(outDir, items[0])).isDirectory()) {
            appSrc = path.join(outDir, items[0]);
        }
    } catch (e) { /* ignore */ }

    if (!fs.existsSync(path.join(appSrc, 'main.js'))) {
        return { ok: false, reason: '更新包不完整（缺少程序文件）' };
    }

    // 版本闸：只允许装比当前新的包，防止被旧包降级
    let packVer = '';
    try {
        packVer = JSON.parse(fs.readFileSync(path.join(appSrc, 'package.json'), 'utf8')).version || '';
    } catch (e) { /* ignore */ }
    if (packVer && cmpVersion(packVer, PKG_VERSION) <= 0) {
        return { ok: false, reason: '这个包是 v' + packVer + '，不比当前的 v' + PKG_VERSION + ' 新，已取消' };
    }

    const appDir = path.join(APP_HOME, 'resources', 'app');
    const exePath = process.execPath;
    const ps1Path = path.join(dir, 'apply.ps1');
    const statusPath = path.join(dir, 'update-status.json');
    const curPid = process.pid;

    // 先清掉上一次的更新结果，避免本次启动读到旧标记
    try { fs.rmSync(statusPath, { force: true }); } catch (e) { /* ignore */ }

    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const ps = [
        '$ErrorActionPreference = "Stop"',
        '$log = ' + q(path.join(dir, 'apply.log')),
        'function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("s") + " " + $m) -Encoding UTF8 } catch {} }',
        'function Write-Status($ok, $reason) {',
        '  $o = [ordered]@{ ok = $ok; from = ' + q(PKG_VERSION) + '; to = ' + q(packVer) + '; reason = $reason; at = (Get-Date).ToString("s") }',
        '  ($o | ConvertTo-Json -Compress) | Set-Content -LiteralPath ' + q(statusPath) + ' -Encoding UTF8',
        '}',
        'L "watcher start, wait pid ' + curPid + '"',
        '$app = ' + q(appDir),
        '$src = ' + q(appSrc),
        '$bak = $app + ".bak"',
        '$moved = $false',
        'try {',
        // 1) 等主进程真的退出（最多约 40 秒），用 PID 判定而非固定 sleep
        '  for ($i = 0; $i -lt 80; $i++) {',
        '    $p = Get-Process -Id ' + curPid + ' -ErrorAction SilentlyContinue',
        '    if (-not $p) { L "main process exited"; break }',
        '    Start-Sleep -Milliseconds 500',
        '  }',
        '  $still = Get-Process -Id ' + curPid + ' -ErrorAction SilentlyContinue',
        '  if ($still) { throw "主进程没有正常退出，已取消更新" }',
        // 2) 再兜底等句柄释放
        '  Start-Sleep -Seconds 2',
        // 3) 替换：先备份现有 app 到 .bak，再把新文件复制进 app
        '  if (-not (Test-Path -LiteralPath ($src + "\\main.js"))) { throw "更新包不完整，缺少程序文件" }',
        '  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue }',
        '  for ($k = 0; $k -lt 20; $k++) {',
        '    try { Rename-Item -LiteralPath $app -NewName "app.bak" -ErrorAction Stop; $moved = $true; break }',
        '    catch { Start-Sleep -Milliseconds 500 }',
        '  }',
        '  if (-not $moved) { throw "替换失败：程序目录被占用，已保持原版本" }',
        '  L "app renamed to bak"',
        '  $copied = $false',
        '  for ($k = 0; $k -lt 3; $k++) {',
        '    try {',
        '      New-Item -ItemType Directory -Force -Path $app | Out-Null',
        '      Copy-Item -Path ($src + "\\*") -Destination $app -Recurse -Force -ErrorAction Stop',
        '      if (Test-Path -LiteralPath ($app + "\\main.js")) { $copied = $true; break }',
        '    } catch { Start-Sleep -Seconds 1 }',
        '  }',
        // 4) 校验新版本真的写进去了，否则视为失败（走 catch 回滚）
        '  $newVer = ""',
        '  if ($copied) { try { $newVer = (Get-Content -LiteralPath ($app + "\\package.json") -Raw | ConvertFrom-Json).version } catch {} }',
        '  if (-not $copied -or $newVer -ne ' + q(packVer) + ') { throw "更新失败，校验未通过（读到 $newVer），已回滚到旧版本" }',
        '  L "apply ok, version ' + packVer + '"',
        '  Write-Status $true "更新成功"',
        '  Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue',
        '} catch {',
        '  $reason = $_.Exception.Message',
        '  L ("FAILED: " + $reason)',
        '  if ($moved -and (Test-Path -LiteralPath $bak)) {',
        '    if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force -ErrorAction SilentlyContinue }',
        '    try { Rename-Item -LiteralPath $bak -NewName "app" -ErrorAction Stop } catch { L "rollback rename failed" }',
        '  }',
        '  Write-Status $false $reason',
        '}',
        // 5) 无论成败都重启程序
        'for ($s = 0; $s -lt 3; $s++) { try { Start-Process -FilePath ' + q(exePath) + ' -ErrorAction Stop; L "restarted"; break } catch { Start-Sleep -Seconds 2 } }',
        'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue'
    ];
    fs.writeFileSync(ps1Path, '\ufeff' + ps.join('\r\n') + '\r\n', 'utf8');
    flog('更新包已解压，由程序自己重启并在启动时替换（PID ' + curPid + '）');

    // 不再依赖 PowerShell：Electron 自己重启，下次启动由 applyStagedUpdate 完成替换
    setTimeout(() => {
        try { app.relaunch(); } catch (e) { /* ignore */ }
        app.exit(0);
    }, 400);
    return { ok: true };
}

function sendProgress(p) {
    for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('update:progress', p); } catch (e) { /* ignore */ }
    }
}

ipcMain.handle('update:apply', async (event, meta) => {
    try {
        if (IS_MAC) return { ok: false, reason: 'Mac 版请到发布页下载新的 .dmg 安装，不支持应用内更新' };
        if (!meta || !meta.url) return { ok: false, reason: '缺少下载地址' };

        const dir = path.join(DATA_DIR, 'update');
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        fs.mkdirSync(dir, { recursive: true });

        const zipPath = path.join(dir, 'app.zip');
        // 多路下载：GitHub raw 在国内经常超时，逐个试镜像
        const rawUrl = String(meta.url || '');
        const zipUrls = [];
        const push = (u) => { if (u && !zipUrls.includes(u)) zipUrls.push(u); };

        // 从 raw 地址解析出 owner/repo/branch/文件
        let gh = null;
        const mRaw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(rawUrl);
        const mCdn = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^@]+)@([^/]+)\/(.+)$/.exec(rawUrl);
        if (mRaw) gh = { owner: mRaw[1], repo: mRaw[2], branch: mRaw[3], file: mRaw[4] };
        else if (mCdn) gh = { owner: mCdn[1], repo: mCdn[2], branch: mCdn[3], file: mCdn[4] };

        let rawRef = '';
        if (gh) {
            rawRef = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${gh.file}`;
            // 实测：raw 在国内常超时，所以先走 jsDelivr 和加速镜像
            push(`https://cdn.jsdelivr.net/gh/${gh.owner}/${gh.repo}@${gh.branch}/${gh.file}`);
            push('https://ghfast.top/' + rawRef);
            push('https://gh-proxy.com/' + rawRef);
            push('https://ghproxy.net/' + rawRef);
            push(rawRef); // 最后才试直连
        } else {
            push(rawUrl);
        }

        const fetchWithTimeout = async (u, ms) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), ms);
            try {
                return await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'xbu-updater' } });
            } finally {
                clearTimeout(timer);
            }
        };

        let buf = null;
        const errors = [];
        for (const u of zipUrls) {
            try {
                flog('尝试下载: ' + u);
                sendProgress({ phase: 'download', percent: 0, text: '正在连接下载服务器…' });
                const res = await fetchWithTimeout(u, 12000);
                if (!res.ok) { errors.push('HTTP ' + res.status); continue; }

                const total = Number(res.headers.get('content-length')) || Number(meta.size) || 0;
                const reader = res.body.getReader();
                const chunks = [];
                let received = 0;
                let lastTick = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    const now = Date.now();
                    if (now - lastTick > 120) {
                        lastTick = now;
                        const percent = total ? Math.min(99, Math.round(received * 100 / total)) : 0;
                        sendProgress({
                            phase: 'download',
                            percent: percent,
                            received: received,
                            total: total,
                            text: '正在下载更新包 ' + Math.round(received / 1024) + ' KB' + (total ? ' / ' + Math.round(total / 1024) + ' KB' : '')
                        });
                    }
                }

                buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
                if (buf.length < 1000) { buf = null; errors.push('内容过小'); continue; }
                sendProgress({ phase: 'download', percent: 100, text: '下载完成' });
                flog('下载成功: ' + u + '（' + buf.length + ' 字节）');
                break;
            } catch (e) {
                errors.push('超时/连接失败');
            }
        }

        // 所有直连都失败时，用 GitHub 内容接口（base64）再试一次
        if (!buf && gh) {
            try {
                const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.file}?ref=${gh.branch}`;
                flog('改用 GitHub 内容接口: ' + api);
                const res = await fetchWithTimeout(api, 25000);
                if (res.ok) {
                    const j = await res.json();
                    if (j && j.encoding === 'base64' && j.content) {
                        sendProgress({ phase: 'download', percent: 60, text: '通过 GitHub 接口下载中…' });
                        buf = Buffer.from(j.content, 'base64');
                        sendProgress({ phase: 'download', percent: 100, text: '下载完成' });
                        flog('内容接口下载成功（' + buf.length + ' 字节）');
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (!buf) {
            return { ok: false, reason: '下载更新包失败：网络连不上 GitHub（已试 ' + zipUrls.length + ' 个地址），请换个网络或稍后重试，也可以用安装包更新' };
        }
        fs.writeFileSync(zipPath, buf);

        if (meta.sha256) {
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h.toLowerCase() !== String(meta.sha256).toLowerCase()) {
                return { ok: false, reason: '更新包校验失败（文件可能没传完）' };
            }
        }
        sendProgress({ phase: 'apply', percent: 0, text: '正在解压更新包…' });
        const applied = await applyZipAndRestart(zipPath);
        if (applied && applied.ok) sendProgress({ phase: 'apply', percent: 100, text: '正在替换程序文件，即将重启…' });
        return applied;
    } catch (e) {
        flog('update 失败: ' + (e && e.stack ? e.stack : e));
        return { ok: false, reason: '更新出错，请重试；若一直失败请用安装包重装' };
    }
});

// 从本地 zip 更新（作者直接把包发给朋友，不需要任何网站）
ipcMain.handle('update:apply-file', async () => {
    try {
        if (IS_MAC) return { ok: false, reason: 'Mac 版请到发布页下载新的 .dmg 安装，不支持应用内更新' };
        const r = await dialog.showOpenDialog({
            title: '选择更新包（xbu-x.x.x.zip）',
            filters: [{ name: '更新包', extensions: ['zip'] }],
            properties: ['openFile']
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };

        flog('本地更新包: ' + r.filePaths[0]);
        return await applyZipAndRestart(r.filePaths[0]);
    } catch (e) {
        flog('本地更新失败: ' + (e && e.stack ? e.stack : e));
        return { ok: false, reason: '更新出错，请重试；若一直失败请用安装包重装' };
    }
});

// 读取并消费更新结果标记（看门狗在替换完成后写入，下次启动时弹窗告知）
// 读完即删，避免每次启动都重复弹窗
ipcMain.handle('update:get-result', () => {
    const f = path.join(DATA_DIR, 'update', 'update-status.json');
    try {
        if (!fs.existsSync(f)) return null;
        const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
        let r = null;
        try { r = JSON.parse(raw); } catch (e) { r = null; }
        try { fs.rmSync(f, { force: true }); } catch (e) { /* ignore */ }
        flog('读取更新结果: ' + (r ? JSON.stringify(r) : '无效标记'));
        return r;
    } catch (e) {
        return null;
    }
});

ipcMain.handle('updater:open', () => { openUpdaterWindow(); return true; });

ipcMain.on('xbu:report', (event, name, data) => {
    try {
        const dir = path.join(DATA_DIR, 'reports');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name + '-' + Date.now() + '.json');
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        flog('诊断已保存: ' + file);
    } catch (e) {
        flog('诊断保存失败: ' + (e && e.message));
    }
});

/* ---------------- 设置 ---------------- */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeSettings(o) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

ipcMain.handle('settings:get', () => Object.assign({ dark: false, privacy: false, zoom: 1, bgRender: true, tileView: false }, readSettings()));

ipcMain.handle('settings:set', (event, patch) => {
    const s = Object.assign({ dark: false, privacy: false, zoom: 1, bgRender: true, tileView: false }, readSettings(), patch || {});
    writeSettings(s);
    for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('settings:changed', s); } catch (e) { /* ignore */ }
    }
    return s;
});

let earningsWin = null;

function openEarningsWindow() {
    if (earningsWin && !earningsWin.isDestroyed()) { earningsWin.show(); earningsWin.focus(); return earningsWin; }
    earningsWin = new BrowserWindow({
        width: 420, height: 480, resizable: false,
        title: '收益', autoHideMenuBar: true,
        backgroundColor: '#f7f9fc',
        webPreferences: {
            preload: path.join(__dirname, 'earnings-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });
    earningsWin.setMenuBarVisibility(false);
    earningsWin.loadFile(path.join(__dirname, 'earnings.html'));
    earningsWin.on('closed', () => { earningsWin = null; });
    return earningsWin;
}

ipcMain.handle('earnings:open', () => { openEarningsWindow(); return true; });


// 星月写作（独立模块，不参与番茄发布流程）
try {
    const registerXingyue = require(path.join(__dirname, 'xingyue-main.js'));
    registerXingyue({
        ipcMain: ipcMain,
        BrowserWindow: BrowserWindow,
        clipboard: clipboard,
        fs: fs,
        path: path,
        dataDir: PORTABLE_DATA
    });
} catch (e) {
    console.log('[星月] 模块加载失败:', e.message);
}

// 用户系统（本地离线校验）
try {
    const registerAuth = require(path.join(__dirname, 'auth.js'));
    registerAuth({ ipcMain: ipcMain, appDir: __dirname, dataDir: PORTABLE_DATA });
} catch (e) {
    console.log('[用户系统] 模块加载失败:', e.message);
}

let settingsWin = null;

function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
    settingsWin = new BrowserWindow({
        width: 460, height: 560, resizable: false,
        title: '设置', autoHideMenuBar: true,
        backgroundColor: '#f7f9fc',
        webPreferences: {
            preload: path.join(__dirname, 'settings-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });
    settingsWin.setMenuBarVisibility(false);
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
    return settingsWin;
}

ipcMain.handle('settings:open', () => { openSettingsWindow(); return true; });

// 新建账号前清空该槽位的登录数据（复用被删掉的编号时保证是干净的）
ipcMain.handle('accounts:reset-slot', async (event, rawSlot) => {
    const slot = Number(rawSlot);
    try {
        await session.fromPartition('persist:fanqie-' + slot).clearStorageData();
        flog('已清空账号 ' + slot + ' 的槽位数据');
        return { ok: true };
    } catch (e) {
        flog('清空槽位失败: ' + (e && e.message));
        return { ok: false };
    }
});

ipcMain.on('splash:close', () => closeSplash());
ipcMain.on('splash:open-update', () => { closeSplash(); openUpdaterWindow(); });
ipcMain.handle('splash:open', () => { createSplash(); return true; });

/* ---------------- 已发章号（防重复上传） ---------------- */
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

function readProgress() {
    try {
        const o = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
}
function writeProgress(o) {
    try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

ipcMain.handle('progress:get', (event, bookHash) => {
    const o = readProgress();
    return o[String(bookHash)] || { max: 0, nums: [] };
});

ipcMain.handle('progress:set', (event, bookHash, num) => {
    const key = String(bookHash || '');
    const n = Number(num) || 0;
    if (!key || !n) return { max: 0, nums: [] };

    const o = readProgress();
    const rec = o[key] || { max: 0, nums: [] };
    rec.max = Math.max(rec.max || 0, n);
    const set = new Set(Array.isArray(rec.nums) ? rec.nums : []);
    set.add(n);
    rec.nums = [...set].sort((a, b) => a - b).slice(-500); // 只留最近 500 条
    rec.updated = Date.now();
    o[key] = rec;
    writeProgress(o);
    return rec;
});

/* ---------------- 每日统计 ---------------- */
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function readStats() {
    try {
        const o = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
}

ipcMain.on('stats:add', (event, bookHash, chapters, words) => {
    try {
        const all = readStats();
        const key = todayKey();
        const day = all[key] || { chapters: 0, words: 0, books: [] };
        day.chapters += Number(chapters) || 0;
        day.words += Number(words) || 0;
        const bh = String(bookHash || '');
        if (bh && !day.books.includes(bh)) day.books.push(bh);
        all[key] = day;

        // 只保留最近 60 天
        const keys = Object.keys(all).sort();
        while (keys.length > 60) delete all[keys.shift()];

        fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8');
        flog('今日统计: ' + day.chapters + ' 章 / ' + day.words + ' 字 / ' + day.books.length + ' 本');
    } catch (e) { /* ignore */ }
});

ipcMain.on('stats:income', (event, slot, bookHash, amount) => {
    try {
        const all = readStats();
        const key = todayKey();
        const day = all[key] || { chapters: 0, words: 0, books: [], income: 0, incomes: {} };
        if (!day.incomes) day.incomes = {};
        if (day.incomeDone) return;
        const s = String(slot || 0) + '|' + String(bookHash || ('t' + Date.now()));
        day.incomes[s] = Number(amount) || 0;
        // 总和 = 各账号相加
        // 只认新格式（slot:book<数字> 或 slot:acct），丢弃历史脏 key
        const clean = {};
        Object.keys(day.incomes).forEach((k) => {
            if (String(k).indexOf('|') > 0) clean[k] = day.incomes[k];
        });
        day.incomes = clean;
        day.income = Object.keys(clean).reduce((sum, k) => sum + (Number(clean[k]) || 0), 0);
        day.incomeAt = Date.now();
        all[key] = day;
        fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8');
        flog('今日收益已记录: ¥' + day.income);
    } catch (e) { /* ignore */ }
});

ipcMain.handle('earnings:get', () => {
    const all = readStats();
    const keys = Object.keys(all).sort().slice(-7);
    const days = keys.map(k => ({
        date: k,
        chapters: all[k].chapters || 0,
        words: all[k].words || 0,
        books: (all[k].books || []).length,
        income: all[k].income || 0
    }));
    const today = all[todayKey()] || {};
    return {
        date: todayKey(),
        today: {
            chapters: today.chapters || 0,
            words: today.words || 0,
            books: (today.books || []).length,
            income: today.income || 0,
            incomes: today.incomes || {}
        },
        days: days
    };
});

ipcMain.handle('earnings:finish', (event, amount) => {
    const all = readStats();
    const k = todayKey();
    const day = all[k] || { chapters: 0, words: 0, books: [], income: 0, incomes: {} };
    const v = Number(amount);
    if (isFinite(v) && v >= 0) {
        day.incomes = { '0|nm:完成' : v };
        day.income = v;
    }
    day.incomeDone = true;
    day.incomeAt = Date.now();
    all[k] = day;
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    flog('今日收益已完成: ¥' + day.income);
    return { ok: true };
});

ipcMain.handle('earnings:unfinish', () => {
    const all = readStats();
    const k = todayKey();
    if (all[k]) { delete all[k].incomeDone; try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ } }
    return { ok: true };
});

ipcMain.handle('earnings:add', (event, name, amount) => {
    const all = readStats();
    const k = todayKey();
    const day = all[k] || { chapters: 0, words: 0, books: [], income: 0, incomes: {} };
    if (!day.incomes) day.incomes = {};
    const label = String(name || '').trim() || ('自定义' + (Object.keys(day.incomes).length + 1));
    day.incomes['0|nm:' + label] = Number(amount) || 0;
    day.income = Object.keys(day.incomes).reduce((s, x) => s + (Number(day.incomes[x]) || 0), 0);
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    return { ok: true };
});

ipcMain.handle('earnings:delete', (event, key) => {
    const all = readStats();
    const k = todayKey();
    const day = all[k];
    if (day && day.incomes && day.incomes[key] !== undefined) {
        delete day.incomes[key];
        day.income = Object.keys(day.incomes).reduce((s, x) => s + (Number(day.incomes[x]) || 0), 0);
        try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    }
    return { ok: true };
});

ipcMain.handle('earnings:clear', () => {
    const all = readStats();
    const k = todayKey();
    if (all[k]) {
        all[k].incomes = {};
        all[k].income = 0;
        try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    }
    return { ok: true };
});

ipcMain.handle('earnings:set-income', (event, amount) => {
    const all = readStats();
    const key = todayKey();
    const day = all[key] || { chapters: 0, words: 0, books: [], income: 0 };
    day.income = Number(amount) || 0;
    day.incomeAt = Date.now();
    all[key] = day;
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    flog('手动设置今日收益: ¥' + day.income);
    return { ok: true, income: day.income };
});

ipcMain.handle('stats:today', () => {
    const all = readStats();
    const day = all[todayKey()] || { chapters: 0, words: 0, books: [] };
    return {
        date: todayKey(),
        chapters: day.chapters || 0,
        words: day.words || 0,
        books: (day.books || []).length,
        income: day.income || 0
    };
});

ipcMain.handle('schedule:find', (event, bookHash) => {
    const key = String(bookHash || '');
    const list = readSchedule();
    const rec = list.find(x => x.bookHash === key);
    return rec || null;
});

ipcMain.handle('schedule:get', () => readSchedule());

ipcMain.handle('schedule:rename', (event, slot, bookHash, name) => {
    const list = readSchedule();
    const target = String(bookHash || '');
    const idx = list.findIndex(x => String(x.slot) === String(slot) && x.bookHash === target);
    if (idx >= 0) {
        list[idx].bookName = String(name || '').trim().slice(0, 40);
        writeSchedule(list);
        notifyReminder();
    }
    return list;
});

ipcMain.handle('schedule:remove', (event, slot, bookHash) => {
    const list = readSchedule().filter(x => !(String(x.slot) === String(slot) && x.bookHash === String(bookHash)));
    writeSchedule(list);
    notifyReminder();
    return list;
});


ipcMain.on('toast:close', () => closeToast());
ipcMain.on('toast:open-reminders', () => {
    closeToast();
    openReminderWindow();
});

ipcMain.handle('reminders:open', () => {
    openReminderWindow();
    return true;
});

/* ---------- 多账号任务：IPC ---------- */
ipcMain.handle('tasks:get', () => readTasks());

ipcMain.handle('tasks:save', (event, list) => {
    writeTasks(Array.isArray(list) ? list : []);
    return { ok: true };
});

ipcMain.handle('tasks:add', (event, task) => {
    const list = readTasks();
    const t = Object.assign({}, task || {});
    if (!t.id) t.id = 't' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    t.createdAt = t.createdAt || Date.now();
    t.status = t.status || 'idle';
    list.unshift(t);
    writeTasks(list);
    return t;
});

ipcMain.handle('tasks:update', (event, id, patch) => {
    const list = readTasks();
    const idx = list.findIndex(t => t.id === id);
    if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], patch || {});
        writeTasks(list);
        return list[idx];
    }
    return null;
});

ipcMain.handle('tasks:remove', (event, id) => {
    writeTasks(readTasks().filter(t => t.id !== id));
    return { ok: true };
});

// 页面脚本跳章后回读任务状态：判断要不要继续保持「已暂停」
ipcMain.handle('tasks:status-get', (event, id) => {
    const t = readTasks().find(x => x.id === String(id || ''));
    return t ? { status: t.status || '', progress: t.progress || null } : null;
});

// 运行日志：webview 里的脚本经 preload 上报，主进程落盘 + 广播给所有窗口
ipcMain.on('task:log', (event, payload) => {
    try {
        const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const entry = {
            id: 'l' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            taskId: p.taskId || '',
            slot: Number(p.slot) || 0,
            bookName: String(p.bookName || ''),
            level: String(p.level || 'info'),
            msg: String(p.msg || ''),
            time: Date.now()
        };
        const logs = readTaskLogs();
        logs.push(entry);
        writeTaskLogs(logs);
        broadcastTaskEvent({ type: 'log', entry });
    } catch (e) { /* ignore */ }
});

// 任务状态变化（由 shell 下发后回报）
ipcMain.on('task:status', (event, payload) => {
    try {
        const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        // 状态落盘：否则重启后任务又变回"待开启"
        if (p.taskId && p.status) {
            const list = readTasks();
            const idx = list.findIndex(t => t.id === p.taskId);
            if (idx >= 0 && list[idx].status !== p.status) {
                list[idx].status = p.status;
                if (p.status === 'done') {
                    const total = (list[idx].chapters || []).length;
                    const old = list[idx].progress || {};
                    list[idx].progress = { done: total, total: total, lastChapter: Number(old.lastChapter) || 0 };
                }
                writeTasks(list);
            }
        }
        broadcastTaskEvent({ type: 'status', taskId: p.taskId, status: p.status, slot: p.slot });
    } catch (e) { /* ignore */ }
});

// 发布进度：章级上报，落盘 + 广播，卡片上的进度条/当前章号就靠它
ipcMain.on('task:progress', (event, payload) => {
    try {
        const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        const list = readTasks();

        // taskId 缺失时（比如用户在面板里手动点开始上传），按账号+书号找回正在跑的任务
        let taskId = String(p.taskId || '');
        if (!taskId) {
            const found = list.find(t => String(t.slot) === String(p.slot || 0) && t.status === 'running');
            if (found) taskId = found.id;
        }
        if (!taskId) return;

        const idx = list.findIndex(t => t.id === taskId);
        if (idx < 0) return;
        const total = Number(p.total) || (list[idx].chapters || []).length || 0;
        let done = Number(p.done) || 0;
        if (done > total) done = total;
        const lastChapter = Number(p.lastChapter) || Number((list[idx].progress || {}).lastChapter) || 0;
        list[idx].progress = { done: done, total: total, lastChapter: lastChapter, updated: Date.now() };

        // 全部发完就自动把任务置为「已完成」，避免卡片停在「发布中 / 暂停发布」
        if (total > 0 && done >= total && list[idx].status !== 'done') {
            list[idx].status = 'done';
            try { writeTasks(list); } catch (e) { /* ignore */ }
            broadcastTaskEvent({ type: 'progress', taskId: taskId, progress: list[idx].progress, slot: p.slot });
            broadcastTaskEvent({ type: 'status', taskId: taskId, status: 'done', slot: p.slot });
            return;
        }

        writeTasks(list);
        broadcastTaskEvent({ type: 'progress', taskId: taskId, progress: list[idx].progress, slot: p.slot });
    } catch (e) { /* ignore */ }
});

ipcMain.handle('logs:get', () => readTaskLogs());
ipcMain.handle('logs:clear', () => { writeTaskLogs([]); return { ok: true }; });

ipcMain.handle('accounts:get', () => {
    const a = readAccounts();
    if (!fs.existsSync(ACCOUNTS_FILE)) writeAccounts(a);   // 首次运行就把合并结果落盘
    return a;
});

ipcMain.handle('accounts:add', (event, rawSlot) => {
    const slot = Number(rawSlot);
    const a = readAccounts();
    if (Number.isInteger(slot) && slot > 0 && !a.slots.includes(slot)) {
        a.slots.push(slot);
        a.slots.sort((x, y) => x - y);
    }
    a.last = slot;
    writeAccounts(a);
    flog('accounts:add ' + slot + ' -> ' + JSON.stringify(a));
    return a;
});

ipcMain.handle('accounts:remove', async (event, rawSlot) => {
    const slot = Number(rawSlot);
    const a = readAccounts();
    a.slots = a.slots.filter(s => s !== slot);
    if (!a.slots.length) a.slots = [1];
    if (!a.slots.includes(a.last)) a.last = a.slots[0];
    if (Array.isArray(a.openTabs)) a.openTabs = a.openTabs.filter(s => s !== slot);
    if (Array.isArray(a.closed)) a.closed = a.closed.filter(s => s !== slot);
    writeAccounts(a);

    try {
        await session.fromPartition(`persist:fanqie-${slot}`).clearStorageData();
        flog('已清除账号 ' + slot + ' 的登录数据');
    } catch (e) {
        flog('clearStorageData 失败: ' + (e && e.message));
    }

    // 顺手把磁盘上的分区目录也删掉，避免下次又被扫出来
    const pd = path.join(DATA_DIR, 'Partitions', 'fanqie-' + slot);
    try {
        fs.rmSync(pd, { recursive: true, force: true });
        flog('已删除分区目录 fanqie-' + slot);
    } catch (e) {
        // 正被占用，记下来下次启动再删
        const c = readCleanup();
        if (!c.includes(slot)) { c.push(slot); writeCleanup(c); }
        flog('分区目录被占用，已排队删除: fanqie-' + slot);
    }
    return a;
});

/* ---------------- 待清理的分区 ---------------- */
const CLEANUP_FILE = path.join(DATA_DIR, 'cleanup.json');

function readCleanup() {
    try {
        const arr = JSON.parse(fs.readFileSync(CLEANUP_FILE, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
}
function writeCleanup(arr) {
    try { fs.writeFileSync(CLEANUP_FILE, JSON.stringify(arr), 'utf8'); } catch (e) { /* ignore */ }
}

function runCleanup() {
    const list = readCleanup();
    if (!list.length) return;
    const keep = [];
    for (const slot of list) {
        const pd = path.join(DATA_DIR, 'Partitions', 'fanqie-' + slot);
        try {
            fs.rmSync(pd, { recursive: true, force: true });
            flog('清理残留分区 fanqie-' + slot);
        } catch (e) {
            keep.push(slot);
        }
    }
    writeCleanup(keep);
}

ipcMain.handle('accounts:set-open-tabs', (event, list) => {
    const a = readAccounts();
    const arr = Array.isArray(list) ? list.filter(n => Number.isInteger(n) && n > 0) : [];
    a.openTabs = Array.from(new Set(arr)).sort((x, y) => x - y);
    writeAccounts(a);
    return a;
});

ipcMain.handle('accounts:set-open', (event, rawSlot, open) => {
    const slot = Number(rawSlot);
    const a = readAccounts();
    const closed = new Set(a.closed || []);
    if (open) closed.delete(slot); else closed.add(slot);
    a.closed = Array.from(closed).sort((x, y) => x - y);
    writeAccounts(a);
    flog('accounts:set-open ' + slot + ' -> ' + (open ? 'open' : 'closed'));
    return a;
});

ipcMain.handle('accounts:rename', (event, rawSlot, rawName) => {
    const slot = Number(rawSlot);
    const a = readAccounts();
    const name = String(rawName || '').trim().slice(0, 20);
    if (!a.names) a.names = {};
    if (name) a.names[slot] = name;
    else delete a.names[slot];
    writeAccounts(a);
    flog('accounts:rename ' + slot + ' -> "' + name + '"');
    return a;
});

ipcMain.on('accounts:set-last', (event, rawSlot) => {
    const slot = Number(rawSlot);
    const a = readAccounts();
    if (a.slots.includes(slot) && a.last !== slot) {
        a.last = slot;
        writeAccounts(a);
    }
});

ipcMain.on('save-file', (event, name, text) => safeWrite(name, text));

// 页面脚本（webview 内）通过 preload 发来的定时诊断
ipcMain.on('save-dump', (event, text) => safeWrite('dump-timed.json', text));

ipcMain.on('toggle-devtools', (event, id) => {
    try {
        const wc = webContents.fromId(Number(id));
        if (!wc) return;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: 'detach' });
    } catch (e) {
        flog('toggle-devtools failed: ' + (e && e.message));
    }
});


/* ---------------- 读取书单（抓接口返回，最可靠） ----------------
 * 番茄作家专区是微前端 SPA：直接扫页面 <a> 链接几乎一定扫不到书（没有链接、书号也不在正文里）。
 * 这里改成三步走：
 *   1) 用 devtools 协议监听 webContents 里所有网络响应，从 JSON 里捞 {书号, 书名}；
 *   2) 同时在所有 frame（含 iframe）里扫内嵌 JSON / 长数字属性作为兜底；
 *   3) 都没捞到时把全过程写进 booklist-debug.json，方便下次精确对齐。
 */
// 作品管理页的真实地址是 /main/writer/book-manage（/novel 是不存在的路由，会 404）
const BOOK_MANAGE_URL = 'https://fanqienovel.com/main/writer/book-manage';
const WRITER_HOME_URL = 'https://fanqienovel.com/main/writer/';

const DOM_SCAN_JS = `(function () {
  try {
    var all = document.querySelectorAll('a[href]');
    var links = [];
    for (var i = 0; i < all.length && i < 3000; i++) {
      var a = all[i];
      var href = String(a.getAttribute('href') || '');
      var text = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      var near = '';
      try {
        var box = a.closest('[class*="book"], [class*="item"], [class*="card"], li, tr');
        if (box) {
          var t = box.querySelector('[class*="title"], [class*="name"], h1, h2, h3, h4');
          if (t) near = (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
        }
      } catch (e) { /* ignore */ }
      links.push({ href: href, text: text, near: near });
    }
    var html = '';
    try { html = document.documentElement ? document.documentElement.outerHTML : ''; } catch (e) {}
    return {
      url: location.href,
      title: document.title,
      linkCount: all.length,
      links: links.slice(0, 200),
      htmlLen: html.length,
      html: html.slice(0, 400000)
    };
  } catch (e) { return { url: location.href, error: String(e && e.message) }; }
})()`;

function looksLikeBookId(v) {
    return /^\d{13,25}$/.test(String(v == null ? '' : v));
}

// 从任意 JSON 结构里递归找 {书号, 书名}（番茄各接口字段名不统一，全都认）
function harvestBooks(node, out, depth) {
    if (!node || depth > 10 || out.length > 600) return;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length && i < 500; i++) harvestBooks(node[i], out, depth + 1);
        return;
    }
    if (typeof node !== 'object') return;
    let id = '';
    let name = '';
    for (const k of Object.keys(node)) {
        const v = node[k];
        const lk = String(k).toLowerCase();
        if (!id && /^(book_?id|bookid|novel_?id|novelid|item_?id)$/.test(lk)
            && (typeof v === 'string' || (typeof v === 'number' && v <= 9007199254740991))
            && looksLikeBookId(v)) id = String(v);
        if (!name && /^(book_?name|bookname|novel_?name|novelname)$/.test(lk) && typeof v === 'string' && v.trim()) name = v.trim();
    }
    if (id && name) out.push({ id: id, name: name.slice(0, 60) });
    for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') harvestBooks(v, out, depth + 1);
    }
}

// 从 HTML 源码/接口原文里用正则捞 "book_id" 与 "book_name" 相邻的片段
function harvestFromText(text, out) {
    if (!text || out.length > 600) return;
    const t = String(text);
    let m;
    const re1 = /"book_?id"\s*:\s*"?(\d{13,25})"?[^"{}]{0,200}?"book_?name"\s*:\s*"([^"]{1,60})"/gi;
    while ((m = re1.exec(t)) && out.length < 600) out.push({ id: m[1], name: m[2].trim() });
    const re2 = /"book_?name"\s*:\s*"([^"]{1,60})"[^"{}]{0,200}?"book_?id"\s*:\s*"?(\d{13,25})"?/gi;
    while ((m = re2.exec(t)) && out.length < 600) out.push({ id: m[2], name: m[1].trim() });
}

const bookReadBusy = new Set(); // 同一个账号页面同时只允许一个读取任务

ipcMain.handle('books:read', async (event, payload) => {
    const wcId = Number(payload && payload.webContentsId || 0);
    const wc = wcId ? webContents.fromId(wcId) : null;
    if (!wc) return { ok: false, error: '找不到这个账号的页面，请先打开该账号标签页' };
    if (bookReadBusy.has(wcId)) return { ok: false, error: '正在读取中，请稍等（上次还没结束）' };
    bookReadBusy.add(wcId);
    try {
        return await readBooksFromWebContents(wc);
    } catch (e) {
        flog('books:read 异常: ' + (e && e.stack ? e.stack : e));
        return { ok: false, error: '读取过程出错：' + (e && e.message) };
    } finally {
        bookReadBusy.delete(wcId);
    }
});

// 作品管理页真正用的书单接口（已在实机诊断里抓到，未签名也能调，靠页面 Cookie 鉴权）
const BOOK_API_URL = 'https://fanqienovel.com/api/author/book/book_list/v0/?aid=2503&app_name=muye_novel&page_count=50&page_index=0';

// 在目标页面里用登录态请求书单接口 → 返回 { books, code, message, error }
async function tryBookApi(wc) {
    const js = 'fetch(' + JSON.stringify(BOOK_API_URL) + ',{credentials:"include",headers:{Accept:"application/json"}})'
        + '.then(function(r){return r.text();}).catch(function(e){return "ERR:"+(e&&e.message);})';
    let text = '';
    try {
        text = await wc.executeJavaScript(js);
    } catch (e) {
        return { books: [], error: '页面里发请求失败：' + (e && e.message) };
    }
    if (typeof text !== 'string' || !text) return { books: [], error: '接口没返回内容（页面可能还没就绪）' };
    if (text.slice(0, 4) === 'ERR:') return { books: [], error: text.slice(4) };

    let json = null;
    try { json = JSON.parse(text); } catch (e) {
        return { books: [], error: '接口返回的不是 JSON' };
    }
    const found = [];
    harvestBooks(json, found, 0);
    if (!found.length) harvestFromText(text, found);

    const books = [];
    const seen = new Set();
    for (const b of found) {
        if (!b || !b.id || seen.has(b.id)) continue;
        seen.add(b.id);
        books.push({ id: String(b.id), name: String(b.name || ('书 ' + b.id)).slice(0, 60) });
    }
    const code = (json && typeof json.code !== 'undefined') ? json.code : null;
    const message = (json && json.message) || '';
    return {
        books: books,
        code: code,
        message: message,
        error: books.length ? '' : ('接口 code=' + code + ' ' + message)
    };
}

async function readBooksFromWebContents(wc) {

    // 0) 快路：直接在页面里用登录态调番茄书单接口（1 秒左右，且不会让用户的页面跳来跳去）
    let fast = { books: [], error: '' };
    try {
        fast = await Promise.race([
            tryBookApi(wc),
            new Promise(r => setTimeout(() => r({ books: [], error: '接口超时' }), 8000))
        ]);
    } catch (e) {
        fast = { books: [], error: (e && e.message) || '接口调用失败' };
    }
    if (fast && fast.books && fast.books.length) {
        flog('books:read 快路命中 ' + fast.books.length + ' 本');
        safeWrite('booklist-debug.json', JSON.stringify({
            at: new Date().toISOString(),
            source: 'api-fast',
            target: BOOK_API_URL,
            bookCount: fast.books.length,
            books: fast.books
        }, null, 2));
        return { ok: true, books: fast.books, source: 'api' };
    }
    flog('books:read 快路没结果（' + ((fast && fast.error) || '空') + '），改走网络嗅探');
    // 接口明确说没登录，就别再傻等 30 秒嗅探了，直接把原因告诉用户
    if (fast && (fast.code === -3 || /登录/.test(String(fast.message || '')))) {
        return { ok: false, error: '这个账号还没登录（番茄返回：' + (fast.message || '登录信息有误') + '），请先在标签页里登录再读取' };
    }

    const books = [];
    const seen = new Set();
    const pushBooks = (list) => {
        for (const b of list || []) {
            if (!b || !b.id) continue;
            const id = String(b.id);
            if (seen.has(id)) continue;
            // 同一本书的 id 可能因为 JSON 数字精度差一点点，前缀+书名相同就当成同一本
            let dup = false;
            for (const e of books) {
                if (e.name === b.name && e.id.slice(0, 10) === id.slice(0, 10)) { dup = true; break; }
            }
            if (dup) continue;
            seen.add(id);
            books.push({ id: id, name: String(b.name || ('书 ' + id)).slice(0, 60) });
        }
    };

    // 1) 挂上调试器，准备窃听网络响应
    const hits = [];
    const hitReq = new Set();
    let dbg = null;
    try {
        dbg = wc.debugger;
        if (wc.isDevToolsOpened && wc.isDevToolsOpened()) {
            try { wc.closeDevTools(); } catch (e) { /* ignore */ }
        }
        if (!dbg.isAttached()) dbg.attach('1.3');
        await dbg.sendCommand('Network.enable', {
            maxResourceBufferSize: 40 * 1024 * 1024,
            maxTotalBufferSize: 80 * 1024 * 1024
        });
        dbg.on('message', (ev, method, params) => {
            if (method !== 'Network.responseReceived') return;
            const r = (params && params.response) || {};
            const url = String(r.url || '');
            const rid = params && params.requestId;
            if (!url || !rid || hitReq.has(rid)) return;
            const mime = String(r.mimeType || '').toLowerCase();
            if (mime.indexOf('json') < 0 && !/(api|book|novel|author|writer|work)/i.test(url)) return;
            hitReq.add(rid);
            if (hits.length < 120) hits.push({ requestId: rid, url: url, status: r.status, mime: mime, size: 0, bookCount: 0 });
        });
    } catch (e) {
        flog('books:read 调试器不可用（改用页面兜底）: ' + (e && e.message));
        dbg = null;
    }

    // 2) 打开作品管理页，边等边把拿到的响应体解析成书单
    const drained = new Set();
    const tries = new Map();
    const drainBodies = async () => {
        if (!dbg) return;
        for (const h of hits) {
            if (drained.has(h.requestId)) continue;
            const t = tries.get(h.requestId) || 0;
            if (t >= 4) { drained.add(h.requestId); continue; } // 一直取不到（未下载完/被清缓存）就不再纠缠
            tries.set(h.requestId, t + 1);
            let body = '';
            try {
                const res = await dbg.sendCommand('Network.getResponseBody', { requestId: h.requestId });
                body = res && res.body ? (res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : String(res.body)) : '';
            } catch (e) {
                continue; // 还没下载完，下一轮再试
            }
            drained.add(h.requestId);
            h.size = body.length;
            if (!body || body.length > 8 * 1024 * 1024) continue;
            const found = [];
            const head = body.trim().slice(0, 1);
            if (head === '{' || head === '[') {
                try { harvestBooks(JSON.parse(body), found, 0); } catch (e) { /* 不是合法 JSON，走正则 */ }
            }
            // 正则永远再跑一遍：接口若把书号当数字返回，JSON.parse 会丢末尾精度
            harvestFromText(body, found);
            if (found.length) {
                h.bookCount = found.length;
                pushBooks(found);
                flog('books:read 接口命中 ' + found.length + ' 本: ' + h.url);
            }
        }
    };

    // 等页面加载 + 边等边解析；加载完后再给 3 秒让异步接口都回来
    const waitAndDrain = async (budgetMs) => {
        let loaded = false;
        const onLoaded = () => { loaded = true; };
        try { wc.once('did-finish-load', onLoaded); } catch (e) { /* ignore */ }
        const deadline = Date.now() + budgetMs;
        let waited = 0;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 800));
            if (loaded) waited += 800;
            await drainBodies();
            if (books.length && loaded && waited >= 3000) break;
        }
        await drainBodies();
        try { wc.removeListener('did-finish-load', onLoaded); } catch (e) { /* ignore */ }
    };

    // 先作品管理页，没捞到再试一次作家首页（有的账号书单接口挂在这边）
    try { wc.loadURL(BOOK_MANAGE_URL); } catch (e) { /* ignore */ }
    await waitAndDrain(20000);
    if (!books.length) {
        flog('books:read 作品管理页没捞到书，改试作家首页');
        try { wc.loadURL(WRITER_HOME_URL); } catch (e) { /* ignore */ }
        await waitAndDrain(15000);
    }

    // 3) 兜底：所有 frame 里扫内嵌 JSON / 链接 / data 属性
    const frameDumps = [];
    const domBooks = [];
    const frames = [];
    const collectFrames = (f) => {
        if (!f) return;
        frames.push(f);
        for (const c of (f.frames || [])) collectFrames(c);
    };
    try { collectFrames(wc.mainFrame); } catch (e) { /* ignore */ }
    for (const f of frames) {
        try {
            const r = await f.executeJavaScript(DOM_SCAN_JS);
            if (!r) continue;
            frameDumps.push({ url: r.url, title: r.title, linkCount: r.linkCount, htmlLen: r.htmlLen, links: r.links || [] });
            const found = [];
            harvestFromText(r.html || '', found);
            for (const l of (r.links || [])) {
                const href = String(l.href || '');
                // 番茄真实的书籍路由形如 /main/writer/{书号}/chapter-manage，优先按这个认
                const pathId = /\/main\/writer\/(\d{6,25})\//.exec(href);
                const anyId = pathId ? null : /\d{13,25}/.exec(href + ' ' + String(l.text || ''));
                const id = pathId ? pathId[1] : (anyId ? anyId[0] : '');
                if (!id) continue;
                const name = String(l.text || '').trim() || String(l.near || '').trim() || ('书 ' + id);
                found.push({ id: id, name: name });
            }
            for (const b of found) domBooks.push(b);
        } catch (e) {
            frameDumps.push({ url: (f && f.url) || '', error: String(e && e.message) });
        }
    }
    // 接口已经拿到书了就不再用页面兜底（页面里可能混进章节号等无关数字）
    if (!books.length) pushBooks(domBooks);

    if (dbg) {
        try { await dbg.sendCommand('Network.disable'); } catch (e) { /* ignore */ }
        try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* ignore */ }
    }

    const dump = {
        at: new Date().toISOString(),
        target: BOOK_MANAGE_URL,
        bookCount: books.length,
        books: books,
        frames: frameDumps,
        network: hits.map(h => ({ url: h.url, status: h.status, mime: h.mime, size: h.size, bookCount: h.bookCount }))
    };
    safeWrite('booklist-debug.json', JSON.stringify(dump, null, 2));

    flog('books:read 完成，书=' + books.length + '，网络响应=' + hits.length + '，frame=' + frames.length);
    return { ok: true, books: books, dump: 'booklist-debug.json' };
}


/* ---------------- 定时提醒窗口 ---------------- */
function openReminderWindow() {
    if (reminderWin && !reminderWin.isDestroyed()) {
        if (reminderWin.isMinimized()) reminderWin.restore();
        reminderWin.show();
        reminderWin.focus();
        try { reminderWin.webContents.send('schedule:changed'); } catch (e) { /* ignore */ }
        return reminderWin;
    }

    reminderWin = new BrowserWindow({
        width: 460,
        height: 480,
        minWidth: 380,
        minHeight: 280,
        title: '存稿 & 更新看板',
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: '#f7f9fc',
        webPreferences: {
            preload: path.join(__dirname, 'reminder-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });

    reminderWin.setMenuBarVisibility(false);
    reminderWin.loadFile(path.join(__dirname, 'reminders.html'));
    reminderWin.webContents.on('did-finish-load', () => {
        try {
            reminderWin.webContents.executeJavaScript('window.__schedPath = ' + JSON.stringify(SCHEDULE_FILE));
        } catch (e) { /* ignore */ }
    });
    reminderWin.on('closed', () => { reminderWin = null; });
    flog('打开定时提醒窗口');
    return reminderWin;
}


/* ---------------- 左上角到期提醒 ---------------- */
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified.json');

function readNotified() {
    try { return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeNotified(obj) {
    try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let toastWin = null;

function closeToast() {
    if (toastWin && !toastWin.isDestroyed()) toastWin.close();
    toastWin = null;
}

function privacyOn() {
    try { return !!readSettings().privacy; } catch (e) { return false; }
}

function maskIfPrivacy(name) {
    return privacyOn() ? '📕 ★★★（隐私模式）' : name;
}

function showToast(items, title) {
    closeToast();

    const disp = screen.getPrimaryDisplay();
    const wa = disp.workArea;

    toastWin = new BrowserWindow({
        width: 330,
        height: Math.min(220, 92 + items.length * 22),
        x: wa.x + 16,
        y: wa.y + 16,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'toast-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });

    // 系统提示音兜底（3 声，间隔 200ms）
    try {
        shell.beep();
        setTimeout(() => { try { shell.beep(); } catch (e) { /* ignore */ } }, 200);
        setTimeout(() => { try { shell.beep(); } catch (e) { /* ignore */ } }, 400);
    } catch (e) { /* ignore */ }

    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.loadFile(path.join(__dirname, 'toast.html'));
    toastWin.once('ready-to-show', () => {
        toastWin.showInactive();
        const acc = readAccounts();
        const payload = {
            title: title,
            items: items.map(it => ({
                bookName: maskIfPrivacy(it.bookName || it.bookHash),
                last: it.last,
                days: (typeof it.days === 'number') ? it.days : null,
                account: (acc.names && acc.names[it.slot]) || ('账号 ' + it.slot)
            }))
        };
        try {
            toastWin.webContents.executeJavaScript('renderToast(' + JSON.stringify(payload) + ')');
        } catch (e) { /* ignore */ }
        setTimeout(closeToast, 15000);
    });
    toastWin.on('closed', () => { toastWin = null; });
    flog('弹出到期提醒: ' + items.length + ' 本');
}

// 检查今天是否某本书的最后一个定时发布日
function checkDueReminders() {
    const list = readSchedule();
    if (!list.length) return;

    const today = todayKey();
    const notified = readNotified();
    const due = [];

    for (const it of list) {
        const m = /(\d{4})-(\d{2})-(\d{2})/.exec(it.last || '');
        if (!m) continue;
        const dateKey = m[1] + '-' + m[2] + '-' + m[3];
        if (dateKey !== today) continue;

        // 用 bookHash 做键。记录经过脱敏后已不含 bookId（旧代码用 it.bookId，
        // 恒为 undefined，导致同一账号下所有到期书共用一个键，只提醒第一本）。
        const key = it.slot + ':' + it.bookHash + ':' + today;
        if (notified[key]) continue;
        due.push(it);
    }

    if (!due.length) return;

    for (const it of due) {
        notified[it.slot + ':' + it.bookHash + ':' + today] = Date.now();
    }
    writeNotified(notified);

    showToast(due, due.length > 1 ? `今天有 ${due.length} 本书走到最后一章定时` : '今天是这本书最后的定时发布日');
}

// 启动时：把所有还没到期的书汇总弹一次
function startupSummary() {
    const list = readSchedule();
    if (!list.length) return;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const rows = [];

    for (const it of list) {
        const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(it.last || '');
        if (!m) continue;
        const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        const days = Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime() - todayStart) / 86400000);
        if (days < 0) continue;
        rows.push({
            bookName: it.bookName || it.bookHash,
            last: it.last,
            slot: it.slot,
            days: days
        });
    }

    if (!rows.length) return;
    rows.sort((a, b) => a.days - b.days);

    const soon = rows.filter(r => r.days <= 3).length;
    const title = rows.length === 1
        ? `《${rows[0].bookName}》还剩 ${rows[0].days} 天到期`
        : `还有 ${rows.length} 本书在定时发布中` + (soon ? `（${soon} 本临近）` : '');

    showToast(rows, title);
}

function startReminderWatcher() {
    setTimeout(() => { try { startupSummary(); } catch (e) { /* ignore */ } }, 4000);
    setInterval(() => { try { checkDueReminders(); } catch (e) { /* ignore */ } }, 30 * 60 * 1000);
}


/* ---------------- 启动动画 ---------------- */
let splashWin = null;

function readChangelog() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
    } catch (e) {
        return { entries: [] };
    }
}

function createSplash() {
    splashWin = new BrowserWindow({
        width: 620,
        height: 330,
        frame: false,
        transparent: true,
        resizable: false,
        show: true,
        center: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'splash-preload.js'),
            contextIsolation: false,
            nodeIntegration: false
        }
    });

    splashWin.loadFile(path.join(__dirname, 'splash.html'));
    splashWin.webContents.on('did-finish-load', () => {
        try {
            splashWin.webContents.executeJavaScript(
                'renderSplash(' + JSON.stringify({ version: PKG_VERSION, changelog: readChangelog() }) + ')'
            );
        } catch (e) { /* ignore */ }
    });
    splashWin.on('closed', () => { splashWin = null; });
    return splashWin;
}

function closeSplash() {
    if (splashWin && !splashWin.isDestroyed()) {
        try { splashWin.close(); } catch (e) { /* ignore */ }
        splashWin = null;
    }
}

/* ---------------- 启动时补装更新 ---------------- */
function applyPendingUpdate() {
    const marker = path.join(DATA_DIR, 'update', 'pending.json');
    if (!fs.existsSync(marker)) return false;

    let info = null;
    try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { info = null; }
    if (!info || !info.src || !fs.existsSync(path.join(info.src, 'main.js'))) {
        try { fs.rmSync(marker, { force: true }); } catch (e) { /* ignore */ }
        return false;
    }

    const files = fs.readdirSync(info.src).filter(n => fs.statSync(path.join(info.src, n)).isFile());
    for (const f of files) {
        try { fs.copyFileSync(path.join(info.src, f), path.join(__dirname, f)); } catch (e) {
            flog('补装失败 ' + f + ': ' + e.message);
            return false;
        }
    }
    try { fs.rmSync(marker, { force: true }); } catch (e) { /* ignore */ }
    flog('已补装更新到 ' + (info.version || '?') + '，重启生效');
    return true;
}

/* ---------------- 主窗口 ---------------- */

/* ---------------- 启动时自替换（不依赖 PowerShell） ---------------- */
function applyStagedUpdate() {
    try {
        const upd = path.join(PORTABLE_DATA, 'update');
        const stagedApp = path.join(upd, 'app');
        const pkgPath = path.join(stagedApp, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;

        let newVer = '';
        try { newVer = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch (e) { return false; }
        if (!newVer || newVer === PKG_VERSION) return false;

        // 把暂存目录里的文件覆盖到程序目录
        const files = fs.readdirSync(stagedApp);
        for (const f of files) {
            const from = path.join(stagedApp, f);
            const to = path.join(__dirname, f);
            try {
                if (fs.statSync(from).isDirectory()) {
                    copyDirSync(from, to);
                } else {
                    fs.copyFileSync(from, to);
                }
            } catch (e) {
                flog('自替换失败 ' + f + ': ' + e.message);
                return false;
            }
        }

        try { fs.rmSync(stagedApp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmSync(path.join(upd, 'app.zip'), { force: true }); } catch (e) { /* ignore */ }
        flog('已自替换到 ' + newVer + '，准备重启');
        return true;
    } catch (e) {
        flog('自替换异常: ' + e.message);
        return false;
    }
}

function copyDirSync(src, dst) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dst, name);
        if (fs.statSync(s).isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 960,
        minHeight: 640,
        title: '阿p全自动发布工具',
        backgroundColor: '#f0f2f5',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'shell-preload.js'),
            webviewTag: true,
            contextIsolation: false,
            nodeIntegration: false,
            spellcheck: false
        }
    });

    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'shell.html'));

    // webview 内的新窗口：站外给系统浏览器，站内就地打开（不再弹第二个窗口）
    win.webContents.on('did-attach-webview', (event, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            if (!/^https?:/i.test(url)) {
                return { action: 'deny' };
            }
            if (!/fanqienovel\.com/i.test(url)) {
                shell.openExternal(url);
                return { action: 'deny' };
            }
            // 番茄的「新建章节」等用 window.open，这里改为在当前标签页内跳转
            setImmediate(() => {
                try {
                    contents.loadURL(url);
                    flog('站内 popup 就地打开: ' + url);
                } catch (e) {
                    flog('popup 就地打开失败: ' + (e && e.message));
                }
            });
            return { action: 'deny' };
        });
        contents.on('page-title-updated', (e) => e.preventDefault());
        contents.on('render-process-gone', (e, details) => {
            flog('webview render-process-gone: ' + JSON.stringify(details));
        });
    });

    win.on('closed', () => flog('main window closed'));
    return win;
}

/* ---------------- 启动 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const all = BrowserWindow.getAllWindows();
        if (all.length) {
            const w = all[0];
            if (w.isMinimized()) w.restore();
            w.focus();
        }
    });

    app.whenReady().then(() => {
        // 菜单保持极简，账号切换都在顶部标签页
        // macOS 必须带上 appMenu / editMenu，否则 Cmd+Q、Cmd+C 这些系统快捷键不生效
        const isMac = process.platform === 'darwin';
        const viewMenu = {
            label: '视图',
            submenu: [
                { label: '放大', role: 'zoomIn' },
                { label: '缩小', role: 'zoomOut' },
                { label: '重置缩放', role: 'resetZoom' }
            ]
        };
        const menuTemplate = isMac
            ? [{ role: 'appMenu' }, { role: 'editMenu' }, viewMenu, { role: 'windowMenu' }]
            : [viewMenu];
        Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
        if (!IS_MAC && applyStagedUpdate()) {
            app.relaunch();
            app.exit(0);
            return;
        }

        const launchMain = () => {
            createSplash();
            const win = createWindow();
            win.webContents.once('did-finish-load', () => {
                setTimeout(closeSplash, 5200);
            });
            setTimeout(closeSplash, 8000);
            startReminderWatcher();
        };

        // 已有本机授权 → 直接进；否则弹登录窗（带兜底，读不到账号表就放行）
        let needLogin = false;
        try {
            const authFile = path.join(PORTABLE_DATA, 'auth.json');
            const accountsFile = path.join(__dirname, 'accounts.json');
            const hasAccounts = fs.existsSync(accountsFile);
            const authed = fs.existsSync(authFile);
            needLogin = hasAccounts && !authed;
        } catch (e) {
            needLogin = false;
        }

        try { flog('登录门禁: needLogin=' + needLogin + ' accounts=' + fs.existsSync(path.join(__dirname, 'accounts.json')) + ' auth=' + fs.existsSync(path.join(PORTABLE_DATA, 'auth.json'))); } catch (e) { /* ignore */ }

        if (!needLogin) { launchMain(); return; }

        let loginWin = new BrowserWindow({
            width: 400, height: 460,
            resizable: false, autoHideMenuBar: true,
            title: '登录',
            backgroundColor: '#f2f5fa',
            webPreferences: {
                preload: path.join(__dirname, 'login-preload.js'),
                contextIsolation: false,
                nodeIntegration: false
            }
        });
        loginWin.setMenuBarVisibility(false);
        loginWin.loadFile(path.join(__dirname, 'login.html'));

        ipcMain.once('auth:done', () => {
            try { if (loginWin && !loginWin.isDestroyed()) loginWin.close(); } catch (e) { /* ignore */ }
            launchMain();
        });

        loginWin.on('closed', () => {
            loginWin = null;
            // 登录窗被关掉且没有主窗口 → 退出，避免后台残留
            if (BrowserWindow.getAllWindows().length === 0) app.quit();
        });
    });

    app.on('window-all-closed', () => app.quit());
}

/* ---------------- 退出前把 Cookie / 存储刷到磁盘 ---------------- */
let quitting = false;
app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();

    try {
        for (const slot of readAccounts().slots) {
            try {
                session.fromPartition(`persist:fanqie-${slot}`).flushStorageData();
            } catch (err) { /* ignore */ }
        }
        flog('退出前已刷新各账号存储');
    } catch (err) {
        flog('flush 失败: ' + (err && err.message));
    }

    setTimeout(() => {
        try { app.quit(); } catch (err) { /* ignore */ }
    }, 800);
});
