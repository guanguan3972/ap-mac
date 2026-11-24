// 外壳页脚本：标签页 + webview 管理 + 注入
const HOME_URL = 'https://fanqienovel.com/main/writer/';
const WRITER_RE = /fanqienovel\.com\/main\/writer/i;
const PRELOAD_URL = new URL('preload.js', location.href).href;

let AUTOMATION = '';
let SHIM = '';

const views = new Map();      // slot -> webview
const known = new Set();      // 已知账号槽位
let names = {};               // slot -> 自定义名字
let savedOpenTabs = null;      // 上次关软件时开着的标签（null = 从没记录过）
let activeSlot = null;
let tabOrder = [];

const tabsEl = document.getElementById('tabs');
const viewsEl = document.getElementById('views');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');
const maskEl = document.getElementById('rename-mask');
const renameInput = document.getElementById('rename-input');
const ctxEl = document.getElementById('ctxmenu');
let renameSlot = null;
let ctxSlot = null;

/* ---------- 右键菜单 ---------- */
function showCtx(slot, x, y) {
    ctxSlot = slot;
    // 每次都重建菜单内容：之前被账号下拉覆盖过就再也回不来了
    ctxEl.innerHTML =
        '<div class="ctx-item" data-act="rename">重命名</div>' +
        '<div class="ctx-item" data-act="close">关闭标签</div>' +
        '<div class="ctx-sep"></div>' +
        '<div class="ctx-item danger" data-act="delete">彻底删除账号</div>';

    ctxEl.classList.add('show');
    const w = 160;
    const h = 120;
    ctxEl.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctxEl.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
}

function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showAccountMenu(x, y) {
    ctxSlot = null;
    const all = Array.from(known).sort((a, b) => a - b);
    if (!all.length) { setStatus('还没有账号，点「＋ 账号」新建'); return; }

    ctxEl.innerHTML = all.map((s) => {
        const isOpen = views.has(s);
        const label = (names[s] || `账号 ${s}`) + (isOpen ? '（已打开）' : '（已关闭）');
        return `<div class="ctx-item" data-open-slot="${s}" style="${isOpen ? 'color:#94a3b8;' : ''}">${escHtml(label)}</div>`;
    }).join('');

    ctxEl.classList.add('show');
    const w = 190, h = Math.min(320, 40 + all.length * 32);
    ctxEl.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctxEl.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';

    ctxEl.querySelectorAll('[data-open-slot]').forEach((el) => {
        el.onclick = () => {
            const s = Number(el.dataset.openSlot);
            hideCtx();
            openSlot(s);
        };
    });
}

// 把"当前开着的标签"写回磁盘
function persistOpenTabs() {
    try {
        window.shellApi.setOpenTabs(Array.from(views.keys()).sort((a, b) => a - b));
    } catch (e) { /* ignore */ }
}

function hideCtx() {
    ctxEl.classList.remove('show');
    ctxSlot = null;
}

ctxEl.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.ctx-item');
    if (!item) return;
    const act = item.dataset.act;
    if (!act) return;
    const slot = ctxSlot;
    hideCtx();
    if (slot === null) return;

    if (act === 'rename') {
        openRename(slot);
    } else if (act === 'close') {
        closeSlot(slot);
    } else if (act === 'delete') {
        if (!confirm(`彻底删除「${labelOf(slot)}」？\n\n这会清除该账号的登录数据，无法撤销。`)) return;
        try { await window.shellApi.removeAccount(slot); } catch (e) { /* ignore */ }
        known.delete(slot);
        delete names[slot];
        closeSlot(slot, true);
        setStatus(`${labelOf(slot)} 已删除`);
    }
});

window.addEventListener('click', (ev) => {
    if (!ctxEl.contains(ev.target)) hideCtx();
});
window.addEventListener('blur', hideCtx);

function setStatus(text) {
    statusEl.textContent = text || '';
}

function loadTabOrder() {
    try {
        const raw = localStorage.getItem('tabOrder');
        const arr = raw ? JSON.parse(raw) : [];
        tabOrder = Array.isArray(arr) ? arr.filter(n => Number.isInteger(n)) : [];
    } catch (e) { tabOrder = []; }
}

function saveTabOrder() {
    try { localStorage.setItem('tabOrder', JSON.stringify(tabOrder)); } catch (e) { /* ignore */ }
}

// 按用户拖出来的顺序返回（新账号追加在末尾）
function orderedSlots() {
    const slots = Array.from(views.keys());
    const knownOrder = tabOrder.filter(s => slots.includes(s));
    const rest = slots.filter(s => !knownOrder.includes(s)).sort((a, b) => a - b);
    tabOrder = knownOrder.concat(rest);
    return tabOrder.slice();
}

function moveTab(from, to) {
    if (!from || !to || from === to) return;
    const list = orderedSlots();
    const a = list.indexOf(from);
    const b = list.indexOf(to);
    if (a < 0 || b < 0) return;
    list.splice(a, 1);
    list.splice(b, 0, from);
    tabOrder = list;
    saveTabOrder();
    renderTabs();
}

function labelOf(slot) {
    const n = names[slot];
    return n && String(n).trim() ? String(n).trim() : `账号 ${slot}`;
}

/* ---------- 账号数据 ---------- */
async function loadAccounts() {
    let acc = { slots: [], last: 1, names: {}, openTabs: null };
    try {
        acc = await window.shellApi.getAccounts();
    } catch (e) { /* ignore */ }

    names = acc.names || {};
    savedOpenTabs = Array.isArray(acc.openTabs) ? acc.openTabs.map(Number) : null;

    // 旧版本把账号清单塞在 localStorage 里，正是"删了又回来"的元凶，清掉
    try { localStorage.removeItem('slots'); } catch (e) { /* ignore */ }

    let slots = (acc.slots || []).slice().sort((a, b) => a - b);
    if (!slots.length) slots = [1];

    const last = Number(acc.last) || slots[0];
    return { slots, last: slots.includes(last) ? last : slots[0] };
}

/* ---------- 重命名弹层 ---------- */
function openRename(slot) {
    renameSlot = slot;
    renameInput.value = names[slot] || '';
    maskEl.classList.add('show');
    setTimeout(() => { renameInput.focus(); renameInput.select(); }, 30);
}

function closeRename() {
    maskEl.classList.remove('show');
    renameSlot = null;
}

async function commitRename() {
    if (renameSlot === null) return;
    const slot = renameSlot;
    const value = renameInput.value.trim();
    closeRename();
    try {
        const acc = await window.shellApi.renameAccount(slot, value);
        names = acc.names || {};
        renderTabs();
        setStatus(value ? `账号 ${slot} 改名为「${value}」` : `账号 ${slot} 已恢复默认名称`);
    } catch (e) {
        setStatus('改名失败: ' + (e && e.message));
    }
}

document.getElementById('rename-ok').addEventListener('click', commitRename);
document.getElementById('rename-cancel').addEventListener('click', closeRename);
maskEl.addEventListener('click', (ev) => { if (ev.target === maskEl) closeRename(); });
renameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeRename(); }
});

/* ---------- 标签页 ---------- */
function renderTabs() {
    tabsEl.innerHTML = '';
    const slots = orderedSlots();

    for (const slot of slots) {
        const tab = document.createElement('div');
        tab.className = 'tab' + (slot === activeSlot ? ' active' : '');
        tab.title = `${labelOf(slot)}  ·  双击改名，右键删除`;
        tab.onclick = () => activate(slot);
        tab.ondblclick = (ev) => { ev.preventDefault(); openRename(slot); };

        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        const name0 = labelOf(slot);
        avatar.textContent = name0.replace(/^账号\s*/, '').slice(0, 1) || String(slot);
        tab.appendChild(avatar);

        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = name0;
        tab.appendChild(label);

        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = '关闭标签（账号保留）';
        x.onclick = (ev) => { ev.stopPropagation(); closeSlot(slot); };
        tab.appendChild(x);

        tab.oncontextmenu = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            showCtx(slot, ev.clientX, ev.clientY);
        };

        // 拖动排序
        tab.draggable = true;
        tab.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(slot));
            tab.classList.add('dragging');
        });
        tab.addEventListener('dragend', () => {
            tab.classList.remove('dragging');
            document.querySelectorAll('.tab.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        tab.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            tab.classList.add('drag-over');
        });
        tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
        tab.addEventListener('drop', (e) => {
            e.preventDefault();
            tab.classList.remove('drag-over');
            const from = Number(e.dataTransfer.getData('text/plain'));
            moveTab(from, slot);
        });

        tabsEl.appendChild(tab);
    }

    emptyEl.classList.toggle('show', views.size === 0);
}

