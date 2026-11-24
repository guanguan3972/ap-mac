// 星月写作模块（独立窗口，简化版）
// 只做四件事：打开窗口、读作品、读章节、点开章节并读正文。
module.exports = function registerXingyue(deps) {
    const { ipcMain, BrowserWindow, clipboard, fs, path, dataDir } = deps;

    const SITES = {
        xingyue: { url: 'https://xingyuexiezuo.com', title: '星月写作' },
        miaobi: { url: 'https://www.miaobiagent.com/books', title: '妙笔写作' }
    };
    const wins = {};
    let currentSite = 'xingyue';

    function winOf(site) {
        const w = wins[site];
        return (w && !w.isDestroyed()) ? w : null;
    }

    // 妙笔点「作品」会 window.open 出一个新窗口，真正的内容在那个新窗口里。
    // 所以按站点取窗口时不能只看我们自己开的那个，得把同站点的窗口都算进来。
    function safeUrl(w) {
        try { return (w && !w.isDestroyed() && w.webContents) ? String(w.webContents.getURL() || '') : ''; } catch (e) { return ''; }
    }

    function siteWindows(site) {
        const out = [];
        try {
            const all = BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [];
            for (const w of all) {
                if (!w || w.isDestroyed()) continue;
                const u = safeUrl(w);
                if (site === 'miaobi' && u.indexOf('miaobiagent.com') >= 0) out.push(w);
                else if (site === 'xingyue' && u.indexOf('xingyuexiezuo.com') >= 0) out.push(w);
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    // 尽量挑「作品窗口」：URL 里带 /books/<id> 的，优先最新打开的那个
    function pickSiteWindow(site) {
        const all = siteWindows(site);
        const books = all.filter((w) => /\/books\/[A-Za-z0-9_-]+/.test(safeUrl(w)));
        if (books.length) return books[books.length - 1];
        return winOf(site) || all[all.length - 1] || null;
    }

    function bookUrlOf(w) {
        const m = /\/books\/([A-Za-z0-9_-]+)/.exec(safeUrl(w));
        return m ? m[1] : '';
    }

    // 判断是不是「作品列表/登录」这类非内容页（这些页面上没有目录）
    function isListPage(w) {
        let p = '/';
        try { p = new URL(safeUrl(w)).pathname || '/'; } catch (e) { p = '/'; }
        return p === '/' || p === '/books' || p === '/books/' || p === '/login' || p === '/login/';
    }

    let win = null;

    // 强力清洗：去掉 "—— 2000 字 ——" 这类字数分隔（各种横线/全角/零宽字符都覆盖）
    function scrubMarkers(s) {
        let x = String(s || '');
        // 统一零宽字符
        x = x.replace(/[\u200b-\u200f\uFEFF]/g, '');
        // 分隔符：各种横线、波浪、等号、下划线
        const D = '[—–‑‒−‐－﹣~～_=─━]';
        const NUM = '[0-9０-９][0-9０-９,，\\s]*';
        const re = new RegExp(D + '{1,8}[ \\t]*' + NUM + '字[ \\t]*' + D + '{1,8}', 'g');
        x = x.replace(re, '');
        // 单边形式：只有前面有横线，例如 "—— 2000 字"
        const re2 = new RegExp(D + '{1,8}[ \\t]*' + NUM + '字', 'g');
        x = x.replace(re2, '');
        // 清理因此留下的空行
        x = x.replace(/[ \\t\\u00a0]+$/gm, '').replace(/\\n{3,}/g, '\\n\\n');
        return x.trim();
    }

    function log(msg) {
        try { fs.appendFileSync(path.join(dataDir, 'xingyue-grab.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ }
    }

    function readScript(name) {
        return fs.readFileSync(path.join(__dirname, name), 'utf8');
    }

    function wc() {
        if (win && !win.isDestroyed()) return win.webContents;
        return null;
    }


    // 读当前章节正文：优先真·Ctrl+A/Ctrl+C，拿不到再用 DOM 并去掉字数分隔符
    async function readEditorText(w) {
        try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch (e) { /* ignore */ }

        const js = `(() => {
            const MARK = /^[—–\\-]{1,4}\\s*\\d[\\d,]*\\s*字\\s*[—–\\-]{1,4}$/;
            const clean = (s) => String(s || '')
                .replace(/[—–\\-]{1,4}\\s*\\d[\\d,，]*\\s*字\\s*[—–\\-]{1,4}/g, '')
                .trim();

            // 找到正文编辑器
            let ed = document.querySelector('[contenteditable="true"]');
            if (!ed) {
                const tas = Array.from(document.querySelectorAll('textarea')).sort((a,b)=>(b.value||'').length-(a.value||'').length);
                if (tas.length) {
                    return { kind: 'textarea', text: clean(tas[0].value) };
                }
                return { kind: 'none', text: '' };
            }

            // 按段落节点取：每段之间用空行连接，跳过"—— N 字 ——"分隔节点
            const parts = [];
            for (const node of ed.children) {
                const t = (node.innerText || '').trim();
                if (!t) continue;
                if (MARK.test(t.replace(/\\s/g, ''))) continue;
                const c = clean(t);
                if (c) parts.push(c);
            }

            let text = parts.length ? parts.join(String.fromCharCode(10, 10)) : clean(ed.innerText);
            return { kind: parts.length ? '段落' : 'innerText', text: text };
        })()`;

        let r = null;
        try { r = await w.executeJavaScript(js, true); } catch (e) { r = null; }
        let text = String((r && r.text) || '').trim();

        // 段落太少且没有换行 → 用剪贴板兜底（Ctrl+A/Ctrl+C）
        if (text.length < 50 || text.indexOf(String.fromCharCode(10)) < 0) {
            try {
                const boxJs = `(() => {
                    const ce = document.querySelector('[contenteditable="true"]');
                    if (!ce) return null;
                    const b = ce.getBoundingClientRect();
                    return { x: Math.round(b.left + 60), y: Math.round(b.top + 30) };
                })()`;
                const box = await w.executeJavaScript(boxJs, true);
                if (box) {
                    // mac 上用 Cmd 而不是 Ctrl，否则全选/复制按不出来
                    const MOD = process.platform === 'darwin' ? 'meta' : 'control';
                    w.sendInputEvent(Object.assign({ type: 'mouseMove' }, box));
                    w.sendInputEvent(Object.assign({ type: 'mouseDown', button: 'left', clickCount: 1 }, box));
                    w.sendInputEvent(Object.assign({ type: 'mouseUp', button: 'left', clickCount: 1 }, box));
                    await new Promise(res => setTimeout(res, 350));
                    w.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [MOD] });
                    w.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [MOD] });
                    await new Promise(res => setTimeout(res, 250));
                    w.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: [MOD] });
                    w.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: [MOD] });
                    await new Promise(res => setTimeout(res, 700));
                }
                let raw = '';
                try { raw = clipboard && clipboard.readText ? clipboard.readText() : ''; } catch (e) { raw = ''; }
                const cbText = (typeof raw === 'string' ? raw : String(raw || ''))
                    .replace(/[—–\\-]{1,4}\\s*\\d[\\d,，]*\\s*字\\s*[—–\\-]{1,4}/g, '')
                    .trim();
                if (cbText.length > text.length) text = cbText;
            } catch (e) { /* ignore */ }
        }

        text = text
            .replace(/[—–\\-]{1,4}\\s*\\d[\\d,，]*\\s*字\\s*[—–\\-]{1,4}/g, '')
            .replace(/[ \\t\\u00a0]+$/gm, '')
            .replace(/\\n{3,}/g, String.fromCharCode(10, 10))
            .trim();

        log('读正文: 来源=' + ((r && r.kind) || '?') + ' 字数=' + text.length + ' 行数=' + (text.split(String.fromCharCode(10)).length));
        return text;
    }

    /* ---------- 打开窗口 ---------- */
    ipcMain.handle('xingyue:open', (event, site) => {
        const key = SITES[site] ? site : 'xingyue';
        currentSite = key;
        try {
            const exist = winOf(key);
            if (exist) { exist.show(); exist.focus(); win = exist; return { ok: true, site: key }; }

            const w = new BrowserWindow({
                width: 1280, height: 860,
                title: SITES[key].title,
                autoHideMenuBar: true,
                backgroundColor: '#ffffff',
                webPreferences: {
                    partition: 'persist:' + key,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    backgroundThrottling: false   // 读章节要边滚边扫，窗口被遮住也别降频
                }
            });
            w.setMenuBarVisibility(false);
            w.loadURL(SITES[key].url);
            if (key === 'miaobi') {
                // 页面每次加载完都补注入一次网络钩子（幂等），这样目录接口一请求就能截到
                try { w.webContents.on('did-finish-load', () => injectNetHook(w.webContents)); } catch (e) { /* ignore */ }
                // 妙笔点作品会弹新窗口：给新窗口也关掉后台降频、补挂钩子
                try {
                    w.webContents.on('did-create-window', (child) => {
                        try {
                            if (child && child.webContents) {
                                child.webContents.setBackgroundThrottling(false);
                                child.webContents.on('did-finish-load', () => injectNetHook(child.webContents));
                                log('妙笔新窗口: ' + String(child.webContents.getURL() || '').slice(0, 100));
                            }
                        } catch (e) { /* ignore */ }
                    });
                } catch (e) { /* ignore */ }
            }
            w.on('closed', () => { delete wins[key]; });
            wins[key] = w;
            win = w;   // 保持旧变量兼容
            return { ok: true, site: key };
        } catch (e) {
            log('打开窗口失败: ' + e.message);
            return { ok: false, reason: e.message };
        }
    });

    ipcMain.handle('xingyue:bind', () => ({ ok: false, reason: '已改为独立窗口' }));

    /* ---------- 读作品列表 ---------- */

    // 妙笔：作品卡是 <a href="/books/<id>">书名</a>
    const MIAOBI_WORKS_JS = `(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/books/"]')) {
            const href = a.getAttribute('href') || '';
            const m = /\\/books\\/([A-Za-z0-9]+)/.exec(href);
            if (!m) continue;
            const id = m[1];
            const name = (a.innerText || '').trim().split(String.fromCharCode(10))[0].trim();
            if (!name || name.length > 40) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            // 同一卡片里的字数
            let words = '';
            let p = a.parentElement;
            for (let i = 0; i < 5 && p; i++) {
                const tx = (p.innerText || '');
                const wm = /([\\d.]+\\s*万字?)/.exec(tx);
                if (wm) { words = wm[1]; break; }
                p = p.parentElement;
            }
            out.push({ id: id, name: name, words: words });
        }
        return out;
    })()`;

    ipcMain.handle('xingyue:syncWorks', async () => {
        if (currentSite === 'miaobi') {
            const w2 = wc();
            if (!w2) return { ok: false, reason: '妙笔窗口还没打开' };
            try {
                const list = await w2.executeJavaScript(MIAOBI_WORKS_JS, true);
                log('妙笔读作品: ' + (list || []).length + ' 个');
                return { ok: true, count: (list || []).length, works: (list || []).map(x => ({ name: x.name, words: x.words, id: x.id })) };
            } catch (e) { return { ok: false, reason: e.message }; }
        }

        const w = wc();
        if (!w) return { ok: false, reason: '星月窗口还没打开，请先点「📖 星月写作」' };
        try {
            const r = await w.executeJavaScript(readScript('xingyue-scrape.js'), true);
            try {
                fs.writeFileSync(path.join(dataDir, 'xingyue-books.json'), JSON.stringify(r.works || [], null, 2), 'utf8');
            } catch (e) { /* ignore */ }
            log('读作品: ' + (r.count || 0) + ' 个');
            return { ok: true, count: r.count || 0, works: r.works || [] };
        } catch (e) {
            log('读作品异常: ' + e.message);
            return { ok: false, reason: e.message };
        }
    });

    /* ---------- 打开作品（点卡片里的「作品管理」） ---------- */
    ipcMain.handle('xingyue:openWork', async (event, name) => {
        if (currentSite === 'miaobi') {
            const w = wc();
            if (!w) return { ok: false, reason: '妙笔窗口还没打开' };
            // 进作品前先挂好网络钩子，目录接口那一次请求才不会漏
            try { await injectNetHook(w); } catch (e) { /* ignore */ }
            try {
                const js = `(() => {
                    const kw = ${JSON.stringify(String(name || ''))};
                    for (const a of document.querySelectorAll('a[href*="/books/"]')) {
                        const nm = (a.innerText || '').trim().split(String.fromCharCode(10))[0].trim();
                        if (nm === kw) { a.click(); return { ok: true, href: a.getAttribute('href') }; }
                    }
                    return { ok: false, reason: '没找到这本书：' + kw };
                })()`;
                const r = await w.executeJavaScript(js, true);
                log('妙笔打开作品 ' + name + ': ' + JSON.stringify(r));
                if (r && r.ok) {
                    await new Promise(res => setTimeout(res, 2500));
                    // 妙笔是 window.open 弹新窗口的，这里确认一下作品窗口能不能抓到
                    const workWin = pickSiteWindow('miaobi');
                    const bk = bookUrlOf(workWin);
                    log('妙笔作品窗口: ' + JSON.stringify({ found: !!bk, url: String(safeUrl(workWin) || '').slice(0, 90) }));
                    return { ok: true, via: '链接跳转', href: r.href, workWindow: !!bk };
                }
                return r || { ok: false, reason: '无返回' };
            } catch (e) { return { ok: false, reason: e.message }; }
        }

        const w = wc();
        if (!w) return { ok: false, reason: '星月窗口还没打开' };
        try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch (e) { /* ignore */ }

        const kw = String(name || '');
        const findJs = `(async () => {
            const kw = ${JSON.stringify(kw)};
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const before = location.href;

            let card = null;
            for (const el of document.querySelectorAll('div, li, article, section')) {
                const tx = (el.innerText || '');
                if (!tx.includes(kw) || !tx.includes('作品管理')) continue;
                if (tx.length > 800) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 60 || r.height < 40) continue;
                const firstLine = tx.split(String.fromCharCode(10)).map(s => s.trim()).filter(Boolean)[0] || '';
                const rank = firstLine === kw ? 0 : (firstLine.startsWith(kw) ? 1 : 2);
                const score = rank * 1000000 + r.width * r.height;
                if (!card || score < card.score) card = { el: el, score: score, firstLine: firstLine };
            }
            if (!card) return { ok: false, reason: '没找到含作品管理的卡片：' + kw };

            card.el.scrollIntoView({ block: 'center' });
            await sleep(600);

            // 优先：从卡片 HTML 里找出书籍 id，直接按网址跳到章节页
            const html = card.el.outerHTML || '';
            let bookId = '';
            const pickId = (str, key) => { const i0 = str.indexOf(key); if (i0 < 0) return ''; let j = i0 + key.length; let d = ''; while (j < str.length && str[j] >= '0' && str[j] <= '9') { d += str[j]; j++; } return d; };
            bookId = pickId(html, 'chapters/');
            bookId = bookId || pickId(html, 'bookId=');
            if (!bookId) {
                // 全页找指向 chapters 的链接，优先文字里含书名的
                for (const a of document.querySelectorAll('a[href*="chapters/"]')) {
                    const hrefAttr = a.getAttribute('href') || '';
                    const idxC = hrefAttr.indexOf('chapters/');
                    let idText = '';
                    if (idxC >= 0) {
                        const rest = hrefAttr.slice(idxC + 9).split(/[^0-9]/)[0];
                        idText = rest;
                    }
                    const m2 = idText ? [idText, idText] : null;
                    if (!m2) continue;
                    const t2 = (a.innerText || '');
                    if (t2.includes(kw) || (a.closest('div') && (a.closest('div').innerText || '').includes(kw))) { bookId = m2[1]; break; }
                    if (!bookId) bookId = m2[1];
                }
            }
            if (bookId) {
                location.hash = '#/chapters/' + bookId;
                await sleep(2500);
                return { ok: location.href !== before || true, href: location.href, via: '直接跳转', bookId: bookId, cardFirst: card.firstLine };
            }

            const norm = (s) => (s || '').replace(/[\\s\\u00a0]/g, '');
            const cands = [];
            for (const b of card.el.querySelectorAll('button, a, span, div, p, i')) {
                if (norm(b.innerText) !== '作品管理') continue;
                const r = b.getBoundingClientRect();
                if (r.width < 8 || r.height < 8) continue;
                cands.push({ el: b, area: r.width * r.height, w: r.width });
            }
            cands.sort((a, b2) => (a.area - b2.area) || (a.w - b2.w));
            if (!cands.length) return { ok: false, reason: '卡片里没找到作品管理按钮' };
            const btn = cands[0].el;

            btn.scrollIntoView({ block: 'center' });
            await sleep(300);
            const r = btn.getBoundingClientRect();
            if (!isFinite(r.left) || !isFinite(r.top) || r.width < 2 || r.height < 2) {
                return { ok: false, reason: '按钮坐标无效' };
            }
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            if (!isFinite(cx) || !isFinite(cy) || cy < 0 || cy > window.innerHeight) {
                return { ok: false, reason: '按钮在视口外 y=' + cy };
            }
            return { ok: true, x: cx, y: cy, before: before, cardFirst: card.firstLine };
        })()`;

        try {
            const pos = await w.executeJavaScript(findJs, true);
            if (!pos || !pos.ok) { log('打开作品 ' + kw + ': ' + JSON.stringify(pos)); return pos; }

            const pt = { x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    w.sendInputEvent(Object.assign({ type: 'mouseMove' }, pt));
                    await new Promise(r => setTimeout(r, 150));
                    w.sendInputEvent(Object.assign({ type: 'mouseDown', button: 'left', clickCount: 1 }, pt));
                    w.sendInputEvent(Object.assign({ type: 'mouseUp', button: 'left', clickCount: 1 }, pt));
                } catch (evErr) {
                    log('鼠标事件异常: ' + evErr.message + ' pt=' + JSON.stringify(pt));
                    break;
                }
                await new Promise(r => setTimeout(r, 2200));

                const check = await w.executeJavaScript(`(() => {
                    const txt = document.body.innerText || '';
                    return {
                        href: location.href,
                        entered: location.href !== ${JSON.stringify(pos.before)} || (txt.includes('新建章节') && /第\\s*\\d+\\s*章/.test(txt))
                    };
                })()`, true);

                if (check && check.entered) {
                    log('打开作品 ' + kw + ': 成功 ' + JSON.stringify({ via: '鼠标点击', attempt: attempt, href: check.href }));
                    return { ok: true, via: '鼠标点击', attempt: attempt, href: check.href };
                }
            }
            const r = { ok: false, reason: '点三次都没进入章节页', cardFirst: pos.cardFirst };
            log('打开作品 ' + kw + ': ' + JSON.stringify(r));
            return r;
        } catch (e) {
            log('打开作品异常: ' + e.message);
            return { ok: false, reason: e.message };
        }
    });

    /* ---------- 读章节列表 ---------- */

    // 妙笔：把网络钩子注入页面（越早越好），用来截页面自己请求的章节列表
    let netHookSrc = null;
    function injectNetHook(w) {
        try {
            if (!netHookSrc) netHookSrc = readScript('xingyue-net-hook.js');
            const p = w.executeJavaScript(netHookSrc, true);
            if (p && typeof p.catch === 'function') p.catch(() => null);
            return p;
        } catch (e) { return null; }
    }

    // 妙笔：左栏目录容器分片滚动（每次调用滚 3 屏），由主进程循环驱动，界面不卡
    const bookKeyOf = (u) => {
        const m = /\/books\/([A-Za-z0-9_-]+)/.exec(String(u || ''));
        return m ? m[1] : '';
    };

    async function readMiaobiChapters(w) {
        const src = readScript('xingyue-miaobi-chapters.js');
        const exec = (cfg) => w.executeJavaScript('window.__mbCfg = ' + JSON.stringify(cfg) + ';\n' + src, true);
        const base = { frames: 3, screens: 0.8, delay: 230 };

        try { await injectNetHook(w); } catch (e) { /* ignore */ }

        let r = null;
        try {
            r = await exec(Object.assign({ phase: 'init' }, base));
        } catch (e) {
            log('妙笔读章节异常(init): ' + e.message);
            return { ok: false, reason: e.message };
        }

        // 缓存只在「同一本书」内复用，换书就从头读，避免串书
        const key = bookKeyOf(r && r.url);
        const acc = new Map();
        const old = global.__miaoCache;
        if (old && old.key && key && old.key === key) for (const c of old.map.values()) acc.set(c.num, c);
        const merge = (rows) => { for (const c of (rows || [])) if (c && c.num) acc.set(c.num, c); };

        if (!r || !r.ok) {
            merge(r && r.rows);
            const reason = (r && r.reason) || '没找到左栏目录容器';
            log('妙笔读章节(init)失败: ' + JSON.stringify({ reason: reason, diag: (r && r.diag) || [] }));
            return { ok: false, reason: reason, diag: (r && r.diag) || [], count: acc.size, key: key };
        }

        merge(r.rows);
        log('妙笔目录容器: mode=' + r.mode + ' cls=' + r.boxCls + ' 可滚层=' + r.cands +
            ' sh=' + r.sh + ' ch=' + r.ch + ' 首屏=' + r.count +
            ' 接口=' + (r.api || 0) + (r.apiTotal ? '/' + r.apiTotal : '') +
            (r.setup ? ' 种子=' + r.setup.seeds : '') +
            (r.probe ? ' 探针=' + JSON.stringify(r.probe) : '') +
            (r.net && r.net.length ? ' 网络=' + JSON.stringify(r.net) : ''));
        if (r.fromApi) log('妙笔读章节: 接口已给全量 ' + r.api + ' 条，跳过滚动');

        let steps = 1;
        let stall = 0;
        while (!r.done && steps < 80) {
            steps++;
            try {
                r = await exec(Object.assign({ phase: 'step' }, base));
            } catch (e) {
                log('妙笔读章节异常(step ' + steps + '): ' + e.message);
                break;
            }
            if (!r || !r.ok) { log('妙笔读章节(step)失败: ' + JSON.stringify({ reason: r && r.reason })); break; }

            const before = acc.size;
            merge(r.rows);
            if (acc.size === before) stall++; else stall = 0;

            // 程序化滚动推不动 → 发真实滚轮事件逼虚拟列表加载
            if (r.needWheel && r.needWheel.x != null) {
                try {
                    const pt = { x: Math.round(r.needWheel.x), y: Math.round(r.needWheel.y) };
                    w.sendInputEvent(Object.assign({ type: 'mouseMove' }, pt));
                    await new Promise(res => setTimeout(res, 80));
                    for (let k = 0; k < 3; k++) {
                        w.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -Math.abs(r.needWheel.dy || 480), canScroll: true });
                        await new Promise(res => setTimeout(res, 140));
                    }
                } catch (e) { /* ignore */ }
            }

            if (stall >= 4) { log('妙笔读章节: 连续 4 次没新增，停在第 ' + steps + ' 步，已读 ' + acc.size + ' 章'); break; }
            if (acc.size > 2000) break;
        }

        const list = Array.from(acc.values()).sort((a, b) => a.num - b.num);
        log('妙笔读章节: ' + list.length + ' 章（' + steps + ' 步' + (r && r.done ? '，到底' : '，未到底') +
            '，接口 ' + ((r && r.api) || 0) + ' 条）');
        return { ok: true, count: list.length, chapters: list, steps: steps, atBottom: !!(r && r.done), key: key, fromApi: !!(r && r.fromApi), api: (r && r.api) || 0 };
    }

    ipcMain.handle('xingyue:listChapters', async (event, siteHint) => {
        // 界面下拉框传了站点就用它（该站窗口确实开着时），否则沿用上次打开的站点
        const site = (siteHint && SITES[siteHint] && (winOf(siteHint) || siteWindows(siteHint).length)) ? siteHint : currentSite;
        const target = pickSiteWindow(site) || winOf(currentSite);
        const w = target ? target.webContents : wc();
        if (!w) return { ok: false, reason: '窗口还没打开' };

        if (site === 'miaobi') {
            // 妙笔的作品是单独弹出来的窗口，必须操作那个窗口（不是主页）
            if (isListPage(target)) {
                return {
                    ok: false,
                    reason: '现在拿到的还是妙笔主页窗口。请先在妙笔里点开一本书（会弹出作品窗口），再点「读取章节」'
                };
            }
            const r = await readMiaobiChapters(w);
            if (r.ok) global.__miaoCache = { key: r.key || '', map: new Map(r.chapters.map(c => [c.num, c])) };
            return r;
        }

        const snapJs = readScript('xingyue-chapters.js');
        const map = new Map();
        try {
            const r = await w.executeJavaScript(snapJs, true);
            for (const c of (r.chapters || [])) map.set(c.num, c);
        } catch (e) { /* ignore */ }

        const list = Array.from(map.values()).sort((a, b) => a.num - b.num);
        log('读章节 ' + site + ': ' + list.length + ' 章');
        return { ok: true, count: list.length, chapters: list };
    });

    ipcMain.handle('xingyue:grabChapters', async (event, nums, siteHint) => {
        // 按当前站点取对应那个窗口（优先界面下拉框），妙笔要取「作品窗口」
        const site = (siteHint && SITES[siteHint] && (winOf(siteHint) || siteWindows(siteHint).length)) ? siteHint : currentSite;
        const grabWin = pickSiteWindow(site) || winOf(currentSite) || winOf('miaobi') || winOf('xingyue');
        const w = grabWin ? grabWin.webContents : wc();
        if (!w) return { ok: false, reason: '星月窗口还没打开' };
        const want = Array.isArray(nums) ? nums.map(Number).filter(Boolean) : [];
        if (!want.length) return { ok: false, reason: '没选章节' };
        if (site === 'miaobi' && isListPage(grabWin)) {
            return { ok: false, reason: '现在拿到的还是妙笔主页窗口。请先在妙笔里点开一本书，再导入' };
        }

        try { if (grabWin && !grabWin.isDestroyed()) { grabWin.show(); grabWin.focus(); } } catch (e) { /* ignore */ }

        const results = [];
        for (const num of want) {
            // 妙笔左栏是虚拟列表：先把这一章滚进可视区，否则第 20 章之后的行走坐标点不到
            if (site === 'miaobi') {
                try {
                    const revealJs = 'window.__mbCfg = ' + JSON.stringify({ num: Number(num) }) + ';\n' + readScript('xingyue-miaobi-locate.js');
                    const rv = await w.executeJavaScript(revealJs, true);
                    if (!rv || !rv.ok) {
                        results.push({ num: num, ok: false, reason: (rv && rv.reason) || '目录里没找到这一章' });
                        continue;
                    }
                } catch (e) {
                    log('妙笔定位第' + num + '章异常: ' + e.message);
                }
            }

            const locateJs = `(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const n = ${JSON.stringify(Number(num))};
                const hit = (el) => new RegExp('第\\\\s*' + n + '\\\\s*章').test(el.innerText || '');
                const els = Array.from(document.querySelectorAll('div, li, a, span, p'))
                    .filter(el => (el.innerText || '').length < 200 && hit(el));
                if (!els.length) return { ok: false, reason: '列表里没找到第' + n + '章' };

                els.sort((a, b2) => {
                    const ra = a.getBoundingClientRect(), rb = b2.getBoundingClientRect();
                    return ra.width * ra.height - rb.width * rb.height;
                });
                const el = els[0];
                el.scrollIntoView({ block: 'center' });
                await sleep(400);
                const r = el.getBoundingClientRect();
                const rowText = (el.innerText || '').replace(/\\s+/g, ' ').trim();
                return {
                    ok: true,
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    rowText: rowText
                };
            })()`;

            let pos = null;
            try { pos = await w.executeJavaScript(locateJs, true); } catch (e) { pos = { ok: false, reason: e.message }; }
            if (!pos || !pos.ok) { results.push({ num: num, ok: false, reason: (pos && pos.reason) || '定位失败' }); continue; }

            // 真实鼠标点开这一章
            const pt = { x: pos.x, y: pos.y };
            w.sendInputEvent(Object.assign({ type: 'mouseMove' }, pt));
            await new Promise(r => setTimeout(r, 120));
            w.sendInputEvent(Object.assign({ type: 'mouseDown', button: 'left', clickCount: 1 }, pt));
            w.sendInputEvent(Object.assign({ type: 'mouseUp', button: 'left', clickCount: 1 }, pt));
            await new Promise(r => setTimeout(r, 1800));

            const text = await readEditorText(w);
            const ok = text.length > 50;
            results.push({ num: num, ok: ok, text: ok ? text : '', len: text.length, rowText: pos.rowText || '', reason: ok ? '' : '没读到正文' });
        }
        log('批量读正文: ' + results.map(x => x.num + (x.ok ? '✔' : '✘') + x.len).join(','));
        return { ok: true, results: results };
    });

    /* ---------- 只读当前章 ---------- */
    ipcMain.handle('xingyue:copyChapter', async () => {
        const tw = pickSiteWindow(currentSite);
        const w = tw ? tw.webContents : wc();
        if (!w) return { ok: false, reason: '星月窗口还没打开' };
        try {
            const text = await readEditorText(w);
            log('只读当前章: ' + text.length + ' 字');
            if (text.length < 50) return { ok: false, reason: '没读到正文，请先在星月里点开一章' };
            return { ok: true, text: text, len: text.length };
        } catch (e) { return { ok: false, reason: e.message }; }
    });

    /* ---------- 兼容旧接口 ---------- */
    ipcMain.handle('xingyue:readChapter', async () => {
        const tw = pickSiteWindow(currentSite);
        const w = tw ? tw.webContents : wc();
        if (!w) return { ok: false, reason: '星月窗口还没打开' };
        try {
            const r = await w.executeJavaScript(readScript('xingyue-chapter.js'), true);
            return { ok: !!(r && r.body && r.body.length > 50), title: r.title, body: r.body, len: r.len };
        } catch (e) { return { ok: false, reason: e.message }; }
    });

    ipcMain.handle('xingyue:openChapter', async () => ({ ok: false, reason: '已改为按章节列表导入' }));
};