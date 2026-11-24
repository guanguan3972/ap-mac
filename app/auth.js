// 用户系统：账号密码校验 + 机器绑定（本地离线）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function machineId() {
    const raw = [os.hostname(), os.platform(), os.arch()].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// 在线账号表：按优先级依次尝试（Gitee 主源 → jsDelivr 镜像 → GitHub）
// 注意：Gitee 的 raw 链接现在会 302 跳到 raw.giteeusercontent.com，
// 必须跟跳转，否则拿到的是一个 HTML 跳转页（以前就是栽在这上面）。
const ACCOUNT_BASES = [
    'https://gitee.com/guanguan520/update1/raw/master/',
    'https://cdn.jsdelivr.net/gh/guanguan3972/-@main/',
    'https://raw.githubusercontent.com/guanguan3972/-/main/'
];

// 账号表签名公钥（与桌面「GitHub上传_账号表」里的 private-key.pem 配对）
const ACCOUNT_PUBKEY = crypto.createPublicKey(
    '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAeR0j3R8fRz8z9bJ+GOrjJV7yJZlEAUdDpGvjgUIECCw=\n' +
    '-----END PUBLIC KEY-----\n'
);

// 抓文本，自动跟 3xx 跳转（最多 6 跳）
function fetchText(url, timeoutMs) {
    return new Promise((resolve) => {
        const https = require('https');
        const http = require('http');
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };

        const go = (u, hop) => {
            let mod;
            try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return finish(null); }
            const req = mod.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                const sc = res.statusCode || 0;
                if (sc >= 300 && sc < 400 && res.headers.location && hop < 6) {
                    res.resume();
                    let next = null;
                    try { next = new URL(res.headers.location, u).toString(); } catch (e) { /* ignore */ }
                    if (!next) return finish(null);
                    return go(next, hop + 1);
                }
                if (sc !== 200) { res.resume(); return finish(null); }
                let s = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { s += c; });
                res.on('end', () => finish(s));
                res.on('error', () => finish(null));
            });
            req.on('timeout', () => { req.destroy(); finish(null); });
            req.on('error', () => finish(null));
        };
        go(url, 0);
    });
}

// 上次用的账号表来源（写日志用）
let lastAccountSource = '';

// 拉账号表：json + sig 都拿到、且验签通过才算数；失败退回旧缓存，最后退回内置表
async function fetchRemoteAccounts(dataDir) {
    lastAccountSource = '';
    const jobs = ACCOUNT_BASES.map(async (base) => {
        const [jsonText, sigB64] = await Promise.all([
            fetchText(base + 'accounts.json', 3500),
            fetchText(base + 'accounts.sig', 3500)
        ]);
        if (!jsonText || !sigB64) return null;
        try {
            const ok = crypto.verify(null, Buffer.from(jsonText, 'utf8'), ACCOUNT_PUBKEY,
                Buffer.from(String(sigB64).trim(), 'base64'));
            if (!ok) { console.log('[账号表] 签名校验失败，跳过 ' + base); return null; }
            const j = JSON.parse(jsonText);
            if (!Array.isArray(j.users)) return null;
            return { base: base, users: j.users };
        } catch (e) { return null; }
    });

    // 并发拉，但按 ACCOUNT_BASES 的顺序取第一个验签通过的（Gitee 优先）
    const results = await Promise.all(jobs);
    for (const r of results) {
        if (!r) continue;
        try {
            fs.writeFileSync(path.join(dataDir, 'accounts-cache.json'),
                JSON.stringify({ at: Date.now(), users: r.users }), 'utf8');
        } catch (e) { /* ignore */ }
        lastAccountSource = '在线 ' + r.base;
        return r.users;
    }

    // 全部拉不到：用旧缓存（可能含已新增的账号），再不行用内置表
    try {
        const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts-cache.json'), 'utf8'));
        if (Array.isArray(j.users)) { lastAccountSource = '缓存'; return j.users; }
    } catch (e) { /* ignore */ }
    return null;
}

function readAccounts(appDir) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(appDir, 'accounts.json'), 'utf8'));
        return Array.isArray(j.users) ? j.users : [];
    } catch (e) { return []; }
}

function sha256(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

module.exports = function registerAuth(deps) {
    const { ipcMain, appDir, dataDir } = deps;
    const authFile = path.join(dataDir, 'auth.json');

    function alog(msg) {
        try { fs.appendFileSync(path.join(dataDir, 'auth.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ }
    }

    function readAuth() {
        try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) { return null; }
    }
    function writeAuth(obj) {
        try { fs.writeFileSync(authFile, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    }

    ipcMain.handle('auth:login', async (event, user, pass) => {
        const list = (await fetchRemoteAccounts(dataDir)) || readAccounts(appDir);
        alog('登录尝试 ' + String(user || '') + ' / 账号表来源=' + (lastAccountSource || '内置') + ' 共 ' + list.length + ' 条');
        const u = list.find(x => String(x.user) === String(user || ''));
        if (!u) return { ok: false, reason: '账号不存在' };
        if (sha256(pass) !== String(u.pass)) { alog('密码错误 ' + String(user || '')); return { ok: false, reason: '密码错误' }; }

        const mid = machineId();
        const saved = readAuth();

        // 管理员或允许多设备的账号：不锁机器
        if (u.admin || u.multiDevice) {
            writeAuth({ user: u.user, machine: mid, at: Date.now(), multi: true });
            return { ok: true, user: u.user, admin: !!u.admin };
        }

        // 普通账号：一码一机
        if (saved && saved.user === u.user && saved.machine && saved.machine !== mid) {
            return { ok: false, reason: '该账号已绑定其他电脑，请联系管理员解绑' };
        }
        if (saved && saved.user && saved.user !== u.user && saved.machine === mid) {
            // 同一台机器登记过别的账号，允许覆盖但提示
            writeAuth({ user: u.user, machine: mid, at: Date.now() });
            return { ok: true, user: u.user, replaced: saved.user };
        }
        writeAuth({ user: u.user, machine: mid, at: Date.now() });
        return { ok: true, user: u.user };
    });

    ipcMain.handle('auth:status', () => {
        const a = readAuth();
        if (!a || !a.user) return { ok: false };
        const list = readAccounts(appDir);
        const u = list.find(x => x.user === a.user);
        if (!u) return { ok: false, reason: '账号已被移除' };
        if (!(u.admin || u.multiDevice) && a.machine !== machineId()) {
            return { ok: false, reason: '本机未授权' };
        }
        return { ok: true, user: a.user, admin: !!u.admin };
    });

    // 管理员解绑：清空指定账号的绑定（普通账号换机时用）
    ipcMain.handle('auth:unbind', (event, user) => {
        const a = readAuth();
        if (!a || !a.admin) {
            const list = readAccounts(appDir);
            const me = list.find(x => x.user === (a && a.user));
            if (!me || !me.admin) return { ok: false, reason: '只有管理员能解绑' };
        }
        if (a && a.user === user) writeAuth(null);
        return { ok: true };
    });

    return { readAuth };
};