function activate(slot) {
    activeSlot = slot;
    for (const [s, wv] of views) {
        wv.classList.toggle('active', s === slot);
    }
    renderTabs();
    updateNav();
    try { window.shellApi.setLast(slot); } catch (e) { /* ignore */ }
}

/* ---------- 注入 ---------- */
async function injectInto(wv, slot) {
    // 每次注入都取最新脚本，改完 userscript.js 只要刷新页面
    try {
        const fresh = await window.shellApi.getAutomation();
        if (fresh) {
            AUTOMATION = fresh;
            const m = /@version\s+([\d.]+)/.exec(fresh);
            if (m) setStatus(`脚本 v${m[1]}（${labelOf(slot)}）`);
        }
    } catch (e) { /* 用内存里的旧副本 */ }
    if (!AUTOMATION) return;
    try {
        // 版本不同就允许重新注入（否则更新后页面一直跑旧脚本，得手动 F5）
        const vm = /@version\s+([\d.]+)/.exec(AUTOMATION);
        const scriptVer = vm ? vm[1] : '0';
        const guard = `(function () {
            var v = '${scriptVer}';
            if (window.__novelUploaderVer === v) return false;
            window.__novelUploaderVer = v;
            window.__novelUploaderBooted = true;
            return true;
        })();`;
        const should = await wv.executeJavaScript(guard);
        if (!should) return;
        await wv.executeJavaScript('window.__novelUploaderSlot = ' + Number(slot) + ';');
        await wv.executeJavaScript(SHIM + '\n' + AUTOMATION);

        // 注入完立刻同步隐私状态（否则开着隐私模式刷新页面会失效）
        try {
            await wv.executeJavaScript('window.__novelUploaderSetPrivacy && window.__novelUploaderSetPrivacy(' + (privacyNow ? 'true' : 'false') + ')');
        } catch (e) { /* ignore */ }

        // 自检：登记通道是否可用
        try {
            const hasBridge = await wv.executeJavaScript("typeof window.__saveSchedule === 'function'");
            if (!hasBridge) setStatus(`${labelOf(slot)}：登记通道缺失（重启程序）`);
        } catch (e) { /* ignore */ }
        setStatus(`${labelOf(slot)}：脚本已注入`);
    } catch (e) {
        setStatus(`${labelOf(slot)}：注入失败 ${e && e.message}`);
    }
}

/* ---------- 打开 / 关闭 ---------- */
function openSlot(slot, { activateNow = true } = {}) {
    if (views.has(slot)) {
        if (activateNow) activate(slot);
        return views.get(slot);
    }

    const wv = document.createElement('webview');
    wv.setAttribute('partition', `persist:fanqie-${slot}`);
    wv.setAttribute('src', HOME_URL);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('preload', PRELOAD_URL);
    // 让 guest 的 preload 能直接挂到页面 window 上（双保险）
    wv.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no');
    wv.dataset.slot = String(slot);

    wv.addEventListener('dom-ready', () => {
        setStatus(`${labelOf(slot)}：页面就绪`);
        hideLoadFail();
    });

    wv.addEventListener('did-finish-load', () => {
        let url = '';
        try { url = wv.getURL(); } catch (e) { url = ''; }
        if (WRITER_RE.test(url)) injectInto(wv, slot);
        if (/\/publish\//i.test(url)) {
            setTimeout(() => dumpPublishPage(wv, slot), 6000);
        }
        updateNav();
    });

    wv.addEventListener('did-navigate', (ev) => {
        if (WRITER_RE.test(ev.url || '')) injectInto(wv, slot);
        updateNav();
    });

    wv.addEventListener('did-fail-load', (ev) => {
        if (ev.isMainFrame === false) return;
        if (ev.errorCode === -3) return;
        setStatus(`${labelOf(slot)}：加载失败 ${ev.errorDescription || ev.errorCode}`);
        showLoadFail(slot, '加载失败：' + (ev.errorDescription || ('错误码 ' + ev.errorCode)) + '。可以点下面的按钮重试。');
        setTimeout(() => { try { wv.loadURL(HOME_URL); } catch (e) { /* ignore */ } }, 3000);
    });

    wv.addEventListener('page-title-updated', (ev) => { ev.preventDefault && ev.preventDefault(); });

    viewsEl.appendChild(wv);
    views.set(slot, wv);
    known.add(slot);

    // 兜底：25 秒还没 ready 就提示，避免只看到白屏
    setTimeout(() => {
        if (!views.has(slot)) return;
        let ok = false;
        try { ok = !!wv.getURL(); } catch (e) { ok = false; }
        if (!ok) {
            showLoadFail(slot, '这个账号的页面 25 秒内没有加载出来，可能是网络问题。');
        }
    }, 25000);

    try { if (window.__applyTileZoom) window.__applyTileZoom(wv); } catch (e) { /* ignore */ }

    renderTabs();
    if (activateNow) activate(slot);
    persistOpenTabs();
    return wv;
}

let failSlot = null;

function showLoadFail(slot, msg) {
    failSlot = slot;
    const box = document.getElementById('load-fail');
    const desc = document.getElementById('lf-desc');
    if (desc && msg) desc.textContent = msg;
    if (box) box.classList.add('show');
    document.body.classList.add('fail');
}

function hideLoadFail() {
    const box = document.getElementById('load-fail');
    if (box) box.classList.remove('show');
    document.body.classList.remove('fail');
    failSlot = null;
}

function closeSlot(slot, purge = false) {
    const wv = views.get(slot);
    if (!wv) return;
    try { wv.remove(); } catch (e) { /* ignore */ }
    views.delete(slot);
    if (!purge) known.add(slot);

    persistOpenTabs();

    if (activeSlot === slot) {
        const next = views.keys().next();
        activeSlot = next.done ? null : next.value;
        if (activeSlot) activate(activeSlot); else renderTabs();
    } else {
        renderTabs();
    }
}

function nextSlot() {
    // 用最小的空闲编号：删掉的号会被重新使用，不会一直往后跳
    const used = new Set([...known, ...views.keys()].map(Number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
}

/* ---------- 发布页留档 ---------- */
async function dumpPublishPage(wv, slot) {
    try {
        const summary = await wv.executeJavaScript(`(function () {
            var els = Array.prototype.slice.call(document.querySelectorAll('input, textarea')).map(function (el, i) {
                var p = el.parentElement ? (el.parentElement.textContent || '') : '';
                return {
                    i: i, tag: el.tagName, type: el.type, placeholder: el.placeholder,
                    value: (el.value || '').slice(0, 60),
                    className: String(el.className).slice(0, 120),
                    id: el.id, name: el.name, maxLength: el.getAttribute('maxlength'),
                    visible: el.offsetParent !== null,
                    parentText: p.replace(/\\s+/g, '').slice(0, 40)
                };
            });
            return JSON.stringify({ url: location.href, inputs: els }, null, 2);
        })()`);
        await window.shellApi.saveFile('dump-inputs.json', summary);
        const html = await wv.executeJavaScript('document.documentElement.outerHTML');
        await window.shellApi.saveFile('dump-publish.html', String(html).slice(0, 3000000));
        setStatus(`${labelOf(slot)}：发布页结构已留档`);
    } catch (e) {
        setStatus(`留档失败 ${e && e.message}`);
    }
}

/* ---------- 快捷键 ---------- */
window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
        hideCtx();
        if (maskshow()) closeRename();
        return;
    }
    if (maskshow()) return;
    if (ev.ctrlKey && (ev.key === 't' || ev.key === 'T')) {
        ev.preventDefault();
        const slot = nextSlot();
        window.shellApi.addAccount(slot).then(() => openSlot(slot));
        return;
    }
    if (ev.altKey && ev.key === 'ArrowLeft') {
        ev.preventDefault();
        withActiveView(wv => wv.canGoBack() && wv.goBack());
        return;
    }
    if (ev.altKey && ev.key === 'ArrowRight') {
        ev.preventDefault();
        withActiveView(wv => wv.canGoForward() && wv.goForward());
        return;
    }
    if (ev.ctrlKey && /^[1-9]$/.test(ev.key)) {
        ev.preventDefault();
        const slot = Number(ev.key);
        if (known.has(slot) || views.has(slot)) openSlot(slot);
        return;
    }
    const wv = activeSlot ? views.get(activeSlot) : null;
    if (!wv) return;
    if (ev.key === 'F5') {
        ev.preventDefault();
        try { wv.reload(); } catch (e) { /* ignore */ }
    }
    if (ev.key === 'F12' || (ev.ctrlKey && ev.shiftKey && (ev.key === 'i' || ev.key === 'I'))) {
        ev.preventDefault();
        window.shellApi.toggleDevTools(wv.getWebContentsId());
    }
});

