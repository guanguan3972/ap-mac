// 更新窗口逻辑
const curEl = document.getElementById('cur');
const latestEl = document.getElementById('latest');
const feedEl = document.getElementById('feed');
const noteEl = document.getElementById('note');
const btnCheck = document.getElementById('btn-check');
const btnApply = document.getElementById('btn-apply');
const btnSave = document.getElementById('btn-save');

let pending = null;

function setNote(text, cls) {
    noteEl.textContent = text;
    noteEl.className = cls || '';
}

function fmtVersion(v) {
    return v ? 'v' + String(v).replace(/^v/i, '') : '—';
}

const feedState = document.getElementById('feed-state');

function showFeedState(info) {
    if (!feedState) return;
    if (info && info.isDefault) {
        feedState.textContent = '使用默认源（Gitee）';
        feedState.style.color = '#15803d';
    } else {
        feedState.textContent = '使用自定义源';
        feedState.style.color = '#b45309';
    }
}

(async function init() {
    try {
        const info = await window.updaterApi.info();
        curEl.textContent = fmtVersion(info.current);
        feedEl.value = info.feed || '';
        showFeedState(info);
        if (info.isDefault) {
            setNote('已内置默认更新源（Gitee），直接点「检查更新」即可。', '');
        }
    } catch (e) {
        setNote('读取版本信息失败，请重启软件再试。', 'err');
    }
})();

const barWrap = document.getElementById('progress-wrap');
const barFill = document.getElementById('bar-fill');
const barText = document.getElementById('bar-text');

try {
    window.updaterApi.onProgress((p) => {
        if (!barWrap) return;
        barWrap.classList.add('show');
        const pct = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
        if (barFill) barFill.style.width = pct + '%';
        if (barText) barText.textContent = (p && p.text ? p.text + '  ' : '') + pct + '%';
    });
} catch (e) { /* ignore */ }

if (btnSave) btnSave.addEventListener('click', async () => {
    const raw = feedEl.value.trim();
    if (raw && !/^https:\/\//i.test(raw)) { setNote('地址要以 https:// 开头，例如 https://…/update.json', 'err'); return; }
    if (raw && !/\.json$/i.test(raw)) { setNote('地址要以 .json 结尾，例如 https://…/update.json', 'err'); return; }

    try {
        const r = await window.updaterApi.setFeed(raw);
        if (r && r.ok === false) { setNote('保存失败：' + (r.error || '地址不合法'), 'err'); return; }
        feedEl.value = (r && r.feed) || '';
        showFeedState(r);
        setNote((r && r.isDefault) ? '已恢复默认更新源。' : '更新源已保存。', 'ok');
    } catch (e) {
        setNote('保存失败，请重试。', 'err');
    }
});

const btnReset = document.getElementById('btn-reset');
if (btnReset) {
    btnReset.addEventListener('click', async () => {
        try {
            const r = await window.updaterApi.setFeed('');
            feedEl.value = (r && r.feed) || '';
            showFeedState(r);
            setNote('已恢复默认更新源（Gitee）。', 'ok');
        } catch (e) {
            setNote('恢复失败，请重试。', 'err');
        }
    });
}

btnCheck.addEventListener('click', async () => {
    btnCheck.disabled = true;
    btnApply.disabled = true;
    pending = null;
    setNote('正在检查…', '');

    let r;
    try {
        r = await window.updaterApi.check();
    } catch (e) {
        r = { ok: false, reason: e && e.message };
    }

    btnCheck.disabled = false;

    if (!r || !r.ok) {
        const map = {
            nofeed: '还没填更新源，先在上面填好再点保存。'
        };
        setNote(map[r && r.reason] || ('检查失败：' + ((r && r.reason) || '未知错误')), 'err');
        return;
    }

    latestEl.textContent = fmtVersion(r.latest);

    if (r.newer) {
        pending = r;
        btnApply.disabled = false;
        setNote('发现新版本 ' + fmtVersion(r.latest) + (r.notes ? '：' + r.notes : '') + '\n点「立即更新」，下载完成后程序会自动重启。', 'ok');
    } else {
        setNote('已经是最新版本（' + fmtVersion(r.current) + '）。', 'ok');
    }
});

const btnFile = document.getElementById('btn-file');
if (btnFile) {
    btnFile.addEventListener('click', async () => {
        btnFile.disabled = true;
        setNote('请选择更新包（xbu-x.x.x.zip）…', '');
        let r;
        try {
            r = await window.updaterApi.applyFile();
        } catch (e) {
            r = { ok: false, reason: e && e.message };
        }
        btnFile.disabled = false;
        if (r && r.ok) {
            setNote('更新已就绪，程序即将关闭并自动重启…', 'ok');
        } else if (r && r.reason === 'cancelled') {
            setNote('已取消。', '');
        } else {
            setNote('更新失败：' + ((r && r.reason) || '未知错误'), 'err');
        }
    });
}

btnApply.addEventListener('click', async () => {
    if (!pending) return;
    btnApply.disabled = true;
    btnCheck.disabled = true;
    setNote('正在下载更新包…（几百 KB，通常几秒钟）', '');

    let r;
    try {
        r = await window.updaterApi.apply(pending);
    } catch (e) {
        r = { ok: false, reason: e && e.message };
    }

    if (r && r.ok) {
        setNote('更新已就绪，程序即将关闭并自动重启…', 'ok');
    } else {
        btnApply.disabled = false;
        btnCheck.disabled = false;
        setNote('更新失败：' + ((r && r.reason) || '未知错误'), 'err');
    }
});
