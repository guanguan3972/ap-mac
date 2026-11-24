const sw = document.getElementById('sw-dark');
const swPrivacy = document.getElementById('sw-privacy');
const zoomRange = document.getElementById('zoom-range');
const zoomVal = document.getElementById('zoom-val');
const zoomReset = document.getElementById('zoom-reset');
let current = { dark: false, privacy: false, zoom: 1, bgRender: true };

function paint() {
    document.body.classList.toggle('dark', !!current.dark);
    if (sw) sw.classList.toggle('on', !!current.dark);
    if (swPrivacy) swPrivacy.classList.toggle('on', !!current.privacy);
    if (zoomRange) zoomRange.value = String(Math.round((current.zoom || 1) * 100));
    if (zoomVal) zoomVal.textContent = Math.round((current.zoom || 1) * 100) + '%';
    const bgAll = document.getElementById('bg-render');
    const bgCur = document.getElementById('bg-current');
    const viewTile = document.getElementById('view-tile');
    if (bgAll && bgCur) {
        bgAll.checked = current.bgRender !== false && !current.tileView;
        bgCur.checked = current.bgRender === false && !current.tileView;
        if (viewTile) viewTile.checked = !!current.tileView;
    }
}

(async function init() {
    try {
        current = await window.settingsApi.get();
    } catch (e) {
        current = { dark: false };
    }
    paint();
})();

if (sw) {
    sw.addEventListener('click', async () => {
        current.dark = !current.dark;
        paint();
        try {
            current = await window.settingsApi.set({ dark: current.dark });
            paint();
        } catch (e) { /* ignore */ }
    });
}

if (swPrivacy) {
    swPrivacy.addEventListener('click', async () => {
        current.privacy = !current.privacy;
        paint();
        try {
            current = await window.settingsApi.set({ privacy: current.privacy });
            paint();
        } catch (e) { /* ignore */ }
    });
}

// 复制微信号
var copyBtn = document.getElementById('copy-contact');
if (copyBtn) {
    copyBtn.addEventListener('click', function () {
        var txt = 'guanguan52867';
        try { navigator.clipboard.writeText(txt); } catch (e) { /* ignore */ }
        copyBtn.textContent = '已复制';
        setTimeout(function () { copyBtn.textContent = '复制微信号'; }, 1500);
    });
}


// 画面缩放
if (zoomRange) {
    let timer = null;
    zoomRange.addEventListener('input', () => {
        const pct = Number(zoomRange.value) || 100;
        if (zoomVal) zoomVal.textContent = pct + '%';
        current.zoom = pct / 100;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            try {
                current = await window.settingsApi.set({ zoom: current.zoom });
                paint();
            } catch (e) { /* ignore */ }
        }, 220);
    });
}
if (zoomReset) {
    zoomReset.addEventListener('click', async () => {
        current.zoom = 1;
        paint();
        try { current = await window.settingsApi.set({ zoom: 1 }); paint(); } catch (e) { /* ignore */ }
    });
}


// 后台渲染
const bgAll = document.getElementById('bg-render');
const bgCur = document.getElementById('bg-current');
const saveBg = async (all) => {
    current.bgRender = !!all;
    current.tileView = false;
    try { current = await window.settingsApi.set({ bgRender: !!all, tileView: false }); paint(); } catch (e) { /* ignore */ }
};
if (bgAll) bgAll.addEventListener('change', () => saveBg(true));
if (bgCur) bgCur.addEventListener('change', () => saveBg(false));
const viewTileEl = document.getElementById('view-tile');
if (viewTileEl) viewTileEl.addEventListener('change', async () => {
    current.tileView = true;
    current.bgRender = true;
    try { current = await window.settingsApi.set({ tileView: true, bgRender: true }); paint(); } catch (e) { /* ignore */ }
});