function maskshow() {
    return maskEl.classList.contains('show');
}

/* ---------- 左上角鲸鱼：唤回上传面板 ---------- */
// 并排模式：所有账号同时渲染
(function bindTile() {
    const btn = document.getElementById('tile');
    if (!btn) return;

    // 页面缩放跟随「设置 → 画面缩放」，用户自己调
    let pageZoom = 1;

    const applyZoom = () => {
        for (const [, wv] of views) {
            try { wv.setZoomFactor(pageZoom); } catch (e) { /* ignore */ }
        }
    };

    window.__setPageZoom = (z) => {
        pageZoom = Number(z) || 1;
        applyZoom();
        setStatus('画面缩放：' + Math.round(pageZoom * 100) + '%');
    };

    const layoutCols = () => {
        const n = views.size;
        document.body.classList.toggle('cols-2', n > 2);
    };
    window.__layoutCols = layoutCols;

    const setTile = (on) => {
        document.body.classList.toggle('tile', on);
        btn.classList.toggle('on', on);
        btn.textContent = on ? '⊞ 单页' : '⊞ 并排';
        layoutCols();
        setStatus(on
            ? '并排模式：所有账号同时渲染；缩放可在「设置」里调'
            : '已恢复单页显示');
    };

    // 供 openSlot 新建视图时复用
    window.__applyTileZoom = (wv) => {
        try { wv.setZoomFactor(pageZoom); } catch (e) { /* ignore */ }
        layoutCols();
    };

    btn.addEventListener('click', async () => {
        const on = !document.body.classList.contains('tile');
        setTile(on);
        try { await window.shellApi.setSettings({ tileView: on, bgRender: on ? true : undefined }); } catch (e) { /* ignore */ }
    });
})();

const earnBtn = document.getElementById('earnings');
if (earnBtn) {
    earnBtn.addEventListener('click', async () => {
        // 先让所有账号页立刻扫一次收益，再开窗口
        for (const [, wv] of views) {
            try { wv.executeJavaScript('window.__xbuScanIncome && window.__xbuScanIncome()'); } catch (e) { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 900));
        try { await window.shellApi.openEarnings(); } catch (e) { /* ignore */ }
    });
}

/* ---------- 主题 ---------- */
// 说明：左上鲸鱼图标（#brand）的 click 事件只在这里绑定一次（见下方导航按钮区），
// 统一打开「设置」窗口。之前这里曾重复绑定一段「唤回面板」逻辑，导致点一次
// 既弹设置窗、又在后台唤回面板，两个动作互相冲突。面板唤回请用页面内的 ☁ 云朵按钮。
// 显示方式：后台全部渲染 / 仅当前 / 并排小窗
function layoutCols() {
    if (window.__layoutCols) window.__layoutCols();
}

function applyRenderMode(s) {
    const tile = !!(s && s.tileView);
    const all = !(s && s.bgRender === false) && !tile;
    document.body.classList.toggle('render-all', all);
    document.body.classList.toggle('tile', tile);

    const btn = document.getElementById('tile');
    if (btn) {
        btn.classList.toggle('on', tile);
        btn.textContent = tile ? '⊞ 单页' : '⊞ 并排';
    }
    try { layoutCols(); } catch (e) { /* ignore */ }
}

function applyTheme(s) {
    document.body.classList.toggle('dark', !!(s && s.dark));
    applyPrivacy(!!(s && s.privacy));
}

// 把隐私模式传给每个页面里的浮窗脚本
let privacyNow = false;

function applyPrivacy(on) {
    privacyNow = !!on;
    document.body.classList.toggle('privacy', !!on);

    // 任务页是 JS 渲染的，切换隐私后必须重画，否则卡片还是全文
    try { if (typeof refreshTasks === 'function') refreshTasks(); } catch (e) { /* ignore */ }
    try { if (typeof renderLogs === 'function') renderLogs(); } catch (e) { /* ignore */ }
    for (const wv of views.values()) {
        try {
            wv.executeJavaScript('window.__novelUploaderSetPrivacy && window.__novelUploaderSetPrivacy(' + (on ? 'true' : 'false') + ')');
        } catch (e) { /* ignore */ }
    }
}

async function initTheme() {
    try {
        const s = await window.shellApi.getSettings();
        applyTheme(s);
        applyRenderMode(s);
        if (s && s.zoom) { try { window.__setPageZoom(s.zoom); } catch (e) { /* ignore */ } }
        window.shellApi.onSettingsChanged((ns) => {
            applyTheme(ns);
            applyRenderMode(ns);
            if (ns && ns.zoom && window.__setPageZoom) window.__setPageZoom(ns.zoom);
        });
    } catch (e) { /* ignore */ }
}



/* ---------- 完整性校验提示 ---------- */
function integrityWarn(r) {
    if (!r || r.ok) return;
    const lines = [];
    if (r.bad && r.bad.length) lines.push('被改动的文件：' + r.bad.slice(0, 4).join('、') + (r.bad.length > 4 ? ' 等' : ''));
    if (r.extra && r.extra.length) lines.push('多余的文件：' + r.extra.slice(0, 4).join('、'));
    setStatus('⚠ 程序文件校验未通过：' + (r.reason || '未知'));

    const box = document.getElementById('update-modal');
    if (!box) return;
    const title = document.getElementById('um-title');
    const ver = document.getElementById('um-ver');
    const notes = document.getElementById('um-notes');
    const go = document.getElementById('um-go');
    const later = document.getElementById('um-later');

    if (title) title.textContent = '⚠ 程序文件可能被改动';
    if (ver) ver.textContent = r.reason || '';
    if (notes) notes.textContent = (lines.join('；') || '') +
        '\n\n如果不是你自己修改的，这个包可能被人动过手脚，建议换成作者发的原始安装包。';
    if (go) { go.textContent = '我知道了'; go.disabled = false; }
    if (later) later.style.display = 'none';

    go.onclick = () => {
        box.classList.remove('show');
        if (later) later.style.display = '';
    };
    box.classList.add('show');
}

/* ---------- 启动检查更新（居中弹窗） ---------- */
let pendingUpdate = null;

function showUpdateModal(info) {
    const box = document.getElementById('update-modal');
    if (!box) return;
    pendingUpdate = info;

    const ver = document.getElementById('um-ver');
    if (ver) ver.textContent = '当前 v' + info.current + ' → 最新 v' + String(info.latest).replace(/^v/i, '');

    const notes = document.getElementById('um-notes');
    if (notes) notes.textContent = info.notes || '修复与优化';

    const go = document.getElementById('um-go');
    if (go) { go.disabled = false; go.textContent = '立即更新'; }

    const prog = document.getElementById('um-progress');
    if (prog) prog.classList.remove('show');
    const fill = document.getElementById('um-bar-fill');
    if (fill) fill.style.width = '0%';

    box.classList.add('show');
}

function hideUpdateModal() {
    const box = document.getElementById('update-modal');
    if (box) box.classList.remove('show');
    pendingUpdate = null;
}

/* ---------- 启动后展示上一次更新的结果 ---------- */
function showUpdateResult(r) {
    if (!r || typeof r.ok !== 'boolean') return false;
    const box = document.getElementById('update-modal');
    if (!box) return false;

    const title = document.getElementById('um-title');
    const ver = document.getElementById('um-ver');
    const notes = document.getElementById('um-notes');
    const go = document.getElementById('um-go');
    const later = document.getElementById('um-later');
    const prog = document.getElementById('um-progress');
    const tip = document.getElementById('um-tip');

    const ok = !!r.ok;
    if (title) title.textContent = ok ? '更新完成' : '更新未成功';
    if (ver) ver.textContent = ok
        ? ('已更新到 v' + String(r.to || '?').replace(/^v/i, ''))
        : ('当前仍是 v' + String(r.from || '?').replace(/^v/i, ''));
    if (notes) notes.textContent = ok
        ? '程序文件已替换完成，新版本现已生效。\n' + (r.reason || '')
        : ((r.reason || '未知原因') + '\n\n你的账号和作品数据没有受影响，可以正常使用。若反复失败，请用安装包重装。');
    if (prog) prog.classList.remove('show');
    if (go) { go.textContent = '知道了'; go.disabled = false; }
    if (later) later.style.display = 'none';
    if (tip) tip.textContent = ok ? '本次更新只替换了程序文件，账号和作品数据保持不变' : '如需帮助可联系作者';

    // 结果窗的"知道了"只负责关闭，不触发更新流程；点完即解除，避免影响后续正常更新弹窗
    if (go) go.onclick = function () {
        box.classList.remove('show');
        if (later) later.style.display = '';
        go.textContent = '立即更新';
        go.onclick = null;
    };
    box.classList.add('show');
    return true;
}

