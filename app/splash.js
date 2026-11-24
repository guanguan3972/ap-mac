// 启动动画：版本号 + 更新日志
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

window.renderSplash = function (data) {
    const d = data || {};
    const verEl = document.getElementById('ver');
    if (verEl) verEl.textContent = 'v' + String(d.version || '—').replace(/^v/i, '');

    const log = document.getElementById('log');
    if (!log) return;

    const entries = (d.changelog && d.changelog.entries) ? d.changelog.entries.slice(0, 3) : [];
    if (!entries.length) {
        log.innerHTML = '<div class="entry"><div class="v">暂无更新记录</div></div>';
        return;
    }

    log.innerHTML = entries.map((e, i) => {
        const items = (e.items || []).slice(0, 3).map(t => '<li>' + esc(t) + '</li>').join('');
        return '<div class="entry' + (i === 0 ? ' new' : '') + '">' +
            '<div class="v">v' + esc(e.version) + '<span>' + esc(e.date || '') + '</span></div>' +
            '<ul>' + items + '</ul></div>';
    }).join('');
};

window.setSplashTip = function (text) {
    const el = document.getElementById('tip');
    if (el) el.textContent = text;
};

// 首页按钮
document.addEventListener('DOMContentLoaded', function () {
    var up = document.getElementById('btn-update');
    var enter = document.getElementById('btn-enter');
    var tip = document.getElementById('tip');

    if (up) {
        up.addEventListener('click', function () {
            try { window.splashApi.openUpdate(); } catch (e) { /* ignore */ }
        });
    }
    if (enter) {
        enter.addEventListener('click', function () {
            try { window.splashApi.close(); } catch (e) { /* ignore */ }
        });
    }
    if (tip) {
        var n = 5;
        var timer = setInterval(function () {
            n = n - 1;
            if (n <= 0) { clearInterval(timer); return; }
            tip.textContent = n + ' 秒后自动进入';
        }, 1000);
    }
});
