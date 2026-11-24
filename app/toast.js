// 左上角提醒弹窗
const bodyEl = document.getElementById('body');
const titleEl = document.getElementById('title');
const closeEl = document.getElementById('close');

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

window.renderToast = function (payload) {
    const items = (payload && payload.items) || [];
    titleEl.textContent = payload && payload.title ? payload.title : '定时发布提醒';

    const show = items.slice(0, 3);
    bodyEl.innerHTML = show.map(it => {
        const d = (typeof it.days === 'number') ? it.days : null;
        let badge = '';
        let cls = 'd';
        if (d === 0) { badge = '今天'; cls = 'd hot'; }
        else if (d === 1) { badge = '明天'; cls = 'd warn'; }
        else if (d !== null) { badge = '还剩 ' + d + ' 天'; cls = d <= 3 ? 'd warn' : 'd'; }
        return `
        <div class="row">
            <span class="b" title="${esc(it.bookName)}">${esc(it.bookName)}</span>
            <span class="a">${esc(it.account || '')}</span>
            <span class="${cls}">${esc(badge || it.last || '')}</span>
        </div>`;
    }).join('') +
        (items.length > show.length ? `<div id="more">还有 ${items.length - show.length} 本…</div>` : '');
};

closeEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    try { window.toastApi.close(); } catch (e) { /* ignore */ }
});

document.getElementById('foot').addEventListener('click', () => {
    try { window.toastApi.openReminders(); } catch (e) { /* ignore */ }
});

// 点卡片任意处也能打开提醒窗口
document.body.addEventListener('dblclick', () => {
    try { window.toastApi.openReminders(); } catch (e) { /* ignore */ }
});


// 弹出时播放提示音（叮—叮—叮），不需要额外音频文件
(function playBeep() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        const freqs = [880, 1100, 1320];
        freqs.forEach((f, i) => {
            const start = ctx.currentTime + i * 0.18;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.18);
        });
    } catch (e) { /* 静默失败 */ }
})();