async function autoCheckUpdate() {
    // 先看有没有上一次更新的结果要展示；有就只弹结果，不叠加"发现新版本"弹窗
    let result = null;
    try { result = await window.shellApi.getUpdateResult(); } catch (e) { /* ignore */ }
    if (result && showUpdateResult(result)) return;

    let r;
    try { r = await window.shellApi.checkUpdate(); } catch (e) { return; }
    if (r && r.ok && r.newer) showUpdateModal(r);
}

const umBarFill = document.getElementById('um-bar-fill');
const umPct = document.getElementById('um-pct');
const umProgress = document.getElementById('um-progress');

function setUpdateProgress(p) {
    if (!umProgress) return;
    umProgress.classList.add('show');
    const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
    if (umBarFill) umBarFill.style.width = pct + '%';
    if (umPct) umPct.textContent = (p.text ? p.text + '  ' : '') + pct + '%';
}

try {
    window.shellApi.onUpdateProgress((p) => {
        if (p && p.phase === 'apply') {
            if (umPct) umPct.textContent = p.text || '正在替换程序文件…';
            if (umBarFill) umBarFill.style.width = Number(p.percent || 0) + '%';
            return;
        }
        setUpdateProgress(p || {});
    });
} catch (e) { /* ignore */ }

const umLater = document.getElementById('um-later');
if (umLater) umLater.addEventListener('click', hideUpdateModal);

const umGo = document.getElementById('um-go');
if (umGo) {
    umGo.addEventListener('click', async () => {
        if (!pendingUpdate) return;
        const btn = umGo;
        btn.disabled = true;
        btn.textContent = '更新中…';
        let r;
        try {
            r = await window.shellApi.applyUpdate(pendingUpdate);
        } catch (e) {
            r = { ok: false, reason: '更新出错' };
        }
        if (r && r.ok) {
            btn.textContent = '即将重启…';
            setStatus('更新已就绪，程序即将重启');
        } else {
            btn.disabled = false;
            btn.textContent = '立即更新';
            setStatus('更新失败：' + ((r && r.reason) || '未知错误'));
        }
    });
}


/* ---------- 导航按钮 ---------- */
function activeView() {
    return activeSlot ? views.get(activeSlot) : null;
}

function updateAddress() {
    const el = document.getElementById('addr-text');
    if (!el) return;
    const wv = activeView();
    let text = '—';
    if (wv) {
        try {
            const url = wv.getURL() || '';
            if (url) {
                text = url.replace(/^https?:\/\//, '');
                if (text.length > 78) text = text.slice(0, 76) + '…';
            }
        } catch (e) { /* ignore */ }
    }
    el.textContent = text;
}

function updateNav() {
    const wv = activeView();
    const back = document.getElementById('nav-back');
    const fwd = document.getElementById('nav-forward');
    let canB = false, canF = false;
    try {
        if (wv) { canB = !!wv.canGoBack(); canF = !!wv.canGoForward(); }
    } catch (e) { /* ignore */ }
    if (back) back.disabled = !canB;
    if (fwd) fwd.disabled = !canF;
    updateAddress();
}

function withActiveView(fn) {
    const wv = activeView();
    if (!wv) { setStatus('还没有打开账号'); return; }
    try { fn(wv); } catch (e) { setStatus('操作失败: ' + (e && e.message)); }
    updateNav();
}

document.getElementById('nav-back').addEventListener('click', () => withActiveView(wv => wv.canGoBack() && wv.goBack()));
document.getElementById('nav-forward').addEventListener('click', () => withActiveView(wv => wv.canGoForward() && wv.goForward()));
document.getElementById('nav-reload').addEventListener('click', () => withActiveView(wv => wv.reload()));
document.getElementById('nav-home').addEventListener('click', () => withActiveView(wv => wv.loadURL(HOME_URL)));

/* =====================================================================
 * 多账号发布任务管理
 * 左侧任务列表 + 右侧所有账号的发布日志汇总
 * ===================================================================== */
(function initTaskManager() {
    const $ = (id) => document.getElementById(id);
    const viewBtn = $('tasks-view-btn');
    const manager = $('task-manager');
    if (!viewBtn || !manager) return;

    let tasks = [];
    let logs = [];
    let selectedTaskId = null;
    let parsedChapters = []; // 弹窗里刚解析出来的章节（保存前临时）

    const STATUS_TEXT = { idle: '待开启', queued: '排队中', running: '发布中', paused: '已暂停', done: '已完成', failed: '失败' };

    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtTime(ts) {
        const d = new Date(ts || Date.now());
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /* ---- 视图切换 ---- */
    function showTaskView(on) {
        document.body.classList.toggle('task-view', !!on);
        viewBtn.classList.toggle('on', !!on);
        if (on) { refreshTasks(); refreshLogs(); }
        else { try { if (activeSlot) activate(activeSlot); } catch (e) {} }
    }
    viewBtn.addEventListener('click', () => showTaskView(!document.body.classList.contains('task-view')));

    /* ---- 任务列表 ---- */
    // 与页面脚本 bookRef() 同一套哈希（djb2），用来读"这本书历史上发到第几章"
    function bookHashOf(id) {
        const s = String(id || '');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return '#' + h.toString(16).padStart(8, '0').slice(0, 8);
    }
    const histProgress = {};   // bookHash -> { max, nums }
    async function loadHistProgress(tasks) {
        const need = [];
        for (const t of tasks) {
            if (!t.bookId) continue;
            const k = bookHashOf(t.bookId);
            if (!(k in histProgress)) need.push(k);
        }
        for (const k of need) {
            try { histProgress[k] = await window.shellApi.progressGet(k); } catch (e) { histProgress[k] = null; }
        }
    }

    // 这批章节的章号区间（第一个 / 最后一个）
    function chapterRange(chapters) {
        let first = 0, last = 0;
        for (const c of (chapters || [])) {
            const n = Number(c && c.number) || 0;
            if (n <= 0) continue;
            if (!first || n < first) first = n;
            if (n > last) last = n;
        }
        return { first, last };
    }

    function progressBlock(t) {
        const chapters = t.chapters || [];
        const total = chapters.length;
        if (!total) {
            return '<div class="tm-prog-empty">章节已清空：点「编辑」粘贴新章节，保存后就能开启任务。</div>';
        }
        const rng = chapterRange(chapters);
        const prog = t.progress || {};
        let done = Number(prog.done) || 0;
        if (done < 0) done = 0;
        if (done > total) done = total;

        // 已发到的章号：优先本任务实时进度，其次这本书的历史记录
        // （历史章号要落在这批区间内才用，否则是上一批的记录，不能拿来当"当前进度"）
        let lastNum = Number(prog.lastChapter) || 0;
        let fromHist = false;
        if (!lastNum && t.bookId) {
            const h = histProgress[bookHashOf(t.bookId)];
            const mx = h ? Number(h.max) || 0 : 0;
            if (mx > 0 && (!rng.first || (mx >= rng.first && mx <= rng.last))) { lastNum = mx; fromHist = true; }
        }

        // 百分比：本任务完成度；本任务没跑过但有历史进度时，按"目标章号"估一个
        let pct = total ? Math.round(done / total * 100) : 0;
        let barPct = pct;
        if (!done && fromHist && rng.first && rng.last > rng.first) {
            barPct = Math.max(0, Math.min(100, Math.round((lastNum - rng.first + 1) / (rng.last - rng.first + 1) * 100)));
        }
        if (t.status === 'done') { pct = 100; barPct = 100; }
        if (barPct > 100) barPct = 100;

        const goalText = total ? (total + ' 章') : '—';
        const goalSub = total
            ? (rng.first && rng.last
                ? (rng.first === rng.last ? ('第 ' + rng.last + ' 章') : ('第 ' + rng.first + '–' + rng.last + ' 章'))
                : '章节没编号')
            : '没有章节';
        const curText = lastNum ? ('第 ' + lastNum + ' 章') : '未开始';
        const curSub = done ? ('已发 ' + done + '/' + total + ' 章') : (fromHist ? '上次记录' : (total ? ('已发 0/' + total + ' 章') : '—'));
        const full = pct >= 100;
        const paused = t.status === 'paused';
        const fillCls = full ? ' full' : (paused ? ' paused' : '');
        const footText = full ? '本批已全部发完'
            : (paused ? '已暂停，点「继续发布」恢复'
                : (t.status === 'running' ? '正在发布中…'
                    : (done ? ('已发 ' + done + ' 章，还剩 ' + (total - done) + ' 章') : '还没开始')));
        return '<div class="tm-prog">' +
                 '<div class="tm-prog-stats">' +
                   '<div class="tm-stat"><span class="tm-stat-k">目标总章节</span><span class="tm-stat-v">' + escapeHtml(goalText) + '</span><span class="tm-stat-s">' + escapeHtml(goalSub) + '</span></div>' +
                   '<div class="tm-stat"><span class="tm-stat-k">当前进度</span><span class="tm-stat-v">' + escapeHtml(curText) + '</span><span class="tm-stat-s">' + escapeHtml(curSub) + '</span></div>' +
                 '</div>' +
                 '<div class="tm-prog-bar"><div class="tm-prog-fill' + fillCls + '" style="width:' + barPct + '%"></div></div>' +
                 '<div class="tm-prog-foot"><span>' + footText + '</span><span class="tm-prog-pct' + (full ? ' full' : (paused ? ' paused' : '')) + '">' + pct + '%</span></div>' +
               '</div>';
    }

    async function refreshTasks() {
        try { tasks = await window.shellApi.tasksGet(); } catch (e) { tasks = []; }
        const list = $('tm-list');
        if (!list) return;
        if (!tasks.length) {
            list.innerHTML = '<div class="tm-empty">还没有任务<br>点右上角「＋ 新增任务」创建一个</div>';
            return;
        }
        try { await loadHistProgress(tasks); } catch (e) { /* ignore */ }
        list.innerHTML = '';
        for (const t of tasks) {
            const card = document.createElement('div');
            card.className = 'tm-card' + (t.id === selectedTaskId ? ' selected' : '');
            const st = t.status || 'idle';
            const slotLabel = (typeof labelOf === 'function' ? labelOf(t.slot) : ('账号' + t.slot));
            const chCount = (t.chapters || []).length;
            const timeDesc = t.settings && t.settings.timedPublish
                ? ((t.settings.startDate || '') + ' ' + (t.settings.startTime || '') + ' 起')
                : '立即发布';
            card.innerHTML =
                '<div class="tm-card-top">' +
                  '<span class="tm-book">' + escapeHtml(maskBookName(t.bookName || ('书 ' + maskBookId(t.bookId)))) + '</span>' +
                  '<span class="tm-badge ' + st + '">' + (STATUS_TEXT[st] || st) + '</span>' +
                '</div>' +
                '<div class="tm-meta"><span>' + escapeHtml(slotLabel) + '</span><span>' + chCount + ' 章</span><span>' + escapeHtml(timeDesc) + '</span></div>' +
                progressBlock(t) +
                '<div class="tm-card-actions">' +
                  (st === 'running'
                    ? '<button class="tm-btn warn" data-act="pause" data-id="' + t.id + '">⏸ 暂停发布</button>'
                    : (st === 'paused'
                        ? '<button class="tm-btn primary" data-act="resume" data-id="' + t.id + '">▶ 继续发布</button>'
                        : '<button class="tm-btn primary" data-act="run" data-id="' + t.id + '">▶ 开启任务</button>')) +
                  // 发布中/已暂停 → 允许直接取消这一批；其它状态 → 允许清空章节换新的
                  ((st === 'running' || st === 'paused')
                    ? '<button class="tm-btn stop" data-act="cancel" data-id="' + t.id + '">✕ 取消本次</button>'
                    : '<button class="tm-btn" data-act="clear" data-id="' + t.id + '">清空章节</button>') +
                  '<button class="tm-btn" data-act="edit" data-id="' + t.id + '">编辑</button>' +
                  '<button class="tm-btn danger" data-act="del" data-id="' + t.id + '">删除</button>' +
                '</div>';
            card.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') return;
                selectedTaskId = t.id;
                refreshTasks();
            });
            list.appendChild(card);
        }
        list.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const id = btn.getAttribute('data-id');
                const act = btn.getAttribute('data-act');
                if (act === 'run') await runTask(id);
                else if (act === 'del') await delTask(id);
                else if (act === 'edit') openTaskModal(id);
                else if (act === 'pause') await setTaskPaused(id, true);
                else if (act === 'resume') await setTaskPaused(id, false);
                else if (act === 'cancel') await cancelTask(id);
                else if (act === 'clear') await clearChapters(id);
            });
        });
    }

    /* ---- 隐私打码：书名、书号、章名 ---- */
    function maskBookName(s) {
        const v = String(s == null ? '' : s).trim();
        if (!privacyNow || !v) return v;
        if (v.length <= 2) return '**';
        return v[0] + '*'.repeat(Math.min(v.length - 2, 6)) + v[v.length - 1];
    }

    function maskBookId(s) {
        const v = String(s == null ? '' : s).trim();
        if (!privacyNow || !v) return v;
        return v.slice(0, 2) + '*'.repeat(Math.max(v.length - 4, 3)) + v.slice(-2);
    }

    // 日志里的【书名】也要遮掉
    function maskLogText(s) {
        let v = String(s == null ? '' : s);
        if (!privacyNow) return v;
        v = v.replace(/【([^】]{1,40})】/g, (m, name) => '【' + maskBookName(name) + '】');
        v = v.replace(/《([^》]{1,40})》/g, (m, name) => '《' + maskBookName(name) + '》');
        v = v.replace(/\b\d{12,}\b/g, (m) => maskBookId(m));
        return v;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---- 开启任务：下发到对应账号的 webview ---- */
    async function runTask(id) {
        const t = tasks.find(x => x.id === id);
        if (!t) return;
        if (!(t.chapters || []).length) { setStatus('任务没有章节：点「编辑」粘贴新章节再开启'); return; }
        const wv = (typeof views !== 'undefined' && views) ? views.get(Number(t.slot)) : null;
        if (!wv) { setStatus('账号 ' + t.slot + ' 未打开，请先在标签页打开该账号'); return; }

        if (t.status === 'running') { setStatus('这个任务正在发布中，请勿重复开启'); return; }
        if (t.status === 'paused') { setStatus('这个任务处于暂停状态，点「继续发布」可恢复'); return; }

        // 同一账号同一时间只能跑一本：别的任务在跑就先排队
        const busy = tasks.find(x => x.id !== t.id && String(x.slot) === String(t.slot) && x.status === 'running');
        if (busy) {
            t.status = 'queued';
            refreshTasks();
            try { window.shellApi.taskUpdate(t.id, { status: 'queued' }); } catch (e) { /* ignore */ }
            addLocalLog('warning', '账号 ' + t.slot + ' 正在发布《' + (busy.bookName || busy.bookId) + '》，'
                + '《' + (t.bookName || t.bookId) + '》已排队，等前一本发完会自动开始');
            setStatus('已排队：账号 ' + t.slot + ' 正在发另一本');
            return;
        }

        try {
            setStatus('正在下发任务到 ' + (typeof labelOf === 'function' ? labelOf(t.slot) : ('账号' + t.slot)) + '…');

            // 先确认脚本已注入：没有 __xbuRunTask 就导航到作家专区，等注入完成
            let ready = false;
            try { ready = await wv.executeJavaScript('typeof window.__xbuRunTask === "function"'); } catch (e) {}
            if (!ready) {
                try { wv.loadURL(HOME_URL); } catch (e) {}
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    try { ready = await wv.executeJavaScript('typeof window.__xbuRunTask === "function"'); } catch (e) {}
                    if (ready) break;
                }
            }
            if (!ready) {
                setStatus('账号脚本未就绪，请确认已登录番茄作家后台，然后重试');
                addLocalLog('error', '任务下发失败：账号 ' + t.slot + ' 的脚本未就绪');
                return;
            }

            const config = {
                taskId: t.id,
                bookId: String(t.bookId),
                bookName: String(t.bookName || ''),
                chapters: t.chapters,
                settings: t.settings || {}
            };
            const js = 'window.__xbuRunTask(' + JSON.stringify(config) + ')';
            const r = await wv.executeJavaScript(js);
            if (r && r.ok === false) { setStatus('下发失败：' + (r.reason || '未知')); return; }
            await window.shellApi.taskUpdate(t.id, { status: 'running' });
            setStatus('任务已开启：' + (t.bookName || t.bookId));
            addLocalLog('warning', '任务已下发到账号 ' + t.slot + '：' + (t.bookName || t.bookId) + '（' + t.chapters.length + ' 章）');
            refreshTasks();
        } catch (e) {
            setStatus('下发任务失败：' + (e && e.message));
        }
    }

    /* ---- 暂停 / 继续：把开关下发给该账号页面里的脚本 ---- */
    async function setTaskPaused(id, paused) {
        const t = tasks.find(x => x.id === id);
        if (!t) return;
        const wv = (typeof views !== 'undefined' && views) ? views.get(Number(t.slot)) : null;
        if (!wv) {
            setStatus('账号 ' + t.slot + ' 的页面没打开，暂停要靠那个页面执行，请先切到该账号标签');
            return;
        }
        try {
            setStatus((paused ? '正在暂停…' : '正在继续…'));
            const js = 'window.__xbuSetPaused ? window.__xbuSetPaused(' + (paused ? 'true' : 'false') +
                       ') : { ok: false, reason: "页面脚本未就绪，请切到该账号页面刷新一下" }';
            const r = await wv.executeJavaScript(js);
            if (r && r.ok === false) {
                setStatus((paused ? '暂停失败：' : '继续失败：') + (r.reason || '未知'));
                return;
            }
            // 页面上的发布流程已经没了（比如中途重启过程序）→ 没法"继续"，让用户重新开启
            if (!paused && r && r.active === false) {
                t.status = 'idle';
                try { await window.shellApi.taskUpdate(id, { status: 'idle' }); } catch (e) { /* ignore */ }
                refreshTasks();
                setStatus('页面上的发布流程已经结束（可能重启过程序），请点「开启任务」重新下发');
                return;
            }
            // 页面会自己回报状态，这里先本地落一次，界面立刻有反馈
            t.status = paused ? 'paused' : 'running';
            try { await window.shellApi.taskUpdate(id, { status: t.status }); } catch (e) { /* ignore */ }
            refreshTasks();
            addLocalLog(paused ? 'warning' : 'info',
                (paused ? '任务已暂停：' : '任务已继续：') + (t.bookName || t.bookId));
            setStatus(paused ? '任务已暂停，点「继续发布」可恢复' : '任务已继续');
        } catch (e) {
            setStatus((paused ? '暂停失败：' : '继续失败：') + (e && e.message));
        }
    }

    /* ---- 取消本次发布：中止正在跑的这批，已发出去的章节不重发 ---- */
    async function cancelTask(id) {
        const t = tasks.find(x => x.id === id);
        if (!t) return;
        const all = t.chapters || [];
        const sent = Math.max(0, Math.min(Number((t.progress || {}).done) || 0, all.length));
        const left = all.slice(sent);
        const msg = '取消本次发布？\n\n' +
            '· 正在发的这一章会立即停下（已点发布的会照常完成）\n' +
            (sent ? '· 已发出的 ' + sent + ' 章会从任务里移除，不会被重发\n' : '') +
            '· 剩下的 ' + left.length + ' 章保留在任务里，之后可以继续\n\n' +
            '取消后也可以点「清空章节」再粘一批新的。';
        if (!confirm(msg)) return;

        // 先让页面脚本停手（页面会清掉自己的断点续传状态）
        let pageOk = false;
        const wv = (typeof views !== 'undefined' && views) ? views.get(Number(t.slot)) : null;
        if (wv) {
            try {
                const r = await wv.executeJavaScript(
                    'window.__xbuCancelTask ? window.__xbuCancelTask() : { ok:false, reason:"页面脚本未就绪" }');
                pageOk = !!(r && r.ok);
            } catch (e) { pageOk = false; }
        }

        // 主进程这边同步：已发章节从任务里摘掉，进度归零；
        // 若其实已经全发完了（只差跳转判断），保持原样标成已完成，别把它清空
        const finished = all.length > 0 && left.length === 0;
        const patch = finished
            ? {
                status: 'done',
                chapters: all,
                progress: { done: all.length, total: all.length, lastChapter: Number((t.progress || {}).lastChapter) || 0 }
            }
            : {
                status: 'idle',
                chapters: left,
                progress: { done: 0, total: left.length, lastChapter: 0 }
            };
        t.status = patch.status;
        t.chapters = patch.chapters;
        t.progress = patch.progress;
        try { await window.shellApi.taskUpdate(id, patch); } catch (e) { /* ignore */ }
        refreshTasks();
        if (finished) {
            addLocalLog('success', '取消时本批已经发完：' + (t.bookName || t.bookId) + '（' + all.length + ' 章）');
            setStatus('这一批其实已经全部发完了，已标记为「已完成」');
            return;
        }
        addLocalLog('warning', '已取消本次发布：' + (t.bookName || t.bookId) +
            (sent ? '（已发 ' + sent + ' 章，剩余 ' + left.length + ' 章）' : ''));
        setStatus(pageOk
            ? '已取消本次发布，可以「清空章节」后粘新章节'
            : '已取消（页面没响应，若还在发请切到该账号页刷新一下）');
    }

    /* ---- 清空章节：清空内容和进度，账号与书保留，方便换一批新章节 ---- */
    async function clearChapters(id) {
        const t = tasks.find(x => x.id === id);
        if (!t) return;
        if (t.status === 'running' || t.status === 'paused') {
            setStatus('任务正在发布，请先点「取消本次」再清空章节');
            return;
        }
        const n = (t.chapters || []).length;
        if (!n) { openTaskModal(id); return; }  // 本来就空，直接开编辑去粘新章节
        if (!confirm('清空这个任务的 ' + n + ' 章？\n\n' +
            '· 账号和书不变\n' +
            '· 章节内容与发布进度会清空\n' +
            '· 已经发到番茄的章节不受影响\n\n' +
            '清空后点「编辑」粘一批新章节即可继续。')) return;
        const patch = { chapters: [], progress: { done: 0, total: 0, lastChapter: 0 }, status: 'idle' };
        t.chapters = [];
        t.progress = patch.progress;
        t.status = 'idle';
        try { await window.shellApi.taskUpdate(id, patch); } catch (e) { /* ignore */ }
        refreshTasks();
        addLocalLog('info', '已清空章节：' + (t.bookName || t.bookId));
        setStatus('章节已清空，点「编辑」粘贴新章节');
    }

    async function delTask(id) {
        if (!confirm('确定删除这个任务？')) return;
        try { await window.shellApi.taskRemove(id); } catch (e) {}
        if (selectedTaskId === id) selectedTaskId = null;
        refreshTasks();
    }

    /* ---- 日志汇总 ---- */
    function refreshLogs() {
        try { window.shellApi.logsGet().then(arr => { logs = arr || []; renderLogs(); }); } catch (e) {}
    }
    function renderLogs() { /* masked below */
        const box = $('tm-log-box');
        if (!box) return;
        if (!logs.length) {
            box.innerHTML = '<div class="tm-empty" style="padding:20px">暂无日志。开启任务后，各账号的发布过程会实时汇总到这里。</div>';
            return;
        }
        const tag = { info: '信息', success: '成功', warning: '注意', error: '错误' };
        box.innerHTML = logs.slice().reverse().map(l => {
            // 级别统一成四种，顺便当 class 用（整行底色 + 整句文字色都靠它）
            const lv = ['success', 'warning', 'error'].indexOf(l.level) >= 0 ? l.level : 'info';
            return '<div class="tm-log-row lv-' + lv + '">' +
              '<span class="tm-log-time">' + fmtTime(l.time) + '</span>' +
              '<span class="tm-log-tag ' + lv + '">[' + (tag[lv] || lv) + ']</span>' +
              '<span class="tm-log-msg lv-' + lv + '">' + (l.bookName ? '【' + escapeHtml(maskBookName(l.bookName)) + '】' : '') + escapeHtml(maskLogText(l.msg)) + '</span>' +
            '</div>';
        }).join('');
    }
    function addLocalLog(level, msg) {
        // 立即在本地追加一条（IPC 通道那头也会落盘，这里只求即时反馈）
        logs.push({ level, msg, time: Date.now(), bookName: '' });
        if (logs.length > TASK_LOG_CAP) logs = logs.slice(-TASK_LOG_CAP);
        renderLogs();
    }
    const TASK_LOG_CAP = 2000;

    // 订阅主进程推送的日志 / 状态
    try {
        window.shellApi.onTaskEvent((p) => {
            if (!p) return;
            if (p.type === 'log' && p.entry) {
                logs.push(p.entry);
                if (logs.length > TASK_LOG_CAP) logs = logs.slice(-TASK_LOG_CAP);
                renderLogs();
            } else if (p.type === 'status' && p.taskId) {
                const t = tasks.find(x => x.id === p.taskId);
                if (t) {
                    t.status = p.status;
                    if (p.status === 'done') {
                        const total = (t.chapters || []).length;
                        t.progress = { done: total, total: total, lastChapter: (t.progress && t.progress.lastChapter) || 0 };
                    }
                    refreshTasks();
                }
                // 状态落盘，重启后不会回退成"待开启"
                try { window.shellApi.taskUpdate(p.taskId, { status: p.status }); } catch (e) { /* ignore */ }

                // 本任务结束 → 看看这个账号还有没有排队的任务，有就自动开下一个
                if (p.status === 'done' || p.status === 'failed' || p.status === 'idle') {
                    const finished = tasks.find(x => x.id === p.taskId);
                    const slot = finished ? finished.slot : null;
                    if (slot !== null) {
                        const next = tasks.find(x => String(x.slot) === String(slot) && x.status === 'queued');
                        if (next) {
                            addLocalLog('info', '账号 ' + slot + ' 空闲了，自动开始排队的《' + (next.bookName || next.bookId) + '》');
                            setTimeout(() => { runTask(next.id); }, 2000);
                        }
                    }
                }
            } else if (p.type === 'progress' && p.taskId) {
                const t = tasks.find(x => x.id === p.taskId);
                if (t) {
                    t.progress = p.progress || t.progress;
                    refreshTasks();
                }
            }
        });
    } catch (e) {}

    // 对外暴露，供弹窗保存后刷新
    window.__tmRefresh = refreshTasks;
    window.__tmAddLocalLog = addLocalLog;



    /* ---- 新增/编辑任务弹窗 ---- */
    function fillSlotSelect() {
        const sel = $('tf-slot');
        if (!sel) return;
        const slots = (typeof known !== 'undefined') ? Array.from(known).sort((a, b) => a - b) : [];
        sel.innerHTML = slots.map(s => {
            const nm = (typeof names !== 'undefined' && names[s]) ? names[s] : ('账号 ' + s);
            return '<option value="' + s + '">' + escapeHtml(nm) + '</option>';
        }).join('');
        if (!slots.length) sel.innerHTML = '<option value="">（请先新建账号）</option>';
    }

    function openTaskModal(editId) {
        const t = editId ? tasks.find(x => x.id === editId) : null;
        fillSlotSelect();
        parsedChapters = [];
        if (t) {
            $('tf-slot').value = String(t.slot);
            $('tf-book').innerHTML = '<option value="' + escapeHtml(t.bookId) + '">' + escapeHtml(maskBookName(t.bookName || t.bookId)) + '</option>';
            $('tf-bookid').value = t.bookId || '';
            $('tf-content').value = (t.chapters || []).map(c => '第' + c.number + '章 ' + c.title + '\n' + c.content).join('\n\n');
            const s = t.settings || {};
            $('tf-timed').value = s.timedPublish ? 'yes' : 'no';
            $('tf-date').value = s.startDate || '';
            $('tf-time').value = s.startTime || '08:00';
            $('tf-daily').value = s.dailyCount || 3;
            $('tf-interval').value = s.intervalMinutes || 0;
            $('tf-weekend').value = s.skipWeekend ? 'yes' : 'no';
            parsedChapters = (t.chapters || []).slice();
            $('tf-parse-hint').textContent = '已加载 ' + parsedChapters.length + ' 章（编辑模式）';
        } else {
            $('tf-book').innerHTML = '<option value="">（先读取书单或填书号）</option>';
            $('tf-bookid').value = '';
            $('tf-content').value = '';
            $('tf-date').value = '';
            $('tf-time').value = '08:00';
            $('tf-daily').value = '3';
            $('tf-interval').value = '0';
            $('tf-timed').value = 'yes';
            $('tf-weekend').value = 'no';
            $('tf-parse-hint').textContent = '还没解析章节';
        }
        $('task-modal').dataset.editId = editId || '';
        $('task-modal').classList.add('show');
    }
    function closeTaskModal() { $('task-modal').classList.remove('show'); }

    $('tm-add').addEventListener('click', () => openTaskModal(null));
    $('tf-cancel').addEventListener('click', closeTaskModal);
    $('task-modal').addEventListener('click', (e) => { if (e.target === $('task-modal')) closeTaskModal(); });
    $('tm-log-clear').addEventListener('click', async () => {
        if (!confirm('确定清空所有运行日志？')) return;
        try { await window.shellApi.logsClear(); } catch (e) {}
        logs = []; renderLogs();
    });

    /* ---- 选书下拉 ↔ 书号输入框 双向同步 ----
     * 之前只在下拉里换了书、书号框还留着上一本，保存时又优先取书号框 → 发到错误的书。
     * 现在：换下拉自动回写书号；手动改书号则反选下拉（找不到就清空选择）。
     */
    (function bindBookSync() {
        const sel = $('tf-book');
        const inp = $('tf-bookid');
        if (!sel || !inp) return;
        const opts = () => Array.prototype.slice.call(sel.options);
        sel.addEventListener('change', () => {
            inp.value = sel.value || '';
            const hint = $('tf-book-hint');
            if (hint && sel.value) hint.textContent = '已选：' + ((sel.options[sel.selectedIndex] || {}).text || sel.value);
        });
        inp.addEventListener('input', () => {
            const v = String(inp.value || '').trim();
            if (!v) return;
            const idx = opts().findIndex(o => o.value === v);
            if (idx >= 0) sel.selectedIndex = idx;
            else sel.selectedIndex = -1; // 手填了书单里没有的书号，就别让下拉继续显示旧书
        });
    })();

    /* ---- 读取书单：由主进程抓作品管理页的接口返回（不靠扫链接） ---- */
    $('tf-load-books').addEventListener('click', async () => {
        const slot = Number($('tf-slot').value);
        const wv = (typeof views !== 'undefined' && views) ? views.get(slot) : null;
        if (!wv) { setStatus('请先打开该账号标签页'); return; }
        const sel = $('tf-book');
        sel.innerHTML = '<option value="">读取中…（正在打开作品管理页，约 10~20 秒）</option>';
        setStatus(labelOf(slot) + '：正在读取书单…');
        let wcId = 0;
        try { wcId = wv.getWebContentsId(); } catch (e) { wcId = 0; }
        if (!wcId) {
            sel.innerHTML = '<option value="">（读取失败，请手填书号）</option>';
            setStatus('读取失败：这个账号的页面还没准备好，等页面加载出来再点一次');
            return;
        }
        try {
            const r = await window.shellApi.readBooks(wcId);
            const books = (r && r.books) || [];
            if (!books.length) {
                sel.innerHTML = '<option value="">（没读到书，请手填书号）</option>';
                setStatus((r && r.error) ? ('读取失败：' + r.error) : '没读到书单：诊断已存 booklist-debug.json');
                return;
            }
            sel.innerHTML = books.map(b => '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>').join('');
            // 默认选中第一本，并同步书号框（书号框原本是空的才自动填，别覆盖用户手填的）
            if (!$('tf-bookid').value.trim()) $('tf-bookid').value = sel.value || '';
            const hint = $('tf-book-hint');
            if (hint) hint.textContent = '读到 ' + books.length + ' 本书，可直接选';
            setStatus(labelOf(slot) + '：书单已读取，共 ' + books.length + ' 本');
        } catch (e) {
            sel.innerHTML = '<option value="">（读取失败，请手填书号）</option>';
            setStatus('读取书单失败：' + (e && e.message));
        }
    });

    /* ---- 章节解析：粘贴文本 / TXT 文件 ---- */
    function parseChaptersFromText(text) {
        const chapters = [];
        const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        // 中文数字转阿拉伯数字（支持到万位以内的常见章号）
        const cnNum = (s) => {
            if (!s) return 0;
            if (/^\d+$/.test(s)) return parseInt(s, 10) || 0;
            const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
            let total = 0, section = 0, n = 0;
            for (const ch of s) {
                if (d[ch] !== undefined) n = d[ch];
                else if (ch === '十') { section += (n || 1) * 10; n = 0; }
                else if (ch === '百') { section += (n || 1) * 100; n = 0; }
                else if (ch === '千') { section += (n || 1) * 1000; n = 0; }
                else if (ch === '万') { total += (section + n || 1) * 10000; section = 0; n = 0; }
            }
            return total + section + n;
        };
        // 章号用 [\d零〇一二两三四五六七八九十百千万]+ 兼容中英文数字
        const N = '[\\d零〇一二两三四五六七八九十百千万]+';
        // "章/节"后必须是空白、冒号或行尾，避免把"第一章正文..."这种正文行误判成新章
        const patterns = [
            new RegExp('^第\\s*(' + N + ')\\s*章(?:[\\s:：]+(.*))?$'),
            new RegExp('^第\\s*(' + N + ')\\s*节(?:[\\s:：]+(.*))?$'),
            /^Chapter\s+(\d+)(?:[\s:：]+(.*))?$/i,
            /^(\d+)[\.、][\s]*(.*)$/
        ];
        let cur = null;
        for (const line of lines) {
            let matched = null, num = 0, title = '';
            for (const re of patterns) {
                const m = re.exec(line.trim());
                if (m) { matched = true; num = cnNum(m[1]); title = (m[2] || '').trim(); break; }
            }
            if (matched) {
                if (cur) chapters.push(cur);
                cur = { number: num, title: title, content: '' };
            } else if (cur) {
                cur.content += (cur.content ? '\n' : '') + line;
            }
        }
        if (cur) chapters.push(cur);
        // 去掉空正文、算字数
        return chapters.map(c => {
            const content = c.content.trim();
            return { number: c.number, title: c.title, content, wordCount: content.replace(/\s/g, '').length };
        }).filter(c => c.content.length > 0);
    }

    function updateParseHint() {
        const text = $('tf-content').value;
        parsedChapters = parseChaptersFromText(text);
        $('tf-parse-hint').textContent = parsedChapters.length
            ? ('已解析 ' + parsedChapters.length + ' 章，约 ' + parsedChapters.reduce((s, c) => s + c.wordCount, 0) + ' 字')
            : '还没解析到章节（检查是否有「第X章」这样的标题行）';
    }
    $('tf-content').addEventListener('input', updateParseHint);
    $('tf-file').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            $('tf-content').value = text;
            updateParseHint();
        } catch (err) { setStatus('读取文件失败：' + (err && err.message)); }
    });

    // 弹窗里「清空」：只清输入框，点「完成」时才真正替换任务里的章节
    $('tf-clear-chapters').addEventListener('click', () => {
        if (!$('tf-content').value.trim() && !parsedChapters.length) { setStatus('章节内容已经是空的'); return; }
        if (!confirm('清空上面的章节内容？\n\n点「完成」保存后，这个任务的章节会被替换成你接下来粘贴的新章节。\n已经发到番茄的章节不受影响。')) return;
        $('tf-content').value = '';
        parsedChapters = [];
        $('tf-parse-hint').textContent = '还没解析章节';
        try { $('tf-file').value = ''; } catch (e) { /* ignore */ }
    });

    /* ---- 保存任务 ---- */
    $('tf-save').addEventListener('click', async () => {
        const slot = Number($('tf-slot').value);
        if (!slot) { alert('请先新建并选择一个账号'); return; }
        const manualId = String($('tf-bookid').value || '').trim();
        const bookSel = $('tf-book');
        // 下拉里选中了具体的书就以它为准（书号框只是它的镜像，避免换了书还按旧书号发）
        const selId = (bookSel && bookSel.value) ? String(bookSel.value) : '';
        const bookId = selId || manualId;
        if (!/^\d{6,}$/.test(bookId)) { alert('请选书或填写正确的书号（一长串数字）'); return; }
        let bookName = selId ? (bookSel.options[bookSel.selectedIndex]?.text || ('书 ' + bookId)) : ('书 ' + bookId);
        if (!parsedChapters.length) updateParseHint();
        if (!parsedChapters.length) { alert('没解析到章节，请检查章节内容'); return; }

        const s = {
            mode: 'timed',
            timedPublish: $('tf-timed').value === 'yes',
            startDate: $('tf-date').value || '',
            startTime: $('tf-time').value || '08:00',
            dailyCount: parseInt($('tf-daily').value, 10) || 3,
            intervalMinutes: parseInt($('tf-interval').value, 10) || 0,
            skipWeekend: $('tf-weekend').value === 'yes',
            ignoreViolation: false,
            checkSequence: false,
            todayQuota: 0,
            settleSeconds: 2.5
        };
        const payload = {
            slot, bookId, bookName,
            chapters: parsedChapters,
            settings: s,
            status: 'idle'
        };
        const editId = $('task-modal').dataset.editId;
        // 章节被换过（清空后粘了新的一批）→ 进度归零，别让卡片显示上一批的「已发 4/10」
        if (editId) {
            const old = (tasks.find(x => x.id === editId) || {}).chapters || [];
            const same = old.length === parsedChapters.length && old.every((c, i) =>
                Number(c.number) === Number(parsedChapters[i].number) &&
                String(c.content || '') === String(parsedChapters[i].content || ''));
            if (!same) payload.progress = { done: 0, total: parsedChapters.length, lastChapter: 0 };
        }
        try {
            if (editId) await window.shellApi.taskUpdate(editId, payload);
            else await window.shellApi.taskAdd(payload);
            closeTaskModal();
            refreshTasks();
            setStatus('任务已保存');
        } catch (e) { setStatus('保存任务失败：' + (e && e.message)); }
    });

    // 初始加载
    refreshTasks();
    refreshLogs();
})();

document.getElementById('home').addEventListener('click', async () => {
    try { await window.shellApi.openHome(); } catch (e) { /* ignore */ }
});

document.getElementById('brand').addEventListener('click', async () => {
    try { await window.shellApi.openSettings(); } catch (e) { /* ignore */ }
});

document.getElementById('update').addEventListener('click', async () => {
    try {
        await window.shellApi.openUpdater();
    } catch (e) {
        setStatus('打开更新失败: ' + (e && e.message));
    }
});

document.getElementById('alarm').addEventListener('click', async () => {
    try {
        await window.shellApi.openReminders();
    } catch (e) {
        setStatus('打开提醒失败: ' + (e && e.message));
    }
});

document.getElementById('accounts-menu').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const r = ev.currentTarget.getBoundingClientRect();
    showAccountMenu(r.left, r.bottom + 6);
});

document.getElementById('add').addEventListener('click', async () => {
    const slot = nextSlot();
    try { await window.shellApi.resetSlot(slot); } catch (e) { /* ignore */ }
    try { await window.shellApi.addAccount(slot); } catch (e) { /* ignore */ }
    openSlot(slot);
    setStatus(`已新增账号 ${slot}，请登录（双击标签可改名）`);
});

/* ---------- 启动 ---------- */
(async function boot() {
    try {
        AUTOMATION = await window.shellApi.getAutomation();
        SHIM = `;(function () {
            if (window.__novelUploaderGMReady) return;
            window.__novelUploaderGMReady = true;
            window.GM_addStyle = function (css) {
                var s = document.createElement('style');
                s.textContent = css;
                (document.head || document.documentElement).appendChild(s);
                return s;
            };
            window.GM_setValue = function (k, v) { try { localStorage.setItem('gm:' + k, JSON.stringify(v)); } catch (e) {} };
            window.GM_getValue = function (k, d) {
                try { var v = localStorage.getItem('gm:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
            };
            window.GM_deleteValue = function (k) { try { localStorage.removeItem('gm:' + k); } catch (e) {} };
            window.GM_setClipboard = function (text) {
                try {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                } catch (e) {}
            };
        })();`;
    } catch (e) {
        setStatus('脚本加载失败: ' + (e && e.message));
        return;
    }

    loadTabOrder();
    initTheme();

    const acc = await loadAccounts();
    for (const s of acc.slots) known.add(s);

    const order = acc.slots.slice().sort((a, b) => a - b);
    // 有快照就严格照快照恢复；没有快照（首次/老版本）才全部打开
    const toOpen = (savedOpenTabs === null) ? order : order.filter(s => savedOpenTabs.includes(s));

    if (toOpen.length === 0) {
        renderTabs();
        setStatus(order.length
            ? `上次关闭时没有开着的账号（共 ${order.length} 个，点 ＋账号 右侧 ▾ 可打开）`
            : '还没有账号，点「＋ 账号」开始');
        return;
    }

    const last = toOpen.includes(Number(acc.last)) ? Number(acc.last) : toOpen[0];

    for (const s of toOpen) openSlot(s, { activateNow: false });
    if (last) activate(last);

    const hidden = order.length - toOpen.length;
    setStatus(`已恢复 ${toOpen.length} 个账号` + (hidden ? `（另有 ${hidden} 个上次就关着）` : ''));

    try { window.shellApi.onIntegrity(integrityWarn); } catch (e) { /* ignore */ }

    setTimeout(autoCheckUpdate, 1200);

})();

/* ---------- 加载失败遮罩的按钮 ---------- */
(function bindLoadFailButtons() {
    var reload = document.getElementById('lf-reload');
    var home = document.getElementById('lf-home');
    if (reload) {
        reload.addEventListener('click', function () {
            var slot = failSlot;
            hideLoadFail();
            if (slot !== null && views.get(slot)) {
                try { views.get(slot).reload(); setStatus('正在重新加载…'); } catch (e) { /* ignore */ }
            } else {
                withActiveView(function (v) { try { v.reload(); } catch (e) { /* ignore */ } });
            }
        });
    }
    if (home) {
        home.addEventListener('click', function () {
            var slot = failSlot;
            hideLoadFail();
            var wv = slot !== null ? views.get(slot) : null;
            if (wv) { try { wv.loadURL(HOME_URL); } catch (e) { /* ignore */ } }
            else { withActiveView(function (v) { try { v.loadURL(HOME_URL); } catch (e) { /* ignore */ } }); }
        });
    }
})();
